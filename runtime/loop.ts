/**
 * Phase 1 Loop Engine.
 *
 * Owns lifecycle, actual usage accounting, terminal events, bounded
 * observations, progress, and typed failure normalization. Strategy modules
 * cannot claim task success; post-loop VerificationGraph execution owns that.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeProgressAtomic } from '../session/progress-store.js';
import type { DurableSession } from '../session/durable-session.js';
import type { RunPlan } from '../contracts/index.js';
import type { StrategyContext } from './reasoning-strategy.js';
import { runDirect } from './direct.js';
import { runReact } from './react.js';
import { runPlanExecute } from './plan-execute.js';

export type TerminationReason =
  | 'iteration_limit'
  | 'budget_exhausted'
  | 'user_cancel'
  | 'deadline'
  | 'model_refusal'
  | 'malformed_response'
  | 'tool_oscillation'
  | 'goal_satisfied'
  | 'context_reset'
  | 'completed'
  | 'denied'
  | 'provider_failure'
  | 'tool_failure'
  | 'verification_failed'
  | 'internal_error';

export type LoopStrategy = 'direct' | 'react' | 'plan_execute';

export interface LoopConfig {
  strategy: LoopStrategy;
  max_iterations: number;
  budget_tokens?: number;
  max_output_tokens_per_call?: number;
  max_observation_bytes?: number;
  deadline_ms?: number;
  data_dir?: string;
  run_id: string;
  goal: string;
  run_plan?: Readonly<RunPlan>;
  clock?: () => string;
  nowMs?: () => number;
}

export interface ModelTurn {
  content: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  stop_reason?: 'stop' | 'length' | 'tool_use' | 'content_filter';
  decision_summary: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface ModelCallBudget {
  remaining_tokens: number;
  max_output_tokens: number;
}

export interface ToolObservation {
  tool_call_id: string;
  name: string;
  arguments: Readonly<Record<string, unknown>>;
  status: 'ok' | 'error' | 'rejected';
  result?: unknown;
  error?: string;
  bytes: number;
  truncated: boolean;
  sha256: string;
}

export interface LoopTurn {
  iteration: number;
  model: ModelTurn;
  tool_observations: ToolObservation[];
  /** Compatibility view of the first successful observation. */
  tool_executed?: {
    name: string;
    arguments: Record<string, unknown>;
    result: unknown;
  };
  timestamp: string;
}

export type RuntimeStepState =
  | 'pending'
  | 'executing'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'awaiting_verification';

export interface LoopResult {
  strategy: LoopStrategy;
  iterations: number;
  termination_reason: TerminationReason;
  turns: LoopTurn[];
  decision_summaries: string[];
  progress_path?: string;
  context_reset_emitted: boolean;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  step_states: Readonly<Record<string, RuntimeStepState>>;
}

export interface LoopDeps {
  session: DurableSession;
  modelCall: (
    messages: unknown[],
    attempt: number,
    budget: ModelCallBudget,
  ) => Promise<ModelTurn>;
  toolExecute?: (
    name: string,
    args: Record<string, unknown>,
    context: ToolCallExecutionContext,
  ) => Promise<unknown>;
  /** Legacy stop hint only. It never grants verification success. */
  goalSatisfied?: (turns: LoopTurn[]) => boolean;
  signal?: AbortSignal;
}

export interface ToolCallExecutionContext {
  readonly tool_call_id: string;
  readonly step_id: string;
  readonly attempt_index: number;
}

export class LoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoopError';
    Object.setPrototypeOf(this, LoopError.prototype);
  }
}

/** Explicit utility retained for setup processes. LoopEngine never mutates the
 * shared host environment because doing so is racy across concurrent runs. */
export function stripCredentialsFromEnv(): string[] {
  const stripped: string[] = [];
  for (const key of Object.keys(process.env)) {
    if (/TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIAL/i.test(key)) {
      stripped.push(key);
      delete process.env[key];
    }
  }
  return stripped;
}

function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (input: unknown): unknown => {
    if (typeof input === 'bigint') return input.toString();
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === 'object') {
      if (seen.has(input)) return '[circular]';
      seen.add(input);
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value) ?? null);
}

function validUsage(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export class LoopEngine {
  private readonly turns: LoopTurn[] = [];
  private iterationsValue = 0;
  private terminatedValue = false;
  private terminationReasonValue: TerminationReason | null = null;
  private readonly decisionSummariesValue: string[] = [];
  private contextResetEmittedValue = false;
  private readonly startTime: number;
  private inputTokens = 0;
  private outputTokens = 0;
  private readonly stepStatesValue = new Map<string, RuntimeStepState>();
  private lifecycle: 'idle' | 'running' | 'finished' = 'idle';
  private requestedStop: TerminationReason | null = null;

  constructor(
    private readonly config: LoopConfig,
    private readonly deps: LoopDeps,
  ) {
    this.validateConfig();
    this.startTime = this.nowMs();
  }

  async run(): Promise<LoopResult> {
    if (this.lifecycle !== 'idle') {
      throw new LoopError('LoopEngine instances can run exactly once');
    }
    this.deps.session.acquireWriter();
    this.lifecycle = 'running';
    try {
      const messages: unknown[] = [
        { role: 'user', content: this.config.goal },
      ];
      const context = this.createContext();
      if (this.config.strategy === 'direct') {
        await runDirect(context, messages);
      } else if (this.config.strategy === 'react') {
        await runReact(context, messages);
      } else if (this.config.strategy === 'plan_execute') {
        await runPlanExecute(context, messages);
      } else {
        throw new LoopError(`unknown strategy: ${String(this.config.strategy)}`);
      }
      if (!this.terminatedValue) this.terminate('completed');
    } catch (error) {
      const reason = this.classifyUnhandled(error);
      this.deps.session.append('error', {
        event: 'runtime_error',
        classification: reason,
        message: error instanceof Error ? error.message : 'unknown runtime error',
      });
      this.terminate(reason);
    } finally {
      this.writeProgressSafely();
      this.deps.session.releaseWriter();
      this.lifecycle = 'finished';
    }
    return {
      strategy: this.config.strategy,
      iterations: this.iterationsValue,
      termination_reason: this.terminationReasonValue ?? 'internal_error',
      turns: this.turns,
      decision_summaries: this.decisionSummariesValue,
      ...(this.config.data_dir === undefined
        ? {}
        : { progress_path: join(this.config.data_dir, 'progress.json') }),
      context_reset_emitted: this.contextResetEmittedValue,
      usage: {
        input_tokens: this.inputTokens,
        output_tokens: this.outputTokens,
        total_tokens: this.usedTokens(),
      },
      step_states: Object.freeze(Object.fromEntries(this.stepStatesValue)),
    };
  }

  stop(reason: TerminationReason): void {
    if (this.lifecycle === 'finished' || this.terminatedValue) return;
    this.requestedStop = reason;
    if (this.lifecycle === 'running') this.terminate(reason);
  }

  private createContext(): StrategyContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      config: this.config,
      deps: this.deps,
      turns: this.turns,
      get iterations() {
        return self.iterationsValue;
      },
      set iterations(value: number) {
        self.iterationsValue = value;
      },
      get terminated() {
        return self.terminatedValue;
      },
      get startTime() {
        return self.startTime;
      },
      decisionSummaries: this.decisionSummariesValue,
      preflight: () => this.preflight(),
      nextModelBudget: () => this.nextModelBudget(),
      budgetExceeded: () => this.budgetExceeded(),
      recordTurn: (turn: ModelTurn) => this.recordTurn(turn),
      recordToolCall: (turn, call, stepId) =>
        this.recordToolCall(turn, call, stepId),
      recordObservation: (turn, call, status, payload, stepId) =>
        this.recordObservation(turn, call, status, payload, stepId),
      terminate: (reason: TerminationReason) => this.terminate(reason),
      setStepState: (stepId, state, details) =>
        this.setStepState(stepId, state, details),
    };
  }

  private preflight(): TerminationReason | null {
    if (this.requestedStop !== null) return this.requestedStop;
    if (this.deps.signal?.aborted) return 'user_cancel';
    if (
      this.config.deadline_ms !== undefined &&
      this.nowMs() - this.startTime >= this.config.deadline_ms
    ) {
      return 'deadline';
    }
    if (
      this.config.budget_tokens !== undefined &&
      this.usedTokens() >= this.config.budget_tokens
    ) {
      return 'budget_exhausted';
    }
    return null;
  }

  private nextModelBudget(): ModelCallBudget {
    const remaining =
      this.config.budget_tokens === undefined
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, this.config.budget_tokens - this.usedTokens());
    return {
      remaining_tokens: remaining,
      max_output_tokens: Math.min(
        remaining,
        this.config.max_output_tokens_per_call ?? 4_096,
      ),
    };
  }

  private budgetExceeded(): boolean {
    return (
      this.config.budget_tokens !== undefined &&
      this.usedTokens() > this.config.budget_tokens
    );
  }

  private recordTurn(turn: ModelTurn): LoopTurn {
    const input = turn.usage?.input_tokens ?? 0;
    const output = turn.usage?.output_tokens ?? 0;
    if (!validUsage(input) || !validUsage(output)) {
      throw new LoopError('model returned invalid usage');
    }
    this.inputTokens += input;
    this.outputTokens += output;
    const recorded: LoopTurn = {
      iteration: this.iterationsValue,
      model: turn,
      tool_observations: [],
      timestamp: this.now(),
    };
    this.turns.push(recorded);
    this.decisionSummariesValue.push(turn.decision_summary);
    this.deps.session.append('assistant', {
      decision_summary: turn.decision_summary,
      tool_calls: turn.tool_calls,
      usage: turn.usage,
    });
    this.writeProgressSafely();
    return recorded;
  }

  private recordToolCall(
    _turn: LoopTurn,
    call: NonNullable<ModelTurn['tool_calls']>[number],
    stepId: string,
  ): void {
    this.deps.session.append('tool_call', {
      step: stepId,
      tool_call_id: call.id,
      tool: call.name,
      arguments: call.arguments,
    });
  }

  private recordObservation(
    turn: LoopTurn,
    call: NonNullable<ModelTurn['tool_calls']>[number],
    status: ToolObservation['status'],
    payload: unknown,
    stepId: string,
  ): ToolObservation {
    const serialized = stableJson(payload);
    const bytes = Buffer.byteLength(serialized);
    const maxBytes = this.config.max_observation_bytes ?? 64 * 1024;
    const truncated = bytes > maxBytes;
    const boundedPayload = truncated
      ? {
          truncated: true,
          original_bytes: bytes,
          preview: Buffer.from(serialized)
            .subarray(0, maxBytes)
            .toString('utf8'),
        }
      : JSON.parse(serialized) as unknown;
    const observation: ToolObservation = {
      tool_call_id: call.id,
      name: call.name,
      arguments: Object.freeze({ ...call.arguments }),
      status,
      ...(status === 'ok'
        ? { result: boundedPayload }
        : { error: String(payload) }),
      bytes,
      truncated,
      sha256: createHash('sha256').update(serialized).digest('hex'),
    };
    turn.tool_observations.push(observation);
    if (status === 'ok' && turn.tool_executed === undefined) {
      turn.tool_executed = {
        name: call.name,
        arguments: call.arguments,
        result: boundedPayload,
      };
    }
    this.deps.session.append('tool_result', {
      step: stepId,
      tool_call_id: call.id,
      tool: call.name,
      status,
      observation,
    });
    return observation;
  }

  private setStepState(
    stepId: string,
    state: RuntimeStepState,
    details: Readonly<Record<string, unknown>> = {},
  ): void {
    this.stepStatesValue.set(stepId, state);
    this.deps.session.append('system', {
      event: 'step_state',
      step: stepId,
      status: state,
      ...details,
    });
  }

  private terminate(reason: TerminationReason): void {
    if (this.terminatedValue) return;
    this.terminatedValue = true;
    this.terminationReasonValue = reason;
    if (reason === 'context_reset') this.contextResetEmittedValue = true;
    this.deps.session.append('system', {
      event: 'run_terminated',
      termination_reason: reason,
      iterations: this.iterationsValue,
      usage: {
        input_tokens: this.inputTokens,
        output_tokens: this.outputTokens,
        total_tokens: this.usedTokens(),
      },
    });
  }

  private classifyUnhandled(error: unknown): TerminationReason {
    if (this.deps.signal?.aborted) return 'user_cancel';
    if (error instanceof LoopError) return 'malformed_response';
    return 'provider_failure';
  }

  private usedTokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  private now(): string {
    const value = this.config.clock?.() ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(value))) {
      throw new LoopError('clock returned an invalid timestamp');
    }
    return value;
  }

  private nowMs(): number {
    const value = this.config.nowMs?.() ?? Date.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new LoopError('nowMs returned an invalid timestamp');
    }
    return value;
  }

  private validateConfig(): void {
    if (this.config.run_id.trim().length === 0) {
      throw new LoopError('run_id is required');
    }
    if (this.config.goal.trim().length === 0) {
      throw new LoopError('goal is required');
    }
    if (
      !Number.isSafeInteger(this.config.max_iterations) ||
      this.config.max_iterations < 0
    ) {
      throw new LoopError(
        'max_iterations must be a non-negative safe integer',
      );
    }
    for (const [name, value] of [
      ['budget_tokens', this.config.budget_tokens],
      ['deadline_ms', this.config.deadline_ms],
    ] as const) {
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || value < 0)
      ) {
        throw new LoopError(`${name} must be a non-negative safe integer`);
      }
    }
    for (const [name, value] of [
      ['max_output_tokens_per_call', this.config.max_output_tokens_per_call],
      ['max_observation_bytes', this.config.max_observation_bytes],
    ] as const) {
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || value < 0)
      ) {
        throw new LoopError(`${name} must be a non-negative safe integer`);
      }
    }
  }

  private writeProgressSafely(): void {
    if (!this.config.data_dir) return;
    try {
      writeProgressAtomic(this.config.data_dir, {
        run_id: this.config.run_id,
        current_step: this.iterationsValue,
        goal: this.config.goal,
        completed_steps: [
          ...this.stepStatesValue.entries(),
        ]
          .filter(([, state]) => state === 'done')
          .map(([step]) => ({ step, summary: 'done' })),
        open_tasks: this.terminatedValue ? [] : [this.config.goal],
        last_error:
          this.terminationReasonValue === null ||
          this.terminationReasonValue === 'completed' ||
          this.terminationReasonValue === 'goal_satisfied'
            ? null
            : this.terminationReasonValue,
        checkpoint_refs: this.turns.map((turn) => turn.timestamp),
        last_updated: this.now(),
      });
    } catch (error) {
      if (!this.terminatedValue) {
        this.deps.session.append('error', {
          event: 'progress_write_failed',
          message: error instanceof Error ? error.message : 'unknown',
        });
        this.terminate('internal_error');
      }
    }
  }
}
