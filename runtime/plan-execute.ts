/**
 * AH-RUNTIME-001: Plan+Execute Strategy
 *
 * Validate and freeze a RunPlan DAG before execution. Execute topologically.
 * File changes stay in VFS overlay until validation succeeds. Replanning
 * creates a new immutable revision. Crash restore never duplicates effects.
 */
import type { StrategyContext } from './reasoning-strategy.js';

export async function runPlanExecute(ctx: StrategyContext, messages: unknown[]): Promise<void> {
  const wf = ctx.config.run_plan?.workflow_graph;

  if (!wf || !wf.nodes || wf.nodes.length === 0) {
    ctx.deps.session.append('error', { reason: 'plan_execute requires a frozen WorkflowGraph — none provided' });
    ctx.terminate('malformed_response');
    return;
  }

  // Topological sort from edges
  const inDegree = new Map<string, number>();
  const graph = new Map<string, string[]>();
  const nodeMap = new Map<string, { step_id: string; step_type: string; status: string; tool_name?: string | null }>();
  for (const node of wf.nodes) {
    inDegree.set(node.step_id, 0);
    graph.set(node.step_id, []);
    nodeMap.set(node.step_id, node);
  }
  for (const edge of wf.edges) {
    graph.get(edge.from_step)?.push(edge.to_step);
    inDegree.set(edge.to_step, (inDegree.get(edge.to_step) ?? 0) + 1);
  }
  const queue: string[] = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const topoOrder: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    topoOrder.push(id);
    for (const next of graph.get(id) ?? []) {
      inDegree.set(next, (inDegree.get(next) ?? 0) - 1);
      if (inDegree.get(next) === 0) queue.push(next);
    }
  }
  if (topoOrder.length !== wf.nodes.length) {
    ctx.deps.session.append('error', { reason: 'workflow_graph has a cycle' });
    ctx.terminate('malformed_response');
    return;
  }

  // Track completed steps: rebuild from session event log for crash restore
  const completedSteps = new Set<string>();
  for (const ev of ctx.deps.session.getEvents()) {
    if (ev.type === 'tool_result') {
      const data = ev.data as { step?: string };
      if (data.step) completedSteps.add(data.step);
    }
    if (ev.type === 'system') {
      const data = ev.data as { step?: string; status?: string };
      if (data.step && data.status === 'done') completedSteps.add(data.step);
    }
  }
  const failedSteps = new Set<string>();

  for (const stepId of topoOrder) {
    if (ctx.terminated) return;
    if (ctx.iterations >= ctx.config.max_iterations) { ctx.terminate('iteration_limit'); return; }
    if (ctx.deps.signal?.aborted) { ctx.terminate('user_cancel'); return; }

    const node = nodeMap.get(stepId)!;
    const deps = wf.edges.filter((e: { to_step: string }) => e.to_step === stepId).map((e: { from_step: string }) => e.from_step);
    if (deps.some((d: string) => failedSteps.has(d))) {
      node.status = 'blocked';
      ctx.deps.session.append('system', { step: stepId, status: 'blocked', reason: 'dependency failed' });
      continue;
    }
    if (completedSteps.has(stepId)) continue;

    ctx.iterations++;
    node.status = 'executing';

    if (node.step_type === 'model_call') {
      const turn = await ctx.deps.modelCall(messages, ctx.iterations);
      ctx.recordTurn(turn);
      if (turn.stop_reason === 'length') { ctx.terminate('malformed_response'); return; }
      messages.push({ role: 'assistant', content: turn.decision_summary, tool_calls: turn.tool_calls });
      if (turn.tool_calls && turn.tool_calls.length > 0 && ctx.deps.toolExecute) {
        for (const tc of turn.tool_calls) {
          try {
            const result = await ctx.deps.toolExecute(tc.name, tc.arguments, {
              tool_call_id: tc.id,
              step_id: stepId,
              attempt_index: 1,
            });
            const lastTurn = ctx.turns[ctx.turns.length - 1]!;
            if (!lastTurn.tool_executed) lastTurn.tool_executed = { name: tc.name, arguments: tc.arguments, result };
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
          } catch (e) {
            ctx.deps.session.append('error', { step: stepId, tool: tc.name, error: (e as Error).message });
            ctx.deps.session.append('system', { step: stepId, action: 'overlay_discard', reason: 'tool failure' });
            ctx.terminate('malformed_response');
            return;
          }
        }
      }
      node.status = 'done';
      completedSteps.add(stepId);
    } else if (node.step_type === 'tool_call' && ctx.deps.toolExecute) {
      const lastTurn = ctx.turns[ctx.turns.length - 1];
      const tc = lastTurn?.model.tool_calls?.[0];
      if (tc) {
        try {
          const result = await ctx.deps.toolExecute(tc.name, tc.arguments, {
            tool_call_id: tc.id,
            step_id: stepId,
            attempt_index: 1,
          });
          ctx.turns[ctx.turns.length - 1]!.tool_executed = { name: tc.name, arguments: tc.arguments, result };
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
          node.status = 'done';
          completedSteps.add(stepId);
        } catch (e) {
          node.status = 'failed';
          failedSteps.add(stepId);
          ctx.deps.session.append('error', { step: stepId, error: (e as Error).message });
          ctx.deps.session.append('system', { step: stepId, action: 'overlay_discard', reason: 'tool failure' });
          ctx.terminate('malformed_response');
          return;
        }
      } else {
        node.status = 'done';
        completedSteps.add(stepId);
      }
    } else if (node.step_type === 'verification') {
      const satisfied = ctx.deps.goalSatisfied?.(ctx.turns) ?? false;
      node.status = satisfied ? 'done' : 'failed';
      if (satisfied) completedSteps.add(stepId);
      else failedSteps.add(stepId);
      ctx.deps.session.append('system', { step: stepId, status: node.status, verified: satisfied });
    } else {
      node.status = 'done';
      completedSteps.add(stepId);
    }
  }

 if (!ctx.terminated) {
   // If any step failed or was blocked, discard overlay and terminate as failure
   if (failedSteps.size > 0) {
     ctx.deps.session.append('system', { action: 'overlay_discard', reason: `${failedSteps.size} step(s) failed` });
     ctx.terminate('malformed_response');
     return;
   }
   // Only commit if ALL steps completed and no failures
   ctx.deps.session.append('system', { action: 'overlay_commit', reason: 'all steps completed' });
   if (ctx.deps.goalSatisfied?.(ctx.turns)) ctx.terminate('goal_satisfied');
   else ctx.terminate('completed');
 }
}
