import type { GatewayProviderRuntime, ProviderDispatchContext } from './model-gateway.js';
import type {
  ProviderRequest, ParsedResponse, Usage, ToolCall,
  HealthStatus, DataPolicyResult, ProviderError, StreamEvent,
} from './scripted-provider.js';
import type { ModelBinding } from './capability-registry.js';
import type { KeyVault } from './key-vault.js';
import type { ProviderType } from '../contracts/index.js';
import { createAsyncTaskAdapter } from './async-task-adapter.js';

const PROVIDER_REGIONS: Record<string, string[]> = {
  openai: ['us'], anthropic: ['us'], zhipu: ['cn'], deepseek: ['cn'],
  qwen: ['cn'], google: ['us'], mistral: ['eu'], kimi: ['cn'], perplexity: ['us'],
  doubao: ['cn'], ollama: ['local'], vllm: ['local'],
  seedance: ['cn'],
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
    for (const m of nonSystemMessages) content.push({ type: 'text', text: m.content });
    const body: Record<string, unknown> = {
      model: binding.model_id,
      messages: [{ role: 'user', content }],
      max_tokens: maxTokens, temperature,
    };
    body['system'] = systemPrompt;
    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools.map(t => ({
        name: t.name,
        description: (t as Record<string, unknown>)['description'] ?? '',
        input_schema: (t as Record<string, unknown>)['parameters'] ?? { type: 'object', properties: {} },
      }));
    }
    return body;
  }

  const messages: unknown[] = [{ role: 'system', content: systemPrompt }];
  for (const m of nonSystemMessages) messages.push({ role: m.role, content: m.content });
  const body: Record<string, unknown> = { model: binding.model_id, messages, temperature, max_tokens: maxTokens };
  if (request.tools && request.tools.length > 0) {
    body['tools'] = request.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: (t as Record<string, unknown>)['description'] ?? '',
        parameters: (t as Record<string, unknown>)['parameters'] ?? { type: 'object', properties: {} },
      },
    }));
    body['tool_choice'] = 'auto';
  }
  return body;
}

function buildHeaders(binding: ModelBinding, apiKey: string): Record<string, string> {
  if (binding.api_format === 'anthropic') {
    return { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  }
  // Local providers with no auth key: omit Authorization header entirely
  if (!apiKey) return { 'Content-Type': 'application/json' };
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
}

function getEndpoint(binding: ModelBinding): string {
  return binding.api_format === 'anthropic'
    ? `${binding.api_base}/messages`
    : `${binding.api_base}/chat/completions`;
}

function parseResponseData(binding: ModelBinding, raw: unknown): {
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number };
  tool_calls?: ToolCall[];
} {
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
  const choices = data['choices'] as Array<{
    message: { content?: string; reasoning_content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
    finish_reason?: string;
  }> | undefined;
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
  // async_task format (Seedance, video generation) uses a separate adapter
  if (binding.api_format === 'async_task') {
    return createAsyncTaskAdapter(binding, keyVault);
  }
  const provider_type = (binding.api_format === 'anthropic' ? 'anthropic' : 'openai') as ProviderType;

  const adapter = {
    provider_type,

    normalizeRequest(request: ProviderRequest): unknown {
      return buildRequestBody(binding, request);
    },

    async resolve(request: ProviderRequest, _context?: ProviderDispatchContext): Promise<unknown> {
      const key = keyVault.getKey(binding.provider);
  // Local providers (Ollama, vLLM) don't require API keys — allow empty key
  const isLocal = binding.api_base.startsWith('http://localhost') || binding.api_base.startsWith('http://127.0.0.1');
  if (!key && !isLocal) throw new Error(`No API key for ${binding.provider}`);
  const effectiveKey = key ?? '';
      const body = buildRequestBody(binding, request);
      const headers = buildHeaders(binding, effectiveKey);
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
      const result: { content: string; stop_reason: 'stop'; usage: Usage; model: string; tool_calls?: ToolCall[] } = {
        content: parsed.content,
        stop_reason: 'stop',
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
      return {
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments ? JSON.parse(tc.function.arguments) : {},
      };
    },

    async *streamEvents(request: ProviderRequest): AsyncIterable<StreamEvent> {
      const skey = keyVault.getKey(binding.provider);
      const sIsLocal = binding.api_base.startsWith('http://localhost') || binding.api_base.startsWith('http://127.0.0.1');
      if (!skey && !sIsLocal) throw new Error(`No API key for ${binding.provider}`);
      const effectiveSKey = skey ?? '';
      const sbody = buildRequestBody(binding, request);
      (sbody as Record<string, unknown>)['stream'] = true;
      const sheaders = buildHeaders(binding, effectiveSKey);
      const sendpoint = getEndpoint(binding);
      const sresp = await fetch(sendpoint, {
        method: 'POST', headers: sheaders, body: JSON.stringify(sbody),
        signal: AbortSignal.timeout(90_000),
      });
      if (!sresp.ok) {
        const errText = await sresp.text().catch(() => '');
        if (sresp.status === 429) throw new Error(`HTTP 429 rate limited (do not retry): ${errText.slice(0, 300)}`);
        throw new Error(`HTTP ${sresp.status}: ${errText.slice(0, 300)}`);
      }
      const reader = sresp.body?.getReader();
      if (!reader) {
        const raw = await sresp.json();
        const res = adapter.parseResponse(raw);
        if (res.content) yield { type: 'text_delta', text: res.content };
        for (const tc of res.tool_calls ?? []) yield { type: 'tool_call', tool_call: tc };
        const stopEv: { type: 'message_stop'; stop_reason: NonNullable<typeof res.stop_reason> } & { usage?: Usage } = { type: 'message_stop', stop_reason: res.stop_reason ?? 'stop' };
        if (res.usage) stopEv.usage = res.usage;
        yield stopEv;
        return;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      let promptTokens = 0;
      let completionTokens = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') continue;
          try {
            const chunk = JSON.parse(dataStr) as Record<string, unknown>;
            if (binding.api_format === 'anthropic') {
              const evtType = chunk['type'] as string;
              if (evtType === 'content_block_delta') {
                const delta = chunk['delta'] as Record<string, unknown>;
                if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') yield { type: 'text_delta', text: delta['text'] };
              } else if (evtType === 'message_delta') {
                const u = chunk['usage'] as Record<string, number> | undefined;
                if (u) { promptTokens = u['input_tokens'] ?? promptTokens; completionTokens = u['output_tokens'] ?? completionTokens; }
              } else if (evtType === 'message_stop') {
                const stopEv: { type: 'message_stop'; stop_reason: 'stop'; usage?: Usage } = { type: 'message_stop', stop_reason: 'stop' };
                if (promptTokens > 0 || completionTokens > 0) stopEv.usage = { input_tokens: promptTokens, output_tokens: completionTokens };
                yield stopEv;
                return;
              }
            } else {
              const choices = chunk['choices'] as Array<{ delta?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }> | undefined;
              const choice = choices?.[0];
              if (choice?.delta?.content) yield { type: 'text_delta', text: choice.delta.content };
              if (choice?.delta?.tool_calls) {
                for (const tc of choice.delta.tool_calls) {
                  const toolCall: ToolCall = { id: tc.id, name: tc.function.name, arguments: JSON.parse(tc.function.arguments || '{}') };
                  yield { type: 'tool_call', tool_call: toolCall };
                }
              }
              const u = chunk['usage'] as Record<string, number> | undefined;
              if (u) { promptTokens = u['prompt_tokens'] ?? promptTokens; completionTokens = u['completion_tokens'] ?? completionTokens; }
              if (choice?.finish_reason) {
                const sr = choice.finish_reason === 'stop' ? 'stop' : choice.finish_reason === 'length' ? 'length' : choice.finish_reason === 'tool_calls' ? 'tool_use' : 'stop';
                const stopEv: { type: 'message_stop'; stop_reason: 'stop' | 'length' | 'tool_use' | 'content_filter'; usage?: Usage } = { type: 'message_stop', stop_reason: sr as 'stop' | 'length' | 'tool_use' | 'content_filter' };
                if (promptTokens > 0 || completionTokens > 0) stopEv.usage = { input_tokens: promptTokens, output_tokens: completionTokens };
                yield stopEv;
                return;
              }
            }
          } catch { /* skip malformed chunk */ }
        }
      }
      const finalStop: { type: 'message_stop'; stop_reason: 'stop'; usage?: Usage } = { type: 'message_stop', stop_reason: 'stop' };
      if (promptTokens > 0 || completionTokens > 0) finalStop.usage = { input_tokens: promptTokens, output_tokens: completionTokens };
      yield finalStop;
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
