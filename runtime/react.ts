/**
 * AH-RUNTIME-001: ReAct Strategy
 *
 * Loop: decision summary -> proposed action -> PEP/Capability -> action -> observation.
 * Stop on completion, denial, cancellation, timeout, budget, or max iterations.
 * Observation may change the next action. Never persists private reasoning text.
 */
import type { StrategyContext } from './reasoning-strategy.js';

export async function runReact(ctx: StrategyContext, messages: unknown[]): Promise<void> {
  const toolCallCounts = new Map<string, number>();
  while (ctx.iterations < ctx.config.max_iterations && !ctx.terminated) {
    if (ctx.deps.signal?.aborted) { ctx.terminate('user_cancel'); return; }
    if (ctx.config.deadline_ms && Date.now() - ctx.startTime > ctx.config.deadline_ms) { ctx.terminate('deadline'); return; }
    if (ctx.config.budget_tokens) {
      const usedTokens = ctx.turns.reduce((sum, t) => sum + (t.model.usage?.input_tokens ?? 0) + (t.model.usage?.output_tokens ?? 0), 0);
      if (usedTokens >= ctx.config.budget_tokens) { ctx.terminate('budget_exhausted'); return; }
    }
    ctx.iterations++;
    const turn = await ctx.deps.modelCall(messages, ctx.iterations);
    ctx.recordTurn(turn);

    if (turn.stop_reason === 'length') { ctx.terminate('malformed_response'); return; }
    if (turn.stop_reason === 'content_filter') { ctx.terminate('model_refusal'); return; }
    if (turn.tool_calls && turn.tool_calls.length > 0) {
      messages.push({ role: 'assistant', content: turn.decision_summary, tool_calls: turn.tool_calls });
      for (const tc of turn.tool_calls) {
        const key = `${tc.name}:${JSON.stringify(tc.arguments, Object.keys(tc.arguments).sort())}`;
        const count = (toolCallCounts.get(key) ?? 0) + 1;
        toolCallCounts.set(key, count);
        if (count >= 3) { ctx.terminate('tool_oscillation'); return; }
        if (!ctx.deps.toolExecute) { ctx.terminate('malformed_response'); return; }
        try {
          const result = await ctx.deps.toolExecute(tc.name, tc.arguments, {
            tool_call_id: tc.id,
            step_id: `react-${ctx.iterations}`,
            attempt_index: count,
          });
          const lastTurn = ctx.turns[ctx.turns.length - 1]!;
          if (!lastTurn.tool_executed) lastTurn.tool_executed = { name: tc.name, arguments: tc.arguments, result };
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        } catch (e) {
          const errMsg = (e as Error).message;
          ctx.deps.session.append('error', { tool: tc.name, error: errMsg, error_type: 'tool_execution' });
          if (ctx.iterations >= ctx.config.max_iterations) {
            ctx.terminate('malformed_response'); return;
          }
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: errMsg }) });
        }
      }
    } else {
      if (ctx.deps.goalSatisfied?.(ctx.turns)) { ctx.terminate('goal_satisfied'); return; }
      if (ctx.detectContextReset()) { ctx.terminate('context_reset'); return; }
      messages.push({ role: 'assistant', content: turn.decision_summary });
      continue;
    }
  }
  if (!ctx.terminated) ctx.terminate('iteration_limit');
}
