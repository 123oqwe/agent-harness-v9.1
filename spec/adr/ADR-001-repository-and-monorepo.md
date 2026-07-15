# ADR-001: Repository and Monorepo Layout

## Status: ACCEPTED
## Decision
Turborepo monorepo with packages for each module.

## Rationale
- Shared types and contracts across packages
- Atomic commits across modules
- Simplified CI/CD

## Structure
```
packages/
  contracts/     (JSON schemas, TypeScript types)
  runtime-core/  (Loop, Session, State)
  router/        (Router DAG)
  security/      (Policy, PEP, Capability, Auth)
  tools/         (Tool implementations)
  ui/            (Frontend)
  api/           (Backend API)
  eval/          (Evaluation framework)
```

## Status: ACCEPTED

## Verification Evidence
- Tool: Turborepo 2.10.5
- Command: `npx turbo --version`
- Result: exit code 0
- Date: 2026-07-16T03:47:55.201681

## Decision
Turborepo is available. Using Turborepo for monorepo management.
