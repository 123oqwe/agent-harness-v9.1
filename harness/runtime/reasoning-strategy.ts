/**
 * AH-RUNTIME-001: Reasoning Strategy Interface
 *
 * Shared interface for Direct, ReAct, and Plan+Execute strategies.
 * Each strategy is a standalone module that receives a StrategyContext
 * and executes without accessing LoopEngine internals directly.
 */
import type { DurableSession as _DurableSession } from '../session/durable-session.js';
import type { RunPlan as _RunPlan } from '../../spec/types/run-plan.js';
import type { TerminationReason, LoopConfig, LoopDeps, ModelTurn, LoopTurn } from './loop.js';

export type { TerminationReason, LoopConfig, LoopDeps, ModelTurn, LoopTurn };

export interface StrategyContext {
  readonly config: LoopConfig;
  readonly deps: LoopDeps;
  readonly turns: LoopTurn[];
  iterations: number;
  readonly terminated: boolean;
  readonly decisionSummaries: string[];
  startTime: number;
  recordTurn(turn: ModelTurn): void;
  terminate(reason: TerminationReason): void;
  detectContextReset(): boolean;
  writeProgress(): void;
}

export type ReasoningStrategyHandler = (ctx: StrategyContext, messages: unknown[]) => Promise<void>;
