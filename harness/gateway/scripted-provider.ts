import { createHash } from 'node:crypto';

import type { ProviderAdapter as ProviderAdapterContract } from '../contracts/index.js';
import type { ToolSpec as ContractToolSpec } from '../contracts/index.js';

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface Message {
  readonly role: 'assistant' | 'system' | 'tool' | 'user';
  content: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly ToolCall[];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface ParsedResponse {
  readonly content: string;
  readonly tool_calls?: readonly ToolCall[];
  readonly stop_reason?: 'content_filter' | 'length' | 'stop' | 'tool_use';
  readonly usage?: Usage;
  readonly model?: string;
}

export type ProviderTool = Pick<ContractToolSpec, 'name'> &
  Partial<Omit<ContractToolSpec, 'name'>>;

export interface ProviderRequest {
  readonly messages: readonly Message[];
  readonly tools?: readonly ProviderTool[];
  readonly model?: string;
  readonly temperature?: number;
  readonly max_tokens?: number;
}

export type HealthStatus = 'healthy' | 'degraded' | 'down';

export interface DataPolicyResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface ProviderError {
  readonly kind:
    | 'auth'
    | 'invalid_request'
    | 'rate_limited'
    | 'server'
    | 'timeout'
    | 'unknown';
  readonly retryable: boolean;
  readonly detail: string;
  readonly status?: number;
}

export type StreamEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'tool_call'; readonly tool_call: ToolCall }
  | {
      readonly type: 'message_stop';
      readonly stop_reason: ParsedResponse['stop_reason'];
      readonly usage?: Usage;
    };

export interface CallMetadata {
  readonly index: number;
  readonly timestamp: string;
  readonly messages: readonly Message[];
  readonly tools_requested: readonly string[];
  readonly response: ParsedResponse;
  readonly usage: Usage;
  readonly lookup_mode: 'map' | 'queue';
}

export class ProviderValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderValidationError';
  }
}

export class ProviderHttpError extends Error {
  readonly status: number;

  constructor(status: number, message = `Provider returned HTTP ${status}`) {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new RangeError('Provider HTTP status must be an integer from 100 through 599');
    }
    super(message);
    this.name = 'ProviderHttpError';
    this.status = status;
  }
}

export class ProviderTimeoutError extends Error {
  constructor(message = 'Provider request timed out') {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

export class ScriptedResponseExhaustedError extends Error {
  constructor(message = 'Scripted response queue exhausted: no response remains') {
    super(message);
    this.name = 'ScriptedResponseExhaustedError';
  }
}

export class ScriptedResponseMissingError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`Scripted response missing for input hash ${key}`);
    this.name = 'ScriptedResponseMissingError';
    this.key = key;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value: unknown, location = '$'): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ProviderValidationError(`${location} must contain only finite JSON numbers`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => cloneJson(entry, `${location}[${index}]`));
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneJson(entry, `${location}.${key}`)]),
    );
  }
  throw new ProviderValidationError(`${location} must be valid JSON data`);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function cloneAndFreeze<T>(value: T, location = '$'): T {
  return deepFreeze(cloneJson(value, location) as T);
}

function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[], location: string) {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    throw new ProviderValidationError(`${location} contains unknown field: ${unknown[0]}`);
  }
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProviderValidationError(`${location} must be a non-empty string`);
  }
  return value;
}

function normalizeUsage(raw: unknown, location = 'usage'): Usage {
  if (!isPlainRecord(raw)) throw new ProviderValidationError(`${location} must be an object`);
  assertKnownKeys(raw, ['input_tokens', 'output_tokens'], location);
  const inputTokens = raw.input_tokens;
  const outputTokens = raw.output_tokens;
  for (const [field, value] of [
    ['input_tokens', inputTokens],
    ['output_tokens', outputTokens],
  ] as const) {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new ProviderValidationError(`${location}.${field} must be a non-negative integer`);
    }
  }
  return deepFreeze({ input_tokens: inputTokens as number, output_tokens: outputTokens as number });
}

function normalizeToolCallValue(raw: unknown, location = 'tool_call'): ToolCall {
  if (!isPlainRecord(raw)) throw new ProviderValidationError(`${location} must be an object`);
  assertKnownKeys(raw, ['arguments', 'id', 'name'], location);
  const id = nonEmptyString(raw.id, `${location}.id`);
  const name = nonEmptyString(raw.name, `${location}.name`);
  if (!isPlainRecord(raw.arguments)) {
    throw new ProviderValidationError(`${location}.arguments must be an object`);
  }
  return deepFreeze({
    id,
    name,
    arguments: cloneAndFreeze(raw.arguments, `${location}.arguments`) as Readonly<
      Record<string, unknown>
    >,
  });
}

function normalizeMessage(raw: unknown, index: number): Message {
  const location = `messages[${index}]`;
  if (!isPlainRecord(raw)) throw new ProviderValidationError(`${location} must be an object`);
  assertKnownKeys(raw, ['content', 'role', 'tool_call_id', 'tool_calls'], location);
  if (
    typeof raw.role !== 'string' ||
    !['assistant', 'system', 'tool', 'user'].includes(raw.role)
  ) {
    throw new ProviderValidationError(`${location}.role is unsupported`);
  }
  if (typeof raw.content !== 'string') {
    throw new ProviderValidationError(`${location}.content must be a string`);
  }
  const normalized: {
    role: Message['role'];
    content: string;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
  } = { role: raw.role as Message['role'], content: raw.content };
  if (raw.tool_call_id !== undefined) {
    normalized.tool_call_id = nonEmptyString(raw.tool_call_id, `${location}.tool_call_id`);
  }
  if (raw.tool_calls !== undefined) {
    if (!Array.isArray(raw.tool_calls)) {
      throw new ProviderValidationError(`${location}.tool_calls must be an array`);
    }
    normalized.tool_calls = raw.tool_calls.map((entry, toolIndex) =>
      normalizeToolCallValue(entry, `${location}.tool_calls[${toolIndex}]`),
    );
  }
  return deepFreeze(normalized);
}

function normalizeMessages(raw: unknown): readonly Message[] {
  if (!Array.isArray(raw)) throw new ProviderValidationError('messages must be an array');
  return deepFreeze(raw.map((entry, index) => normalizeMessage(entry, index)));
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(',')}}`;
}

export function hashMessages(messages: readonly Message[]): string {
  const normalized = normalizeMessages(messages);
  const canonical = canonicalJson(cloneJson(normalized, 'messages'));
  return createHash('sha256').update(canonical).digest('hex');
}

export const scriptedProviderContract = deepFreeze({
  provider_type: 'scripted_test',
  normalize_request: true,
  parse_response: true,
  normalize_tool_call: true,
  stream_events: true,
  map_error: true,
  meter_usage: true,
  check_health: true,
  validate_data_policy: true,
} satisfies ProviderAdapterContract);

export interface ScriptedTestProviderOptions {
  readonly queue?: readonly ParsedResponse[];
  readonly map?: Readonly<Record<string, ParsedResponse>>;
  readonly dataPolicy?: DataPolicyResult;
  readonly model?: string;
  readonly now?: () => Date;
}

export class ScriptedTestProvider {
  readonly provider_type = 'scripted_test' as const;

  private readonly queue: ParsedResponse[];
  private readonly responsesByHash: ReadonlyMap<string, ParsedResponse>;
  private readonly dataPolicy: DataPolicyResult;
  private readonly model: string;
  private readonly now: () => Date;
  private readonly calls: CallMetadata[] = [];
  private callIndex = 0;

  constructor(options: ScriptedTestProviderOptions = {}) {
    this.model = nonEmptyString(options.model ?? 'scripted-test', 'model');
    this.now = options.now ?? (() => new Date());
    this.dataPolicy = this.normalizeDataPolicy(
      options.dataPolicy === undefined ? { allowed: true } : options.dataPolicy,
    );
    this.queue = (options.queue ?? []).map((entry) => this.parseResponse(entry));

    const mapEntries = Object.entries(options.map ?? {}).map(([key, entry]) => {
      if (!/^[0-9a-f]{64}$/u.test(key)) {
        throw new ProviderValidationError('response map keys must be lowercase SHA-256 hashes');
      }
      return [key, this.parseResponse(entry)] as const;
    });
    this.responsesByHash = new Map(mapEntries);
  }

  resolve(request: ProviderRequest): ParsedResponse {
    const normalizedRequest = this.normalizeRequest(request) as Readonly<{
      messages: readonly Message[];
      tools: readonly ProviderTool[];
    }>;
    const key = hashMessages(normalizedRequest.messages);
    let response: ParsedResponse | undefined;
    let lookupMode: 'map' | 'queue';

    if (this.responsesByHash.has(key)) {
      response = this.responsesByHash.get(key);
      lookupMode = 'map';
    } else if (this.queue.length > 0) {
      response = this.queue.shift();
      lookupMode = 'queue';
    } else if (this.responsesByHash.size > 0) {
      throw new ScriptedResponseMissingError(key);
    } else {
      throw new ScriptedResponseExhaustedError();
    }
    if (!response) throw new ScriptedResponseExhaustedError();

    const timestamp = this.now();
    if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
      throw new ProviderValidationError('clock must return a valid Date');
    }
    const usage = this.meterUsage(response);
    const metadata = deepFreeze({
      index: this.callIndex,
      timestamp: timestamp.toISOString(),
      messages: normalizedRequest.messages,
      tools_requested: deepFreeze(normalizedRequest.tools.map((tool) => tool.name)),
      response,
      usage,
      lookup_mode: lookupMode,
    } satisfies CallMetadata);
    this.callIndex += 1;
    this.calls.push(metadata);
    return response;
  }

  normalizeRequest(request: ProviderRequest): unknown {
    if (!isPlainRecord(request)) throw new ProviderValidationError('request must be an object');
    assertKnownKeys(
      request,
      ['max_tokens', 'messages', 'model', 'temperature', 'tools'],
      'request',
    );
    const messages = normalizeMessages(request.messages);
    if (request.tools !== undefined && !Array.isArray(request.tools)) {
      throw new ProviderValidationError('request.tools must be an array');
    }
    const tools = (request.tools ?? []).map((tool, index) => {
      if (!isPlainRecord(tool)) {
        throw new ProviderValidationError(`request.tools[${index}] must be an object`);
      }
      nonEmptyString(tool.name, `request.tools[${index}].name`);
      return cloneAndFreeze(tool, `request.tools[${index}]`) as ProviderTool;
    });
    const model = nonEmptyString(request.model ?? this.model, 'request.model');
    const temperature = request.temperature ?? 0;
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new ProviderValidationError('request.temperature must be between 0 and 2');
    }
    if (
      request.max_tokens !== undefined &&
      (!Number.isSafeInteger(request.max_tokens) || request.max_tokens <= 0)
    ) {
      throw new ProviderValidationError('request.max_tokens must be a positive integer');
    }

    return deepFreeze({
      model,
      messages,
      tools: deepFreeze(tools),
      temperature,
      max_tokens: request.max_tokens ?? null,
    });
  }

  parseResponse(raw: unknown): ParsedResponse {
    if (!isPlainRecord(raw)) throw new ProviderValidationError('response must be an object');
    assertKnownKeys(raw, ['content', 'model', 'stop_reason', 'tool_calls', 'usage'], 'response');
    if (typeof raw.content !== 'string') {
      throw new ProviderValidationError('response.content must be a string');
    }
    const stopReason = raw.stop_reason ?? 'stop';
    if (
      typeof stopReason !== 'string' ||
      !['content_filter', 'length', 'stop', 'tool_use'].includes(stopReason)
    ) {
      throw new ProviderValidationError('response.stop_reason is unsupported');
    }
    if (raw.tool_calls !== undefined && !Array.isArray(raw.tool_calls)) {
      throw new ProviderValidationError('response.tool_calls must be an array');
    }

    const normalized: {
      content: string;
      tool_calls?: ToolCall[];
      stop_reason: NonNullable<ParsedResponse['stop_reason']>;
      usage?: Usage;
      model: string;
    } = {
      content: raw.content,
      stop_reason: stopReason as NonNullable<ParsedResponse['stop_reason']>,
      model: nonEmptyString(raw.model ?? this.model, 'response.model'),
    };
    if (raw.tool_calls !== undefined) {
      normalized.tool_calls = raw.tool_calls.map((entry, index) =>
        normalizeToolCallValue(entry, `response.tool_calls[${index}]`),
      );
    }
    if (raw.usage !== undefined) normalized.usage = normalizeUsage(raw.usage);
    return deepFreeze(normalized);
  }

  normalizeToolCall(raw: unknown): ToolCall {
    return normalizeToolCallValue(raw);
  }

  async *streamEvents(request: ProviderRequest): AsyncIterable<StreamEvent> {
    const response = this.resolve(request);
    if (response.content.length > 0) yield { type: 'text_delta', text: response.content };
    for (const toolCall of response.tool_calls ?? []) {
      yield { type: 'tool_call', tool_call: toolCall };
    }
    yield {
      type: 'message_stop',
      stop_reason: response.stop_reason ?? 'stop',
      usage: this.meterUsage(response),
    };
  }

  mapError(raw: unknown): ProviderError {
    if (
      raw instanceof ProviderValidationError ||
      raw instanceof ScriptedResponseExhaustedError ||
      raw instanceof ScriptedResponseMissingError
    ) {
      return deepFreeze({ kind: 'invalid_request', retryable: false, detail: raw.message });
    }
    if (raw instanceof ProviderTimeoutError) {
      return deepFreeze({ kind: 'timeout', retryable: true, detail: 'Provider request timed out' });
    }
    if (raw instanceof ProviderHttpError) {
      const status = raw.status;
      if (status === 401 || status === 403) {
        return deepFreeze({
          kind: 'auth',
          retryable: false,
          detail: 'Provider authentication failed',
          status,
        });
      }
      if (status === 408) {
        return deepFreeze({
          kind: 'timeout',
          retryable: true,
          detail: 'Provider request timed out',
          status,
        });
      }
      if (status === 429) {
        return deepFreeze({
          kind: 'rate_limited',
          retryable: true,
          detail: 'Provider rate limit exceeded',
          status,
        });
      }
      if (status >= 500) {
        return deepFreeze({
          kind: 'server',
          retryable: true,
          detail: `Provider server error (${status})`,
          status,
        });
      }
      if (status >= 400) {
        return deepFreeze({
          kind: 'invalid_request',
          retryable: false,
          detail: `Provider rejected request (${status})`,
          status,
        });
      }
      return deepFreeze({
        kind: 'unknown',
        retryable: false,
        detail: `Unexpected provider HTTP status (${status})`,
        status,
      });
    }
    return deepFreeze({
      kind: 'unknown',
      retryable: false,
      detail: 'Unknown provider failure',
    });
  }

  meterUsage(response: ParsedResponse): Usage {
    return response.usage === undefined
      ? deepFreeze({ input_tokens: 0, output_tokens: 0 })
      : normalizeUsage(response.usage);
  }

  checkHealth(): HealthStatus {
    return 'healthy';
  }

  validateDataPolicy(_request: ProviderRequest): DataPolicyResult {
    return this.dataPolicy;
  }

  get callLog(): readonly CallMetadata[] {
    return deepFreeze([...this.calls]);
  }

  get callCount(): number {
    return this.calls.length;
  }

  get remainingQueueLength(): number {
    return this.queue.length;
  }

  private normalizeDataPolicy(raw: unknown): DataPolicyResult {
    if (!isPlainRecord(raw)) throw new ProviderValidationError('dataPolicy must be an object');
    assertKnownKeys(raw, ['allowed', 'reason'], 'dataPolicy');
    if (typeof raw.allowed !== 'boolean') {
      throw new ProviderValidationError('dataPolicy.allowed must be a boolean');
    }
    if (raw.reason !== undefined && typeof raw.reason !== 'string') {
      throw new ProviderValidationError('dataPolicy.reason must be a string');
    }
    return deepFreeze(
      raw.reason === undefined ? { allowed: raw.allowed } : { allowed: raw.allowed, reason: raw.reason },
    );
  }
}
