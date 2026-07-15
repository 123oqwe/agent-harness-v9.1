# AGENTS.md

## Canonical Specification Paths

```
SPEC_ROOT=agent-harness-v9.1/
REQUIREMENTS=agent-harness-v9.1/requirements/requirements.ndjson
PHASES=agent-harness-v9.1/phases/
CONTRACTS=agent-harness-v9.1/contracts/
STATE_MACHINES=agent-harness-v9.1/state-machines/
THREAT_MODEL=agent-harness-v9.1/threat-model/
```

## How to Select Current Task

1. Read `phases/phase-N.yaml` for current phase
2. Read `requirements/requirements.ndjson` for requirements with `implementation_maturity: not_started` AND all dependencies `verified`
3. Pick ONE requirement
4. Follow `AI_EXECUTION_PROTOCOL.md`

## Forbidden Changes

- Do not delete tests, lower thresholds, add skip, weaken gates
- Do not change required fields to optional
- Do not enable production credentials
- Do not mark complete without command evidence
- Do not bypass Policy/PEP/sandbox
- Do not implement deprecated v8 content (see `appendix/appendix/deprecated-v8-content/`)
- Do not modify frozen contracts without ADR + human approval

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

## Branch/Worktree Rules

- One branch per requirement: `req/AH-DOMAIN-TOPIC-NNN`
- Isolated worktree per requirement
- Commit with requirement ID in message

## Blocked Protocol

See `AI_EXECUTION_PROTOCOL.md` → Blocked Protocol section.
