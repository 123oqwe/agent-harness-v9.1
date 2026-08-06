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
import { LoopError } from './errors.js';
import { runDirect } from './direct.js';
import { runReact } from './react.js';
import { runPlanExecute } from './plan-execute.js';
import { HookRestrictionError } from './hook-port.js';
import { EventBus, createEvent, type BusEvent } from '../packages/runtime-core/src/event-bus.js';
import type {
  RuntimeSteeringCommand,
  RuntimeSteeringPort,
  RuntimeSteeringQueue,
} from './steering-port.js';
import type { RuntimeBudgetPort } from './budget-port.js';

export { LoopError } from './errors.js';

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
  | 'skipped'
  | 'approval_required'
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
  data_dir?: string | undefined;
  run_id: string;
  goal: string;
  run_plan?: Readonly<RunPlan>;
  clock?: () => string;
  nowMs?: () => number;
  /**
   * P1-10: Plan mode. When false, the loop pauses before executing the
   * frozen RunPlan and terminates with 'approval_required'. The caller
   * (harness) can then resume after human approval. Defaults to true.
   */
  auto_execute?: boolean;
  /**
   * #1: Context window capacity in tokens. When set, the loop checks
   * context pressure before each model call and triggers compaction
   * if the threshold is exceeded.
   */
  context_capacity_tokens?: number | undefined;
  context_compaction_threshold?: number | undefined;
}

export interface ModelTurn {
  content: string;
  /** Provider-private reasoning carried in memory only between tool turns. */
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  stop_reason?: 'stop' | 'length' | 'tool_use' | 'content_filter';
  decision_summary: string;
  usage?: { input_tokens: number; output_tokens: number };
  /** #8: images returned by vision-capable models. */
  images?: string[];
}

export interface ModelCallBudget {
  remaining_tokens: number;
  max_output_tokens: number;
}

export interface ModelCallDirective {
  readonly system_instruction: string;
  readonly allowed_tools?: readonly string[];
  readonly required_tool?: string;
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
    directive?: ModelCallDirective,
    signal?: AbortSignal,
    onDelta?: (delta: string) => void,
  ) => Promise<ModelTurn>;
  toolExecute?: (
    name: string,
    args: Record<string, unknown>,
    context: ToolCallExecutionContext,
  ) => Promise<unknown>;
  /** Legacy stop hint only. It never grants verification success. */
  goalSatisfied?: (turns: LoopTurn[]) => boolean;
  signal?: AbortSignal | undefined;
  steering?: RuntimeSteeringPort;
  budgetGuard?: RuntimeBudgetPort;
  turnHooks?: {
    beforeTurn(input: {
      readonly iteration: number;
      readonly messages: unknown[];
    }): Promise<void>;
    afterTurn(input: {
      readonly iteration: number;
      readonly turn?: ModelTurn;
      readonly observations: readonly ToolObservation[];
    }): Promise<void>;
  };
  /** P1-06: EventBus for pub/sub streaming of agent activity. */
  eventBus?: EventBus;
  /** #9: Callback for streaming command output to external consumers. */
  onToolOutput?: (toolCallId: string, stepId: string, stream: 'stdout' | 'stderr', chunk: string) => void;
  /** #4: Callback for streaming model output tokens. */
  onModelDelta?: (delta: string) => void;
  /** #6: RAG query port for retrieving relevant evidence before model calls. */
  ragQuery?: (query: string, topK: number) => Promise<readonly { readonly chunk: { readonly text: string }; readonly citation: { readonly source_path: string; readonly content_hash: string } }[]>;
}

export interface ToolCallExecutionContext {
  readonly tool_call_id: string;
  readonly step_id: string;
  readonly attempt_index: number;
  /** #9: streaming output callback for execute_command. */
  readonly on_output?: ((stream: 'stdout' | 'stderr', chunk: string) => void) | undefined;
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
  private pendingHookTurn: LoopTurn | undefined;
  private lifecycle: 'idle' | 'running' | 'finished' = 'idle';
  private requestedStop: TerminationReason | null = null;
  private activeModelAbort: AbortController | null = null;
  private steeringInterruptedModel = false;

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
    let unsubscribeSteering: (() => void) | undefined;
    try {
     const messages: unknown[] = [
       { role: 'user', content: this.config.goal },
     ];
     // #6: inject RAG-retrieved evidence before strategy execution
     if (this.deps.ragQuery) {
       try {
         const results = await this.deps.ragQuery(this.config.goal, 5);
         if (results.length > 0) {
           const evidence = results.map((r) =>
             `[${r.citation.source_path}]\n${r.chunk.text}`,
           ).join('\n\n');
           messages.push({
             role: 'system',
             content: `Retrieved evidence (untrusted, injection-sanitized):\n${evidence}`,
           });
         }
       } catch {
         // RAG retrieval is best-effort; failures should not block the run
       }
     }
     unsubscribeSteering = this.deps.steering?.subscribe((command) =>
        this.onSteering(command),
      );
     this.applySteering(messages, 'next_turn');
     const context = this.createContext();
      // P1-10: plan mode — if auto_execute is false, pause before executing
      // the frozen RunPlan and wait for human approval.
      if (this.config.auto_execute === false && !this.terminatedValue) {
        this.deps.session.append('system', {
          event: 'plan_mode_paused',
          reason: 'auto_execute is false — awaiting human approval',
        });
        this.publishEvent('run_state_change', {
          state: 'paused',
          reason: 'auto_execute false — awaiting approval',
        });
        this.terminate('approval_required');
      }
     if (this.terminatedValue) {
       // A replayed cancellation remains authoritative after restart.
     } else if (this.config.strategy === 'direct') {
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
      unsubscribeSteering?.();
      try {
        await this.flushPendingTurnHook();
      } catch (error) {
        this.deps.session.append('error', {
          event: 'post_turn_hook_failed',
          message: error instanceof Error ? error.message : 'unknown hook error',
        });
        if (!this.terminatedValue) this.terminate(this.classifyUnhandled(error));
      }
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
    this.activeModelAbort?.abort('loop_stop');
    if (this.lifecycle === 'running') this.terminate(reason);
  }

  private createContext(): StrategyContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      config: this.config,
      deps: {
        ...this.deps,
        modelCall: async (messages, attempt, budget, directive) => {
          await self.flushPendingTurnHook();
          if (self.turns.length > 0) self.applySteering(messages, 'follow_up');
          self.applySteering(messages, 'steer');
          await self.deps.turnHooks?.beforeTurn({
            iteration: self.iterationsValue,
            messages,
          });
         if (self.terminatedValue) return { content: '', decision_summary: '' };
         // #1: context pressure check — if context window is near full, trigger reset
         if (self.config.context_capacity_tokens !== undefined) {
           const threshold = self.config.context_compaction_threshold ?? 0.85;
           const estimated = Math.min(100_000, stableJson(messages).length);
           if (estimated >= self.config.context_capacity_tokens * threshold) {
             self.publishEvent('run_state_change', {
               state: 'context_reset',
               pressure: estimated / self.config.context_capacity_tokens,
             });
             self.terminate('context_reset');
             return { content: '', decision_summary: '' };
           }
         }
         const budgetDecision = self.deps.budgetGuard?.beforeModelCall({
            run_id: self.config.run_id,
            iteration: self.iterationsValue,
            attempt,
            remaining_tokens: budget.remaining_tokens,
            requested_max_output_tokens: budget.max_output_tokens,
            estimated_input_tokens: Math.min(
              100_000,
              stableJson([messages, directive]).length,
            ),
          });
          if (budgetDecision && !budgetDecision.allowed) {
            self.terminate('budget_exhausted');
            return { content: '', decision_summary: '' };
          }
          const approvedBudget = budgetDecision
            ? {
                remaining_tokens: budget.remaining_tokens,
                max_output_tokens: Math.min(
                  budget.max_output_tokens,
                  budgetDecision.max_output_tokens,
                ),
              }
           : budget;
        // #4: pass onModelDelta for streaming token output
        const callProvider = async (signal?: AbortSignal) => {
          const delta = self.deps.onModelDelta;
          const turn =
            signal === undefined
              ? await self.deps.modelCall(messages, attempt, approvedBudget, directive, undefined, delta)
              : await self.deps.modelCall(messages, attempt, approvedBudget, directive, signal, delta);
           if (turn.usage) {
              self.deps.budgetGuard?.afterModelCall({
                run_id: self.config.run_id,
                iteration: self.iterationsValue,
                attempt,
                input_tokens: turn.usage.input_tokens,
                output_tokens: turn.usage.output_tokens,
              });
            }
            return turn;
          };
          if (!self.deps.steering) {
            return self.deps.signal === undefined
              ? callProvider()
              : callProvider(self.deps.signal);
          }
          for (;;) {
            self.steeringInterruptedModel = false;
            // Close the async beforeTurn/retry window before starting a provider.
            self.applySteering(messages, 'steer');
            if (self.terminatedValue) return { content: '', decision_summary: '' };
            const controller = new AbortController();
            self.activeModelAbort = controller;
            const signal = self.deps.signal
              ? AbortSignal.any([self.deps.signal, controller.signal])
              : controller.signal;
            try {
              const turn = await callProvider(signal);
              if (self.terminatedValue) return { content: '', decision_summary: '' };
              if (!self.steeringInterruptedModel) return turn;
            } catch (error) {
              if (self.terminatedValue) return { content: '', decision_summary: '' };
              if (!self.steeringInterruptedModel) throw error;
            } finally {
              if (self.activeModelAbort === controller) self.activeModelAbort = null;
            }
            self.applySteering(messages, 'steer');
          }
        },
      },
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

  private onSteering(command: RuntimeSteeringCommand): void {
    if (command.priority === 'kill' || command.priority === 'human_cancel') {
      this.stop('user_cancel');
      return;
    }
    if (command.queue === 'steer') {
      this.steeringInterruptedModel = true;
      this.activeModelAbort?.abort('steering_interrupt');
    }
  }

  private applySteering(messages: unknown[], queue: RuntimeSteeringQueue): void {
    for (const command of this.deps.steering?.drain(queue) ?? []) {
      if (command.priority === 'kill' || command.priority === 'human_cancel') {
        this.stop('user_cancel');
        continue;
      }
      messages.push({
        role: 'user',
        content: command.content,
        metadata: {
          source: 'steering',
          trust: 'user',
          command_id: command.command_id,
          priority: command.priority,
        },
      });
    }
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
    this.pendingHookTurn = recorded;
    this.decisionSummariesValue.push(turn.decision_summary);
    this.deps.session.append('assistant', {
      decision_summary: turn.decision_summary,
      tool_calls: turn.tool_calls,
      usage: turn.usage,
    });
    // P1-06: publish model_called event
    this.publishEvent('model_called', {
      iteration: this.iterationsValue,
      decision_summary: turn.decision_summary,
      tool_calls: turn.tool_calls?.map((c) => c.name) ?? [],
      usage: turn.usage,
    });
    this.writeProgressSafely();
    return recorded;
  }

  private async flushPendingTurnHook(): Promise<void> {
    const pending = this.pendingHookTurn;
    if (pending === undefined) return;
    this.pendingHookTurn = undefined;
    await this.deps.turnHooks?.afterTurn({
      iteration: pending.iteration,
      turn: pending.model,
      observations: pending.tool_observations,
    });
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
    // P1-06: publish tool_call_start event
    this.publishEvent('tool_call_start', {
      tool_call_id: call.id,
      tool: call.name,
      arguments: call.arguments,
    }, stepId);
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
    // P1-06: publish tool_result event
    this.publishEvent('tool_result', {
      tool_call_id: call.id,
      tool: call.name,
      status,
      bytes,
      truncated,
    }, stepId);
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
    // P1-06: publish step_transition event
    this.publishEvent('step_transition', { state, ...details }, stepId);
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
    // P1-06: publish run_state_change event
    this.publishEvent('run_state_change', {
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
    if (error instanceof HookRestrictionError) {
      return error.action === 'force_prompt'
        ? 'approval_required'
        : error.action === 'skip'
          ? 'skipped'
          : 'denied';
    }
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

  /** P1-06: Publish a BusEvent to the EventBus if one is attached. */
  private publishEvent(
    type: BusEvent['type'],
    data: Record<string, unknown>,
    stepId?: string,
  ): void {
    if (!this.deps.eventBus) return;
    this.deps.eventBus.publish(
      createEvent(type, this.config.run_id, data, stepId),
    );
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
