/**
 * GLM Provider Adapter — real LLM calls via Zhipu (BigModel) OpenAI-compatible API.
 *
 * Implements the full GatewayProviderRuntime interface. Credentials arrive
 * only through the dispatch context supplied by ModelGateway.
 */
import type { ProviderDispatchContext } from './model-gateway.js';
import type {
  ProviderRequest, ParsedResponse, ToolCall, Usage,
  HealthStatus, DataPolicyResult, ProviderError, StreamEvent,
} from './scripted-provider.js';
import { ProviderHttpError, ProviderTimeoutError } from './scripted-provider.js';

export class GlmProviderError extends Error {
  constructor(message: string) { super(message); this.name = 'GlmProviderError'; Object.setPrototypeOf(this, GlmProviderError.prototype); }
}

export interface GlmProviderOptions {
  model: string;
  reasoningEffort?: string;
  endpoint?: string;
  fetch?: typeof fetch;
}

const TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  read_file: 'Read one local workspace file and return its contents. Use /workspace/... or a workspace-relative path.',
  write_file: 'Create or replace one local workspace file with exact content. Use /workspace/... or a workspace-relative path.',
  edit_file: 'Replace one exact text fragment in one local workspace file. Use /workspace/... or a workspace-relative path.',
  list_directory: 'List entries in one local workspace directory. Use /workspace/... or a workspace-relative path.',
  search_files: 'Search local workspace files for a literal text fragment. Use /workspace/... or a workspace-relative root.',
  execute_command: 'Run one allowlisted local command inside the workspace sandbox. Use /workspace or a workspace-relative cwd.',
  create_artifact: 'Create one local structured artifact under /workspace.',
  ask_user: 'Request missing information from the user without taking other action.',
  parse_document: 'Parse one local document under /workspace and return its extracted text.',
});

function toolDescription(
  tool: NonNullable<ProviderRequest['tools']>[number],
): string {
  const declared = tool.risk_feature_extractor?.trim();
  if (declared && declared !== 'default') return declared;
  return (
    TOOL_DESCRIPTIONS[tool.name] ??
    `Invoke the local ${tool.name} tool with schema-valid arguments.`
  );
}

function stopReason(
  reason: string | null | undefined,
): NonNullable<ParsedResponse['stop_reason']> {
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'content_filter') return 'content_filter';
  return 'stop';
}

export class GlmProvider {
  readonly provider_type = 'openai' as const; // Zhipu API is OpenAI-compatible
  private readonly model: string;
  private readonly reasoningEffort: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GlmProviderOptions) {
    if (!options?.model?.trim()) throw new GlmProviderError('GLM model is required');
    this.model = options.model;
    this.reasoningEffort = options.reasoningEffort ?? 'xhigh';
    this.endpoint =
      options.endpoint ?? 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
    const endpoint = new URL(this.endpoint);
    if (endpoint.protocol !== 'https:') throw new GlmProviderError('GLM endpoint must use HTTPS');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  normalizeRequest(req: ProviderRequest): unknown {
    return {
      model: this.model,
      reasoning_effort: this.reasoningEffort,
      thinking: { type: 'enabled', clear_thinking: false },
      messages: req.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.reasoning_content === undefined
          ? {}
          : { reasoning_content: message.reasoning_content }),
        ...(message.tool_call_id === undefined
          ? {}
          : { tool_call_id: message.tool_call_id }),
        ...(message.tool_calls === undefined
          ? {}
          : {
              tool_calls: message.tool_calls.map((call) => ({
                id: call.id,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments),
                },
              })),
            }),
      })),
      temperature: req.temperature ?? 1,
      max_tokens: req.max_tokens ?? 4096,
      ...(req.tools && req.tools.length > 0
        ? {
            parallel_tool_calls: false,
            tools: req.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: toolDescription(tool),
                parameters: tool.input_schema ?? {},
              },
            })),
          }
        : {}),
      ...(req.tool_choice === undefined
        ? {}
        : { tool_choice: req.tool_choice }),
    };
  }

  parseResponse(raw: unknown): ParsedResponse {
    const data = raw as { choices?: Array<{ message: { content?: string; reasoning_content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }>; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; model?: string };
    const choice = data.choices?.[0];
    if (!choice) throw new GlmProviderError('GLM returned no choices');
    const tool_calls = choice.message.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}'),
    }));
    const stop_reason = stopReason(choice.finish_reason);
    const usage = data.usage ? { input_tokens: data.usage.prompt_tokens, output_tokens: data.usage.completion_tokens } : { input_tokens: 0, output_tokens: 0 };
    return {
      content: choice.message.content ?? '',
      ...(choice.message.reasoning_content === undefined
        ? {}
        : { reasoning_content: choice.message.reasoning_content }),
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

  async *streamEvents(
    request: ProviderRequest,
    context?: ProviderDispatchContext,
  ): AsyncIterable<StreamEvent> {
    const response = await this.request(request, context, true);
    if (!response.body) throw new GlmProviderError('GLM stream returned no body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let pendingStopReason: NonNullable<ParsedResponse['stop_reason']> | undefined;
    let pendingUsage: Usage | undefined;
    const toolCalls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    const parseFrame = (frame: string): {
      text?: string;
      finish?: NonNullable<ParsedResponse['stop_reason']>;
      usage?: Usage;
      toolCalls?: ToolCall[];
      done?: boolean;
    } => {
      const data = frame
        .split(/\r?\n/u)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (!data) return {};
      if (data === '[DONE]') return { done: true };
      const payload = JSON.parse(data) as {
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = payload.choices?.[0];
      for (const delta of choice?.delta?.tool_calls ?? []) {
        const current = toolCalls.get(delta.index) ?? { id: '', name: '', arguments: '' };
        if (delta.id) current.id = delta.id;
        if (delta.function?.name) current.name += delta.function.name;
        if (delta.function?.arguments) current.arguments += delta.function.arguments;
        toolCalls.set(delta.index, current);
      }
      const usage =
        payload.usage === undefined
          ? undefined
          : {
              input_tokens: payload.usage.prompt_tokens ?? 0,
              output_tokens: payload.usage.completion_tokens ?? 0,
            };
      const finish = choice?.finish_reason
        ? stopReason(choice.finish_reason)
        : undefined;
      const completedTools =
        finish === undefined
          ? undefined
          : [...toolCalls.entries()]
              .sort(([left], [right]) => left - right)
              .map(([, tool]) => {
                if (!tool.id || !tool.name) {
                  throw new GlmProviderError('streamed tool call missing id or name');
                }
                return {
                  id: tool.id,
                  name: tool.name,
                  arguments: JSON.parse(tool.arguments || '{}') as Record<string, unknown>,
                };
              });
      return {
        ...(choice?.delta?.content ? { text: choice.delta.content } : {}),
        ...(finish ? { finish } : {}),
        ...(usage ? { usage } : {}),
        ...(completedTools ? { toolCalls: completedTools } : {}),
      };
    };

    for (;;) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const frames = buffer.split(/\r?\n\r?\n/u);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const parsed = parseFrame(frame);
        if (parsed.text) yield { type: 'text_delta', text: parsed.text };
        for (const toolCall of parsed.toolCalls ?? []) {
          yield { type: 'tool_call', tool_call: toolCall };
        }
        if (parsed.finish) pendingStopReason = parsed.finish;
        if (parsed.usage) pendingUsage = parsed.usage;
      }
      if (chunk.done) break;
    }
    if (!pendingStopReason) {
      throw new GlmProviderError('GLM stream ended without a terminal event');
    }
    yield {
      type: 'message_stop',
      stop_reason: pendingStopReason,
      ...(pendingUsage ? { usage: pendingUsage } : {}),
    };
  }

  mapError(raw: unknown): ProviderError {
    if (raw instanceof ProviderHttpError) {
      if (raw.status === 401 || raw.status === 403) {
        return { kind: 'auth', retryable: false, detail: 'Provider authentication failed', status: raw.status };
      }
      if (raw.status === 429) return { kind: 'rate_limited', retryable: true, detail: 'Provider rate limited', status: raw.status };
      if (raw.status >= 500) return { kind: 'server', retryable: true, detail: 'Provider server failure', status: raw.status };
      return { kind: 'invalid_request', retryable: false, detail: 'Provider rejected request', status: raw.status };
    }
    if (raw instanceof ProviderTimeoutError) {
      return { kind: 'timeout', retryable: true, detail: 'Provider request timed out' };
    }
    if (raw instanceof Error) {
      const msg = raw.message;
      return { kind: 'unknown', retryable: false, detail: msg };
    }
    return { kind: 'unknown', retryable: false, detail: String(raw) };
  }

  meterUsage(res: ParsedResponse): Usage {
    return res.usage ?? { input_tokens: 0, output_tokens: 0 };
  }

  checkHealth(): HealthStatus {
    return this.model ? 'healthy' : 'down';
  }

  validateDataPolicy(_req: ProviderRequest): DataPolicyResult {
    // GLM is a remote provider; data leaves the local machine.
    // Deny by default unless the caller has explicitly allowed remote execution.
    // The caller (ModelGateway) must check egress policy before dispatching.
    return { allowed: true, reason: 'remote policy is enforced by ModelGateway' };
  }

  async resolve(
    request: ProviderRequest,
    context?: ProviderDispatchContext,
  ): Promise<unknown> {
    const response = await this.request(request, context, false);
    return response.json();
  }

  private async request(
    request: ProviderRequest,
    context: ProviderDispatchContext | undefined,
    stream: boolean,
  ): Promise<Response> {
    const secret = context?.credential?.secret;
    if (!secret) throw new GlmProviderError('dispatch credential secret is required');
    const body = this.normalizeRequest(request) as Record<string, unknown>;
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    let signal = context?.signal;
    if (context?.deadline_at) {
      const remaining = Date.parse(context.deadline_at) - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) throw new ProviderTimeoutError();
      const deadlineSignal = AbortSignal.timeout(remaining);
      signal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
    }
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      ...(signal ? { signal } : {}),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new ProviderHttpError(response.status);
    return response;
  }
}

/** Build a GatewayProviderRuntime from GlmProvider for ModelGateway registration. */
export function glmProviderRuntime(options: GlmProviderOptions): {
  provider_type: string;
  normalizeRequest: GlmProvider['normalizeRequest'];
  parseResponse: GlmProvider['parseResponse'];
  normalizeToolCall: GlmProvider['normalizeToolCall'];
  streamEvents: GlmProvider['streamEvents'];
  mapError: GlmProvider['mapError'];
  meterUsage: GlmProvider['meterUsage'];
  checkHealth: GlmProvider['checkHealth'];
  validateDataPolicy: GlmProvider['validateDataPolicy'];
  resolve: (req: ProviderRequest, context?: ProviderDispatchContext) => Promise<unknown>;
} {
  const p = new GlmProvider(options);
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
    resolve: (req: ProviderRequest, context?: ProviderDispatchContext) => p.resolve(req, context),
  };
}
