# AGENTS.md

## Quick Start (for a fresh agent — read this first)

You are implementing the Agent Harness product, Phase 0 through Phase 8, autonomously.
Follow these steps IN ORDER. Do not skip.

1. **Read status**: `control/current-state.json` — this is the ONLY authoritative status source. It tells you which phase is READY to work on. Do not trust any other file's status field.
2. **Read the protocol**: `spec/AI_EXECUTION_PROTOCOL.md` — defines the work loop (15 steps), MUST/MUST NOT rules, Blocked Protocol.
3. **Read precedence**: `spec/NORMATIVE_PRECEDENCE.md` — when sources conflict, higher priority wins. Runtime status: `current-state.json` is authority; phase manifest status MUST match it.
4. **Read current phase manifest**: `spec/phases/phase-N.yaml` where N = current phase from step 1. This lists in-scope requirements and enabled domains.
5. **Pick ONE requirement**: from `spec/requirements/requirements.ndjson` with `implementation_maturity: not_started` AND all dependencies `verified`. The phase manifest's `requirements` list defines scope.
6. **Implement**: follow `spec/AI_EXECUTION_PROTOCOL.md` work loop. Write tests first. Run `cd harness && npm test`. Generate evidence from actual command output.
7. **Verify**: use a different model family as independent verifier. Update requirement `implementation_maturity` to `verified` in registry.
8. **Repeat** until all phase requirements are verified, then run the phase gate (`infra/ci-gate-phaseN.sh`).

If you are stuck, follow the Blocked Protocol in `spec/AI_EXECUTION_PROTOCOL.md`. Do not guess.

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
3. Read `spec/requirements/requirements.ndjson` for requirements where: `implementation_maturity: not_started` AND `delivery_phase` equals the current phase AND all dependencies have `implementation_maturity: verified` AND the current phase is not BLOCKED (per current-state.json)
4. Pick ONE requirement (prefer the order listed in phases/phase-N.yaml)
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

## Context Saving Guide

### Two operating modes

**Mode A — Factory-dispatched worker**: You receive a ContextPacket from `factory/controller`. The packet contains your requirement, acceptance criteria, schemas, and forbidden paths. You do NOT need to read AGENTS.md or browse the repo — the packet is your scope. Follow the prompt you received.

**Mode B — Manual session** (you were started directly in this repo): Read AGENTS.md (this file) as your entry point, then follow the Quick Start steps above.

### What NOT to read (in either mode, unless specifically needed)

These directories are NOT product specs. Reading them proactively wastes context and may mislead with outdated content:

- `spec/appendix/archive/non-normative/` — old audit artifacts superseded by `control/current-state.json`. Read only if investigating a specific past audit finding.
- `spec/appendix/deprecated-v8-content/` — 14 files documenting v8→v9 changes. Read ONLY if a requirement references a v8 concept and you need to understand what v9 corrected.
- `spec/appendix/competitor-research/` — framework comparison and gap analysis. Background only. Read if working on `product/design-framework.md` or ADR-013.
- `spec/appendix/evidence-registry/` and `spec/appendix/original-documents/` — placeholder READMEs, no substantive content.
- `HARNESS_NOTES.md` — audit notes from spec review. Non-normative.

### Factory — what it is and when to read it

`factory/` is the autonomous engineering system that dispatches Codex/Claude workers to implement requirements. It is NOT a product spec — it is the construction equipment. See `factory/FACTORY_MANUAL.md` for how it works.

- **If you are a dispatched worker**: you do not need to read factory source code. Your ContextPacket is your scope.
- **If you are running or debugging the factory**: read `factory/FACTORY_MANUAL.md` first, then the relevant module under `factory/`.
- **If you are implementing a product requirement manually**: you do not need to read factory source code. The factory is optional — you can implement requirements directly by reading spec/ and writing code in harness/.

### Evidence directory

`evidence/` contains immutable verification records from past runs. Do not modify (requires CTO approval). Read only if verifying a specific past result or if your requirement's acceptance criteria reference an evidence file.

## What TO Read (normative, in priority order)

1. `control/current-state.json` — status (only authoritative source)
2. `spec/AI_EXECUTION_PROTOCOL.md` — work loop and rules
3. `spec/NORMATIVE_PRECEDENCE.md` — priority hierarchy (contracts > phases > requirements > state machines > security > architecture > product)
4. `spec/phases/phase-N.yaml` — current phase manifest
5. `spec/requirements/requirements.ndjson` — your assigned requirement
6. `spec/contracts/*.schema.json` — the frozen contracts for your requirement
7. `spec/architecture/*.md` — the architecture spec for your module (see Scenario-Based Reading Index below)
8. `spec/state-machines/*.machine.json` — state machine definitions
9. `spec/threat-model/threats.yaml` and `controls.yaml` — security controls

Everything else in `spec/` (product/, api/, ui/, adr/, deployment/, operations/, data-tests/, evals/, types/, scripts/) is read on-demand when your requirement touches that domain.

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

## Scenario-Based Reading Index

When implementing a specific type of work, read these specs first (in addition to AI_EXECUTION_PROTOCOL.md and the current phase manifest):

| Scenario | Read these |
|----------|-----------|
| Implementing a tool | architecture/tool-skill-fabric.md, architecture/action-control.md, contracts/tool-spec.schema.json, contracts/effect-risk.schema.json, contracts/capability-token.schema.json |
| Implementing Loop Engine | architecture/runtime-core.md, contracts/run-plan.schema.json, state-machines/run.machine.json, state-machines/step.machine.json |
| Implementing Sandbox | architecture/runtime-core.md, architecture/trust-boundaries.md, threat-model/threats.yaml (SSRF, TOCTOU), architecture/action-control.md (steps 7-9) |
| Implementing Policy/PEP | architecture/action-control.md, architecture/trust-boundaries.md, contracts/effect-risk.schema.json, contracts/capability-token.schema.json, threat-model/controls.yaml |
| Implementing Router | architecture/routing-system.md, architecture/request-to-outcome.md, contracts/run-plan.schema.json, contracts/agent-graph.schema.json |
| Implementing Memory | architecture/context-memory-rag.md, contracts/memory-record.schema.json, architecture/evolution.md (cold start safety) |
| Implementing RAG | architecture/context-memory-rag.md (injection pattern library), contracts/context-graph.schema.json |
| Implementing VFS | architecture/virtual-filesystem.md, architecture/tool-skill-fabric.md (file tools via VFS), architecture/action-control.md (step 9 VFS dispatch), architecture/context-memory-rag.md (RAG via VFS) |
| Implementing Computer Use | architecture/tool-skill-fabric.md (computer_operate/browser_operate, screen injection isolation), contracts/effect-risk.schema.json (screen_access), contracts/tool-spec.schema.json (display_policy), threat-model/threats.yaml (THREAT-SCREEN-INJECTION) |
| Implementing Two-Phase Runtime | architecture/runtime-core.md (RunPhase), architecture/action-control.md (step 8 credential exchange), threat-model/threats.yaml (THREAT-CRED-REACH) |
| Implementing Network Policy | contracts/effect-risk.schema.json (egress_policy), threat-model/controls.yaml (CTRL-EGRESS-002), architecture/tool-skill-fabric.md (egress_policy_ref) |
| Implementing Cache Engineering | architecture/model-api-gateway.md (Prompt Cache Engineering, tool-masking), architecture/context-memory-rag.md (offloading, cache-aware compaction) |
| Implementing real-time UI | architecture/realtime-execution-visualization.md, api/asyncapi.yaml (run_event_stream), ui/screens/chat.yaml (steer endpoint), architecture/runtime-core.md (StreamEvent, steering 3 queues) |
| Implementing failure recovery | architecture/failure-recovery.md, state-machines/operation.machine.json (37 states), state-machines/external-effect.machine.json (14 states), architecture/runtime-core.md (effect-state-aware resume), architecture/virtual-filesystem.md (OverlayBackend transaction rollback) |
| Implementing security controls | architecture/security-control-mapping.md, threat-model/controls.yaml, threat-model/control-test-map.yaml, architecture/action-control.md (12-step pipeline), architecture/trust-boundaries.md (TCB 6 components) |
| Implementing multi-agent (Phase 3) | architecture/runtime-topology.md, architecture/routing-system.md (FG7/FG8), contracts/agent-graph.schema.json (message_security), architecture/trust-boundaries.md (FG8 cross-process), architecture/context-memory-rag.md (7 context topologies) |
| Implementing external actions (Phase 5) | architecture/runtime-topology.md, architecture/failure-recovery.md (reconciliation), state-machines/external-effect.machine.json, architecture/action-control.md (effect-state-aware resume, credential exchange), contracts/effect-risk.schema.json (egress_policy for connector traffic) |
| Implementing MCP | architecture/tool-skill-fabric.md (MCP Allowlist), threat-model/threats.yaml (TOOL-POISONING) |
| Implementing Verification | architecture/assurance.md, contracts/evidence-package.schema.json, contracts/verification-graph.schema.json |
| Security testing | threat-model/ (all), state-machines/invariants.md, state-machines/model-check-report.txt |
| Writing tests | AI_EXECUTION_PROTOCOL.md (work loop), current phase manifest (exit_criteria, mutation_score) |
