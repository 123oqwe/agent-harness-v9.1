/**
 * AH-RUNTIME-001: ReAct Strategy
 *
 * Loop: decision summary -> proposed action -> PEP/Capability -> action -> observation.
 * Stop on completion, denial, cancellation, timeout, budget, or max iterations.
 * Observation may change the next action. Never persists private reasoning text.
 */

import type { Message, ProviderRequest, ParsedResponse } from '../gateway/provider.js';
import type { StrategyContext, StrategyResult, ToolExecutor, ModelCaller, ReasoningStrategyHandler } from './reasoning-strategy.js';

export class ReactStrategy implements ReasoningStrategyHandler {
  readonly strategy_type = 'react' as const;

  async execute(
    messages: Message[],
    ctx: StrategyContext,
    model: ModelCaller,
    toolExecutor?: ToolExecutor,
  ): Promise<StrategyResult> {
    const maxIterations = ctx.max_iterations ?? 10;
    const observations: string[] = [];
    const deniedActions: string[] = [];
    let toolCallsMade = 0;
    let modelCalls = 0;
    let stopReason: StrategyResult['stop_reason'] = 'max_iterations';
    let output = '';

    const conversationMessages = [...messages];

    for (let i = 0; i < maxIterations; i++) {
      // Check budget
      if (ctx.budget_tokens !== undefined && modelCalls > 0 && modelCalls * 1000 > ctx.budget_tokens) {
        stopReason = 'budget_exhausted';
        break;
      }

      const req: ProviderRequest = { messages: conversationMessages };
      const response: ParsedResponse = model.complete(req);
      modelCalls++;

      // If no tool calls, we're done
      if (!response.tool_calls || response.tool_calls.length === 0) {
        output = response.content;
        stopReason = 'completed';
        break;
      }

      // Execute tool calls
      for (const tc of response.tool_calls) {
        if (!toolExecutor) {
          deniedActions.push(`no_tool_executor: ${tc.name}`);
          stopReason = 'error';
          break;
        }

        try {
          const result = await toolExecutor.execute(tc.name, tc.arguments);
          toolCallsMade++;

          if (result.success) {
            observations.push(`[${tc.name}] ${result.output}`);
            conversationMessages.push(
              { role: 'assistant', content: response.content, tool_calls: response.tool_calls },
              { role: 'tool', content: result.output, tool_call_id: tc.id },
            );
          } else {
            observations.push(`[${tc.name}] ERROR: ${result.error ?? 'unknown'}`);
            conversationMessages.push(
              { role: 'assistant', content: response.content, tool_calls: response.tool_calls },
              { role: 'tool', content: `Error: ${result.error ?? 'unknown'}`, tool_call_id: tc.id },
            );
          }
        } catch (err) {
          deniedActions.push(`tool_error: ${tc.name} - ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (stopReason === 'error') break;
    }

    return {
      strategy: 'react',
      output,
      tool_calls_made: toolCallsMade,
      iterations: modelCalls,
      model_calls: modelCalls,
      stop_reason: stopReason,
      observations,
      denied_actions: deniedActions,
    };
  }
}
