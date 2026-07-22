/**
 * GLM Provider Adapter — real LLM calls via Zhipu (BigModel) OpenAI-compatible API.
 *
 * Implements the full GatewayProviderRuntime interface so it can be registered
 * into ModelGateway alongside ScriptedTestProvider. Credentials are read from
 * env ONLY (GLM_API_KEY, GLM_MODEL, GLM_REASONING_EFFORT) — never from args,
 * never printed, never stored.
 */
import type {
  ProviderRequest, ParsedResponse, ToolCall, Usage,
  HealthStatus, DataPolicyResult, ProviderError, StreamEvent,
} from './scripted-provider.js';

export class GlmProviderError extends Error {
  constructor(message: string) { super(message); this.name = 'GlmProviderError'; Object.setPrototypeOf(this, GlmProviderError.prototype); }
}

export class GlmProvider {
  readonly provider_type = 'openai' as const; // Zhipu API is OpenAI-compatible
  private readonly apiKey: string;
  private readonly model: string;
  private readonly reasoningEffort: string;
  private readonly endpoint = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

  constructor() {
    this.apiKey = process.env.GLM_API_KEY ?? '';
    this.model = process.env.GLM_MODEL ?? 'glm-4-plus';
    this.reasoningEffort = process.env.GLM_REASONING_EFFORT ?? 'xhigh';
    if (!this.apiKey) throw new GlmProviderError('GLM_API_KEY not set in env');
  }

  normalizeRequest(req: ProviderRequest): unknown {
    return {
      model: this.model,
      reasoning_effort: this.reasoningEffort,
      messages: req.messages.map(m => ({ role: m.role, content: m.content })),
      temperature: req.temperature ?? 0.1,
      max_tokens: req.max_tokens ?? 4096,
      ...(req.tools && req.tools.length > 0 ? { tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: '', parameters: {} } })) } : {}),
    };
  }

  parseResponse(raw: unknown): ParsedResponse {
    const data = raw as { choices?: Array<{ message: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }>; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; model?: string };
    const choice = data.choices?.[0];
    if (!choice) throw new GlmProviderError('GLM returned no choices');
    const tool_calls = choice.message.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}'),
    }));
    const stop_reason = (choice.finish_reason === 'stop' ? 'stop' : choice.finish_reason === 'length' ? 'length' : choice.finish_reason === 'tool_calls' ? 'tool_use' : 'stop') as 'stop' | 'length' | 'tool_use' | 'content_filter';
    const usage = data.usage ? { input_tokens: data.usage.prompt_tokens, output_tokens: data.usage.completion_tokens } : { input_tokens: 0, output_tokens: 0 };
    return {
      content: choice.message.content ?? '',
      ...(tool_calls && tool_calls.length > 0 ? { tool_calls } : {}),
      stop_reason,
      usage,
      model: data.model ?? this.model,
    } as ParsedResponse;
  }

  normalizeToolCall(raw: unknown): ToolCall {
    if (typeof raw !== 'object' || raw === null) throw new GlmProviderError('invalid tool call');
    const tc = raw as { id?: string; function?: { name?: string; arguments?: string } };
    if (!tc.id || !tc.function?.name) throw new GlmProviderError('tool call missing id or name');
    return { id: tc.id, name: tc.function.name, arguments: tc.function.arguments ? JSON.parse(tc.function.arguments) : {} };
  }

  async *streamEvents(_req: ProviderRequest): AsyncIterable<StreamEvent> {
    // Phase 1: no streaming; single response. Yield message_stop at the end.
    const res = await this.resolve(_req);
    if (res.content) yield { type: 'text_delta', text: res.content };
    for (const tc of res.tool_calls ?? []) yield { type: 'tool_call', tool_call: tc };
    const stopEv: { type: "message_stop"; stop_reason: NonNullable<typeof res.stop_reason> } & { usage?: Usage } = { type: "message_stop", stop_reason: res.stop_reason ?? "stop" };
    if (res.usage) stopEv.usage = res.usage;
    yield stopEv;
  }

  mapError(raw: unknown): ProviderError {
    if (raw instanceof Error) {
      const msg = raw.message;
      if (/401|auth|unauthorized/i.test(msg)) return { kind: 'auth', retryable: false, detail: msg };
      if (/429|rate/i.test(msg)) return { kind: 'rate_limited', retryable: true, detail: msg };
      if (/timeout|timed out/i.test(msg)) return { kind: 'timeout', retryable: true, detail: msg };
      if (/500|502|503|504|server/i.test(msg)) return { kind: 'server', retryable: true, detail: msg };
      if (/400|invalid/i.test(msg)) return { kind: 'invalid_request', retryable: false, detail: msg };
      return { kind: 'unknown', retryable: false, detail: msg };
    }
    return { kind: 'unknown', retryable: false, detail: String(raw) };
  }

  meterUsage(res: ParsedResponse): Usage {
    return res.usage ?? { input_tokens: 0, output_tokens: 0 };
  }

  checkHealth(): HealthStatus {
    return this.apiKey ? 'healthy' : 'down';
  }

  validateDataPolicy(_req: ProviderRequest): DataPolicyResult {
    // GLM is a remote provider; data leaves the local machine.
    // Deny by default unless the caller has explicitly allowed remote execution.
    // The caller (ModelGateway) must check egress policy before dispatching.
    const allowRemote = process.env.GLM_ALLOW_REMOTE === 'true';
    return { allowed: allowRemote, reason: allowRemote ? 'remote egress permitted by config' : 'remote egress denied by default' };
  }

  /** The main resolve: makes a real HTTP call to the GLM API. */
  async resolve(request: ProviderRequest): Promise<ParsedResponse> {
    const body = this.normalizeRequest(request) as Record<string, unknown>;
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new GlmProviderError(`GLM API error ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    return this.parseResponse(data);
  }
}

/** Build a GatewayProviderRuntime from GlmProvider for ModelGateway registration. */
export function glmProviderRuntime(): {
  provider_type: string;
  normalizeRequest: GlmProvider['normalizeRequest'];
  parseResponse: GlmProvider['parseResponse'];
  normalizeToolCall: GlmProvider['normalizeToolCall'];
  streamEvents: GlmProvider['streamEvents'];
  mapError: GlmProvider['mapError'];
  meterUsage: GlmProvider['meterUsage'];
  checkHealth: GlmProvider['checkHealth'];
  validateDataPolicy: GlmProvider['validateDataPolicy'];
  resolve: (req: ProviderRequest) => Promise<ParsedResponse>;
} {
  const p = new GlmProvider();
  return {
    provider_type: p.provider_type,
    normalizeRequest: p.normalizeRequest.bind(p),
    parseResponse: p.parseResponse.bind(p),
    normalizeToolCall: p.normalizeToolCall.bind(p),
    streamEvents: p.streamEvents.bind(p),
    mapError: p.mapError.bind(p),
    meterUsage: p.meterUsage.bind(p),
    checkHealth: p.checkHealth.bind(p),
    validateDataPolicy: p.validateDataPolicy.bind(p),
    resolve: (req: ProviderRequest) => p.resolve(req),
  };
}
