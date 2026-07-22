> ⚠️ ARCHIVED (2026-07-20): This file contained stale phase status ("Phase 0: READY" when it is VERIFIED, "Phase 1-8: BLOCKED" when Phase 1 is READY).
> It is superseded by `AGENTS.md` (root) and `control/current-state.json` (authoritative status).
> Retained for historical reference only. DO NOT use this file for current status — read `control/current-state.json`.

# Execution Bootstrap Prompt

## For: AI Engineering Team (Codex / Claude Code)

You are the AI engineering team implementing the Agent Harness v9.2 specification.

### Current Status

- **Specification:** VERIFIED
- **Phase 0R:** VERIFIED
- **Phase 0:** READY
- **Phase 1-8:** BLOCKED

### What Has Been Verified

- Model checking: VERIFIED (TLC v2.19, 251 states, 0 errors, 3 invariants)
- Specification validator: PASS (0 failures, actual command execution)
- Requirements: 213 (expanded from 40)
- API contracts: 6 files created (OpenAPI 1291 lines, AsyncAPI 211 lines)
- UI screens: 19 screens with real differentiated content
- CODEOWNERS: Created for protected paths
- Orchestrator: Skeleton created (4 scripts)
- Role files: 17 .agents/ files created
- Adversarial review: 55 issues found, P0=0, P1=0

### What Is Still Blocked

1. Phase 0 Reference Project Gate not yet run
2. Product code not started (product/ is empty)
3. No real Codex/Claude worker sessions executed yet
4. No staging/canary/production deployment

### What Has Been Verified

1. Model check: VERIFIED (TLC v2.19, 251 states, 0 errors)
2. Spec gate: PASS (10/10 checks, actual file checks)
3. Failure injection: PASS (10/10 failures detected)
4. Factory tests: PASS (state store, controller, blocker, budget, secret, worktree, merge queue)
5. ADRs: 12/12 resolved (0 NEEDS_VERIFICATION)
6. Capability coverage: 100% (108/108 mapped)
7. Requirements: 213

### Before You Start

1. Read `NORMATIVE_PRECEDENCE.md`
2. Read `AI_EXECUTION_PROTOCOL.md`
3. Read your role file in `.agents/`
4. Read `phases/phase-0R.yaml` for current phase
5. Read `requirements/requirements.ndjson` for READY requirements

### Execution Rules

- Take ONE requirement at a time
- Work in isolated worktrees
- Write tests before or with implementation
- Run actual commands
- Generate Evidence Packages from actual output
- NEVER fabricate test output
- NEVER weaken gates
- NEVER change required fields to optional
- NEVER enable production credentials
- Stop on unresolved specification conflicts
- Generate Phase Handoffs
- Require independent verifier
- Require ReleaseApproval for production

### Start Here

### What Is Still Blocked (Phase 0, not 0R)

1. Phase 0 has 7 ADR spikes (AH-SPIKE-001 to 007) not yet executed
2. Product code not started (harness/ has only config files)
3. No staging/canary/production deployment

Only when Phase 0 gate passes may Phase 1 begin.
Only when Phase 0 passes may Phase 1 begin.
