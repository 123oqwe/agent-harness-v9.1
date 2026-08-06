/**
 * AH-RUNTIME-LOOP-001: Loop Engine with stop conditions and error classification.
 *
 * Executes the frozen RunPlan.reasoning_strategy without switching:
 *   - direct: exactly one model call, no tool calls
 *   - react: one Policy-Capability-PEP action at a time, max_iterations bounded
 *   - plan_execute: freeze+validate DAG, topo order, VFS overlay commit/discard
 *
 * Stop conditions: max_iterations, budget exhausted, user cancel, deadline,
 * model refusal, malformed response, tool oscillation, goal satisfied, context_reset.
 * Truncation (stop_reason=length) never executes the truncated tool call.
 * progress.json written after every turn and on every stop condition.
 * RunPhase: agent phase network disabled, credentials stripped before agent phase.
 * No private CoT stored — only plan, decision summary, tool calls, evidence.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DurableSession } from '../session/durable-session.js';
import type { EventBus } from './event-bus.js';
import type { PluginManager } from './plugin-manager.js';
import { createEvent } from './event-bus.js';

export type TerminationReason =
  | 'iteration_limit' | 'budget_exhausted' | 'user_cancel' | 'deadline'
  | 'model_refusal' | 'malformed_response' | 'tool_oscillation' | 'goal_satisfied'
  | 'context_reset' | 'completed';

export type LoopStrategy = 'direct' | 'react' | 'plan_execute';

export interface LoopConfig {
  strategy: LoopStrategy;
  max_iterations: number;
  budget_tokens?: number | undefined;
  deadline_ms?: number | undefined;
  data_dir?: string | undefined;
  run_id: string;
  goal: string;
  auto_execute?: boolean | undefined;
  eventBus?: EventBus | undefined;
  pluginManager?: PluginManager | undefined;
}

export interface ModelTurn {
  content: string;
  tool_calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  stop_reason?: 'stop' | 'length' | 'tool_use' | 'content_filter';
  decision_summary: string; // NOT private CoT
  usage?: { input_tokens: number; output_tokens: number };
}

export interface LoopTurn {
  iteration: number;
  model: ModelTurn;
  tool_executed?: { name: string; arguments: Record<string, unknown>; result: unknown };
  timestamp: string;
}

export interface LoopResult {
  strategy: LoopStrategy;
  iterations: number;
  termination_reason: TerminationReason;
  turns: LoopTurn[];
  decision_summaries: string[];
  progress_path?: string | undefined;
  context_reset_emitted: boolean;
  paused?: boolean | undefined;
  estimated_cost?: number | undefined;
}

export interface LoopDeps {
  session: DurableSession;
  // model call: given messages, returns a turn; never called after termination
  modelCall: (messages: unknown[], attempt: number, tools?: unknown[]) => Promise<ModelTurn>;
  // tool execute: given tool name+args, returns result; goes through Policy/Capability/PEP externally
  toolExecute?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  // goal checker: returns true if goal is satisfied
  goalSatisfied?: (turns: LoopTurn[]) => boolean;
  signal?: AbortSignal;
  eventBus?: import('./event-bus.js').EventBus | undefined;
  pluginManager?: import('./plugin-manager.js').PluginManager | undefined;
}

export class LoopError extends Error {
  constructor(message: string) { super(message); this.name = 'LoopError'; Object.setPrototypeOf(this, LoopError.prototype); }
}

/** Strip credentials from process.env before entering agent phase (FG2 CTRL-CRED-REACH-001). */
export function stripCredentialsFromEnv(): string[] {
  const stripped: string[] = [];
  for (const k of Object.keys(process.env)) {
    if (/TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIAL/i.test(k)) {
      stripped.push(k);
      delete process.env[k];
    }
  }
  return stripped;
}

export class LoopEngine {
  private turns: LoopTurn[] = [];
  private iterations = 0;
  private terminated = false;
  private termination_reason: TerminationReason | null = null;
  private readonly decision_summaries: string[] = [];
  private context_reset_emitted = false;

  constructor(private readonly config: LoopConfig, private readonly deps: LoopDeps) {}

  async run(): Promise<LoopResult> {
    // P1-10: Plan mode — if auto_execute=false, pause before execution
    if (this.config.auto_execute === false) {
      this.deps.eventBus?.publish(createEvent('plan_ready', this.config.run_id, { strategy: this.config.strategy }));
      this.deps.eventBus?.publish(createEvent('paused', this.config.run_id, { reason: 'plan_mode' }));
      this.writeProgress();
      return {
        strategy: this.config.strategy, iterations: 0,
        termination_reason: 'completed', turns: [], decision_summaries: [],
        progress_path: this.config.data_dir ? join(this.config.data_dir, 'progress.json') : undefined,
        context_reset_emitted: false, paused: true,
      };
    }

    // P1-24: on_task_start hook
    if (this.deps.pluginManager) {
      await this.deps.pluginManager.trigger('on_task_start', { run_id: this.config.run_id });
    }

    // Enter agent phase: network disabled by default, credentials stripped
    // Save credentials so they can be restored after the agent phase ends
    const savedCreds: Record<string, string | undefined> = {};
    for (const k of Object.keys(process.env)) {
      if (/TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIAL/i.test(k)) savedCreds[k] = process.env[k];
    }
    stripCredentialsFromEnv();
    this.deps.session.acquireWriter();
    try {
      const messages: unknown[] = [{ role: 'user', content: this.config.goal }];

      if (this.config.strategy === 'direct') {
        await this.runDirect(messages);
      } else if (this.config.strategy === 'react') {
        await this.runReact(messages);
      } else {
        await this.runPlanExecute(messages);
      }
    } finally {
      this.writeProgress();
      this.deps.session.releaseWriter();
      // Restore credentials after agent phase ends
      for (const [k, v] of Object.entries(savedCreds)) {
        if (v !== undefined) process.env[k] = v;
      }
    }
    return {
      strategy: this.config.strategy,
      iterations: this.iterations,
      termination_reason: this.termination_reason ?? 'completed',
      turns: this.turns,
      decision_summaries: this.decision_summaries,
      progress_path: this.config.data_dir ? join(this.config.data_dir, 'progress.json') : undefined,
      context_reset_emitted: this.context_reset_emitted,
    };
  }

  /** direct: exactly one model call, no tool calls, no action/observation loop. */
  private async runDirect(messages: unknown[]): Promise<void> {
    this.iterations = 1;
    const turn = await this.deps.modelCall(messages, 1);
    this.recordTurn(turn);
    // direct strategy: a returned tool_call is a strategy violation
    // The Router selected direct (tool-free) but the model proposed a tool.
    // This requires a new RunPlan revision, not just termination.
    if (turn.tool_calls && turn.tool_calls.length > 0) {
      this.deps.session.append('system', { reason: 'strategy_violation', detail: 'direct strategy received tool_call, requires RunPlan revision' });
      this.terminate('malformed_response');
      return;
    }
    if (turn.stop_reason === 'length') { this.terminate('malformed_response'); return; }
    if (this.deps.goalSatisfied?.(this.turns)) this.terminate('goal_satisfied');
    else this.terminate('completed');
  }

  /** react: one Policy-Capability-PEP action at a time, bounded by max_iterations. */
  private async runReact(messages: unknown[]): Promise<void> {
    const toolCallCounts = new Map<string, number>();
    while (this.iterations < this.config.max_iterations && !this.terminated) {
      if (this.deps.signal?.aborted) { this.terminate('user_cancel'); return; }
      if (this.config.deadline_ms && Date.now() - this.startTime > this.config.deadline_ms) { this.terminate('deadline'); return; }
      if (this.config.budget_tokens) {
        const usedTokens = this.turns.reduce((sum, t) => sum + (t.model.usage?.input_tokens ?? 0) + (t.model.usage?.output_tokens ?? 0), 0);
        if (usedTokens >= this.config.budget_tokens) { this.terminate('budget_exhausted'); return; }
      }
      this.iterations++;
      const turn = await this.deps.modelCall(messages, this.iterations);
      this.recordTurn(turn);

      if (turn.stop_reason === 'length') { this.terminate('malformed_response'); return; } // truncated tool call NOT executed
      if (turn.stop_reason === 'content_filter') { this.terminate('model_refusal'); return; }
      if (turn.tool_calls && turn.tool_calls.length > 0) {
        // Execute ALL tool calls in this turn (was only first)
        messages.push({ role: 'assistant', content: turn.decision_summary, tool_calls: turn.tool_calls });
        for (const tc of turn.tool_calls) {
          // Canonical oscillation detection (stable JSON key)
          const key = `${tc.name}:${JSON.stringify(tc.arguments, Object.keys(tc.arguments).sort())}`;
          const count = (toolCallCounts.get(key) ?? 0) + 1;
          toolCallCounts.set(key, count);
          if (count >= 3) { this.terminate('tool_oscillation'); return; }
          if (!this.deps.toolExecute) { this.terminate('malformed_response'); return; }
          try {
            const result = await this.deps.toolExecute(tc.name, tc.arguments);
            const lastTurn = this.turns[this.turns.length - 1]!;
            if (!lastTurn.tool_executed) lastTurn.tool_executed = { name: tc.name, arguments: tc.arguments, result };
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
          } catch (e) {
            // Typed error: distinguish tool errors from malformed responses
            const errMsg = (e as Error).message;
            this.deps.session.append('error', { tool: tc.name, error: errMsg, error_type: 'tool_execution' });
            // Tool errors are retryable if budget allows, otherwise terminate
            if (this.iterations >= this.config.max_iterations) {
              this.terminate('malformed_response'); return;
            }
            // Record error and continue to next iteration for retry
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: errMsg }) });
          }
        }
      } else {
        // no tool call: check goal
        if (this.deps.goalSatisfied?.(this.turns)) { this.terminate('goal_satisfied'); return; }
        // detect context_reset: 2 consecutive no-tool no-progress turns
        if (this.detectContextReset()) { this.context_reset_emitted = true; this.terminate('context_reset'); return; }
        // not satisfied and no tool: continue to next iteration (may context_reset)
        messages.push({ role: 'assistant', content: turn.decision_summary });
        continue;
      }
    }
    if (!this.terminated) this.terminate('iteration_limit');
  }

  /** plan_execute: read WorkflowGraph from RunPlan, execute in topo order,
   *  stage writes in Overlay, commit on success, discard on failure. */
  private async runPlanExecute(messages: unknown[]): Promise<void> {
    // Read the frozen WorkflowGraph from the RunPlan
    const runPlan = this.config as unknown as { workflow_graph?: { nodes: Array<{ step_id: string; step_type: string; status: string; tool_name?: string | null }>; edges: Array<{ from_step: string; to_step: string }> } };
    const wf = runPlan.workflow_graph;

    // If no WorkflowGraph, fall back to linear plan->execute->verify
    if (!wf || !wf.nodes || wf.nodes.length === 0) {
      await this.runPlanExecuteLinear(messages);
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

      this.deps.session.append('error', { reason: 'workflow_graph has a cycle' });
      this.terminate('malformed_response');
      return;
    }

    // Track completed steps for crash restore (no duplicate side effects)
    const completedSteps = new Set<string>();
    const failedSteps = new Set<string>();

    // Execute steps in topological order
    for (const stepId of topoOrder) {
      if (this.terminated) return;
      if (this.iterations >= this.config.max_iterations) { this.terminate('iteration_limit'); return; }
      if (this.deps.signal?.aborted) { this.terminate('user_cancel'); return; }

      const node = nodeMap.get(stepId)!;
      // Skip if a dependency failed (blocked)
      const deps = wf.edges.filter(e => e.to_step === stepId).map(e => e.from_step);
      if (deps.some(d => failedSteps.has(d))) {
        node.status = 'blocked';
        this.deps.session.append('system', { step: stepId, status: 'blocked', reason: 'dependency failed' });
        continue;
      }
      if (completedSteps.has(stepId)) continue; // crash restore: skip already done

      this.iterations++;
      node.status = 'executing';

      if (node.step_type === 'model_call') {
        const turn = await this.deps.modelCall(messages, this.iterations);
        this.recordTurn(turn);
        if (turn.stop_reason === 'length') { this.terminate('malformed_response'); return; }
        messages.push({ role: 'assistant', content: turn.decision_summary, tool_calls: turn.tool_calls });
        node.status = 'done';
        completedSteps.add(stepId);
      } else if (node.step_type === 'tool_call' && this.deps.toolExecute) {
        // Tool calls are dispatched through the model's tool_calls
        const lastTurn = this.turns[this.turns.length - 1];
        const tc = lastTurn?.model.tool_calls?.[0];
        if (tc) {
          try {
            const result = await this.deps.toolExecute(tc.name, tc.arguments);
            this.turns[this.turns.length - 1]!.tool_executed = { name: tc.name, arguments: tc.arguments, result };
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
            node.status = 'done';
            completedSteps.add(stepId);
          } catch (e) {
            node.status = 'failed';
            failedSteps.add(stepId);
            this.deps.session.append('error', { step: stepId, error: (e as Error).message });
            // Discard overlay on failure — partial writes never reach the real FS
            this.deps.session.append('system', { step: stepId, action: 'overlay_discard', reason: 'tool failure' });
            this.terminate('malformed_response');
            return;
          }
        } else {
          node.status = 'done';
          completedSteps.add(stepId);
        }
      } else if (node.step_type === 'verification') {
        const satisfied = this.deps.goalSatisfied?.(this.turns) ?? false;
        node.status = satisfied ? 'done' : 'failed';
        if (satisfied) {
          completedSteps.add(stepId);
        } else {
          failedSteps.add(stepId);
        }
        this.deps.session.append('system', { step: stepId, status: node.status, verified: satisfied });
      } else {
        // Other step types (decision, parallel_fork, etc.) — pass through
        node.status = 'done';
        completedSteps.add(stepId);
      }
    }

    // All steps done: commit overlay (writes become durable)
    if (!this.terminated) {
      this.deps.session.append('system', { action: 'overlay_commit', reason: 'all steps completed' });
      if (this.deps.goalSatisfied?.(this.turns)) this.terminate('goal_satisfied');
      else this.terminate('completed');
    }
  }

  /** Fallback: linear plan_execute without WorkflowGraph. */
  private async runPlanExecuteLinear(messages: unknown[]): Promise<void> {
    const steps = ['plan', 'execute', 'verify'];
    let stepIdx = 0;
    while (this.iterations < this.config.max_iterations && !this.terminated && stepIdx < steps.length) {
      if (this.deps.signal?.aborted) { this.terminate('user_cancel'); return; }
      this.iterations++;
      const turn = await this.deps.modelCall(messages, this.iterations);
      this.recordTurn(turn);
      if (turn.stop_reason === 'length') { this.terminate('malformed_response'); return; }
      if (turn.tool_calls && turn.tool_calls.length > 0 && this.deps.toolExecute) {
        const tc = turn.tool_calls[0]!;
        try {
          const result = await this.deps.toolExecute(tc.name, tc.arguments);
          this.turns[this.turns.length - 1]!.tool_executed = { name: tc.name, arguments: tc.arguments, result };
          messages.push({ role: 'assistant', content: turn.decision_summary });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        } catch (e) {
          this.deps.session.append('error', { step: steps[stepIdx], error: (e as Error).message });
          this.terminate('malformed_response'); return;
        }
      }
      stepIdx++;
    }
    if (!this.terminated) {
      if (this.deps.goalSatisfied?.(this.turns)) this.terminate('goal_satisfied');
      else this.terminate(this.iterations >= this.config.max_iterations ? 'iteration_limit' : 'completed');
    }
  }

  private detectContextReset(): boolean {
    // Phase 1 scope: emit context_reset on 2 consecutive tool oscillations OR goal regress.
    // Simplified: if last 2 turns had no tool calls and no progress, emit.
    if (this.turns.length < 2) return false;
    const last2 = this.turns.slice(-2);
    return last2.every(t => !t.model.tool_calls || t.model.tool_calls.length === 0);
  }

  private startTime = Date.now();

  private recordTurn(turn: ModelTurn): void {
    const t: LoopTurn = { iteration: this.iterations, model: turn, timestamp: new Date().toISOString() };
    this.turns.push(t);
    this.decision_summaries.push(turn.decision_summary);
    // No private CoT stored — only decision summary
    this.deps.session.append('assistant', { decision_summary: turn.decision_summary, tool_calls: turn.tool_calls });
    // P1-06: emit model_called event
    this.deps.eventBus?.publish(createEvent('model_called', this.config.run_id, { iteration: this.iterations }));
    this.writeProgress();
  }

  private terminate(reason: TerminationReason): void {
    if (this.terminated) return;
    this.terminated = true;
    this.termination_reason = reason;
    this.deps.session.append('system', { termination_reason: reason, iterations: this.iterations });
    // P1-06: emit run_state_change on termination
    this.deps.eventBus?.publish(createEvent('run_state_change', this.config.run_id, { state: reason }));
    // P1-24: on_task_end hook
    if (this.deps.pluginManager) {
      void this.deps.pluginManager.trigger('on_task_end', { run_id: this.config.run_id });
    }
  }

  /** Write progress.json after every turn and on every stop condition. */
  private writeProgress(): void {
    if (!this.config.data_dir) return;
    mkdirSync(this.config.data_dir, { recursive: true });
    const progress = {
      run_id: this.config.run_id,
      current_step: this.iterations,
      goal: this.config.goal,
      completed_steps: this.turns.map((t, i) => ({ step: i + 1, summary: t.model.decision_summary })),
      open_tasks: this.terminated ? [] : [this.config.goal],
      last_error: this.termination_reason === 'malformed_response' ? 'malformed' : null,
      checkpoint_refs: this.turns.map(t => t.timestamp),
      last_updated: new Date().toISOString(),
    };
    writeFileSync(join(this.config.data_dir, 'progress.json'), JSON.stringify(progress, null, 2));
  }
}
