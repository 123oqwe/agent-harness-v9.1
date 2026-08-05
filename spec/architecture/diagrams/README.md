# Architecture Diagrams

18 SVG diagrams: 9 original (v8, updated to v9.1 where noted) + 9 new (v9.1).

## Original Diagrams (updated to v9.1)

| # | File | Description | v9.1 Status |
|---|------|-------------|-------------|
| 1 | [01-harness-14-modules.svg](01-harness-14-modules.svg) | Agent Harness System Architecture — 14 Modules inside Harness Boundary | ✓ redrawn v9 (13-stage DAG, no Re-router) |
| 2 | [02-request-to-outcome.svg](02-request-to-outcome.svg) | Complete Execution Flow — User Input → RunPlan → Execution → Outcome | ✓ redrawn v9 (20-step sequential, Policy at step 3) |
| 3 | [03-routing-dag.svg](03-routing-dag.svg) | Routing & Orchestration — v9 Dependency-Aware DAG (replaces v8 8-routers + Re-router) | ✓ redrawn v9 (13-stage dependency DAG) |
| 4 | [04-three-orthogonal-dimensions.svg](04-three-orthogonal-dimensions.svg) | Three Orthogonal Dimensions + Workflow Overlay — Strategy × Workflow × Agent Topology | ✓ redrawn v9 (3 dimensions, v8 label cleaned) |
| 5 | [05-context-topologies.svg](05-context-topologies.svg) | Context Topologies — 7 Types (Shared Full/Selective/Parent-Child/Isolated/Artifact/Blackboard/Blind) | ✓ redrawn v9 (7 topologies + F8 ref) |
| 6 | [06-model-api-gateway.svg](06-model-api-gateway.svg) | Model/API Gateway — Capability Registry + Provider Policy + Dynamic Selection | ✓ redrawn v9 (Capability Registry + F5/F11) |
| 7 | [07-operation-state-machine.svg](07-operation-state-machine.svg) | Operation State Machine v9 (37 states) — CREATED → COMPILED → ... → EFFECT_CONFIRMED | ✓ redrawn v9 (37 states, no re-router overlay) |
| 8 | [08-mission-layer.svg](08-mission-layer.svg) | Mission Layer + Dynamic Capability + Self-Evolving Toolchain (Phase 6) | ✓ redrawn v9 (RunPlan, 10 states, no v6.1) |
| 9 | [09-tool-skill-catalog.svg](09-tool-skill-catalog.svg) | Tool & Skill Fabric — Registry/Search and 31 phased tools (9 P1 + 11 P2 + 5 P3 + 6 P6) | ✓ normalized v9.2 (representative tables, authoritative list in tool-skill-fabric.md) |

## New Diagrams (v9.1)

| # | File | Description | Spec Source |
|---|------|-------------|-------------|
| 10 | [10-capability-token-lifecycle.svg](10-capability-token-lifecycle.svg) | Capability Token Lifecycle — 签发 → 验证 → TOCTOU 重验 → 单次使用 → 失效 | capability-token.schema.json (18 fields) + action-control.md (12 steps) |
| 11 | [11-realtime-execution-visualization.svg](11-realtime-execution-visualization.svg) | Real-time Execution Visualization — StreamEvent → Event Bus → asyncapi → UI | realtime-execution-visualization.md + asyncapi.yaml + runtime-core.md |
| 12 | [12-failure-recovery.svg](12-failure-recovery.svg) | Failure Recovery & Reconciliation — effect-state-aware resume + compensation decision tree | failure-recovery.md + operation.machine.json (37) + external-effect.machine.json (14) |
| 13 | [13-security-control-mapping.svg](13-security-control-mapping.svg) | Security Control Mapping — 15 CTRL → architecture enforcement points | security-control-mapping.md + threat-model/controls.yaml |
| 14 | [14-runtime-topology.svg](14-runtime-topology.svg) | Runtime Topology — Phase 1 single-process → Phase 3 cross-process → Phase 5 cross-host | runtime-topology.md + routing-system.md (F8) |
| 15 | [15-vfs-data-flow.svg](15-vfs-data-flow.svg) | VFS Data Flow — 4 entry → CompositeBackend → 5 backend + transaction + offload | virtual-filesystem.md (F4) + context-memory-rag.md (F10) |
| 16 | [16-evolution-shadow.svg](16-evolution-shadow.svg) | Evolution Shadow Mode — dual-path execution with isolation boundaries | evolution.md (shadow mode) |
| 17 | [17-mission-run-memory.svg](17-mission-run-memory.svg) | Mission → Run → Session → Memory hierarchy + Phase 1→4 migration | runtime-core.md (progress.json) + mission.machine.json + run.machine.json |
| 18 | [18-hook-architecture.svg](18-hook-architecture.svg) | Hook Architecture — Loop Engine injection points + re-validation (AR-007) | runtime-core.md (Hook Re-validation) |

## Usage

- Diagrams 1-9 are original v8 artifacts, updated to v9.1 where contradictions were found (state counts, tool counts, routing model).
- Diagrams 10-18 are new v9.1 artifacts covering previously missing architecture areas.
- All diagrams are normative architecture references (NORMATIVE_PRECEDENCE priority 8).
- The SVG files are the canonical source for visual rendering.
- Modifications to frozen contracts require ADR + CTO approval.
- The v12 HTML overview (`/Users/guanjieqiao/agent-runtime-v7/Agent-Harness-v12-Architecture.html`) integrates all 18 diagrams into a single navigable view.
