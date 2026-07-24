/**
 * AH-RUNTIME-LOOP-001: Loop Engine with stop conditions and error classification.
 *
 * Executes the frozen RunPlan.reasoning_strategy by delegating to the
 * appropriate strategy module (direct.ts, react.ts, plan-execute.ts).
 * This file only manages lifecycle: credential stripping, session writer lock,
 * progress writing, termination state, and final result assembly.
 *
 * Stop conditions: max_iterations, budget exhausted, user cancel, deadline,
 * model refusal, malformed response, tool oscillation, goal satisfied, context_reset.
 * Truncation (stop_reason=length) never executes the truncated tool call.
 * No private CoT stored — only plan, decision summary, tool calls, evidence.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DurableSession as _DurableSession } from '../session/durable-session.js';
import type { RunPlan as _RunPlan } from '../contracts/index.js';
import type { StrategyContext } from './reasoning-strategy.js';
import { runDirect } from './direct.js';
import { runReact } from './react.js';
import { runPlanExecute } from './plan-execute.js';

export type TerminationReason =
  | 'iteration_limit' | 'budget_exhausted' | 'user_cancel' | 'deadline'
  | 'model_refusal' | 'malformed_response' | 'tool_oscillation' | 'goal_satisfied'
  | 'context_reset' | 'completed' | 'denied';

export type LoopStrategy = 'direct' | 'react' | 'plan_execute';

export interface LoopConfig {
  strategy: LoopStrategy;
  max_iterations: number;
  budget_tokens?: number | undefined;
  deadline_ms?: number | undefined;
  data_dir?: string | undefined;
  run_id: string;
  goal: string;
  run_plan?: Readonly<_RunPlan> | undefined;
}

export interface ModelTurn {
  content: string;
  tool_calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  stop_reason?: 'stop' | 'length' | 'tool_use' | 'content_filter';
  decision_summary: string;
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
}

export interface LoopDeps {
  session: _DurableSession;
  modelCall: (messages: unknown[], attempt: number) => Promise<ModelTurn>;
  toolExecute?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  goalSatisfied?: (turns: LoopTurn[]) => boolean;
  signal?: AbortSignal;
}

export class LoopError extends Error {
 constructor(message: string) { super(message); this.name = 'LoopError'; Object.setPrototypeOf(this, LoopError.prototype); }
}
// Fix prototype chain
Object.defineProperty(LoopError, 'name', { value: 'LoopError' });

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
  private _iterations = 0;
  private _terminated = false;
  private _termination_reason: TerminationReason | null = null;
  private readonly _decision_summaries: string[] = [];
  private _context_reset_emitted = false;
  private _startTime = Date.now();

  constructor(private readonly config: LoopConfig, private readonly deps: LoopDeps) {}

  async run(): Promise<LoopResult> {
    const savedCreds: Record<string, string | undefined> = {};
    for (const k of Object.keys(process.env)) {
      if (/TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIAL/i.test(k)) savedCreds[k] = process.env[k];
    }
    stripCredentialsFromEnv();
    this.deps.session.acquireWriter();
    try {
      const messages: unknown[] = [{ role: 'user', content: this.config.goal }];
      const ctx = this.createContext();

      if (this.config.strategy === 'direct') {
        await runDirect(ctx, messages);
      } else if (this.config.strategy === 'react') {
        await runReact(ctx, messages);
      } else if (this.config.strategy === 'plan_execute') {
        await runPlanExecute(ctx, messages);
      } else {
        this.terminate('denied');
        throw new LoopError(`unknown strategy: ${this.config.strategy}`);
      }
    } finally {
      this.writeProgress();
      this.deps.session.releaseWriter();
      for (const [k, v] of Object.entries(savedCreds)) {
        if (v !== undefined) process.env[k] = v;
      }
    }
    return {
      strategy: this.config.strategy,
      iterations: this._iterations,
      termination_reason: this._termination_reason ?? 'completed',
      turns: this.turns,
      decision_summaries: this._decision_summaries,
      progress_path: this.config.data_dir ? join(this.config.data_dir, 'progress.json') : undefined,
      context_reset_emitted: this._context_reset_emitted,
    };
  }

private createContext(): StrategyContext {
  // eslint-disable-next-line @typescript-eslint/no-this-alias
  const self = this;
  return {
    config: this.config,
    deps: this.deps,
    turns: this.turns,
    get iterations() { return self._iterations; },
    set iterations(v: number) { self._iterations = v; },
    get terminated() { return self._terminated; },
    decisionSummaries: this._decision_summaries,
    startTime: this._startTime,
    recordTurn: (turn: ModelTurn) => this.recordTurn(turn),
    terminate: (reason: TerminationReason) => this.terminate(reason),
    detectContextReset: () => this.detectContextReset(),
    writeProgress: () => this.writeProgress(),
  } as StrategyContext;
}


  private detectContextReset(): boolean {
    if (this.turns.length < 2) return false;
    const last2 = this.turns.slice(-2);
    return last2.every(t => !t.model.tool_calls || t.model.tool_calls.length === 0);
  }

  private recordTurn(turn: ModelTurn): void {
    const t: LoopTurn = { iteration: this._iterations, model: turn, timestamp: new Date().toISOString() };
    this.turns.push(t);
    this._decision_summaries.push(turn.decision_summary);
    this.deps.session.append('assistant', { decision_summary: turn.decision_summary, tool_calls: turn.tool_calls });
    this.writeProgress();
  }

 private terminate(reason: TerminationReason): void {
   if (this._terminated) return;
   this._terminated = true;
   this._termination_reason = reason;
   if (reason === 'context_reset') this._context_reset_emitted = true;
   this.deps.session.append('system', { termination_reason: reason, iterations: this._iterations });
 }

  private writeProgress(): void {
    if (!this.config.data_dir) return;
    mkdirSync(this.config.data_dir, { recursive: true });
    const progress = {
      run_id: this.config.run_id,
      current_step: this._iterations,
      goal: this.config.goal,
      completed_steps: this.turns.map((t, i) => ({ step: i + 1, summary: t.model.decision_summary })),
      open_tasks: this._terminated ? [] : [this.config.goal],
      last_error: this._termination_reason === 'malformed_response' ? 'malformed' : null,
      checkpoint_refs: this.turns.map(t => t.timestamp),
      last_updated: new Date().toISOString(),
    };
    writeFileSync(join(this.config.data_dir, 'progress.json'), JSON.stringify(progress, null, 2));
  }
}
