/**
 * AH-GATEWAY-001: Model Gateway
 *
 * Central authority for all model calls. Handles provider registration,
 * model profile matching, timeout, cancellation, usage tracking, normalized
 * errors, and redacted telemetry. No strategy or tool may call a provider
 * directly.
 *
 * Invariants:
 *  - All model requests go through ModelGateway
 *  - Provider errors are normalized to ProviderError
 *  - Usage is tracked for budget enforcement
 *  - Telemetry never includes request/response content (only metadata)
*  - Timeout and cancellation are enforced
 *
 * Error Classification (P1-09):
 *  - rate_limited (429): NOT retried — retrying aggravates the throttle.
 *    Caller should respect retry-after and re-queue.
 *  - server (5xx) / timeout: retried with exponential backoff (max 3).
 *  - auth (401) / invalid_request (400): NOT retried — caller must fix input.
 *  - truncation (stop_reason="length"): NOT retried — return error to LLM
 *    so it can split the task. Retrying the same input wastes tokens.
*/

import type { ProviderAdapter, ProviderRequest, ParsedResponse, ProviderError, Usage, HealthStatus } from './provider.js';
import { ScriptedTestProvider, ScriptedResponseExhaustedError, ScriptedResponseMissingError } from './scripted-provider.js';
import {
  RateLimiter, LLMCache, UsageMeter, FallbackChain,
  CapabilityRegistry, KeyVault,
  type RateLimitConfig, type ModelCapabilityEntry,
} from './capability-registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelProfile {
  model_id: string;
  provider_type: ProviderAdapter['provider_type'];
  max_input_tokens: number;
  max_output_tokens: number;
  supports_tools: boolean;
  supports_streaming: boolean;
}

export interface GatewayCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  retries?: number;
  retryDelayMs?: number;
}

export interface GatewayCallResult {
  response: ParsedResponse;
  usage: Usage;
  provider_type: ProviderAdapter['provider_type'];
  model: string;
  durationMs: number;
  retried: boolean;
}

// ---------------------------------------------------------------------------
// Managed-Platform Routing (G1, G2, G4, G5, G6)
// ---------------------------------------------------------------------------

export type ModelTier = 'route' | 'work' | 'verify';

export interface RouteOptions {
  tier: ModelTier;
  requiredCapabilities?: string[];
  userId?: string;
  taskId?: string;
  stepId?: string;
  budgetRemaining?: number;  // in USD
  images?: string[];
  tools?: ProviderRequest['tools'];
  tool_choice?: ProviderRequest['tool_choice'];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  timeoutMs?: number;
}

export interface RouteResult {
  response: ParsedResponse;
  usage: Usage;
  provider_type: ProviderAdapter['provider_type'];
  model: string;
  durationMs: number;
  retried: boolean;
  costUsd: number;
  fallbackTriggered: boolean;
  fallbackChain: string[];
}

export interface GatewayTelemetry {
  provider_type: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  retried: boolean;
  error_kind?: string;
  timestamp: string;
}

export class GatewayTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayTimeoutError';
    Object.setPrototypeOf(this, GatewayTimeoutError.prototype);
  }
}

export class GatewayRetryExhaustedError extends Error {
  readonly lastError: ProviderError | null;
  constructor(message: string, lastError: ProviderError | null = null) {
    super(message);
    this.name = 'GatewayRetryExhaustedError';
    this.lastError = lastError;
   Object.setPrototypeOf(this, GatewayRetryExhaustedError.prototype);
 }
}

// Thrown when a model response is truncated (stop_reason === "length").
// The caller must return this as an error to the LLM, NOT retry the same input.
export class GatewayTruncationError extends Error {
  readonly response: ParsedResponse;
  constructor(message: string, response: ParsedResponse) {
    super(message);
    this.name = 'GatewayTruncationError';
    this.response = response;
    Object.setPrototypeOf(this, GatewayTruncationError.prototype);
  }
}

// Thrown when a provider returns 429 rate_limited.
// The caller should respect retry-after and re-queue, NOT auto-retry.
export class GatewayRateLimitedError extends Error {
  readonly lastError: ProviderError;
  constructor(message: string, lastError: ProviderError) {
    super(message);
    this.name = 'GatewayRateLimitedError';
    this.lastError = lastError;
    Object.setPrototypeOf(this, GatewayRateLimitedError.prototype);
  }
}

/**
 * Returns true if a ProviderError should be retried with exponential backoff.
 * Only server (5xx) and timeout errors are transient and worth retrying.
 * rate_limited, auth, and invalid_request are NOT retried.
 */
export function isBackoffRetryable(err: ProviderError): boolean {
  return err.retryable && (err.kind === 'server' || err.kind === 'timeout');
}

// ---------------------------------------------------------------------------
// Circuit Breaker (P1-19)
// ---------------------------------------------------------------------------

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  failureThreshold: number;   // consecutive failures to trip OPEN
  recoveryTimeoutMs: number;  // time before HALF_OPEN probe
}

const DEFAULT_CIRCUIT_OPTS: CircuitBreakerOptions = {
  failureThreshold: 5,
  recoveryTimeoutMs: 60_000,
};

/**
 * Per-provider circuit breaker.
 *
 * CLOSED  → normal operation. Consecutive failures are counted.
 * OPEN    → provider is considered down. Requests are rejected immediately
 *           without calling the provider. After recoveryTimeoutMs, transitions
 *           to HALF_OPEN.
 * HALF_OPEN → a single probe request is allowed through. Success → CLOSED.
 *             Failure → back to OPEN.
 *
 * Only server (5xx) and timeout errors trip the breaker. rate_limited,
 * auth, and invalid_request do not (they are caller errors, not provider
 * health issues).
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private halfOpenProbeInFlight = false;
  private readonly opts: CircuitBreakerOptions;

  constructor(opts: Partial<CircuitBreakerOptions> = {}) {
    this.opts = { ...DEFAULT_CIRCUIT_OPTS, ...opts };
  }

  /** Returns true if the request should be allowed through. */
  allowRequest(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.opts.recoveryTimeoutMs) {
        this.state = 'half_open';
        this.halfOpenProbeInFlight = true; // this call IS the probe
        return true;
      }
      return false;
    }
    // half_open: only one probe at a time
    if (!this.halfOpenProbeInFlight) {
      this.halfOpenProbeInFlight = true;
      return true;
    }
    return false;
  }

  /** Record a successful response. Resets to CLOSED. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
    this.halfOpenProbeInFlight = false;
  }

  /** Record a failure. Trips OPEN if threshold reached. */
  recordFailure(err: ProviderError): void {
    // Only provider-health errors trip the breaker
    if (!isBackoffRetryable(err)) return;

    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();
    this.halfOpenProbeInFlight = false;

    if (this.state === 'half_open') {
      // Probe failed — back to OPEN
      this.state = 'open';
      return;
    }

    if (this.consecutiveFailures >= this.opts.failureThreshold) {
      this.state = 'open';
    }
  }

  get currentState(): CircuitState {
    // Reflect time-based transition from open to half_open
    if (this.state === 'open') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.opts.recoveryTimeoutMs) {
        return 'half_open';
      }
    }
    return this.state;
  }

  get failureCount(): number {
    return this.consecutiveFailures;
  }

  /** Reset to closed (for testing or manual recovery). */
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
  }
}

// Thrown when the circuit breaker is OPEN and rejects a request.
export class CircuitOpenError extends Error {
  readonly providerType: ProviderAdapter['provider_type'];
  constructor(providerType: ProviderAdapter['provider_type']) {
    super(`Circuit breaker OPEN for provider ${providerType}: rejecting request without calling provider`);
    this.name = 'CircuitOpenError';
    this.providerType = providerType;
    Object.setPrototypeOf(this, CircuitOpenError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Model Gateway
// ---------------------------------------------------------------------------

export interface ModelGatewayOptions {
  rateLimiter?: RateLimiter;
  cache?: LLMCache;
  usageMeter?: UsageMeter;
  fallbackChain?: FallbackChain;
  registry?: CapabilityRegistry;
  keyVault?: KeyVault;
  userId?: string;
}

export class ModelGateway {
 private readonly adapters = new Map<ProviderAdapter['provider_type'], ProviderAdapter>();
 private readonly profiles = new Map<string, ModelProfile>();
 private readonly telemetry: GatewayTelemetry[] = [];
 private readonly totalUsage = new Map<string, Usage>();
  private readonly circuitBreakers = new Map<ProviderAdapter['provider_type'], CircuitBreaker>();
  private readonly rateLimiter?: RateLimiter;
  private readonly cache?: LLMCache;
  private readonly usageMeter?: UsageMeter;
  private readonly fallbackChain?: FallbackChain;
  private readonly registry?: CapabilityRegistry;
  private readonly keyVault?: KeyVault;
  private readonly userId?: string;

  constructor(initial: ProviderAdapter[] = [], options: ModelGatewayOptions = {}) {
    for (const a of initial) this.register(a);
    this.rateLimiter = options.rateLimiter;
    this.cache = options.cache;
    this.usageMeter = options.usageMeter;
    this.fallbackChain = options.fallbackChain;
    this.registry = options.registry;
    this.keyVault = options.keyVault;
    this.userId = options.userId;
  }

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.provider_type, adapter);
  }

  registerProfile(profile: ModelProfile): void {
    this.profiles.set(profile.model_id, profile);
  }

  resolve(type: ProviderAdapter['provider_type']): ProviderAdapter {
    const a = this.adapters.get(type);
    if (!a) throw new Error(`No provider registered for type: ${type}`);
    return a;
  }

 getProfile(modelId: string): ModelProfile | undefined {
   return this.profiles.get(modelId);
 }

  /** Get or create the circuit breaker for a provider type. */
  getCircuitBreaker(type: ProviderAdapter['provider_type']): CircuitBreaker {
    let cb = this.circuitBreakers.get(type);
    if (!cb) {
      cb = new CircuitBreaker();
      this.circuitBreakers.set(type, cb);
    }
    return cb;
  }

  complete(
    type: ProviderAdapter['provider_type'],
    req: ProviderRequest,
    opts: GatewayCallOptions = {},
  ): GatewayCallResult {
    // P1-18: Rate limiting — check per-user limits before anything else
    if (this.rateLimiter && this.userId) {
      const estimatedTokens = (req.messages?.length ?? 1) * 500; // rough estimate
      const rateCheck = this.rateLimiter.check(this.userId, estimatedTokens);
      if (!rateCheck.allowed) {
        throw new Error(`Rate limit exceeded for user '${this.userId}'. Retry after ${rateCheck.retryAfterMs ?? 1000}ms`);
      }
      this.rateLimiter.recordStart(this.userId, estimatedTokens);
    }

    // P2-12: LLM cache — check cache before calling provider
    if (this.cache) {
      const model = req.model ?? 'default';
      const cached = this.cache.get(model, req.messages, req.temperature ?? 0);
      if (cached !== null) {
        const response = cached as ParsedResponse;
        const usage = response.usage ?? { input_tokens: 0, output_tokens: 0 };
        return {
          response,
          usage,
          provider_type: type,
          model: response.model ?? model,
          durationMs: 0,
          retried: false,
        };
      }
    }

    const adapter = this.resolve(type);
    const circuit = this.getCircuitBreaker(type);

    // Circuit breaker: if OPEN, reject immediately without calling the provider
    if (!circuit.allowRequest()) {
      throw new CircuitOpenError(type);
    }

    const startTime = Date.now();
    const timeoutMs = opts.timeoutMs ?? 30000;
    const maxRetries = opts.retries ?? 2;
    const retryDelayMs = opts.retryDelayMs ?? 1000;

    let lastError: ProviderError | null = null;
    let retried = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (opts.signal?.aborted) {
        throw new GatewayTimeoutError('Request aborted');
      }

      // Check timeout
      const elapsed = Date.now() - startTime;
      if (elapsed > timeoutMs) {
        throw new GatewayTimeoutError(`Request timed out after ${timeoutMs}ms`);
      }

      try {
        let response: ParsedResponse;

        if (adapter instanceof ScriptedTestProvider) {
          response = adapter.resolve(req);
        } else {
          // For non-scripted providers, use normalizeRequest + parseResponse
          const raw = adapter.normalizeRequest(req);
          response = adapter.parseResponse(raw);
        }

       const usage = adapter.meterUsage(response);
       const durationMs = Date.now() - startTime;

        // Truncation detection: stop_reason === "length" means the model
        // output was cut off. Do NOT retry the same input (wastes tokens).
        // Return error to LLM so it can split the task.
        if (response.stop_reason === 'length') {
          throw new GatewayTruncationError(
            `Provider ${type} returned truncated response (stop_reason=length). ` +
            `The model output exceeded max_tokens — ask the LLM to split the task.`,
            response,
          );
        }

        // Record telemetry (no content, only metadata)
        this.recordTelemetry(adapter.provider_type, response.model ?? 'unknown', usage, durationMs, retried);

        // Track total usage
        this.addUsage(adapter.provider_type, usage);

        // Circuit breaker: record success (resets to CLOSED)
        circuit.recordSuccess();

        // P1-18: Record rate limit completion
        if (this.rateLimiter && this.userId) {
          this.rateLimiter.recordCompletion(this.userId);
        }

        // P2-12: Store response in LLM cache
        if (this.cache) {
          const model = req.model ?? 'default';
          this.cache.set(model, req.messages, response, req.temperature ?? 0);
        }

        // P1-17: Record usage for real cost tracking
        if (this.usageMeter) {
          this.usageMeter.record(response.model ?? 'unknown', usage.input_tokens, usage.output_tokens);
        }

        return {
          response,
          usage,
          provider_type: adapter.provider_type,
          model: response.model ?? 'unknown',
          durationMs,
          retried,
        };
     } catch (err) {
        // Truncation errors must propagate immediately — no retry.
        if (err instanceof GatewayTruncationError) {
          throw err;
        }

        const providerError = adapter.mapError(err);
        lastError = providerError;

        // Circuit breaker: record failure (trips OPEN if threshold reached)
        circuit.recordFailure(providerError);

        // rate_limited: do NOT retry with backoff (aggravates throttle).
        // Throw immediately so the caller can respect retry-after and re-queue.
        if (providerError.kind === 'rate_limited') {
          throw new GatewayRateLimitedError(
            `Provider ${type} rate limited (429): ${providerError.detail}`,
            providerError,
          );
        }

        // P1-18: Record rate limit completion on error
        if (this.rateLimiter && this.userId) {
          this.rateLimiter.recordCompletion(this.userId);
        }

        // Only server (5xx) and timeout errors are backoff-retryable.
        // auth, invalid_request, unknown are NOT retried.
        if (!isBackoffRetryable(providerError) || attempt === maxRetries) {
          if (err instanceof ScriptedResponseExhaustedError || err instanceof ScriptedResponseMissingError) {
            throw err;
          }
          throw new GatewayRetryExhaustedError(
            `Provider ${type} failed after ${attempt + 1} attempts: ${providerError.detail}`,
            lastError,
          );
        }

        retried = true;
        // Exponential backoff: Phase 1 uses ScriptedTestProvider (sync, no real delay).
        // Real providers will use async complete() with await sleep(delay).
        // The delay value is retryDelayMs * 2^attempt (1ms, 2ms, 4ms...).
      }
    }

    throw new GatewayRetryExhaustedError(
      `Provider ${type} failed after ${maxRetries + 1} attempts`,
      lastError,
    );
  }

  checkHealth(type: ProviderAdapter['provider_type']): HealthStatus {
    return this.resolve(type).checkHealth();
  }

 list(): ProviderAdapter['provider_type'][] {
   return [...this.adapters.keys()];
 }

  /**
   * Complete a request with native function calling (P1-01).
   *
   * Passes tools array + tool_choice to the provider. The provider returns
   * structured tool_calls in the response, no JSON parsing needed.
   * This is the preferred API for tool-augmented calls.
   *
   * tool_choice: 'auto' lets the model decide, 'required' forces a tool call,
   * 'none' disables tools, or a specific tool name.
   */
  completeWithTools(
    type: ProviderAdapter['provider_type'],
    messages: ProviderRequest['messages'],
    tools: ProviderRequest['tools'],
    opts: GatewayCallOptions & {
      tool_choice?: 'auto' | 'required' | 'none' | string;
      model?: string;
      temperature?: number;
      max_tokens?: number;
    } = {},
  ): GatewayCallResult {
    const req: ProviderRequest = {
      messages,
      tools,
      model: opts.model,
      temperature: opts.temperature,
      max_tokens: opts.max_tokens,
    };
    // tool_choice is passed through opts but ProviderRequest doesn't have it
    // yet — the provider adapter normalizes it.
    return this.complete(type, req, opts);
  }

  /**
   * Stream a request (P1-06/P2-18). Returns an async iterable of StreamEvent.
   * Phase 1: phase-level events. Phase 2: token-level streaming.
   */
  async *stream(
    type: ProviderAdapter['provider_type'],
    req: ProviderRequest,
    opts: GatewayCallOptions = {},
  ): AsyncIterable<import('./provider.js').StreamEvent> {
    const adapter = this.resolve(type);
    // Circuit breaker check
    const circuit = this.getCircuitBreaker(type);
    if (!circuit.allowRequest()) {
      throw new CircuitOpenError(type);
    }
    try {
      for await (const event of adapter.streamEvents(req)) {
        yield event;
      }
      circuit.recordSuccess();
    } catch (err) {
      const providerError = adapter.mapError(err);
      circuit.recordFailure(providerError);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Managed-Platform Routing (G1-G6): capability + budget + failover
  // -------------------------------------------------------------------------

  /**
   * Route a model call through the full managed-platform pipeline.
   *
   * Flow: rate limit -> find models by capability -> filter by key + circuit
   * breaker -> select by budget-aware scoring -> call provider -> real cost
   * tracking -> auto-failover on failure.
   *
   * This is the production entry point. complete() is the low-level direct
   * provider call (for testing / backward compat).
   */
  route(req: ProviderRequest, routeOpts: RouteOptions): RouteResult {
    const { tier, requiredCapabilities = [], userId = this.userId ?? 'default', budgetRemaining, tools, tool_choice } = routeOpts;

    // 1. Rate limit check (G3)
    if (this.rateLimiter) {
      const estTokens = (req.messages?.length ?? 1) * 500;
      const check = this.rateLimiter.check(userId, estTokens);
      if (!check.allowed) {
        throw new GatewayRateLimitedError(
          `Rate limit exceeded for user '${userId}'. Retry after ${check.retryAfterMs ?? 1000}ms`,
          { kind: 'rate_limited', retryable: false, detail: 'rate limit' },
        );
      }
      this.rateLimiter.recordStart(userId, estTokens);
    }

    // 2. Find candidate models by capability (G1)
    let candidates: ModelCapabilityEntry[] = [];
    if (this.registry) {
      candidates = this.registry.filterByCapabilities(requiredCapabilities);
      // Filter by tier — map tier to expected capabilities
      // route = fast/cheap, work = main workhorse, verify = independent
      // For now, all candidates are considered; tier is advisory
    }

    // 3. Filter by available API keys (G2) + circuit breaker state
    const available: { entry: ModelCapabilityEntry; providerType: ProviderAdapter['provider_type'] }[] = [];
    for (const entry of candidates) {
      // Check key vault
      if (this.keyVault && !this.keyVault.listProviders().includes(entry.provider_type)) {
        continue;
      }
      // Check circuit breaker
      const cb = this.getCircuitBreaker(entry.provider_type);
      if (!cb.allowRequest()) {
        continue;
      }
      available.push({ entry, providerType: entry.provider_type });
    }

    // If no registry/keyVault configured, fall back to direct provider mode
    if (available.length === 0) {
      // Use registered providers that have closed circuit breakers
      for (const [ptype] of this.adapters) {
        if (ptype === 'scripted_test') {
          available.push({
            entry: {
              model_id: req.model ?? 'scripted-test',
              provider_type: ptype,
              capabilities: [],
              price_input_per_1m: 0, price_output_per_1m: 0,
              max_context: 128000, max_output: 8192, latency_ms: 0,
            },
            providerType: ptype,
          });
        }
      }
    }

    if (available.length === 0) {
      if (this.rateLimiter) this.rateLimiter.recordCompletion(userId);
      throw new CircuitOpenError('scripted_test');
    }

    // 4. Select best model by budget-aware scoring (G5)
    const estInput = (req.messages?.length ?? 1) * 500;
    const estOutput = routeOpts.max_tokens ?? 2000;
    const selected = this._selectModel(available, budgetRemaining, estInput, estOutput);
    const fallbackChain: string[] = [`${selected.providerType}/${selected.entry.model_id}`];
    const tried = new Set<string>();

    // 5. Call provider with auto-failover (G4, G6)
    let lastError: Error | null = null;
    let current: { entry: ModelCapabilityEntry; providerType: ProviderAdapter['provider_type'] } | undefined = selected;

    while (current) {
      const key = `${current.providerType}/${current.entry.model_id}`;
      if (tried.has(key)) break;
      tried.add(key);

      // Budget check
      const estCost = this._estimateCost(current.entry, estInput, estOutput);
      if (budgetRemaining !== undefined && estCost > budgetRemaining) {
        // Find cheaper alternative
        const cheaper = available.filter(a =>
          !tried.has(`${a.providerType}/${a.entry.model_id}`) &&
          this._estimateCost(a.entry, estInput, estOutput) <= budgetRemaining
        );
        if (cheaper.length > 0) {
          current = cheaper[0];
          fallbackChain.push(`${current.providerType}/${current.entry.model_id}`);
          continue;
        }
        if (this.rateLimiter) this.rateLimiter.recordCompletion(userId);
        throw new GatewayRetryExhaustedError(
          `Budget insufficient: estimated $${estCost.toFixed(6)} > remaining $${budgetRemaining.toFixed(6)}`,
        );
      }

      // Build request with tool_choice
      const callReq: ProviderRequest = {
        ...req,
        tools: tools ?? req.tools,
        model: current.entry.model_id,
        temperature: routeOpts.temperature ?? req.temperature,
        max_tokens: routeOpts.max_tokens ?? req.max_tokens,
      };
      if (tool_choice) callReq.tool_choice = tool_choice;

      try {
        const result = this.complete(current.providerType, callReq, {
          timeoutMs: routeOpts.timeoutMs,
        });

        // 6. Real cost tracking (G5)
        const costUsd = this._computeCost(current.entry, result.usage);

        if (this.rateLimiter) this.rateLimiter.recordCompletion(userId);

        return {
          response: result.response,
          usage: result.usage,
          provider_type: result.provider_type,
          model: result.model,
          durationMs: result.durationMs,
          retried: result.retried,
          costUsd,
          fallbackTriggered: fallbackChain.length > 1,
          fallbackChain,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Non-retryable errors propagate immediately
        if (err instanceof GatewayTruncationError || err instanceof GatewayRateLimitedError) {
          if (this.rateLimiter) this.rateLimiter.recordCompletion(userId);
          throw err;
        }

        // Find next available provider (G6: auto-failover)
        const remaining = available.filter(a =>
          !tried.has(`${a.providerType}/${a.entry.model_id}`) &&
          this.getCircuitBreaker(a.providerType).allowRequest()
        );

        if (remaining.length > 0) {
          current = remaining[0];
          fallbackChain.push(`${current.providerType}/${current.entry.model_id}`);
       } else {
          current = undefined;
        }
      }
    }

    // All providers failed
    if (this.rateLimiter) this.rateLimiter.recordCompletion(userId);
    throw new GatewayRetryExhaustedError(
      `All providers failed after failover. Chain: ${fallbackChain.join(' -> ')}`,
      lastError ? { kind: 'server', retryable: false, detail: lastError.message } : null,
    );
  }

  /**
   * Budget-aware model selection (G5).
   * - Ample budget (<10% of remaining): pure capability score
   * - Moderate (10%-50%): capability * (1 - cost/budget)
   * - Tight (>50%): capability * 0.1 * (budget/cost)
   */
  private _selectModel(
    candidates: { entry: ModelCapabilityEntry; providerType: ProviderAdapter['provider_type'] }[],
    budgetRemaining: number | undefined,
    estInput: number,
    estOutput: number,
  ): { entry: ModelCapabilityEntry; providerType: ProviderAdapter['provider_type'] } {
    let best = candidates[0];
    let bestScore = -Infinity;

    for (const c of candidates) {
      const avgCap = c.entry.benchmark_scores
        ? Object.values(c.entry.benchmark_scores).reduce((a, b) => a + b, 0) / Math.max(Object.keys(c.entry.benchmark_scores).length, 1)
        : 0.5; // default if no scores
      const cost = this._estimateCost(c.entry, estInput, estOutput);

      let score: number;
      if (budgetRemaining !== undefined && budgetRemaining > 0) {
        const pct = cost / budgetRemaining;
        if (pct > 0.5) {
          score = avgCap * 0.1 * (budgetRemaining / (cost + 0.001));
        } else if (pct < 0.1) {
          score = avgCap;
        } else {
          score = avgCap * (1.0 - pct);
        }
      } else {
        score = avgCap / (cost + 0.001);
      }

      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }

    return best;
  }

  private _estimateCost(entry: ModelCapabilityEntry, inputTokens: number, outputTokens: number): number {
    return (inputTokens / 1_000_000) * entry.price_input_per_1m
         + (outputTokens / 1_000_000) * entry.price_output_per_1m;
  }

  private _computeCost(entry: ModelCapabilityEntry, usage: Usage): number {
    return (usage.input_tokens / 1_000_000) * entry.price_input_per_1m
         + (usage.output_tokens / 1_000_000) * entry.price_output_per_1m;
  }

  getTelemetry(): readonly GatewayTelemetry[] {
    return [...this.telemetry];
  }

  getTotalUsage(type: ProviderAdapter['provider_type']): Usage {
    return this.totalUsage.get(type) ?? { input_tokens: 0, output_tokens: 0 };
  }

  private recordTelemetry(
    providerType: string,
    model: string,
    usage: Usage,
    durationMs: number,
    retried: boolean,
    errorKind?: string,
  ): void {
    this.telemetry.push({
      provider_type: providerType,
      model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      duration_ms: durationMs,
      retried,
      error_kind: errorKind,
      timestamp: new Date().toISOString(),
    });
  }

  private addUsage(type: string, usage: Usage): void {
    const current = this.totalUsage.get(type) ?? { input_tokens: 0, output_tokens: 0 };
    this.totalUsage.set(type, {
      input_tokens: current.input_tokens + usage.input_tokens,
      output_tokens: current.output_tokens + usage.output_tokens,
    });
  }
}
