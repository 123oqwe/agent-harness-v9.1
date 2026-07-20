# Runtime Core

## Loop Engine
- Stop conditions: max_iterations, budget exhausted, user cancel, deadline, model refusal, malformed response, tool oscillation, goal satisfied, context_reset
- Error classification: network (transient), tool (tool-specific), model (provider), truncation (structural - do NOT execute)
- No private CoT storage: only plan, decision summary, tool calls, evidence, error classification

### Eight loop families and their Phase owner

These are explicit state machines coordinated through events; they are not eight recursive model loops and they do not create competing sources of truth.

| Loop | First complete Phase | Authority and termination |
|------|----------------------|---------------------------|
| Request reasoning | 1 | Static Router selects direct, ReAct, or plan_execute; TaskContract success, budget, deadline, cancel, or typed failure terminates it |
| Tool execution | 1 | Runtime proposes; the 12-step Action Control pipeline authorizes and dispatches each call; receipt or typed error returns control |
| Verification and recovery | 1, advanced in 4 | Deterministic local eval and Evidence Package first; Independent Verifier may request bounded recovery but cannot edit implementation or expected results |
| Steering and context maintenance | 2 | Three queues, active-plan rewrite, offload, compaction, and context_reset are event-log transitions, never hidden prompt mutation |
| Adaptive routing and multi-agent | 3 | One Router revises RunPlan; AgentGraph children are bounded by DAG completion, attenuated budgets/capabilities, and merge policy |
| Memory and personalization | 4 | Outcome creates proposals; provenance/trust/consent/TTL/conflict checks decide persistence; session event log remains runtime authority |
| Capability evolution | 4 | Offline replay and shadow comparison produce proposals only; rollback/quarantine/human certification bound promotion |
| Mission and schedule | 6 | Durable mission/occurrence state, leases, idempotency, fresh context/authorization, sleep/wake, cancel, and budget terminate each activation |

## Phase 1 Reasoning Strategies

Runtime executes the frozen `RunPlan.reasoning_strategy`; it never silently switches strategy.

- `direct` performs exactly one model call, no Tool execution, no action/observation loop, and no multi-step WorkflowGraph. A returned ToolCall is a typed strategy violation or causes the Router to issue a new RunPlan revision; Runtime does not execute it.
- `react` alternates a persisted decision summary, one proposed ToolCall, Policy, Capability, PEP, Tool execution, Observation, and the next model turn. It stores summaries, calls, observations, receipts, and Evidence but no private chain-of-thought. Maximum iterations, budget, deadline, cancellation, and repeated Tool-plus-arguments oscillation bound the loop. A ToolCall truncated with `stop_reason=length` is never executed.
- `plan_execute` requires a frozen acyclic WorkflowGraph before any Tool execution. Steps execute in topological order and are verified individually; a failed verification blocks dependent steps. Writes remain in a VFS Overlay until every verification passes, then commit atomically; failure discards the Overlay. Replanning increments `revision` and binds the correct `previous_revision_hash`. Crash restore resumes at the first incomplete step without repeating completed real side effects.

## Session Model
- Event log = authority (source of truth)
- Snapshot = acceleration (rebuildable)
- 11 entry types: user, assistant, tool_call, tool_result, compaction, branch, fork, steer, system, error, summary
- Crash recovery: rebuild from event log

## Cross-Session Progress (Phase 1 interim, before Phase 4 full Memory)
- Not a replacement for the session event log (which remains the in-session authority). progress.json is a cross-session bridge only.
- `.harness/progress.json`: lightweight state file written after each turn by Loop Engine (runtime data dir, not source tree)
- Contains: run_id, current_step, goal, completed_steps, open_tasks, last_error, checkpoint_refs, last_updated
- Purpose: bridge context loss across sessions before full Memory system lands in Phase 4
- Replaced by full Memory system (6 types + provenance) in Phase 4; progress.json becomes an episodic-memory source
- Loop Engine MUST append a progress entry after every turn and on every stop condition

## Two-Phase Runtime (FG2 — RunPhase, CTRL-RUNPHASE-001)

A RunPlan executes in two network-isolation phases. This is a framework-level construction (not an implementation choice) so that `deny-by-default` applies to credentials by construction, not only by policy.

- **setup phase**: network enabled. Used to install dependencies, fetch seed data. May obtain credentials via Secrets Broker. Tools bound to `run_phase_binding: [setup]` run here.
- **agent phase**: network disabled by default (egress only via CTRL-EGRESS-002 allowlist). Before entering the agent phase, the Runtime strips all credentials from the process environment. Tools bound to `run_phase_binding: [agent]` run here. A tool requiring a credential obtains it via single-exchange at dispatch (CTRL-CRED-REACH-001): the Broker issues a short-lived, single-use credential scoped to that one tool call; the credential is never present in env across loop iterations.

Rationale: if the agent loop is compromised by `THREAT-INDIRECT-INJECTION` or `THREAT-TOOL-POISONING`, a "legitimate" credentialed tool call could otherwise exchange a credential into loop-reachable state, and a second tool call (`web_fetch` to an attacker host, credential in URL) could exfiltrate it. Taint controls cannot block a seemingly-legitimate second call. Two-phase runtime + credential stripping makes the credential physically absent from the agent environment between dispatches, so T5 risk ceiling holds by construction.

Scheduled/routine tasks extend the existing "credentials must be fresh" rule to "credentials absent from agent env" — scheduled runs always enter agent phase.

## Phase 1 Sandbox Mechanism (G-OS1)

Phase 1 sandbox uses OS-native containment, not a custom process wrapper. The mechanism is platform-specific:

| Platform | Mechanism | Profile |
|----------|-----------|---------|
| macOS | Seatbelt (`sandbox-exec -p`) | workspace-write + network deny-by-default (egress only via FG3 egress_policy) |
| Linux | bubblewrap (`bwrap`) | unshare network namespace + bind-mount workspace read-write, host FS read-only |
| Windows | AppContainer | workspace-write + network capability disabled by default |

Defaults (all platforms):
- Filesystem: workspace dir read-write; everything else denied
- Network: denied by default in agent phase (FG2); setup phase may allow via egress_policy
- Process/memory/output/cpu: enforced via rlimit (Unix) / JobObject (Windows)
- Symlink escape: resolved via realpath before access (VFS FG4 enforces at the VFS layer; sandbox is defense-in-depth)

The sandbox profile is part of the ToolSpec's `sandbox` field and is enforced at action-control step 9. Phase 7 microVM replaces this for multi-tenant; Phase 1 uses OS-native because it is sufficient for single-user local execution and aligns with Codex/Claude Code.

## Pause/Resume (v9 correction)
v8 had generic reExecuteFromStep. v9 uses effect-state-aware resume:
- PRE_DISPATCH: new attempt OK
- IN_FLIGHT: NO retry, query provider/ledger first
- EFFECT_UNKNOWN: enter Reconciliation
- EFFECT_CONFIRMED: continue from next step
- DEFINITELY_FAILED_NO_EFFECT: new attempt + new Capability

## Sandbox Sleep/Wake (Phase 6+)

Distinct from Pause/Resume (which is within a single run: effect-state-aware retry/resume) and from context_reset (which clears the window and starts fresh): Sleep/Wake releases compute resources across a long mission while preserving full session state.

- **Sleep**: Runtime writes handoff artifact (goal, completed steps, open tasks, checkpoint refs) to VFS, persists sandbox filesystem, expires all Capability Tokens, releases compute.
- **Wake**: Runtime verifies state integrity (hash check), rebuilds context from handoff + VFS, re-issues fresh Capability Tokens, resumes. Sandbox files preserved.

Use case: a Founder mission runs for days; between active phases the sandbox sleeps (no compute cost), wakes when the user returns or a scheduled trigger fires.

## Steering (3 queues)
- steerQueue: within current turn
- followUpQueue: after current turn
- nextTurnQueue: next user turn
- Priority: Kill > Security > Human Cancel > Human Correction > Admin > User > Supervisor > Agent
- IN_FLIGHT external action: cannot cancel/retry, must reconcile


## Hook Event Catalog

Hooks fire at specific execution boundaries. Each hook type has defined capabilities:

| Hook | When | Can Do | Cannot Do |
|------|------|--------|-----------|
| PreToolUse | Before action-control step 1 (schema validation) | block (deny), force-prompt, skip, mutate args (re-validated against schema) | bypass deny rules, grant permissions, issue Capability |
| PostToolUse | After action-control step 11 (postcondition) | observe, log, trigger follow-up | modify result, block retroactively |
| UserPromptSubmit | Before input normalization (request-to-outcome step 1) | block, sanitize, add context | bypass Policy, inject instructions |
| SessionStart | On session creation | initialize state, load memory | grant permissions beyond session scope |
| SessionEnd | On session termination | flush state, write memory | execute actions |
| Stop | On run termination | cleanup, final logging | restart run |

Decision-capable hooks (PreToolUse, UserPromptSubmit) can block but CANNOT bypass deny rules (deny-first). Hook output re-validated against Schema AND Policy before execution (AR-007). Hook trust levels: hash_reviewed, managed, user. Hooks CANNOT: grant permissions, issue Capability, lower data classification, remove safety, act as PEP.

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
  | "tool_oscillation" | "goal_satisfied" | "context_reset";
```

### Stop Conditions (all agent-tunable via RunPlan)
- max_iterations: default 25 (agent should tune per domain)
- max_repeated_tool_calls: default 3 (same tool + same args)
- budget_exhausted: when BudgetGuard returns 0 remaining
- truncation: stop_reason === "length" → do NOT execute truncated tool call, error to LLM
- goal_satisfied: checked by GoalEvaluator after each turn
- context_reset: triggered when post-compaction performance degrades (2 consecutive tool oscillations OR goal regress after a compaction). Writes a structured handoff artifact (current goal, completed steps, open tasks, checkpoint refs, next step), starts a fresh session, restores from handoff. Interface required in Phase 1 (Loop Engine emits the event); full implementation in Phase 2 (session spawn-from-handoff). Distinct from compaction: compaction summarizes in-place; context_reset clears the window entirely and hands off state via artifact.

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

### Context pressure thresholds
`shouldOffload(tokens, window)`: at 40%, mechanically offload large reversible payloads to VFS.
`shouldCompact(tokens, window)`: at 70% after offload, run cache-aligned summarization.
`shouldReset(tokens, window)`: at 85% when offload + compaction cannot recover, or earlier on measured goal regression/oscillation, write handoff and start a fresh context.

These are one policy, not three competing defaults: 40% is the soft offload boundary, 70% is the lossy-compaction boundary, and 85% is the hard reset boundary. RunPlan may lower thresholds for a domain but cannot raise the hard reset above the model's safe input budget.
 Must preserve: goals, constraints, decisions, approvals, side effects, open tasks, security state.
