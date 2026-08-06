import { KeyVault } from './key-vault.js';
import { CapabilityRegistry, type ModelBinding, type ModelTier, type RouteResult, type UsageRecord } from './capability-registry.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { RateLimiter } from './rate-limiter.js';
import { EconomicKernel } from './economic-kernel.js';
import {
  ModelGateway, FrozenProviderRegistry, ProviderDispatchError,
  type GatewayProviderRegistration, type GatewayProviderMetadata, type GatewayClockPort,
  type ProviderSelectionRequest, type SecretsBrokerPort,
  type EgressPolicyPort, type UsageMeterPort, type GatewayProviderRuntime,
} from './model-gateway.js';
import { createProviderAdapter, getProviderRegions } from './provider-adapters.js';
import type { ModelTurn } from '../runtime/loop.js';
import type { Message } from './scripted-provider.js';
import type { ProviderType } from '../contracts/index.js';

export interface ManagedGatewayOptions {
  keyVault?: KeyVault;
  registry?: CapabilityRegistry;
  economic?: EconomicKernel;
  rateLimiter?: RateLimiter;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
}

interface CallContext {
  userId: string;
  taskId: string;
  stepId: string;
  tier: ModelTier;
  requiredCapabilities?: readonly string[];
  tools?: unknown[];
  images?: string[];
  systemPrompt?: string;
  estimatedOutputTokens?: number;
}

export class ManagedGateway {
  private readonly keyVault: KeyVault;
  private readonly capRegistry: CapabilityRegistry;
  private readonly economic: EconomicKernel;
  private readonly rateLimiter: RateLimiter;
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly usageLog: UsageRecord[] = [];
  private readonly defaultTemperature: number;
  private readonly defaultMaxTokens: number;
  private readonly modelGateway: ModelGateway;
  private readonly frozenRegistry: FrozenProviderRegistry;
  private readonly bindingMap = new Map<string, ModelBinding>();

  constructor(opts: ManagedGatewayOptions = {}) {
    this.keyVault = opts.keyVault ?? new KeyVault();
    this.capRegistry = opts.registry ?? new CapabilityRegistry();
    this.economic = opts.economic ?? new EconomicKernel();
    this.rateLimiter = opts.rateLimiter ?? new RateLimiter();
    this.defaultTemperature = opts.defaultTemperature ?? 0.3;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 8000;

    for (const b of this.capRegistry.listAll()) {
      if (!this.breakers.has(b.provider)) {
        this.breakers.set(b.provider, new CircuitBreaker(b.provider));
      }
    }

    const registrations: GatewayProviderRegistration[] = [];
    for (const binding of this.capRegistry.listAll()) {
      if (!this.keyVault.hasProvider(binding.provider)) continue;
      const adapter = createProviderAdapter(binding, this.keyVault);
      const providerId = `${binding.provider}/${binding.model_id}/${binding.tier}`;
      const metadata = this.buildMetadata(binding);
      registrations.push({
        provider_id: providerId,
        contract: {
          provider_type: (binding.api_format === 'anthropic' ? 'anthropic' : 'openai') as ProviderType,
          normalize_request: true, parse_response: true, normalize_tool_call: true,
          stream_events: true, map_error: true, meter_usage: true,
          check_health: true, validate_data_policy: true,
        },
        adapter: adapter as unknown as GatewayProviderRuntime,
        metadata,
      });
      this.bindingMap.set(providerId, binding);
    }

    this.frozenRegistry = new FrozenProviderRegistry(registrations);
    this.modelGateway = new ModelGateway(this.frozenRegistry, {
      secretsBroker: this.makeSecretsBroker(),
      egressPolicy: this.makeEgressPolicy(),
      usageMeter: this.makeUsageMeter(),
      clock: this.makeClock(),
    });
  }

  get keyVaultRef(): KeyVault { return this.keyVault; }
  get registryRef(): CapabilityRegistry { return this.capRegistry; }
  get economicRef(): EconomicKernel { return this.economic; }

  private buildMetadata(binding: ModelBinding): GatewayProviderMetadata {
    return {
      capabilities: Object.keys(binding.capabilities),
      max_context_tokens: binding.max_context,
      structured_output: (binding.capabilities['structured_output'] ?? 0) > 0.5,
      tool_calling: binding.supports_tools,
      data_policy: {
        execution: 'remote',
        regions: getProviderRegions(binding.provider),
        retention_days: 30,
        training_allowed: false,
      },
      pricing: {
        currency: 'USD' as const,
        input_per_million: binding.price_input,
        output_per_million: binding.price_output,
      },
      health: 'healthy' as const,
      network: { required: true, destination: binding.api_base },
      credentials: { required: true, audience: binding.api_base },
    };
  }

  private makeSecretsBroker(): SecretsBrokerPort {
    return {
      async exchangeCredential(input) {
        return {
          lease_id: `lease-${input.operation_id}`,
          audience: input.audience,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    };
  }

  private makeClock(): GatewayClockPort {
    return {
      now() { return Date.now(); },
      async sleep(ms: number, signal: AbortSignal) {
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
        });
      },
    };
  }

  private makeEgressPolicy(): EgressPolicyPort {
    const keyVault = this.keyVault;
    return {
      async authorize(input) {
        if (!input.network_required) return { allowed: true };
        if (input.data_policy.local_only) {
          return { allowed: false, reason: 'local_only policy denies remote egress' };
        }
        const provider = input.provider_id.split('/')[0] ?? '';
        if (!keyVault.hasProvider(provider)) {
          return { allowed: false, reason: `No API key for ${provider}` };
        }
        return { allowed: true };
      },
    };
  }

  private makeUsageMeter(): UsageMeterPort {
    const usageLog = this.usageLog;
    return {
      async record(input) {
        usageLog.push({
          model_id: input.provider_id.split('/')[1] ?? input.provider_id,
          provider: input.provider_id.split('/')[0] ?? input.provider_id,
          prompt_tokens: input.usage.input_tokens,
          completion_tokens: input.usage.output_tokens,
          cost_usd: 0, latency_ms: 0, timestamp: Date.now(), success: true,
        });
        if (usageLog.length > 10000) usageLog.splice(0, usageLog.length - 10000);
      },
    };
  }

  async complete(prompt: string, ctx: CallContext): Promise<RouteResult> {
    const estInput = Math.ceil(prompt.length / 4);
    const estOutput = ctx.estimatedOutputTokens ?? 2000;

    const rl = this.rateLimiter.check(ctx.userId, estInput + estOutput);
    if (!rl.allowed) {
      this.rateLimiter.release(ctx.userId);
      return this.fail(rl.reason ?? 'rate limited', ctx);
    }

    const messages: Message[] = [
      { role: 'system', content: ctx.systemPrompt ?? 'You are a precise agent execution engine.' },
      { role: 'user', content: prompt },
    ];

    const request: ProviderSelectionRequest = {
      registry_snapshot_hash: this.frozenRegistry.snapshot.hash,
      request: {
        messages,
        ...(ctx.tools && ctx.tools.length > 0
          ? { tools: ctx.tools.map((t, i) => ({ name: typeof t === 'object' && t !== null && 'name' in t ? String((t as Record<string, unknown>)['name']) : `tool_${i}` })) }
          : {}),
        temperature: this.defaultTemperature,
        max_tokens: this.defaultMaxTokens,
      },
      estimated_input_tokens: estInput,
      required_capabilities: ctx.requiredCapabilities ?? [],
      requires_structured_output: false,
      data_policy: {
        local_only: false, allowed_regions: ['cn', 'us'],
        max_retention_days: 30, training_allowed: false,
      },
      policy: { allowed_provider_ids: undefined, denied_provider_ids: [] },
      run_plan: { allowed_provider_ids: undefined, required_capabilities: ctx.requiredCapabilities ?? [] },
    };

    let resolved;
    try {
      resolved = this.modelGateway.resolve(request);
    } catch {
      this.rateLimiter.release(ctx.userId);
      return this.fail('No compatible provider', ctx);
    }

    const fallbackChain: string[] = [resolved.provider_id];
    const attempted: string[] = [];

    while (true) {
      const binding = this.bindingMap.get(resolved.provider_id);
      if (!binding) {
        attempted.push(resolved.provider_id);
        try { resolved = this.modelGateway.switchProvider(resolved, request, attempted); fallbackChain.push(resolved.provider_id); continue; }
        catch { this.rateLimiter.release(ctx.userId); return this.fail('All providers failed', ctx, fallbackChain); }
      }

      const breaker = this.breakers.get(binding.provider);
      if (breaker && !breaker.canRequest()) {
        attempted.push(resolved.provider_id);
        try { resolved = this.modelGateway.switchProvider(resolved, request, attempted); fallbackChain.push(resolved.provider_id); continue; }
        catch { this.rateLimiter.release(ctx.userId); return this.fail('Circuit breakers open', ctx, fallbackChain); }
      }

      const budget = this.economic.getBudget(ctx.taskId);
      const budgetRemaining = budget ? budget.total - budget.spent : undefined;
      if (budgetRemaining !== undefined) {
        const estCost = this.capRegistry.estimateCost(binding, estInput, estOutput);
        if (estCost > budgetRemaining) {
          attempted.push(resolved.provider_id);
          try { resolved = this.modelGateway.switchProvider(resolved, request, attempted); fallbackChain.push(resolved.provider_id); continue; }
          catch { this.rateLimiter.release(ctx.userId); return this.fail('Budget insufficient', ctx, fallbackChain); }
        }
      }

      const t0 = performance.now();
      try {
        const dispatchResult = await this.modelGateway.dispatch(resolved, request, {
          operation_id: `op-${ctx.taskId}-${Date.now()}`,
        });

        this.rateLimiter.release(ctx.userId);
        breaker?.recordSuccess();

        const cost = dispatchResult.usage.input_tokens / 1_000_000 * binding.price_input +
                     dispatchResult.usage.output_tokens / 1_000_000 * binding.price_output;
        const latencyMs = performance.now() - t0;

        if (cost > 0) {
          this.economic.spend(ctx.taskId, cost, ctx.stepId, `model:${binding.provider}/${binding.model_id}`);
          this.economic.debitWallet(ctx.userId, cost);
        }

        if (this.usageLog.length > 0) {
          const last = this.usageLog[this.usageLog.length - 1]!;
          last.cost_usd = cost;
          last.latency_ms = latencyMs;
        }

        return {
          response: dispatchResult.response.content,
          usage: {
            model_id: binding.model_id, provider: binding.provider,
            prompt_tokens: dispatchResult.usage.input_tokens,
            completion_tokens: dispatchResult.usage.output_tokens,
            cost_usd: cost, latency_ms: latencyMs,
            timestamp: Date.now(), success: true,
          },
          model_used: binding.model_id, provider_used: binding.provider,
          fallback_triggered: fallbackChain.length > 1, fallback_chain: fallbackChain,
        };
      } catch (e) {
        if (e instanceof ProviderDispatchError) {
          if (e.code === 'provider_failure' || e.code === 'provider_unhealthy') breaker?.recordFailure();
        } else {
          breaker?.recordFailure();
        }
        attempted.push(resolved.provider_id);
        try {
          resolved = this.modelGateway.switchProvider(resolved, request, attempted);
          fallbackChain.push(resolved.provider_id);
        } catch {
          this.rateLimiter.release(ctx.userId);
          const errorMsg = e instanceof ProviderDispatchError ? e.code : (e as Error).message;
          return this.fail(`All providers failed (last: ${errorMsg})`, ctx, fallbackChain);
        }
      }
    }
  }

  private fail(error: string, ctx: CallContext, chain: string[] = [], model = 'none', provider = 'none'): RouteResult {
    return {
      response: JSON.stringify({ error }),
      usage: { model_id: model, provider, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, latency_ms: 0, timestamp: Date.now(), success: false, error },
      model_used: model, provider_used: provider,
      fallback_triggered: chain.length > 1, fallback_chain: chain,
    };
  }

  getUsageSummary(): Record<string, unknown> {
    const totalCost = this.usageLog.reduce((s, r) => s + r.cost_usd, 0);
    const totalTokens = this.usageLog.reduce((s, r) => s + r.prompt_tokens + r.completion_tokens, 0);
    const byProvider: Record<string, { calls: number; cost: number; tokens: number; failures: number }> = {};
    for (const r of this.usageLog) {
      const k = r.provider;
      if (!byProvider[k]) byProvider[k] = { calls: 0, cost: 0, tokens: 0, failures: 0 };
      byProvider[k]!.calls += 1;
      byProvider[k]!.cost += r.cost_usd;
      byProvider[k]!.tokens += r.prompt_tokens + r.completion_tokens;
      if (!r.success) byProvider[k]!.failures += 1;
    }
    return {
      total_calls: this.usageLog.length,
      total_cost_usd: Math.round(totalCost * 10000) / 10000,
      total_tokens: totalTokens,
      by_provider: byProvider,
      circuit_breakers: Object.fromEntries(
        [...this.breakers.entries()].map(([p, b]) => [p, { state: b.state, failures: b.consecutiveFailures }]),
      ),
    };
  }

  getAvailableModels(): unknown[] {
    return this.capRegistry.listAll().map(b => ({
      model_id: b.model_id, provider: b.provider, tier: b.tier,
      capabilities: b.capabilities, price_input: b.price_input, price_output: b.price_output,
      max_context: b.max_context, supports_tools: b.supports_tools, supports_vision: b.supports_vision,
      has_api_key: this.keyVault.hasProvider(b.provider),
      circuit_breaker: this.breakers.get(b.provider)?.state ?? 'closed',
    }));
  }

  toHarnessProvider(userId: string, taskId: string): {
    resolve: (messages: Array<{ role: string; content: string }>, tools?: Array<{ name: string; description?: string }>) => Promise<ModelTurn>;
  } {
    return {
      resolve: async (messages, tools) => {
        const prompt = messages.map(m => `${m.role}: ${m.content}`).join('\n\n');
        const result = await this.complete(prompt, {
          userId, taskId, stepId: 'model', tier: 'work',
          requiredCapabilities: ['reasoning'],
          ...(tools && tools.length > 0 ? { tools } : {}),
        });
        let toolCalls: ModelTurn['tool_calls'];
        try {
          const parsed = JSON.parse(result.response) as { tool_calls?: unknown[] };
          if (Array.isArray(parsed.tool_calls)) {
            toolCalls = parsed.tool_calls.map((tc) => {
              const t = tc as { id: string; name: string; arguments: Record<string, unknown> };
              return { id: t.id, name: t.name, arguments: t.arguments };
            });
          }
        } catch { toolCalls = undefined; }
        return {
          content: result.response,
          ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
          stop_reason: (result.usage.success ? 'stop' : 'content_filter') as 'stop' | 'content_filter',
          decision_summary: result.response.slice(0, 200),
          usage: { input_tokens: result.usage.prompt_tokens, output_tokens: result.usage.completion_tokens },
        };
      },
    };
  }
}
