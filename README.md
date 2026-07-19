# Agent Harness v9.2.1

**Status is managed by `control/current-state.json`. This README does not contain status.**

## What is this?

Agent Harness is a general-purpose agent platform. This repo contains both the **specification** and the **product code** being built against it.

- `spec/` — immutable product & engineering specification (contracts, requirements, architecture, phases)
- `control/current-state.json` — the ONLY authoritative status source
- `factory/` — autonomous engineering system that dispatches Codex/Claude workers
- `harness/` — the Agent Harness product code (TypeScript)
- `infra/` — CI/CD and phase gate scripts
- `evidence/` — immutable verification records

## For AI workers (Codex / Claude Code)

Read `AGENTS.md` first. It has a Quick Start that walks you from zero to your first requirement.

## Repository Structure

```
agent-harness-v9.1/
├── AGENTS.md          ← AI worker entry point (read first)
├── CLAUDE.md          ← Claude Code entry (points to AGENTS.md)
├── control/           ← current-state.json (ONLY authority)
├── spec/              ← immutable specification
│   ├── product/       ← PRD, personas, UX, journeys
│   ├── architecture/  ← 18 architecture specs + 18 diagrams
│   ├── requirements/  ← requirement registry (NDJSON)
│   ├── contracts/     ← 19 JSON Schemas
│   ├── state-machines/← 7 state machines + TLA+
│   ├── phases/        ← 10 phase manifests (0R + 0-8, status MUST match current-state.json)
│   ├── api/           ← OpenAPI, AsyncAPI, error catalog
│   ├── ui/            ← screen specs, routes, states
│   ├── adr/           ← 13 ADRs
│   ├── threat-model/  ← threats, controls, trust boundaries
│   ├── deployment/    ← deployment specs
│   ├── operations/    ← SLOs, runbooks, alerts
│   ├── data-tests/    ← data test governance
│   └── evals/         ← 14 domain eval suites (Phase 1: 6 with phase-1.yaml)
├── factory/           ← autonomous engineering factory (Python)
├── harness/           ← Agent Harness product code (TypeScript)
├── infra/             ← CI/CD and phase gates
└── evidence/          ← immutable verification records (do not modify without CTO approval)
├── HARNESS_NOTES.md   ← audit notes (non-normative, for reference only)
```

## Current Phase

See `control/current-state.json` for authoritative status.
