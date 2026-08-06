import type { GatewayProviderRuntime, ProviderDispatchContext } from './model-gateway.js';
import type {
  ProviderRequest, ParsedResponse, Usage, ToolCall,
  HealthStatus, DataPolicyResult, ProviderError, StreamEvent,
} from './scripted-provider.js';
import type { ModelBinding } from './capability-registry.js';
import type { KeyVault } from './key-vault.js';
import type { ProviderType } from '../../spec/types/provider-adapter.js';

const PROVIDER_REGIONS: Record<string, string[]> = {
  openai: ['us'], anthropic: ['us'], zhipu: ['cn'], deepseek: ['cn'],
  qwen: ['cn'], google: ['us'], mistral: ['eu'], kimi: ['cn'], perplexity: ['us'],
};

export function getProviderRegions(provider: string): string[] {
  return PROVIDER_REGIONS[provider] ?? ['us'];
}

function buildRequestBody(binding: ModelBinding, request: ProviderRequest): Record<string, unknown> {
  const temperature = request.temperature ?? 0.3;
  const maxTokens = request.max_tokens ?? 8000;

  const systemMessages = request.messages.filter(m => m.role === 'system');
  const nonSystemMessages = request.messages.filter(m => m.role !== 'system');
  const systemPrompt = systemMessages.map(m => m.content).join('\n') || 'You are a precise agent execution engine.';

  if (binding.api_format === 'anthropic') {
    const content: unknown[] = [];
    for (const m of nonSystemMessages) {
      content.push({ type: 'text', text: m.content });
    }
    const body: Record<string, unknown> = {
      model: binding.model_id,
      messages: [{ role: 'user', content }],
      max_tokens: maxTokens, temperature,
    };
    body['system'] = systemPrompt;
    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools.map(t => ({ name: t.name, description: (t as Record<string, unknown>)['description'] ?? '', input_schema: (t as Record<string, unknown>)['parameters'] ?? { type: 'object', properties: {} } }));
    }
    return body;
  }

  const messages: unknown[] = [{ role: 'system', content: systemPrompt }];
  for (const m of nonSystemMessages) {
    messages.push({ role: m.role, content: m.content });
  }
  const body: Record<string, unknown> = { model: binding.model_id, messages, temperature, max_tokens: maxTokens };
  if (request.tools && request.tools.length > 0) {
    body['tools'] = request.tools.map(t => ({ type: 'function', function: { name: t.name, description: (t as Record<string, unknown>)['description'] ?? '', parameters: (t as Record<string, unknown>)['parameters'] ?? { type: 'object', properties: {} } } }));
    body['tool_choice'] = 'auto';
  }
  return body;
}

function buildHeaders(binding: ModelBinding, apiKey: string): Record<string, string> {
  if (binding.api_format === 'anthropic') {
    return { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  }
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
}

function getEndpoint(binding: ModelBinding): string {
  return binding.api_format === 'anthropic'
    ? `${binding.api_base}/messages`
    : `${binding.api_base}/chat/completions`;
}

function parseResponseData(binding: ModelBinding, raw: unknown): { content: string; usage: { prompt_tokens: number; completion_tokens: number }; tool_calls?: ToolCall[] } {
  const data = raw as Record<string, unknown>;
  if (binding.api_format === 'anthropic') {
    const content = data['content'] as Array<{ type: string; text?: string }> | undefined;
    let text = '';
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) text += block.text;
      }
    }
    const usage = data['usage'] as Record<string, number> | undefined;
    return {
      content: text,
      usage: { prompt_tokens: usage?.['input_tokens'] ?? 0, completion_tokens: usage?.['output_tokens'] ?? 0 },
    };
  }
  const choices = data['choices'] as Array<{ message: { content?: string; reasoning_content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }> | undefined;
  const choice = choices?.[0];
  if (!choice) throw new Error('No choices in response');
  const msg = choice.message;
  let text = msg?.content ?? '';
  if (!text && msg?.reasoning_content) {
    const match = msg.reasoning_content.match(/\{[^{}]*\}/);
    text = match ? match[0] : msg.reasoning_content.slice(0, 2000);
  }
  let tool_calls: ToolCall[] | undefined;
  if (msg?.tool_calls && msg.tool_calls.length > 0) {
    tool_calls = msg.tool_calls.map(tc => ({
      id: tc.id, name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}'),
    }));
  }
  const usage = data['usage'] as Record<string, number> | undefined;
  return {
    content: text,
    usage: { prompt_tokens: usage?.['prompt_tokens'] ?? 0, completion_tokens: usage?.['completion_tokens'] ?? 0 },
    ...(tool_calls !== undefined ? { tool_calls } : {}),
  };
}

export function createProviderAdapter(
  binding: ModelBinding,
  keyVault: KeyVault,
): GatewayProviderRuntime {
  const provider_type = (binding.api_format === 'anthropic' ? 'anthropic' : 'openai') as ProviderType;

  const adapter = {
    provider_type,

    normalizeRequest(request: ProviderRequest): unknown {
      return buildRequestBody(binding, request);
    },

    async resolve(request: ProviderRequest, _context?: ProviderDispatchContext): Promise<unknown> {
      const key = keyVault.getKey(binding.provider);
      if (!key) throw new Error(`No API key for ${binding.provider}`);
      const body = buildRequestBody(binding, request);
      const headers = buildHeaders(binding, key);
      const endpoint = getEndpoint(binding);
      const resp = await fetch(endpoint, {
        method: 'POST', headers, body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        if (resp.status === 429) throw new Error(`HTTP 429 rate limited (do not retry): ${errText.slice(0, 300)}`);
        throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 300)}`);
      }
      return resp.json();
    },

    parseResponse(raw: unknown): ParsedResponse {
      const parsed = parseResponseData(binding, raw);
      const stopReason = 'stop' as const;
      const result: { content: string; stop_reason: 'stop'; usage: Usage; model: string; tool_calls?: ToolCall[] } = {
        content: parsed.content,
        stop_reason: stopReason,
        usage: { input_tokens: parsed.usage.prompt_tokens, output_tokens: parsed.usage.completion_tokens },
        model: binding.model_id,
      };
      if (parsed.tool_calls !== undefined) result.tool_calls = parsed.tool_calls;
      return result as unknown as ParsedResponse;
    },

    normalizeToolCall(raw: unknown): ToolCall {
      if (typeof raw !== 'object' || raw === null) throw new Error('invalid tool call');
      const tc = raw as { id?: string; function?: { name?: string; arguments?: string } };
      if (!tc.id || !tc.function?.name) throw new Error('tool call missing id or name');
      return { id: tc.id, name: tc.function.name, arguments: tc.function.arguments ? JSON.parse(tc.function.arguments) : {} };
    },

    async *streamEvents(request: ProviderRequest): AsyncIterable<StreamEvent> {
      const raw = await adapter.resolve(request);
      const res = adapter.parseResponse(raw);
      if (res.content) yield { type: 'text_delta', text: res.content };
      for (const tc of res.tool_calls ?? []) yield { type: 'tool_call', tool_call: tc };
      const stopEv: { type: 'message_stop'; stop_reason: NonNullable<typeof res.stop_reason> } & { usage?: Usage } = { type: 'message_stop', stop_reason: res.stop_reason ?? 'stop' };
      if (res.usage) stopEv.usage = res.usage;
      yield stopEv;
    },

    mapError(raw: unknown): ProviderError {
      if (raw instanceof Error) {
        const msg = raw.message;
        if (/401|auth|unauthorized/i.test(msg)) return { kind: 'auth', retryable: false, detail: msg };
        if (/429|rate/i.test(msg)) return { kind: 'rate_limited', retryable: false, detail: msg };
        if (/timeout|timed out/i.test(msg)) return { kind: 'timeout', retryable: true, detail: msg };
        if (/500|502|503|504|server/i.test(msg)) return { kind: 'server', retryable: true, detail: msg };
        if (/400|invalid/i.test(msg)) return { kind: 'invalid_request', retryable: false, detail: msg };
        return { kind: 'unknown', retryable: false, detail: msg };
      }
      return { kind: 'unknown', retryable: false, detail: String(raw) };
    },

    meterUsage(response: ParsedResponse): Usage {
      return response.usage ?? { input_tokens: 0, output_tokens: 0 };
    },

    checkHealth(): HealthStatus {
      return keyVault.hasProvider(binding.provider) ? 'healthy' : 'down';
    },

    validateDataPolicy(_request: ProviderRequest): DataPolicyResult {
      return { allowed: true };
    },
  };

  return adapter as unknown as GatewayProviderRuntime;
}
