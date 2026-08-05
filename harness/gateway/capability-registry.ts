import type { KeyVault } from './key-vault.js';

export type ModelTier = 'route' | 'work' | 'verify';

export interface ModelBinding {
  model_id: string;
  provider: string;
  tier: ModelTier;
  capabilities: Record<string, number>;
  price_input: number;
  price_output: number;
  max_context: number;
  avg_latency_ms: number;
  api_base: string;
  api_format: 'openai_chat' | 'anthropic';
  supports_tools: boolean;
  supports_streaming: boolean;
  supports_vision: boolean;
  enabled: boolean;
}

export interface UsageRecord {
  model_id: string;
  provider: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  latency_ms: number;
  timestamp: number;
  success: boolean;
  error?: string;
}

export interface RouteResult {
  response: string;
  usage: UsageRecord;
  model_used: string;
  provider_used: string;
  fallback_triggered: boolean;
  fallback_chain: string[];
}

const DEFAULT_MODELS: ModelBinding[] = [
  {
    model_id: 'glm-4-plus', provider: 'zhipu', tier: 'work',
    capabilities: { code: 0.82, reasoning: 0.80, tool_calling: 0.78, structured_output: 0.80, long_context: 0.85, chinese: 0.95 },
    price_input: 0.5, price_output: 1.5, max_context: 131072, avg_latency_ms: 800,
    api_base: 'https://open.bigmodel.cn/api/paas/v4', api_format: 'openai_chat',
    supports_tools: true, supports_streaming: true, supports_vision: false, enabled: true,
  },
  {
    model_id: 'glm-4-plus', provider: 'zhipu', tier: 'route',
    capabilities: { code: 0.82, reasoning: 0.80, tool_calling: 0.78, structured_output: 0.80, long_context: 0.85, chinese: 0.95 },
    price_input: 0.5, price_output: 1.5, max_context: 131072, avg_latency_ms: 800,
    api_base: 'https://open.bigmodel.cn/api/paas/v4', api_format: 'openai_chat',
    supports_tools: true, supports_streaming: true, supports_vision: false, enabled: true,
  },
  {
    model_id: 'gpt-4o', provider: 'openai', tier: 'work',
    capabilities: { code: 0.95, reasoning: 0.94, tool_calling: 0.95, structured_output: 0.95, long_context: 0.90, chinese: 0.85 },
    price_input: 2.5, price_output: 10.0, max_context: 131072, avg_latency_ms: 1200,
    api_base: 'https://api.openai.com/v1', api_format: 'openai_chat',
    supports_tools: true, supports_streaming: true, supports_vision: true, enabled: true,
  },
  {
    model_id: 'gpt-4o-mini', provider: 'openai', tier: 'route',
    capabilities: { code: 0.80, reasoning: 0.78, tool_calling: 0.82, structured_output: 0.82, long_context: 0.80, chinese: 0.75 },
    price_input: 0.15, price_output: 0.60, max_context: 131072, avg_latency_ms: 400,
    api_base: 'https://api.openai.com/v1', api_format: 'openai_chat',
    supports_tools: true, supports_streaming: true, supports_vision: true, enabled: true,
  },
  {
    model_id: 'claude-sonnet-4-5', provider: 'anthropic', tier: 'work',
    capabilities: { code: 0.93, reasoning: 0.95, tool_calling: 0.92, structured_output: 0.93, long_context: 0.95, chinese: 0.88 },
    price_input: 3.0, price_output: 15.0, max_context: 200000, avg_latency_ms: 1000,
    api_base: 'https://api.anthropic.com/v1', api_format: 'anthropic',
    supports_tools: true, supports_streaming: true, supports_vision: true, enabled: true,
  },
  {
    model_id: 'claude-sonnet-4-5', provider: 'anthropic', tier: 'verify',
    capabilities: { code: 0.93, reasoning: 0.95, tool_calling: 0.92, structured_output: 0.93, long_context: 0.95, chinese: 0.88 },
    price_input: 3.0, price_output: 15.0, max_context: 200000, avg_latency_ms: 1000,
    api_base: 'https://api.anthropic.com/v1', api_format: 'anthropic',
    supports_tools: true, supports_streaming: true, supports_vision: true, enabled: true,
  },
  {
    model_id: 'deepseek-chat', provider: 'deepseek', tier: 'work',
    capabilities: { code: 0.85, reasoning: 0.83, tool_calling: 0.80, structured_output: 0.82, long_context: 0.75, chinese: 0.92 },
    price_input: 0.14, price_output: 0.28, max_context: 65536, avg_latency_ms: 900,
    api_base: 'https://api.deepseek.com/v1', api_format: 'openai_chat',
    supports_tools: true, supports_streaming: true, supports_vision: false, enabled: true,
  },
  {
    model_id: 'deepseek-chat', provider: 'deepseek', tier: 'route',
    capabilities: { code: 0.85, reasoning: 0.83, tool_calling: 0.80, structured_output: 0.82, long_context: 0.75, chinese: 0.92 },
    price_input: 0.14, price_output: 0.28, max_context: 65536, avg_latency_ms: 900,
    api_base: 'https://api.deepseek.com/v1', api_format: 'openai_chat',
    supports_tools: true, supports_streaming: true, supports_vision: false, enabled: true,
  },
  {
    model_id: 'qwen-max', provider: 'qwen', tier: 'work',
    capabilities: { code: 0.80, reasoning: 0.82, tool_calling: 0.78, structured_output: 0.80, long_context: 0.80, chinese: 0.96 },
    price_input: 0.4, price_output: 1.2, max_context: 131072, avg_latency_ms: 700,
    api_base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api_format: 'openai_chat',
    supports_tools: true, supports_streaming: true, supports_vision: false, enabled: true,
  },
];

export class CapabilityRegistry {
  private readonly bindings = new Map<string, ModelBinding>();

  constructor() {
    for (const b of DEFAULT_MODELS) this.register(b);
  }

  register(b: ModelBinding): void {
    const key = `${b.provider}/${b.model_id}/${b.tier}`;
    this.bindings.set(key, b);
  }

  findModels(opts: {
    tier: ModelTier;
    requiredCapabilities?: readonly string[];
    minContext?: number;
    maxPricePerMillion?: number;
    requireVision?: boolean;
    requireTools?: boolean;
  }): ModelBinding[] {
    const results: ModelBinding[] = [];
    for (const b of this.bindings.values()) {
      if (!b.enabled || b.tier !== opts.tier) continue;
      if (opts.requireVision && !b.supports_vision) continue;
      if (opts.requireTools && !b.supports_tools) continue;
      if (opts.minContext && b.max_context < opts.minContext) continue;
      if (opts.maxPricePerMillion !== undefined) {
        if ((b.price_input + b.price_output) / 2 > opts.maxPricePerMillion) continue;
      }
      if (opts.requiredCapabilities) {
        const allMatch = opts.requiredCapabilities.every(c => (b.capabilities[c] ?? 0) > 0.5);
        if (!allMatch) continue;
      }
      results.push(b);
    }
    results.sort((a, b) => {
      const avgA = Object.values(a.capabilities).reduce((s, v) => s + v, 0) / Math.max(Object.values(a.capabilities).length, 1);
      const avgB = Object.values(b.capabilities).reduce((s, v) => s + v, 0) / Math.max(Object.values(b.capabilities).length, 1);
      if (avgB !== avgA) return avgB - avgA;
      return (a.price_input + a.price_output) - (b.price_input + b.price_output);
    });
    return results;
  }

  estimateCost(b: ModelBinding, inputTokens: number, outputTokens: number): number {
    return inputTokens / 1_000_000 * b.price_input + outputTokens / 1_000_000 * b.price_output;
  }

  listAll(): ModelBinding[] {
    return [...this.bindings.values()].filter(b => b.enabled);
  }

  filterByKeyAvailability(keyVault: KeyVault): ModelBinding[] {
    return this.listAll().filter(b => keyVault.hasProvider(b.provider));
  }
}
