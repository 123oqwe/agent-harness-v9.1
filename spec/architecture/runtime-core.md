# Runtime Core

## Loop Engine
- Stop conditions: max_iterations, budget exhausted, user cancel, deadline, model refusal, malformed response, tool oscillation, goal satisfied
- Error classification: network (transient), tool (tool-specific), model (provider), truncation (structural - do NOT execute)
- No private CoT storage: only plan, decision summary, tool calls, evidence, error classification

## Session Model
- Event log = authority (source of truth)
- Snapshot = acceleration (rebuildable)
- 11 entry types: user, assistant, tool_call, tool_result, compaction, branch, fork, steer, system, error, summary
- Crash recovery: rebuild from event log

## Pause/Resume (v9 correction)
v8 had generic reExecuteFromStep. v9 uses effect-state-aware resume:
- PRE_DISPATCH: new attempt OK
- IN_FLIGHT: NO retry, query provider/ledger first
- EFFECT_UNKNOWN: enter Reconciliation
- EFFECT_CONFIRMED: continue from next step
- DEFINITELY_FAILED_NO_EFFECT: new attempt + new Capability

## Steering (3 queues)
- steerQueue: within current turn
- followUpQueue: after current turn
- nextTurnQueue: next user turn
- Priority: Kill > Security > Human Cancel > Human Correction > Admin > User > Supervisor > Agent
- IN_FLIGHT external action: cannot cancel/retry, must reconcile


## Hook Re-validation (AR-007 fix)
Hook output MUST be re-validated against Schema AND Policy before execution. This is already stated above but requires an explicit adversarial test: tests/security/hook-injection.test.ts must verify that a compromised hook cannot inject malicious arguments.


## Implementation Notes

### Loop Engine Interface

```typescript
interface LoopEngine {
  run(plan: RunPlan): AsyncGenerator<StreamEvent>;
  stop(reason: TerminationReason): void;
}

type TerminationReason =
  | "iteration_limit" | "budget_exhausted" | "user_cancel"
  | "deadline_exceeded" | "model_refusal" | "malformed_response"
  | "tool_oscillation" | "goal_satisfied";
```

### Stop Conditions (all agent-tunable via RunPlan)
- max_iterations: default 25 (agent should tune per domain)
- max_repeated_tool_calls: default 3 (same tool + same args)
- budget_exhausted: when BudgetGuard returns 0 remaining
- truncation: stop_reason === "length" → do NOT execute truncated tool call, error to LLM
- goal_satisfied: checked by GoalEvaluator after each turn

### Error Classification
| Error Type | Classification | Action |
|------------|---------------|--------|
| Network error | transient | retry with backoff (max 3) |
| Tool error | tool-specific | return error to LLM |
| Model error | provider-specific | model fallback |
| Truncation | structural | do NOT execute, error to LLM |
| Malformed JSON | repairable | JSON repair (max 2 attempts) |

### Session Model
Event sourcing: append-only event log is source of truth. Snapshot is acceleration (can rebuild from log).
Agent should use SQLite for event log (consistent with ADR-004/ADR-006).

### Compaction Trigger
`shouldCompact(tokens, window, settings)`: when tokens > window * 0.8 (agent-tunable threshold).
Must preserve: goals, constraints, decisions, approvals, side effects, open tasks, security state.
