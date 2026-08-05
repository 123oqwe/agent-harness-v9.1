/**
 * Anthropic Provider Adapter — real HTTP calls to Anthropic API.
 *
 * Uses the Anthropic Messages API format (distinct from OpenAI):
 * - system prompt is a top-level field, not a message
 * - tool calls use content blocks (type: "tool_use")
 * - tool results use role: "user" with tool_result content blocks
 * - usage: input_tokens / output_tokens (not prompt_tokens / completion_tokens)
 *
 * AH-GATEWAY-PROVIDER-001: implements ProviderAdapter interface.
 */

import type {
  ProviderAdapter, ProviderRequest, ParsedResponse, ToolCall,
  Usage, HealthStatus, DataPolicyResult, ProviderError, StreamEvent,
} from './provider.js';

export interface AnthropicAdapterOptions {
  apiBase?: string;        // default: https://api.anthropic.com/v1
  defaultModel?: string;   // default: claude-sonnet-4-6
  timeoutMs?: number;      // default: 90000
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly provider_type = 'anthropic' as const;

  private readonly apiBase: string;
  private readonly defaultModel: string;
  private readonly defaultTimeoutMs: number;

  constructor(opts: AnthropicAdapterOptions = {}) {
    this.apiBase = (opts.apiBase ?? 'https://api.anthropic.com/v1').replace(/\/$/, '');
    this.defaultModel = opts.defaultModel ?? 'claude-sonnet-4-6';
    this.defaultTimeoutMs = opts.timeoutMs ?? 90_000;
  }

  normalizeRequest(req: ProviderRequest): unknown {
    // Anthropic: system prompt is top-level, not a message
    let systemPrompt = '';
    const messages: Array<Record<string, unknown>> = [];

    for (const m of req.messages) {
      if (m.role === 'system') {
        systemPrompt += (systemPrompt ? '\n' : '') + m.content;
      } else if (m.role === 'tool') {
        // Tool results: Anthropic uses role "user" with tool_result content blocks
        messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: m.tool_call_id ?? '',
            content: m.content,
          }],
        });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }

    const body: Record<string, unknown> = {
      model: req.model ?? this.defaultModel,
      messages,
      max_tokens: req.max_tokens ?? 8000,
      temperature: req.temperature ?? 0.3,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(t => ({
        name: t.name,
        description: t.description ?? '',
        input_schema: t.input_schema ?? { type: 'object', properties: {} },
      }));
      // Anthropic tool_choice format: { type: "auto" | "any" | "tool", name?: string }
      if (req.tool_choice === 'required') {
        body.tool_choice = { type: 'any' };
      } else if (req.tool_choice === 'none') {
        // Anthropic doesn't have "none" — just don't pass tools
      } else if (req.tool_choice && req.tool_choice !== 'auto') {
        body.tool_choice = { type: 'tool', name: req.tool_choice };
      } else {
        body.tool_choice = { type: 'auto' };
      }
    }

    // Anthropic doesn't support response_format json_object;
    // it's handled via system prompt instruction instead.
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

    if (opts?.signal) {
      opts.signal.addEventListener('abort', () => controller.abort());
    }

    try {
      const resp = await fetch(`${this.apiBase}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(normalizedReq),
        signal: controller.signal,
      });

      const text = await resp.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Anthropic returned non-JSON (HTTP ${resp.status}): ${text.slice(0, 500)}`);
      }

      if (!resp.ok) {
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
    const contentBlocks = (r.content ?? []) as Array<Record<string, unknown>>;

    let text = '';
    const toolCalls: ToolCall[] = [];

    for (const block of contentBlocks) {
      if (block.type === 'text') {
        text += (block.text as string) ?? '';
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: (block.id as string) ?? `tc_${Date.now()}`,
          name: (block.name as string) ?? 'unknown',
          arguments: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }

    const stopReason = r.stop_reason === 'max_tokens' ? 'length'
      : r.stop_reason === 'tool_use' ? 'tool_use'
      : 'stop';

   return {
     content: text,
     tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
     stop_reason: stopReason as ParsedResponse['stop_reason'],
      usage: (r.usage as Record<string, unknown> | undefined)
        ? AnthropicAdapter.parseUsage(r)
        : this.meterUsage({ content: text, stop_reason: stopReason as ParsedResponse['stop_reason'] }),
     model: r.model as string | undefined,
   };
  }

  normalizeToolCall(raw: unknown): ToolCall {
    const r = raw as Record<string, unknown>;
    return {
      id: (r.id as string) ?? `tc_${Date.now()}`,
      name: (r.name as string) ?? 'unknown',
      arguments: (r.input as Record<string, unknown>) ?? {},
    };
  }

  streamEvents(_req: ProviderRequest): AsyncIterable<StreamEvent> {
    throw new Error('Streaming not implemented for AnthropicAdapter');
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
    if (lower.includes('500') || lower.includes('overloaded')) {
      return { kind: 'server', retryable: true, detail: msg };
    }
    if (status === 400 || lower.includes('400') || lower.includes('invalid')) {
      return { kind: 'invalid_request', retryable: false, detail: msg };
    }
    return { kind: 'unknown', retryable: false, detail: msg };
  }

  meterUsage(res: ParsedResponse): Usage {
    // Anthropic returns usage in the response; if not yet parsed, estimate
    if (res.usage) {
      return {
        input_tokens: res.usage.input_tokens,
        output_tokens: res.usage.output_tokens,
        reasoning_tokens: res.usage.reasoning_tokens,
      };
    }
    return {
      input_tokens: 0,
      output_tokens: Math.ceil((res.content?.length ?? 0) / 4),
    };
  }

  checkHealth(): HealthStatus {
    return 'healthy';
  }

  validateDataPolicy(req: ProviderRequest): DataPolicyResult {
    const content = req.messages.map(m => m.content).join(' ');
    if (/sk-[a-zA-Z0-9]{20,}/.test(content)) {
      return { allowed: false, reason: 'API key detected in message content' };
    }
    return { allowed: true };
  }

  /**
   * Parse usage from raw Anthropic response (called during parseResponse).
   */
  static parseUsage(raw: Record<string, unknown>): Usage {
    const usage = (raw.usage ?? {}) as Record<string, unknown>;
    return {
      input_tokens: (usage.input_tokens as number) ?? 0,
      output_tokens: (usage.output_tokens as number) ?? 0,
    };
  }
}
