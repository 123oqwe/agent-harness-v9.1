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
