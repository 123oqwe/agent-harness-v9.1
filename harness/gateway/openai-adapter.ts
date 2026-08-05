/**
 * OpenAI Provider Adapter — real HTTP calls to OpenAI-compatible APIs.
 *
 * Works with: OpenAI, GLM (Zhipu), DeepSeek, Qwen (DashScope),
 * and any provider that uses the OpenAI chat/completions format.
 *
 * AH-GATEWAY-PROVIDER-001: implements ProviderAdapter interface.
 */

import type {
  ProviderAdapter, ProviderRequest, ParsedResponse, ToolCall,
  Usage, HealthStatus, DataPolicyResult, ProviderError, StreamEvent,
} from './provider.js';

export interface OpenAIAdapterOptions {
  apiBase?: string;        // default: https://api.openai.com/v1
  defaultModel?: string;   // default: gpt-4o
  timeoutMs?: number;      // default: 90000
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly provider_type = 'openai' as const;

  private readonly apiBase: string;
  private readonly defaultModel: string;
  private readonly defaultTimeoutMs: number;

  constructor(opts: OpenAIAdapterOptions = {}) {
    this.apiBase = (opts.apiBase ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.defaultModel = opts.defaultModel ?? 'gpt-4o';
    this.defaultTimeoutMs = opts.timeoutMs ?? 90_000;
  }

  normalizeRequest(req: ProviderRequest): unknown {
    const messages = req.messages.map(m => {
      if (m.role === 'tool' && m.tool_call_id) {
        return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id };
      }
      return { role: m.role, content: m.content };
    });

    const body: Record<string, unknown> = {
      model: req.model ?? this.defaultModel,
      messages,
      temperature: req.temperature ?? 0.3,
      max_tokens: req.max_tokens ?? 8000,
    };

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.input_schema ?? { type: 'object', properties: {} },
        },
      }));
      body.tool_choice = req.tool_choice ?? 'auto';
    }

    body.response_format = { type: 'json_object' };

    return body;
  }

  async executeRequest(
    normalizedReq: unknown,
    apiKey: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // Link external signal if provided
    if (opts?.signal) {
      opts.signal.addEventListener('abort', () => controller.abort());
    }

    try {
      const resp = await fetch(`${this.apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(normalizedReq),
        signal: controller.signal,
      });

      const text = await resp.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Provider returned non-JSON response (HTTP ${resp.status}): ${text.slice(0, 500)}`);
      }

      if (!resp.ok) {
        // Attach HTTP status for mapError to classify
        const err = new Error(`HTTP ${resp.status}: ${text.slice(0, 500)}`) as Error & { status?: number };
        err.status = resp.status;
        throw err;
      }

      return json;
    } finally {
      clearTimeout(timeout);
    }
  }

  parseResponse(raw: unknown): ParsedResponse {
    const r = raw as Record<string, unknown>;
    const choices = r.choices as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) {
      return { content: '', stop_reason: 'stop', model: r.model as string | undefined };
    }

    const msg = choices[0].message as Record<string, unknown>;
    let content = (msg.content as string) ?? '';

    // GLM-5.2 reasoning_content fallback: if content is empty, extract from reasoning_content
    if (!content && msg.reasoning_content) {
      const reasoning = msg.reasoning_content as string;
      const match = reasoning.match(/\{[^{}]*\}/);
      content = match ? match[0] : reasoning.slice(0, 2000);
    }

    const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;

    const finishReason = choices[0].finish_reason as string | undefined;
    const stopReason = finishReason === 'length' ? 'length'
      : finishReason === 'tool_calls' ? 'tool_use'
      : finishReason === 'content_filter' ? 'content_filter'
      : 'stop';

   return {
     content,
     tool_calls: toolCalls?.map(tc => this.normalizeToolCall(tc)),
     stop_reason: stopReason as ParsedResponse['stop_reason'],
      usage: (r.usage as Record<string, unknown> | undefined)
        ? parseOpenAIUsage(r)
        : this.meterUsage({ content, stop_reason: stopReason as ParsedResponse['stop_reason'] }),
     model: r.model as string | undefined,
   };
  }

  normalizeToolCall(raw: unknown): ToolCall {
    const r = raw as Record<string, unknown>;
    const fn = (r.function ?? r) as Record<string, unknown>;
    let args: Record<string, unknown> = {};
    if (typeof fn.arguments === 'string') {
      try { args = JSON.parse(fn.arguments); } catch { args = {}; }
    } else if (typeof fn.arguments === 'object' && fn.arguments) {
      args = fn.arguments as Record<string, unknown>;
    }
    return {
      id: (r.id as string) ?? `tc_${Date.now()}`,
      name: (fn.name as string) ?? 'unknown',
      arguments: args,
    };
  }

  streamEvents(_req: ProviderRequest): AsyncIterable<StreamEvent> {
    // Streaming not yet implemented for real providers (Phase 2+)
    throw new Error('Streaming not implemented for OpenAIAdapter');
  }

  mapError(raw: unknown): ProviderError {
    const msg = raw instanceof Error ? raw.message : String(raw);
    const status = (raw as { status?: number })?.status;
    const lower = msg.toLowerCase();

    if (status === 429 || lower.includes('rate')) {
      return { kind: 'rate_limited', retryable: false, detail: msg };
    }
    if (status === 401 || lower.includes('auth') || lower.includes('key') || lower.includes('401')) {
      return { kind: 'auth', retryable: false, detail: msg };
    }
    if (lower.includes('timeout') || lower.includes('aborted')) {
      return { kind: 'timeout', retryable: true, detail: msg };
    }
    if (status && status >= 500) {
      return { kind: 'server', retryable: true, detail: msg };
    }
    if (lower.includes('500') || lower.includes('server') || lower.includes('502') || lower.includes('503')) {
      return { kind: 'server', retryable: true, detail: msg };
    }
    if (status === 400 || lower.includes('400') || lower.includes('invalid')) {
      return { kind: 'invalid_request', retryable: false, detail: msg };
    }
    return { kind: 'unknown', retryable: false, detail: msg };
  }

  meterUsage(res: ParsedResponse): Usage {
    if (res.usage) {
      return {
        input_tokens: res.usage.input_tokens,
        output_tokens: res.usage.output_tokens,
        reasoning_tokens: res.usage.reasoning_tokens,
      };
    }
    // Estimate from content if provider didn't return usage
    return {
      input_tokens: 0,
      output_tokens: Math.ceil((res.content?.length ?? 0) / 4),
    };
  }

  checkHealth(): HealthStatus {
    return 'healthy'; // No health endpoint to check; assume healthy
  }

  validateDataPolicy(req: ProviderRequest): DataPolicyResult {
    // Basic check: no obvious secrets in messages
    const content = req.messages.map(m => m.content).join(' ');
    if (/sk-[a-zA-Z0-9]{20,}/.test(content)) {
      return { allowed: false, reason: 'API key detected in message content' };
    }
    return { allowed: true };
  }
}

/**
 * Parse usage from raw OpenAI response. Called internally by parseResponse
 * when the provider includes a usage block.
 */
export function parseOpenAIUsage(raw: Record<string, unknown>): Usage {
  const usage = (raw.usage ?? {}) as Record<string, unknown>;
  const promptTokens = (usage.prompt_tokens as number) ?? 0;
  const completionTokens = (usage.completion_tokens as number) ?? 0;

  let reasoningTokens = 0;
  const details = usage.completion_tokens_details as Record<string, unknown> | undefined;
  if (details && typeof details.reasoning_tokens === 'number') {
    reasoningTokens = details.reasoning_tokens;
  }

  return {
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    reasoning_tokens: reasoningTokens > 0 ? reasoningTokens : undefined,
  };
}
