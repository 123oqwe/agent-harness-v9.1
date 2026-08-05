/**
 * AH-RUNTIME-001: Reasoning Strategy Interface
 *
 * Shared interface for Direct, ReAct, and Plan+Execute strategies.
 * All strategies share the same security control plane.
 */

import type { ProviderRequest, ParsedResponse, Message } from '../gateway/provider.js';
import type { ToolSpec } from '../gateway/provider.js';
import type { RoutingResult } from '../router/static-router.js';

export type ReasoningStrategy = 'direct' | 'react' | 'plan_execute';

export interface StrategyContext {
  run_id: string;
  step_id: string;
  attempt_id: string;
  tenant_id: string;
  subject: string;
  routing: RoutingResult;
  max_iterations?: number;
  budget_tokens?: number;
  timeout_ms?: number;
}

export interface ToolExecutionResult {
  tool_name: string;
  success: boolean;
  output: string;
  error?: string;
}

export interface StrategyResult {
  strategy: ReasoningStrategy;
  output: string;
  tool_calls_made: number;
  iterations: number;
  model_calls: number;
  stop_reason: 'completed' | 'denied' | 'cancelled' | 'timeout' | 'budget_exhausted' | 'max_iterations' | 'error';
  observations: string[];
  denied_actions: string[];
}

export interface ToolExecutor {
  execute(toolName: string, args: Record<string, unknown>): Promise<ToolExecutionResult>;
}

export interface ModelCaller {
  complete(req: ProviderRequest): ParsedResponse;
}

export interface ReasoningStrategyHandler {
  readonly strategy_type: ReasoningStrategy;
  execute(
    messages: Message[],
    ctx: StrategyContext,
    model: ModelCaller,
    toolExecutor?: ToolExecutor,
    availableTools?: ToolSpec[],
  ): Promise<StrategyResult>;
}
