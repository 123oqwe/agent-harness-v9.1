# Phase 3 Independent Acceptance — GLM-5.2 xhigh (read-only)

> Protocol: `spec/phases/phase-3.yaml` → `independent_acceptance`
> Trigger: runs **only after** `npm run verify:phase3:local` is green
> Mode: **read-only** — no file writes, no test runs, no `npm install`, no git mutation

## Mission

Independently accept Phase 3 (Adaptive Routing & Multi-Agent) against the six
evaluation axes the phase spec mandates:

1. **routing regret** — suboptimal route selections (multi-agent when a single
   agent sufficed, wrong execution mode, budget-ignoring picks)
2. **unnecessary multi-agent use** — fan-out chosen where `single_agent_sufficient`
3. **isolation** — AgentGraph worker isolation (context, VFS, PEP) — no cross-worker
   bleed
4. **attenuation** — capability attenuation of workers vs. the orchestrator
5. **merge** — deterministic, conflict-safe merge of worker results
6. **fallback** — the eleven typed fallbacks + DAG failure propagation
7. **adversarial routing** — prohibited-route tokens, prohibition clauses, tool/app
   allowlists, fail-closed paths

You do **not** trust gate evidence claims. You read source + tests and verify
each axis with your own eyes. Anything the gate said "PASS" that you cannot
confirm from code is a finding.

## Worktree

- Working directory: `/Users/guanjieqiao/agent-runtime-v7/worktrees/phase2-integrated`
- Branch: `codex/phase2-integrated`
- All paths below are relative to the worktree root.

## Map: axis → evidence to inspect

| Axis | Read | Check |
|------|------|-------|
| routing regret | `router/pipeline.ts` (`stageWorkflow`, `resolveExecutionMode`, `stageConstraints`) | open_ended → routing_slip; fan_out ≥ 12 → workflow_script; budget constraint → `budget_allocation.usd_micros` |
| routing regret (eval) | `evals/routing/eval.ts`, `evals/routing/dataset.json`, `tests/router/eval.test.ts` | hard violations = 0; forbidden = 0; regret ≤ 15%; unnecessary ≤ 20%; `releaseReady` |
| unnecessary multi-agent | `router/static-router.ts` (`workflowTools`, `abstain` paths), dataset `single_agent_sufficient` annotations | no `/multi` route where `single_agent_sufficient` |
| isolation | `router/agent-graph.ts`, `session/` worker context, `vfs/` mounts | per-worker VFS/PEP/context are separate objects, not shared references |
| attenuation | `router/agent-graph.ts`, `contracts/` AgentGraph worker model | worker capability set ⊂ orchestrator; explicit attenuated model/tool/skill lists |
| merge | `router/merge.ts` (or equivalent) | deterministic ordering, conflict resolution, no silent data loss |
| fallback | `router/fallbacks.ts` (11 typed fallbacks), `router/pipeline.ts` DAG failure path | each fallback has a distinct typed class + a test; failure propagates as typed error |
| adversarial routing | `router/static-router.ts` veto paths, `tools/browser-operate.ts` origin allowlist, `tools/computer-operate.ts` app allowlist, `tools/media-errors.ts` | deny-before-act; private-IP block; no bypass when adapter absent |

## Inputs you may read (must exist, else that is itself a finding)

- `verification/gates/phase3-gate.json` (16 requirements, byte-frozen)
- `artifacts/phase-3/*.json` (gate evidence produced by the pre-acceptance local run)
- Every file listed under `source_files` / `test_files` in `phase3-gate.json`
- `docs/plans/PHASE3_IMPLEMENTATION_PLAN.md` (WP-1..WP-5 narrative)

## Read-only hard rules

- No `Write`, `Edit`, `mv`, `rm`, `git commit/push/rebase/reset/checkout`.
- No `npm`, `npx`, `pnpm`, `tsc`, `vitest`, `node` execution. Static reading only.
- Do not modify `spec/`, `control/`, `verification/gates/`, `artifacts/` on disk.

## Output contract

Produce one verdict file per requirement in the phase-3 flat convention:

`artifacts/phase-3/<REQUIREMENT_ID>.glm-verification.json`

Shape (mirrors phase-1 `glm-verification.json`):

```json
{
  "requirement_id": "AH-ROUTER-EVAL-001",
  "model": "glm-5.2",
  "reasoning_effort": "xhigh",
  "commit": "<HEAD sha>",
  "tree": "<git tree sha>",
  "source_files": ["evals/routing/eval.ts", "evals/routing/dataset.json"],
  "verdict": "pass | pass_with_notes | fail",
  "severity": "none | low | medium | high | critical",
  "findings": [
    {
      "severity": "low",
      "category": "correctness | completeness | isolation | attenuation | merge | fallback | security | dead_code | misleading_default",
      "description": "concrete claim with file:line",
      "location": "path:line"
    }
  ],
  "summary": "one paragraph: what passes, what fails, what to fix first",
  "finishReason": "stop",
  "usage": { "completion_tokens": 0, "prompt_tokens": 0, "total_tokens": 0 }
}
```

Plus one rollup: `artifacts/phase-3/phase3-acceptance-report.json` with
`{ schema_version, model, reasoning_effort, commit, tree, overall: "accept|accept_with_notes|reject", per_requirement: [verdicts], axes_checked: [six + adversarial], findings_total }`.

## Verdict semantics

- `pass` — axis verified from code, no material gaps.
- `pass_with_notes` — implementation sound; minor findings (≤ medium) that don't
  violate a frozen exit criterion. Gate may still ship; notes become follow-up.
- `fail` — any hard-constraint violation reachable in code, any veto path that
  fails open, any unisolated/unattenuated worker, any missing typed fallback, or
  evidence claims that contradict code.

## After you finish

Report verdicts in your final message: overall verdict, per-axis pass/fail,
top-3 findings by severity, and any requirement whose gate evidence you could
not corroborate.
