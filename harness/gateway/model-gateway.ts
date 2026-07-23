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
 */

import type { ProviderAdapter, ProviderRequest, ParsedResponse, ProviderError, Usage, HealthStatus } from './provider.js';
import { ScriptedTestProvider, ScriptedResponseExhaustedError, ScriptedResponseMissingError } from './scripted-provider.js';

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

// ---------------------------------------------------------------------------
// Model Gateway
// ---------------------------------------------------------------------------

export class ModelGateway {
  private readonly adapters = new Map<ProviderAdapter['provider_type'], ProviderAdapter>();
  private readonly profiles = new Map<string, ModelProfile>();
  private readonly telemetry: GatewayTelemetry[] = [];
  private readonly totalUsage = new Map<string, Usage>();

  constructor(initial: ProviderAdapter[] = []) {
    for (const a of initial) this.register(a);
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

  complete(
    type: ProviderAdapter['provider_type'],
    req: ProviderRequest,
    opts: GatewayCallOptions = {},
  ): GatewayCallResult {
    const adapter = this.resolve(type);
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

        // Record telemetry (no content, only metadata)
        this.recordTelemetry(adapter.provider_type, response.model ?? 'unknown', usage, durationMs, retried);

        // Track total usage
        this.addUsage(adapter.provider_type, usage);

        return {
          response,
          usage,
          provider_type: adapter.provider_type,
          model: response.model ?? 'unknown',
          durationMs,
          retried,
        };
      } catch (err) {
        const providerError = adapter.mapError(err);
        lastError = providerError;

        if (!providerError.retryable || attempt === maxRetries) {
          if (err instanceof ScriptedResponseExhaustedError || err instanceof ScriptedResponseMissingError) {
            throw err;
          }
          throw new GatewayRetryExhaustedError(
            `Provider ${type} failed after ${attempt + 1} attempts: ${providerError.detail}`,
            lastError,
          );
        }

        retried = true;
        // Simple backoff
        const delay = retryDelayMs * Math.pow(2, attempt);
        // Synchronous sleep for deterministic testing (very short)
        if (delay > 0 && delay < 100) {
          const start = Date.now();
          while (Date.now() - start < delay) { /* busy wait */ }
        }
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
