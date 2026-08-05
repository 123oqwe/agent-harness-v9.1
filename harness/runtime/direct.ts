/**
 * AH-RUNTIME-001: Direct Strategy
 *
 * Exactly one ModelGateway call. No tool or skill execution.
 * A model tool-call response is a strategy violation, not an implicit switch.
 */

import type { Message, ProviderRequest, ParsedResponse } from '../gateway/provider.js';
import type { ToolSpec } from '../gateway/provider.js';
import type { StrategyContext, StrategyResult, ModelCaller, ReasoningStrategyHandler } from './reasoning-strategy.js';

export class DirectStrategy implements ReasoningStrategyHandler {
  readonly strategy_type = 'direct' as const;

  async execute(
    messages: Message[],
    ctx: StrategyContext,
    model: ModelCaller,
    _toolExecutor?: unknown,
    _availableTools?: ToolSpec[],
  ): Promise<StrategyResult> {
    const req: ProviderRequest = { messages };
    const response: ParsedResponse = model.complete(req);

    // Strategy violation: model requested tools in direct mode
    if (response.tool_calls && response.tool_calls.length > 0) {
      return {
        strategy: 'direct',
        output: '',
        tool_calls_made: 0,
        iterations: 1,
        model_calls: 1,
        stop_reason: 'error',
        observations: [],
        denied_actions: [`strategy_violation: model requested ${response.tool_calls.length} tool call(s) in direct mode`],
      };
    }

    return {
      strategy: 'direct',
      output: response.content,
      tool_calls_made: 0,
      iterations: 1,
      model_calls: 1,
      stop_reason: 'completed',
      observations: [],
      denied_actions: [],
    };
  }
}
