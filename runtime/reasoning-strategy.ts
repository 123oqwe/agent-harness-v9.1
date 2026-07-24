import type {
  LoopConfig,
  LoopDeps,
  LoopTurn,
  ModelCallBudget,
  ModelTurn,
  RuntimeStepState,
  TerminationReason,
  ToolObservation,
} from './loop.js';

export type {
  LoopConfig,
  LoopDeps,
  LoopTurn,
  ModelCallBudget,
  ModelTurn,
  TerminationReason,
};

export interface StrategyContext {
  readonly config: LoopConfig;
  readonly deps: LoopDeps;
  readonly turns: LoopTurn[];
  iterations: number;
  readonly terminated: boolean;
  readonly decisionSummaries: string[];
  readonly startTime: number;
  preflight(): TerminationReason | null;
  nextModelBudget(): ModelCallBudget;
  budgetExceeded(): boolean;
  recordTurn(turn: ModelTurn): LoopTurn;
  recordToolCall(
    turn: LoopTurn,
    call: NonNullable<ModelTurn['tool_calls']>[number],
    stepId: string,
  ): void;
  recordObservation(
    turn: LoopTurn,
    call: NonNullable<ModelTurn['tool_calls']>[number],
    status: ToolObservation['status'],
    payload: unknown,
    stepId: string,
  ): ToolObservation;
  terminate(reason: TerminationReason): void;
  setStepState(
    stepId: string,
    state: RuntimeStepState,
    details?: Readonly<Record<string, unknown>>,
  ): void;
  writeProgress(): void;
}

export type ReasoningStrategyHandler = (
  context: StrategyContext,
  messages: unknown[],
) => Promise<void>;
