# Model Gateway Implementation Notes

> Date: 2026-08-06
> Context: Implementing the agent-aware ModelGateway in the Python harness (agent-os-harness/)
> Spec reference: spec/architecture/model-api-gateway.md

## Background

The v9.1 spec defines a complete Model Gateway in spec/architecture/model-api-gateway.md:

- Capability Registry (20+ capability dimensions)
- Provider Adapter (13 methods: request_normalizer, structured_output_handler, tool_call_normalizer, streaming_event_handler, error_mapper, usage_meter, rate_limiter, circuit_breaker, health_checker, data_policy_validator, fallback_compatibility_checker)
- Fallback Chain (primary -> fallback_1 -> fallback_2 -> local_model -> cascade_failure_handler, cannot return to primary)
- Model Switch Re-validation (5 items: context length / tool definitions / data policy / structured output / plan compatibility)
- KV-cache engineering (cache layers + invalidation matrix + tool-masking state machine)
- Cache-aware compaction

The Python harness (agent-os-harness/harness/model_backend.py) had only:
- OpenAICompatibleBackend (single endpoint + response cache + retry)
- MultiModelBackend (tier routing, not provider routing)
- FallbackChainBackend (sequential try, string-match failure detection)
- MultimodalBackend (image support)
- OllamaBackend (local model)

All requests went through CC Switch (local proxy at 127.0.0.1:15721) with api_key: "empty".

## Problem

For the managed-platform model (users don't bring their own API keys), CC Switch is structurally unsuitable:

1. CC Switch is a local desktop tool (Electron app), not a server-side component
2. CC Switch doesn't understand agent semantics (tier, capability, budget, PII)
3. CC Switch's failover is manual (enableFailoverToggle: false by default)
4. CC Switch doesn't do real cost tracking (only forwards requests)
5. The economic kernel (Wallet + Budget + Settlement) is disconnected from model calls (uses COST_MODEL fixed weights, not real token costs)

## Solution: ModelGateway

Created harness/gateway.py (799 lines) implementing the agent-aware gateway layer.

### Architecture

```
kernel._call_model(prompt, tier="work")
  |
  v
ModelGateway.complete()
  |-- KeyVault: get API key for provider (not "empty")
  |-- CapabilityRegistry: find models matching tier + capabilities
  |-- Router: select best by capability/price ratio + budget
  |-- ProviderAdapter: build provider-specific request, parse response
  |-- UsageMeter: extract real token counts, compute real USD cost
  |-- economic.spend(): charge real cost to economic kernel
  |-- CircuitBreaker: trip on failures, auto-failover to next provider
  |-- RateLimiter: per-user RPM/TPM/concurrent limiting
  |
  v
LLM Provider (Zhipu / OpenAI / Anthropic / DeepSeek / Qwen)
```

### Components

#### KeyVault
- Loads API keys from environment variables and ~/.env
- Supports 9 providers: openai, anthropic, zhipu, deepseek, google, mistral, qwen, kimi, perplexity
- Key health tracking: 3 consecutive failures marks key unhealthy
- Multi-key rotation per provider (round-robin by creation time)
- Phase 7: AES-256 encryption with KMS master key

#### CapabilityRegistry
- 9 default model bindings registered with benchmark-based capability scores
- Models: glm-5.2, gpt-5.4, gpt-5.4-mini, claude-sonnet-4.6, deepseek-v3, qwen-max
- Each binding: model_id, provider, tier, capabilities (code/reasoning/tool_calling/structured_output/long_context/chinese), price_input, price_output, max_context, supports_tools, supports_vision
- find_models() filters by tier + required capabilities + budget + vision/tools requirement
- Sort: highest capability score first, then cheapest

#### CircuitBreaker
- Per-provider state machine: CLOSED -> OPEN (5 failures) -> HALF_OPEN (60s timeout) -> CLOSED (probe success)
- OPEN: all requests rejected immediately (no API call)
- HALF_OPEN: one probe request allowed; success closes, failure re-opens
- Bug found and fixed: OPEN->HALF_OPEN transition didn't set half_open_probe_in_flight = True, allowing a second request through

#### RateLimiter
- Per-user sliding window: RPM (60/min) + TPM (100K/min) + concurrent (5)
- All three checked atomically under lock
- release() called on all code paths (success, failure, error) to free concurrent slots

#### ProviderAdapter
- Builds requests for OpenAI-compatible and Anthropic formats
- Parses responses: extracts content + usage (prompt_tokens, completion_tokens, reasoning_tokens)
- GLM-5.2 reasoning_content fallback: when content is empty, extracts JSON from reasoning_content
- OpenAI o-series reasoning_tokens: extracted from completion_tokens_details.reasoning_tokens
- Vision: OpenAI uses image_url content parts; Anthropic uses image source blocks

#### ModelGateway.complete()
- Flow: rate limit check -> find candidates -> filter by key + circuit breaker -> select by budget-aware scoring -> call provider -> real cost to economic kernel -> failover on failure
- Budget-aware model selection (3 zones):
  - Ample (cost < 10% of remaining): pure capability score
  - Moderate (10%-50%): capability * (1 - cost/budget)
  - Tight (>50%): capability * 0.1 * (budget/cost) -- heavily penalizes expensive models
- Failover: tries next provider with available key + closed circuit breaker
- Fallback chain tracked in RouteResult for observability

### Kernel Integration

Modified harness/kernel.py:

1. __init__: added gateway parameter
2. _call_model: if gateway exists, calls _call_via_gateway() (real routing + real cost); otherwise falls back to legacy path (MultiModelBackend + COST_MODEL)
3. _call_via_gateway: calls gateway.complete(), tracks real token usage, records real cost in CostDashboard
4. _tier_capabilities: maps tier to required capabilities:
   - route (L1): reasoning + tool_calling
   - work (L2): code + reasoning + structured_output
   - verify (L3): reasoning + structured_output

Modified main.py:
1. build_kernel: in non-mock mode, creates ModelGateway with shared economic kernel instance
2. Mock mode skips gateway (uses MockBackend, doesn't break existing tests)
3. Gateway config from defaults.yaml: rpm_limit, tpm_limit, concurrent_limit

### Economic Kernel Integration

The gateway charges real USD to the economic kernel:

    # In _call_provider, after successful response:
    cost_usd = prompt_tokens / 1M * price_input + completion_tokens / 1M * price_output
    # Convert to internal credits (1 credit = $0.01)
    self.economic.spend(task_id, user_id, cost_usd * 100, step_id, "model:{provider}/{model}")

This replaces the old COST_MODEL fixed weights (route=0.5, work=1.0, verify=2.0) with real per-token costs.

### CC Switch Compatibility

CCSwitchBackend class provides backward compatibility for developer mode:
- Routes through CC Switch proxy at 127.0.0.1:15721
- Same OpenAI-compatible format
- No real cost tracking (CC Switch doesn't return usage in a structured way)

Production mode: ModelGateway direct to providers.
Developer mode: CCSwitchBackend through local proxy.

## Testing

17 logic tests (41 assertions) covering:
- KeyVault: add/get/mark_unhealthy/mark_healthy/multi-key
- CapabilityRegistry: filter by tier/capability/budget/vision/tools + sort
- CircuitBreaker: full state machine (CLOSED/OPEN/HALF_OPEN) + probe semantics
- RateLimiter: RPM + TPM + concurrent + error path release
- Economic: real cost -> credits conversion + budget enforcement + overspend block
- ProviderAdapter: OpenAI/Anthropic request building + response parsing + GLM reasoning fallback + vision
- ModelGateway: no-key graceful failure + key filtering + budget-aware selection (3 zones) + failover chain + real cost charging
- Kernel integration: mock mode (legacy path) + gateway mode (real routing)
- Rate limiter release on all error paths
- Budget blocks expensive models

All 41 gateway tests pass. All 274 existing project tests pass (no regression).

### Bugs Found During Testing

1. CircuitBreaker half-open leak: OPEN->HALF_OPEN transition returned True without setting half_open_probe_in_flight = True, allowing a second request through. Fixed: set flag to True on transition (the transition call IS the probe).

2. Model selection cross-zone incomparability: old scoring used 1.0 / (cost + 0.001) (~31) for tight zone and avg_cap (~0.9) for ample zone. Tight zone always won regardless of budget. Fixed: all zones use same 0-1 scale (ample=avg_cap, moderate=avg_cap*(1-pct), tight=avg_cap*0.1*(budget/cost)).

3. ProviderAdapter system_prompt handling: when system_prompt="", no system message is added, so user message is at index 0 not index 1. Tests assumed fixed index. Fixed tests to search by role.

## Remaining Gaps (Future Phases)

### Not yet implemented from v9.1 spec

1. KV-cache engineering (CTRL-TOOL-MASK-001): tool-masking state machine requires provider-side constrained decoding. GLM doesn't support it. Phase 3 blocker.
2. Model Switch Re-validation: only context length is checked. Missing: tool definition format, data policy, structured output format, plan compatibility, tool calling format.
3. Data policy validation: no PII detection before routing to providers. Need data_policy_validator in ProviderAdapter.
4. Streaming: ProviderAdapter supports building streaming requests but gateway doesn't use streaming yet. Kernel's _call_model still gets full response.
5. Prompt caching breakpoints: Anthropic cache_control and OpenAI automatic caching not implemented. System prompt is rebuilt every call.
6. Batch API: OpenAI Batch API (50% discount) and Anthropic Message Batches not supported.
7. Capability scoring from production data: scores are benchmark-based, not updated from real usage (Phase 4 evolution).
8. Fallback chain "cannot return to primary": spec says no return to primary. Current circuit breaker allows return via HALF_OPEN probe. This is intentional (better than permanent fallback) but diverges from spec.

### From gap analysis (P1-17 to P1-22)

- P1-17: Gateway implemented (this work)
- P1-18: Rate limiter implemented (this work)
- P1-19: Circuit breaker implemented (this work)
- P1-20: Fallback chain "no return to primary" -- diverged (circuit breaker allows recovery, intentional)
- P1-21: Cost estimation before task execution -- not yet (TaskState.estimate_plan still uses COST_MODEL)
- P1-22: Model Switch Re-validation missing tool calling format check
