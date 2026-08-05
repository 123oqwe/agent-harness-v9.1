# Gateway Gap Analysis — v9.1 TypeScript Implementation

> Date: 2026-08-06
> Scope: `harness/gateway/*.ts` vs `spec/architecture/model-api-gateway.md`
> All 66 existing gateway tests pass. This analysis identifies what the spec requires but the code does not yet do.

## Current State (What's Implemented)

### model-gateway.ts (503 lines)
- ModelGateway class: register/resolve providers, complete() with retry, telemetry, usage tracking
- CircuitBreaker: CLOSED/OPEN/HALF_OPEN, only server/timeout trip, probe semantics
- Error classification: rate_limited (no retry), server/timeout (backoff retry), auth/invalid_request (no retry), truncation (no retry, throw GatewayTruncationError)
- completeWithTools(): passes tools array to provider (native function calling)
- stream(): async iterable of StreamEvent (text_delta, tool_call, message_stop)
- GatewayTruncationError, GatewayRateLimitedError, GatewayRetryExhaustedError, CircuitOpenError

### capability-registry.ts (386 lines)
- CapabilityRegistry: register/get/list models, filterByCapabilities (cheapest first)
- getToolCallingFormat(): returns format per provider type (P1-22)
- isToolFormatCompatible(): checks format compatibility between models (P1-22)
- UsageMeter: record real cost, getTotalCost, estimateCost for plans (P1-21)
- KeyVault: AES-256-GCM encrypted key storage with store/retrieve
- RateLimiter: per-user sliding window (RPM + TPM + concurrent)
- LLMCache: persistent cache with TTL, SHA-256 key, JSON file persistence
- FallbackChain: primary -> fallbacks, failover(), attemptRecovery()

### scripted-provider.ts (328 lines)
- ScriptedTestProvider: queue mode (ordered) + map mode (hash-based)
- Full ProviderAdapter implementation (8 methods)
- Call metadata logging (index, timestamp, messages, tools, usage, lookup_mode)
- Zero network calls in all code paths
- ScriptedResponseExhaustedError / ScriptedResponseMissingError

### provider.ts (78 lines)
- ProviderAdapter interface: 8 methods + provider_type enum
- ToolCall, Message, ParsedResponse, Usage, ProviderRequest, ProviderError, StreamEvent types

## Gaps (What's Missing)

### Critical: Components exist but are NOT integrated

#### G1: CapabilityRegistry not connected to ModelGateway.complete()
**Spec ref**: model-api-gateway.md "Capability Registry" + routing-system.md "Model/tool/skill/environment binding"

The ModelGateway.complete() takes a `type` parameter (provider type) — the caller must already know which provider to use. The CapabilityRegistry exists but is never queried by the gateway. The spec requires the gateway to resolve models by capability, not by manual provider type selection.

**What needs to happen**: complete() should accept `requiredCapabilities: string[]` + `tier: ModelTier` and internally query the CapabilityRegistry to find matching models, then select the best one by cost/quality/budget.

#### G2: KeyVault not used by ModelGateway
**Spec ref**: model-api-gateway.md "Provider Adapter Must Implement" — secrets broker

KeyVault stores and retrieves encrypted API keys, but ModelGateway never calls `vault.retrieve(provider)`. The ScriptedTestProvider doesn't need keys (it's network-free), but real providers (OpenAI, Anthropic) will. The gateway should obtain keys from KeyVault at dispatch time and pass them to the provider adapter.

#### G3: RateLimiter not used by ModelGateway
**Spec ref**: P1-18, model-api-gateway.md "rate_limiter"

RateLimiter has check/recordStart/recordCompletion, but ModelGateway.complete() never calls them. No per-user rate limiting is enforced. A user could make unlimited requests.

#### G4: FallbackChain not used by ModelGateway
**Spec ref**: P1-20, model-api-gateway.md "Fallback Chain"

FallbackChain has failover()/attemptRecovery(), but ModelGateway doesn't use it. When the circuit breaker is OPEN, the gateway throws CircuitOpenError — it doesn't try the next provider. The spec requires automatic failover to alternative providers.

#### G5: No budget-aware model selection
**Spec ref**: P1-21, routing-system.md "Joint constraint solver"

The gateway doesn't check the user's remaining budget before selecting a model. UsageMeter records costs after the fact, but doesn't influence model selection. The spec requires budget as a hard constraint in routing.

#### G6: No automatic failover across providers
**Spec ref**: model-api-gateway.md "Fallback Chain: primary -> fallback_1 -> fallback_2 -> local_model -> cascade_failure_handler"

When a provider fails, the gateway retries the SAME provider (up to maxRetries), then throws GatewayRetryExhaustedError. It doesn't try a different provider. The CircuitBreaker blocks requests to the same provider when OPEN, but doesn't route to alternatives.

### Important: Spec features not implemented at all

#### G7: No Model Switch Re-validation
**Spec ref**: model-api-gateway.md "Model Switch Must Re-validate" (5 items)

When switching from model A to model B, the spec requires re-validating:
1. Context length (B.max_context >= current_tokens) — NOT implemented
2. Tool definitions serialization — NOT implemented
3. Data policy — NOT implemented
4. Structured output format — NOT implemented
5. Plan compatibility — NOT implemented

CapabilityRegistry has `isToolFormatCompatible()` (checks tool calling format), but it's never called during routing. The other 4 checks don't exist.

#### G8: No data policy validation
**Spec ref**: model-api-gateway.md "data_policy_validator", trust-boundaries.md

ProviderAdapter has `validateDataPolicy()` in the interface, but it's never called by ModelGateway. The spec requires checking data region/retention before routing to a provider. Some data (PII, health, financial) must not be sent to certain providers.

#### G9: No prompt caching breakpoints
**Spec ref**: model-api-gateway.md "Prompt Cache Engineering", CTRL-TOOL-MASK-001

The spec defines cache layers (system prompt, conversation) with an invalidation matrix. The gateway doesn't manage cache breakpoints. System prompt is rebuilt every call. No Anthropic `cache_control` or OpenAI automatic caching support.

#### G10: No KV-cache / tool-masking state machine
**Spec ref**: model-api-gateway.md "Tool-masking state machine (FG5)", CTRL-TOOL-MASK-001

The spec defines a tool-masking state machine that masks tool-name token logits at decode time to preserve KV-cache. This requires provider-side constrained decoding support. Not implemented. Spec marks this as a Phase 3 launch blocker.

#### G11: No batch API support
**Spec ref**: Not in spec, but competitive gap

OpenAI Batch API (50% discount) and Anthropic Message Batches not supported. Useful for non-real-time research tasks.

### Code quality issues

#### G12: Duplicate ModelGateway class
**File**: scripted-provider.ts exports its own `ModelGateway` class (simpler, only supports scripted_test providers). model-gateway.ts exports the full `ModelGateway`. This creates a naming conflict. Tests in scripted-provider.test.ts import from scripted-provider.ts, while tests in model-gateway.test.ts import from model-gateway.ts.

**Fix**: Remove the duplicate ModelGateway from scripted-provider.ts. All tests should import from model-gateway.ts.

#### G13: CircuitBreaker half-open allows multiple probes
**File**: model-gateway.ts, CircuitBreaker.allowRequest()

In HALF_OPEN state, `allowRequest()` always returns true. There's no `halfOpenProbeInFlight` flag to prevent multiple concurrent probes. If two requests arrive simultaneously in HALF_OPEN, both go through, defeating the "one probe" semantics.

**Fix**: Add `halfOpenProbeInFlight` flag. Set to true on first allowRequest() in HALF_OPEN. Reset on recordSuccess/recordFailure.

#### G14: Busy-wait sleep in retry loop
**File**: model-gateway.ts, line in complete() retry loop

```typescript
const delay = retryDelayMs * Math.pow(2, attempt);
if (delay > 0 && delay < 100) {
  const start = Date.now();
  while (Date.now() - start < delay) { /* busy wait */ }
}
```

Busy-wait blocks the event loop. Should use `await new Promise(resolve => setTimeout(resolve, delay))` instead. This also means the retry only works for very short delays (<100ms), which is unrealistic for real API calls.

#### G15: completeWithTools doesn't pass tool_choice to ProviderRequest
**File**: model-gateway.ts, completeWithTools()

The method accepts `tool_choice` in opts but ProviderRequest doesn't have a `tool_choice` field. The comment says "the provider adapter normalizes it" but there's no mechanism to pass it through.

**Fix**: Add `tool_choice?: 'auto' | 'required' | 'none' | string` to ProviderRequest interface.

#### G16: No real provider adapters (OpenAI, Anthropic, etc.)
**File**: gateway/ directory only has scripted-provider.ts

ScriptedTestProvider is the only ProviderAdapter implementation. No real adapters for OpenAI, Anthropic, Google, or local providers. The gateway can only be tested with scripted responses, not real API calls.

#### G17: LLMCache not integrated with ModelGateway
**File**: capability-registry.ts has LLMCache, but ModelGateway doesn't use it

The cache exists but complete() doesn't check cache before calling the provider, and doesn't store responses after. The spec mentions prompt caching at the provider level (KV-cache), but application-level response caching (same prompt = same response) is also useful for cost savings.

## Priority

| Gap | Phase | Priority | Effort |
|-----|-------|----------|--------|
| G1: CapabilityRegistry routing | P1 | Critical | Medium |
| G2: KeyVault integration | P1 | Critical | Small |
| G3: RateLimiter integration | P1 | Critical | Small |
| G4: FallbackChain integration | P1 | Critical | Medium |
| G5: Budget-aware selection | P1 | High | Medium |
| G6: Auto-failover | P1 | Critical | Medium |
| G7: Model Switch Re-validation | P2 | High | Medium |
| G8: Data policy validation | P2 | High | Medium |
| G9: Prompt caching | P3 | Medium | Large |
| G10: KV-cache / tool-masking | P3 | Medium | Large |
| G11: Batch API | P5 | Low | Small |
| G12: Duplicate ModelGateway | P1 | Critical | Trivial |
| G13: CircuitBreaker multi-probe | P1 | High | Small |
| G14: Busy-wait sleep | P1 | High | Trivial |
| G15: tool_choice passthrough | P1 | High | Trivial |
| G16: Real provider adapters | P1 | Critical | Large |
| G17: LLMCache integration | P2 | Medium | Small |
