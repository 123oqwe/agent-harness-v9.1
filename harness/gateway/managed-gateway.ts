import { KeyVault } from './key-vault.js';
import { CapabilityRegistry, type ModelBinding, type ModelTier, type RouteResult, type UsageRecord } from './capability-registry.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { RateLimiter } from './rate-limiter.js';
import { EconomicKernel } from './economic-kernel.js';
import type { ModelTurn } from '../runtime/loop.js';

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
  private readonly registry: CapabilityRegistry;
  private readonly economic: EconomicKernel;
  private readonly rateLimiter: RateLimiter;
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly usageLog: UsageRecord[] = [];
  private readonly defaultTemperature: number;
  private readonly defaultMaxTokens: number;

  constructor(opts: ManagedGatewayOptions = {}) {
    this.keyVault = opts.keyVault ?? new KeyVault();
    this.registry = opts.registry ?? new CapabilityRegistry();
    this.economic = opts.economic ?? new EconomicKernel();
    this.rateLimiter = opts.rateLimiter ?? new RateLimiter();
    this.defaultTemperature = opts.defaultTemperature ?? 0.3;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 8000;

    for (const b of this.registry.listAll()) {
      if (!this.breakers.has(b.provider)) {
        this.breakers.set(b.provider, new CircuitBreaker(b.provider));
      }
    }
  }

  get keyVaultRef(): KeyVault { return this.keyVault; }
  get registryRef(): CapabilityRegistry { return this.registry; }
  get economicRef(): EconomicKernel { return this.economic; }

  async complete(prompt: string, ctx: CallContext): Promise<RouteResult> {
    const estInput = Math.ceil(prompt.length / 4);
    const estOutput = ctx.estimatedOutputTokens ?? 2000;

    const rl = this.rateLimiter.check(ctx.userId, estInput + estOutput);
    if (!rl.allowed) {
      this.rateLimiter.release(ctx.userId);
      return this.fail(rl.reason ?? 'rate limited', ctx);
    }

   const requireVision = !!ctx.images && ctx.images.length > 0;
   const requireTools = !!ctx.tools && ctx.tools.length > 0;
    const findOpts: { tier: ModelTier; requireVision: boolean; requireTools: boolean; requiredCapabilities?: readonly string[] } = {
      tier: ctx.tier, requireVision, requireTools,
    };
    if (ctx.requiredCapabilities !== undefined) findOpts.requiredCapabilities = ctx.requiredCapabilities;
    const candidates = this.registry.findModels(findOpts);

    const available: ModelBinding[] = [];
    for (const b of candidates) {
      if (!this.keyVault.hasProvider(b.provider)) continue;
      const breaker = this.breakers.get(b.provider);
      if (breaker && !breaker.canRequest()) continue;
      available.push(b);
    }

    if (available.length === 0) {
      this.rateLimiter.release(ctx.userId);
      return this.fail('No providers available', ctx);
    }

    const budget = this.economic.getBudget(ctx.taskId);
    const budgetRemaining = budget ? budget.total - budget.spent : undefined;
    const selected = this.selectModel(available, budgetRemaining, estInput, estOutput);
    const fallbackChain: string[] = [`${selected.provider}/${selected.model_id}`];
    const tried = new Set<string>();

    let current: ModelBinding | undefined = selected;
    while (current) {
      const key = `${current.provider}/${current.model_id}`;
      if (tried.has(key)) break;
      tried.add(key);

      const estCost = this.registry.estimateCost(current!, estInput, estOutput);
      if (budgetRemaining !== undefined && estCost > budgetRemaining) {
        const cheaper = available.filter(b =>
          !tried.has(`${b.provider}/${b.model_id}`) &&
          this.registry.estimateCost(b, estInput, estOutput) <= budgetRemaining,
        );
       if (cheaper.length > 0) {
          current = cheaper[0]!;
          fallbackChain.push(`${current!.provider}/${current!.model_id}`);
         continue;
        }
        this.rateLimiter.release(ctx.userId);
        return this.fail('Budget insufficient', ctx, fallbackChain);
      }

      const result = await this.callProvider(current!, prompt, ctx);
      if (result.usage.success) {
        this.rateLimiter.release(ctx.userId);
        const breaker = this.breakers.get(current.provider);
        if (breaker) breaker.recordSuccess();
        this.keyVault.markHealthy(current.provider, result.usage.provider);
        this.logUsage(result.usage);

        if (result.usage.cost_usd > 0) {
          this.economic.spend(ctx.taskId, result.usage.cost_usd, ctx.stepId, `model:${current.provider}/${current.model_id}`);
          this.economic.debitWallet(ctx.userId, result.usage.cost_usd);
        }

        return {
          ...result,
          fallback_triggered: fallbackChain.length > 1,
          fallback_chain: fallbackChain,
        };
      }

      const breaker = this.breakers.get(current.provider);
      if (breaker) breaker.recordFailure();

      const remaining = available.filter(b =>
        !tried.has(`${b.provider}/${b.model_id}`) &&
        this.keyVault.hasProvider(b.provider) &&
        this.breakers.get(b.provider)?.canRequest(),
      );
     if (remaining.length > 0) {
        current = remaining[0]!;
        fallbackChain.push(`${current!.provider}/${current!.model_id}`);
      } else {
        current = undefined;
      }
    }

    this.rateLimiter.release(ctx.userId);
    return this.fail('All providers failed', ctx, fallbackChain);
  }

  private selectModel(candidates: ModelBinding[], budgetRemaining: number | undefined, estInput: number, estOutput: number): ModelBinding {
    let best: ModelBinding | undefined;
    let bestScore = -1;
    for (const b of candidates) {
      const avgCap = Object.values(b.capabilities).reduce((s, v) => s + v, 0) / Math.max(Object.values(b.capabilities).length, 1);
      const cost = this.registry.estimateCost(b, estInput, estOutput);
      let score: number;
      if (budgetRemaining !== undefined && budgetRemaining > 0) {
        const pct = cost / budgetRemaining;
        if (pct > 0.5) score = avgCap * 0.1 * (budgetRemaining / (cost + 0.001));
        else if (pct < 0.1) score = avgCap;
        else score = avgCap * (1.0 - pct);
      } else {
        score = avgCap;
      }
      if (score > bestScore) { bestScore = score; best = b; }
    }
    return best ?? candidates[0]!;
  }

  private async callProvider(binding: ModelBinding, prompt: string, ctx: CallContext): Promise<RouteResult> {
    const t0 = performance.now();
    const apiKey = this.keyVault.getKey(binding.provider);
    if (!apiKey) {
      return this.fail(`No API key for ${binding.provider}`, ctx, [], binding.model_id, binding.provider);
    }

    const body = this.buildRequestBody(binding, prompt, ctx);
    const headers = this.buildHeaders(binding, apiKey);
    const endpoint = this.getEndpoint(binding);

    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90_000),
        });
       if (!resp.ok) {
         const errText = await resp.text().catch(() => '');
          // P1-09: 429 rate_limited must NOT be retried — retrying aggravates the throttle.
          // Return immediately so the caller can respect retry-after and re-queue.
          if (resp.status === 429) {
            return this.providerError(binding, `HTTP 429 rate limited (do not retry): ${errText.slice(0, 300)}`, t0);
          }
          if (resp.status < 500 && resp.status !== 429) {
            return this.providerError(binding, `HTTP ${resp.status}: ${errText.slice(0, 300)}`, t0);
          }
          if (attempt < maxRetries) {
            await sleep(2 ** attempt * 1000);
            continue;
          }
          return this.providerError(binding, `HTTP ${resp.status} after retries`, t0);
        }

        const raw = await resp.json() as Record<string, unknown>;
        const { text, usage } = this.parseResponse(binding, raw);
        const latencyMs = performance.now() - t0;
        const cost = usage.prompt_tokens / 1_000_000 * binding.price_input +
                     usage.completion_tokens / 1_000_000 * binding.price_output;

        const record: UsageRecord = {
          model_id: binding.model_id, provider: binding.provider,
          prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens,
          cost_usd: cost, latency_ms: latencyMs, timestamp: Date.now(), success: true,
        };

        return {
          response: text, usage: record,
          model_used: binding.model_id, provider_used: binding.provider,
          fallback_triggered: false, fallback_chain: [],
        };
      } catch (e) {
        if (attempt < maxRetries) {
          await sleep(2 ** attempt * 1000);
          continue;
        }
        return this.providerError(binding, (e as Error).message, t0);
      }
    }
    return this.providerError(binding, 'Max retries exceeded', t0);
  }

  private buildRequestBody(binding: ModelBinding, prompt: string, ctx: CallContext): Record<string, unknown> {
    const systemPrompt = ctx.systemPrompt ?? 'You are a precise agent execution engine. Return ONLY valid JSON.';
    const temperature = this.defaultTemperature;
    const maxTokens = this.defaultMaxTokens;

    if (binding.api_format === 'anthropic') {
      const content: unknown[] = [{ type: 'text', text: prompt }];
      if (ctx.images) {
        for (const img of ctx.images) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: img } });
      }
      const body: Record<string, unknown> = {
        model: binding.model_id,
        messages: [{ role: 'user', content }],
        max_tokens: maxTokens, temperature,
      };
      body['system'] = systemPrompt;
      if (ctx.tools) body['tools'] = ctx.tools;
      return body;
    }

    const messages: unknown[] = [{ role: 'system', content: systemPrompt }];
    if (ctx.images) {
      const content: unknown[] = [{ type: 'text', text: prompt }];
      for (const img of ctx.images) content.push({ type: 'image_url', image_url: { url: img, detail: 'auto' } });
      messages.push({ role: 'user', content });
    } else {
      messages.push({ role: 'user', content: prompt });
    }
    const body: Record<string, unknown> = {
      model: binding.model_id, messages, temperature, max_tokens: maxTokens,
    };
    if (ctx.tools) { body['tools'] = ctx.tools; body['tool_choice'] = 'auto'; }
    return body;
  }

  private buildHeaders(binding: ModelBinding, apiKey: string): Record<string, string> {
    if (binding.api_format === 'anthropic') {
      return { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    }
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  }

  private getEndpoint(binding: ModelBinding): string {
    return binding.api_format === 'anthropic'
      ? `${binding.api_base}/messages`
      : `${binding.api_base}/chat/completions`;
  }

  private parseResponse(binding: ModelBinding, raw: Record<string, unknown>): { text: string; usage: { prompt_tokens: number; completion_tokens: number } } {
    if (binding.api_format === 'anthropic') {
      const content = raw['content'] as Array<{ type: string; text?: string }> | undefined;
      let text = '';
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) text += block.text;
        }
      }
      const usage = raw['usage'] as Record<string, number> | undefined;
      return {
        text,
        usage: {
          prompt_tokens: usage?.['input_tokens'] ?? 0,
          completion_tokens: usage?.['output_tokens'] ?? 0,
        },
      };
    }
    const choices = raw['choices'] as Array<{ message: { content?: string; reasoning_content?: string } }> | undefined;
    const msg = choices?.[0]?.message;
    let text = msg?.content ?? '';
    if (!text && msg?.reasoning_content) {
      const match = msg.reasoning_content.match(/\{[^{}]*\}/);
      text = match ? match[0] : msg.reasoning_content.slice(0, 2000);
    }
    const usage = raw['usage'] as Record<string, number> | undefined;
    return {
      text,
      usage: {
        prompt_tokens: usage?.['prompt_tokens'] ?? 0,
        completion_tokens: usage?.['completion_tokens'] ?? 0,
      },
    };
  }

  private providerError(binding: ModelBinding, error: string, t0: number): RouteResult {
    const latency = performance.now() - t0;
    const record: UsageRecord = {
      model_id: binding.model_id, provider: binding.provider,
      prompt_tokens: 0, completion_tokens: 0, cost_usd: 0,
      latency_ms: latency, timestamp: Date.now(), success: false, error,
    };
    return {
      response: JSON.stringify({ error }), usage: record,
      model_used: binding.model_id, provider_used: binding.provider,
      fallback_triggered: false, fallback_chain: [],
    };
  }

  private fail(error: string, ctx: CallContext, chain: string[] = [], model = 'none', provider = 'none'): RouteResult {
    return {
      response: JSON.stringify({ error }),
      usage: { model_id: model, provider, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, latency_ms: 0, timestamp: Date.now(), success: false, error },
      model_used: model, provider_used: provider,
      fallback_triggered: chain.length > 1, fallback_chain: chain,
    };
  }

  private logUsage(record: UsageRecord): void {
    this.usageLog.push(record);
    if (this.usageLog.length > 10000) this.usageLog.splice(0, this.usageLog.length - 10000);
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
    return this.registry.listAll().map(b => ({
      model_id: b.model_id, provider: b.provider, tier: b.tier,
      capabilities: b.capabilities, price_input: b.price_input, price_output: b.price_output,
      max_context: b.max_context, supports_tools: b.supports_tools, supports_vision: b.supports_vision,
      has_api_key: this.keyVault.hasProvider(b.provider),
      circuit_breaker: this.breakers.get(b.provider)?.state ?? 'closed',
    }));
  }

  /** Adapt the gateway to the HarnessProvider interface for the Harness runtime. */
  toHarnessProvider(userId: string, taskId: string): {
    resolve: (messages: Array<{ role: string; content: string }>) => Promise<ModelTurn>;
  } {
    return {
      resolve: async (messages) => {
        const prompt = messages.map(m => `${m.role}: ${m.content}`).join('\n\n');
        const result = await this.complete(prompt, {
          userId, taskId, stepId: 'model', tier: 'work',
          requiredCapabilities: ['reasoning'],
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
        } catch { toolCalls = undefined; /* not JSON, plain text response */ }
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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
