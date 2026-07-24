/**
 * AH-RUNTIME-001: Direct Strategy
 *
 * Exactly one model call. No tool or skill execution.
 * A model tool-call response is a strategy violation, not an implicit switch.
 */
import type { StrategyContext } from './reasoning-strategy.js';

export async function runDirect(ctx: StrategyContext, messages: unknown[]): Promise<void> {
  ctx.iterations = 1;
  const turn = await ctx.deps.modelCall(messages, 1);
  ctx.recordTurn(turn);

  if (turn.tool_calls && turn.tool_calls.length > 0) {
    ctx.deps.session.append('system', { reason: 'strategy_violation', detail: 'direct strategy received tool_call, requires RunPlan revision' });
    ctx.terminate('malformed_response');
    return;
  }
  if (turn.stop_reason === 'length') { ctx.terminate('malformed_response'); return; }
  if (ctx.deps.goalSatisfied?.(ctx.turns)) ctx.terminate('goal_satisfied');
  else ctx.terminate('completed');
}
