# Protected Paths

Implementation workers CANNOT modify these paths. Changes require CTO approval.

## Protected (CODEOWNERS enforced)

- `spec/contracts/` — JSON Schemas
- `spec/state-machines/` — State machine definitions + TLA+
- `spec/requirements/` — Requirement registry
- `spec/phases/` — Phase manifests
- `spec/NORMATIVE_PRECEDENCE.md`
- `spec/AI_EXECUTION_PROTOCOL.md`
- `spec/CODEOWNERS`
- `control/` — Current state
- `evidence/` — Immutable evidence

## Worker-Editable

- `product/` — Product implementation
- `factory/` — Factory code (but not factory state)
- `infra/` — Infrastructure definitions

## Enforcement

1. CODEOWNERS file (GitHub)
2. Required status checks (CI)
3. Branch protection rules
4. Factory controller refuses to merge protected path changes
