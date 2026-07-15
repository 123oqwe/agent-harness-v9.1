# AGENTS.md

## Canonical Specification Paths

```
SPEC_ROOT=spec/
REQUIREMENTS=spec/requirements/requirements.ndjson
PHASES=spec/phases/
CONTRACTS=spec/contracts/
STATE_MACHINES=spec/state-machines/
THREAT_MODEL=spec/threat-model/
CONTROL=control/current-state.json
FACTORY=factory/
HARNESS=harness/
EVIDENCE=evidence/
```

## How to Select Current Task

1. Read `control/current-state.json` for current phase and status
2. Read `spec/phases/phase-N.yaml` for phase manifest
3. Read `spec/requirements/requirements.ndjson` for requirements with `implementation_maturity: not_started` AND all dependencies `verified`
4. Pick ONE requirement
5. Follow `spec/AI_EXECUTION_PROTOCOL.md`

## Forbidden Changes

- Do not delete tests, lower thresholds, add skip, weaken gates
- Do not change required fields to optional
- Do not enable production credentials
- Do not mark complete without command evidence
- Do not bypass Policy/PEP/sandbox
- Do not implement deprecated v8 content (see `spec/appendix/deprecated-v8-content/`)
- Do not modify frozen contracts without ADR + human approval
- Do not modify `spec/`, `control/`, or `evidence/` without CTO approval

## Testing Requirements

- Write tests first or alongside implementation
- Run targeted tests, then package tests
- Mutation testing score must meet phase threshold
- Contract fixtures must validate (valid pass, invalid fail)
- No active-path stubs allowed

## Evidence Requirements

- Generate Evidence Package from actual command output
- Independent verifier (different model family) must check
- Self-reported PASS without evidence is forbidden
- Evidence stored in `evidence/` directory

## Branch/Worktree Rules

- One branch per requirement: `req/AH-DOMAIN-TOPIC-NNN`
- Isolated worktree per requirement
- Commit with requirement ID in message

## Blocked Protocol

See `spec/AI_EXECUTION_PROTOCOL.md` → Blocked Protocol section.
