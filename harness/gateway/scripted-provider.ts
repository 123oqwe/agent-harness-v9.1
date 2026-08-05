/**
 * AH-GATEWAY-TESTPROVIDER-001: ScriptedTestProvider
 *
 * Deterministic, network-free test provider implementing the full
 * ProviderAdapter interface. Enables all Phase 1-4 tests to run without any
 * LLM API key. Zero network calls in any code path.
 *
 * Modes:
 *  - queue: responses returned in order, one per call; exhausted queue throws
 *  - map:   responses keyed by SHA-256 of the input messages (deterministic)
 */
import { createHash } from 'node:crypto';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ParsedResponse {
  content: string;
  tool_calls?: ToolCall[];
  stop_reason?: 'stop' | 'length' | 'tool_use' | 'content_filter';
  usage?: Usage;
  model?: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface ToolSpec {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface ProviderRequest {
  messages: Message[];
  tools?: ToolSpec[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

export type HealthStatus = 'healthy' | 'degraded' | 'down';

export interface DataPolicyResult {
  allowed: boolean;
  reason?: string;
}

export type ProviderError =
  | { kind: 'rate_limited'; retryable: boolean; detail: string }
  | { kind: 'auth'; retryable: boolean; detail: string }
  | { kind: 'invalid_request'; retryable: boolean; detail: string }
  | { kind: 'server'; retryable: boolean; detail: string }
  | { kind: 'timeout'; retryable: boolean; detail: string }
  | { kind: 'unknown'; retryable: boolean; detail: string };

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; tool_call: ToolCall }
  | { type: 'message_stop'; stop_reason: ParsedResponse['stop_reason']; usage?: Usage };

export interface CallMetadata {
  index: number;
  timestamp: string;
  messages: Message[];
  tools_requested: string[];
  response: ParsedResponse;
  usage: Usage;
  lookup_mode: 'queue' | 'map';
}

export interface ProviderAdapter {
  readonly provider_type: 'openai' | 'anthropic' | 'google' | 'local' | 'scripted_test';
  normalizeRequest(req: ProviderRequest): unknown;
  parseResponse(raw: unknown): ParsedResponse;
  normalizeToolCall(raw: unknown): ToolCall;
  streamEvents(req: ProviderRequest): AsyncIterable<StreamEvent>;
  mapError(raw: unknown): ProviderError;
  meterUsage(res: ParsedResponse): Usage;
  checkHealth(): HealthStatus;
  validateDataPolicy(req: ProviderRequest): DataPolicyResult;
}

/** Thrown when the scripted response queue runs out. Prevents silent passes. */
export class ScriptedResponseExhaustedError extends Error {
  constructor(message = 'Scripted response queue exhausted: no more responses queued.') {
    super(message);
    this.name = 'ScriptedResponseExhaustedError';
    Object.setPrototypeOf(this, ScriptedResponseExhaustedError.prototype);
  }
}

/** Thrown when a map lookup misses (no scripted response for that input hash). */
export class ScriptedResponseMissingError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`Scripted response missing for input hash ${key}`);
    this.name = 'ScriptedResponseMissingError';
    this.key = key;
    Object.setPrototypeOf(this, ScriptedResponseMissingError.prototype);
  }
}

function hashMessages(messages: Message[]): string {
  // Deterministic canonical JSON: stable key order, no whitespace.
  const canonical = JSON.stringify(messages, Object.keys(messages[0] ?? {}).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

function defaultUsage(res: ParsedResponse): Usage {
  const out = res.usage ?? { input_tokens: 0, output_tokens: 0 };
  // If output tokens unset, estimate from content length so metering is non-zero.
  if (out.output_tokens === 0 && res.content) {
    return { input_tokens: out.input_tokens, output_tokens: Math.ceil(res.content.length / 4) };
  }
  return out;
}

export interface ScriptedTestProviderOptions {
  queue?: ParsedResponse[];
  map?: Record<string, ParsedResponse>;
  health?: HealthStatus;
  dataPolicy?: DataPolicyResult;
  model?: string;
}

/**
 * Deterministic, network-free ProviderAdapter for testing.
 *
 * Lookup order per call:
 *   1. If a response map is provided AND the input hash is present -> use it.
 *   2. Else if a queue is provided -> shift the next response.
 *   3. Else throw ScriptedResponseExhaustedError / ScriptedResponseMissingError.
 */
export class ScriptedTestProvider implements ProviderAdapter {
  readonly provider_type = 'scripted_test' as const;

  private readonly queue: ParsedResponse[];
  private readonly map: Record<string, ParsedResponse>;
  private readonly health: HealthStatus;
  private readonly dataPolicy: DataPolicyResult;
  private readonly model: string;
  private readonly calls: CallMetadata[] = [];
  private callIndex = 0;

  constructor(opts: ScriptedTestProviderOptions = {}) {
    this.queue = opts.queue ? [...opts.queue] : [];
    this.map = opts.map ? { ...opts.map } : {};
    this.health = opts.health ?? 'healthy';
    this.dataPolicy = opts.dataPolicy ?? { allowed: true };
    this.model = opts.model ?? 'scripted-test';
  }

  /** Resolve the scripted response for a request (the core dispatch). */
  resolve(req: ProviderRequest): ParsedResponse {
    const key = hashMessages(req.messages);
    let response: ParsedResponse | undefined;
    let mode: 'queue' | 'map';

    if (Object.keys(this.map).length > 0 && key in this.map) {
      response = this.map[key];
      mode = 'map';
    } else if (this.queue.length > 0) {
      response = this.queue.shift();
      mode = 'queue';
    } else if (Object.keys(this.map).length > 0) {
      throw new ScriptedResponseMissingError(key);
    } else {
      throw new ScriptedResponseExhaustedError();
    }

    const usage = defaultUsage(response!);
    const meta: CallMetadata = {
      index: this.callIndex++,
      timestamp: new Date().toISOString(),
      messages: req.messages,
      tools_requested: (req.tools ?? []).map((t) => t.name),
      response: response!,
      usage,
      lookup_mode: mode,
    };
    this.calls.push(meta);
    return response!;
  }

  normalizeRequest(req: ProviderRequest): unknown {
    return {
      model: req.model ?? this.model,
      messages: req.messages,
      tools: req.tools ?? [],
      temperature: req.temperature ?? 0,
      max_tokens: req.max_tokens ?? null,
    };
  }

  parseResponse(raw: unknown): ParsedResponse {
    if (typeof raw !== 'object' || raw === null) {
      throw new TypeError('parseResponse expects an object');
    }
    const r = raw as Partial<ParsedResponse>;
    if (typeof r.content !== 'string') {
      throw new TypeError('parseResponse: content must be a string');
    }
    return {
      content: r.content,
      tool_calls: r.tool_calls,
      stop_reason: r.stop_reason ?? 'stop',
      usage: r.usage,
      model: r.model ?? this.model,
    };
  }

  normalizeToolCall(raw: unknown): ToolCall {
    if (typeof raw !== 'object' || raw === null) {
      throw new TypeError('normalizeToolCall expects an object');
    }
    const r = raw as Partial<ToolCall>;
    if (typeof r.name !== 'string' || typeof r.id !== 'string') {
      throw new TypeError('normalizeToolCall: id and name required');
    }
    return { id: r.id, name: r.name, arguments: r.arguments ?? {} };
  }

  async *streamEvents(req: ProviderRequest): AsyncIterable<StreamEvent> {
    const res = this.resolve(req);
    if (res.content) {
      yield { type: 'text_delta', text: res.content };
    }
    for (const tc of res.tool_calls ?? []) {
      yield { type: 'tool_call', tool_call: tc };
    }
    yield { type: 'message_stop', stop_reason: res.stop_reason ?? 'stop', usage: defaultUsage(res) };
  }

  mapError(raw: unknown): ProviderError {
    const msg = raw instanceof Error ? raw.message : String(raw);
    if (raw instanceof ScriptedResponseExhaustedError || raw instanceof ScriptedResponseMissingError) {
      return { kind: 'invalid_request', retryable: false, detail: msg };
    }
    const lower = msg.toLowerCase();
  // 429 must NOT be auto-retried with backoff — retrying aggravates the
  // throttle. Caller should respect retry-after and re-queue.
  if (lower.includes('rate')) return { kind: 'rate_limited', retryable: false, detail: msg };
    if (lower.includes('auth') || lower.includes('401') || lower.includes('key')) {
      return { kind: 'auth', retryable: false, detail: msg };
    }
    if (lower.includes('timeout')) return { kind: 'timeout', retryable: true, detail: msg };
    if (lower.includes('500') || lower.includes('server')) return { kind: 'server', retryable: true, detail: msg };
    if (lower.includes('400') || lower.includes('invalid')) {
      return { kind: 'invalid_request', retryable: false, detail: msg };
    }
    return { kind: 'unknown', retryable: false, detail: msg };
  }

  meterUsage(res: ParsedResponse): Usage {
    return defaultUsage(res);
  }

  checkHealth(): HealthStatus {
    // Always healthy without network -- by design.
    return this.health;
  }

  validateDataPolicy(_req: ProviderRequest): DataPolicyResult {
    // Scripted provider never transmits data; policy trivially satisfied.
    return this.dataPolicy;
  }

  get callLog(): readonly CallMetadata[] {
    return [...this.calls];
  }

  get callCount(): number {
    return this.calls.length;
  }

  get remainingQueueLength(): number {
    return this.queue.length;
  }
}

// ModelGateway has been consolidated into model-gateway.ts.
// This file only exports the ScriptedTestProvider and helpers.
// Tests should import ModelGateway from '../../gateway/model-gateway.js'.

export const __hashMessages = hashMessages;
