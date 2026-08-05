/**
 * AH-RUNTIME-001: ReAct Strategy
 *
 * Loop: decision summary -> proposed action -> PEP/Capability -> action -> observation.
 * Stop on completion, denial, cancellation, timeout, budget, or max iterations.
 * Observation may change the next action. Never persists private reasoning text.
 */

import type { Message, ProviderRequest, ParsedResponse } from '../gateway/provider.js';
import type { StrategyContext, StrategyResult, ToolExecutor, ModelCaller, ReasoningStrategyHandler } from './reasoning-strategy.js';
import type { ToolSpec } from '../gateway/provider.js';

export class ReactStrategy implements ReasoningStrategyHandler {
  readonly strategy_type = 'react' as const;

  async execute(
    messages: Message[],
    ctx: StrategyContext,
    model: ModelCaller,
    toolExecutor?: ToolExecutor,
    availableTools?: ToolSpec[],
  ): Promise<StrategyResult> {
    // Default 50: coding verticals need 10-15 steps, plus retries and path switches.
    // Manus typical tasks run ~50 tool calls. max_repeated_tool_calls=3 prevents loops.
    const maxIterations = ctx.max_iterations ?? 50;
    const maxRepeatedToolCalls = 3; // AH-RUNTIME-LOOP-001: oscillation detection
    const observations: string[] = [];
    const deniedActions: string[] = [];
    let toolCallsMade = 0;
    let modelCalls = 0;
    let stopReason: StrategyResult['stop_reason'] = 'max_iterations';
    let output = '';
    // Track tool call signatures for oscillation detection
    const toolCallHistory = new Map<string, number>();

    const conversationMessages = [...messages];

    for (let i = 0; i < maxIterations; i++) {
      // Check budget
      if (ctx.budget_tokens !== undefined && modelCalls > 0 && modelCalls * 1000 > ctx.budget_tokens) {
        stopReason = 'budget_exhausted';
        break;
      }

      // P1-01: Pass tools to the model via native function calling
      const req: ProviderRequest = {
        messages: conversationMessages,
        tools: availableTools,
      };
      const response: ParsedResponse = model.complete(req);
      modelCalls++;

      // P1-12: Truncation handling — stop_reason=length means output was cut off.
      // Do NOT execute the truncated tool call. Return error to LLM.
      if (response.stop_reason === 'length') {
        observations.push('[truncation] Model output was truncated (stop_reason=length). Output too long — split into multiple steps.');
        conversationMessages.push(
          { role: 'assistant', content: response.content },
          { role: 'user', content: 'Your previous output was truncated. Please split the task into smaller steps and try again.' },
        );
        // Continue the loop — let the model try again with smaller output
        continue;
      }

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

        // AH-RUNTIME-LOOP-001: Tool oscillation detection
        const callSig = `${tc.name}:${JSON.stringify(tc.arguments)}`;
        const count = (toolCallHistory.get(callSig) ?? 0) + 1;
        toolCallHistory.set(callSig, count);
        if (count > maxRepeatedToolCalls) {
          stopReason = 'max_iterations';
          deniedActions.push(`tool_oscillation: ${tc.name} called ${count} times with same args`);
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
      if (stopReason === 'max_iterations' && deniedActions.some((d) => d.includes('oscillation'))) break;
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
