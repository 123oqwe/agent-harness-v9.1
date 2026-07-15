# Harness Boundary


![01-harness-14-modules.svg](diagrams/01-harness-14-modules.svg)

## Definition
Agent Harness is the complete product technical system containing 14 modules. It is permanent. Router generates RunPlan; Runtime Core executes it. The Harness is NOT rebuilt per task.

## 14 Modules
1. Prompt & Instruction System
2. Context & Data System (RAG 5 subsystems)
3. Model & API Gateway (Capability Registry)
4. Router & Orchestration System (dependency-aware DAG)
5. Agent Runtime Core (Loop/Scheduler/State/Streaming)
6. State System (Conversation + Workflow)
7. Memory System (6 types + Provenance)
8. Tools/Skills/Function Call/MCP
9. Execution Environment & Sandbox
10. Action Control & Human Review (Policy/Consent/Capability/PEP)
11. Retry/Recovery/Reconciliation
12. Assurance & Verification (Independent Verifier)
13. Observability & Audit (Tracing/Profiler/Replay/Anomaly)
14. Evaluation & Evolution (Observe/Extract/Synthesize/Optimize)

## Module Boundary Table (can/cannot)
See requirements and module-boundaries.md for detailed can/cannot table for each module.

## Non-Goals
- Does not train foundation models
- Does not allow model to self-grant permissions
- Does not require all tasks to use Agent or multi-Agent
- Does not promise all providers support transactions
- Does not call compensation "rollback"
- Does not store private chain-of-thought
- Does not allow generated tools to auto-obtain production permissions


## Mission Layer Architecture
![Mission Layer](diagrams/08-mission-layer.svg)
