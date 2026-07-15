# Architecture Diagrams

These 9 SVG diagrams were extracted from the v8 PRD and are preserved as canonical architecture artifacts.

| # | File | Description |
|---|------|-------------|
| 1 | [01-harness-14-modules.svg](01-harness-14-modules.svg) | Agent Harness System Architecture — 14 Modules inside Harness Boundary |
| 2 | [02-request-to-outcome.svg](02-request-to-outcome.svg) | Complete Execution Flow — User Input → RunConfiguration → Execution → Outcome |
| 3 | [03-routing-8-routers.svg](03-routing-8-routers.svg) | Routing & Orchestration System — 8 Routers + Global Optimizer + Re-router |
| 4 | [04-three-orthogonal-dimensions.svg](04-three-orthogonal-dimensions.svg) | Three Orthogonal Dimensions + Workflow Overlay — Strategy × Workflow × Agent Topology |
| 5 | [05-context-topologies.svg](05-context-topologies.svg) | Context Topologies — 7 Types (Shared Full/Selective/Parent-Child/Isolated/Artifact/Blackboard/Blind) |
| 6 | [06-model-api-gateway.svg](06-model-api-gateway.svg) | Model/API Gateway — Capability Registry + Provider Policy + Dynamic Selection |
| 7 | [07-operation-state-machine.svg](07-operation-state-machine.svg) | Operation State Machine v6.1 (35 states) — CREATED → COMPILED → ... → EFFECT_CONFIRMED |
| 8 | [08-mission-layer.svg](08-mission-layer.svg) | Mission Layer + Dynamic Capability + Self-Evolving Toolchain (Phase 6) |
| 9 | [09-tool-skill-catalog.svg](09-tool-skill-catalog.svg) | Concrete Tool & Skill Catalog — 20 Tools + 10 Skills |

## Usage
- These diagrams are normative architecture references.
- They may be rendered in HTML/PDF overviews but the SVG files are the canonical source.
- Modifications require ADR + CTO approval (protected path).
