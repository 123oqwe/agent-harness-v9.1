/** Direct: exactly one model call, no tool execution. */
import type { StrategyContext } from './reasoning-strategy.js';

export async function runDirect(
  context: StrategyContext,
  messages: unknown[],
): Promise<void> {
  const preflight = context.preflight();
  if (preflight) {
    context.terminate(preflight);
    return;
  }
  context.iterations = 1;
  const turn = await context.deps.modelCall(
    messages,
    1,
    context.nextModelBudget(),
  );
  const recorded = context.recordTurn(turn);

  if (turn.stop_reason === 'length') {
    context.terminate('malformed_response');
    return;
  }
  if (turn.stop_reason === 'content_filter') {
    context.terminate('model_refusal');
    return;
  }
  if (context.budgetExceeded()) {
    context.terminate('budget_exhausted');
    return;
  }
  if (turn.tool_calls && turn.tool_calls.length > 0) {
    for (const call of turn.tool_calls) {
      context.recordToolCall(recorded, call, 'direct');
      context.recordObservation(
        recorded,
        call,
        'rejected',
        'direct strategy forbids tool calls',
        'direct',
      );
    }
    context.deps.session.append('system', {
      reason: 'strategy_violation',
      detail: 'direct strategy received tool_call',
    });
    context.terminate('malformed_response');
    return;
  }
  context.terminate('completed');
}
