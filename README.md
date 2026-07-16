# Agent Harness v9.2.1

**Status is managed by `control/current-state.json`. This README does not contain status.**

## Repository Structure

```
agent-harness-v9.1/
├── control/           ← Authoritative state (current-state.json)
├── spec/              ← Immutable specification (workers cannot modify)
│   ├── product/       ← PRD, personas, UX, journeys
│   ├── architecture/  ← 14 module specs
│   ├── requirements/  ← Requirement registry (NDJSON)
│   ├── contracts/     ← 19 JSON Schemas
│   ├── state-machines/← 7 state machines + TLA+
│   ├── phases/        ← 9 phase manifests
│   ├── api/           ← OpenAPI, AsyncAPI, error catalog
│   ├── ui/            ← Screen specs, routes, states
│   ├── adr/           ← 12 ADRs
│   ├── threat-model/  ← Threat model
│   ├── deployment/    ← Deployment specs
│   ├── operations/    ← SLOs, runbooks, alerts
│   ├── data-tests/    ← Data test governance
│   ├── evals/         ← 14 domain eval suites
│   └── appendix/      ← Deprecated content
├── factory/           ← Autonomous engineering factory (Python)
├── harness/           ← Agent Harness product code (TypeScript)
├── infra/             ← CI/CD and infrastructure
├── evidence/          ← Immutable verification records
└── control/           ← current-state.json (ONLY authority)
```

## Current Phase

Phase 0 — VERIFIED. Phase 1 — READY.

See control/current-state.json for authoritative status.
