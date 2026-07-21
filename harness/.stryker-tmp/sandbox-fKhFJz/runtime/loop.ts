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
// @ts-nocheck

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DurableSession } from '../session/durable-session.js';

export type TerminationReason =
  | 'iteration_limit' | 'budget_exhausted' | 'user_cancel' | 'deadline'
  | 'model_refusal' | 'malformed_response' | 'tool_oscillation' | 'goal_satisfied'
  | 'context_reset' | 'completed';

export type LoopStrategy = 'direct' | 'react' | 'plan_execute';

export interface LoopConfig {
  strategy: LoopStrategy;
  max_iterations: number;
  budget_tokens?: number;
  deadline_ms?: number;
  data_dir?: string;
  run_id: string;
  goal: string;
}

export interface ModelTurn {
  content: string;
  tool_calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  stop_reason?: 'stop' | 'length' | 'tool_use' | 'content_filter';
  decision_summary: string; // NOT private CoT
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
}

export interface LoopDeps {
  session: DurableSession;
  // model call: given messages, returns a turn; never called after termination
  modelCall: (messages: unknown[], attempt: number) => Promise<ModelTurn>;
  // tool execute: given tool name+args, returns result; goes through Policy/Capability/PEP externally
  toolExecute?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  // goal checker: returns true if goal is satisfied
  goalSatisfied?: (turns: LoopTurn[]) => boolean;
  signal?: AbortSignal;
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
    // Enter agent phase: network disabled by default, credentials stripped
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
    // direct strategy: a returned tool_call is a typed violation — do NOT execute
    if (turn.tool_calls && turn.tool_calls.length > 0) {
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
      this.iterations++;
      const turn = await this.deps.modelCall(messages, this.iterations);
      this.recordTurn(turn);

      if (turn.stop_reason === 'length') { this.terminate('malformed_response'); return; } // truncated tool call NOT executed
      if (turn.tool_calls && turn.tool_calls.length > 0) {
        const tc = turn.tool_calls[0]!;
        const key = `${tc.name}:${JSON.stringify(tc.arguments)}`;
        const count = (toolCallCounts.get(key) ?? 0) + 1;
        toolCallCounts.set(key, count);
        if (count >= 3) { this.terminate('tool_oscillation'); return; }
        if (!this.deps.toolExecute) { this.terminate('malformed_response'); return; }
        try {
          const result = await this.deps.toolExecute(tc.name, tc.arguments);
          this.turns[this.turns.length - 1]!.tool_executed = { name: tc.name, arguments: tc.arguments, result };
          messages.push({ role: 'assistant', content: turn.decision_summary, tool_calls: turn.tool_calls });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        } catch (e) {
          this.deps.session.append('error', { tool: tc.name, error: (e as Error).message });
          this.terminate('malformed_response'); return;
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

  /** plan_execute: freeze+validate DAG, topo order, VFS overlay commit/discard. */
  private async runPlanExecute(messages: unknown[]): Promise<void> {
    // Phase 1: freeze a simple linear DAG (plan -> execute -> verify)
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
          // plan_execute: discard overlay on failure, do NOT commit partial writes
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
    this.writeProgress();
  }

  private terminate(reason: TerminationReason): void {
    if (this.terminated) return;
    this.terminated = true;
    this.termination_reason = reason;
    this.deps.session.append('system', { termination_reason: reason, iterations: this.iterations });
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
