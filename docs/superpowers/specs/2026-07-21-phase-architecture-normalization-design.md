# Agent Harness v9.1 Phase Architecture Normalization

Date: 2026-07-21

Status: accepted design, pending repository-wide normalization

Scope: architecture, contracts, requirements, Phase manifests, diagrams, gates, and authoritative state. Product source implementation is explicitly out of scope for this design change.

## 1. Objective

Normalize Phase 1–8 so the repository has one coherent product architecture, no duplicate ownership, no dependency inversion, and no loss of existing capability detail.

The normalized architecture must make it possible to answer, mechanically:

1. Which Phase first delivers a capability?
2. Which module owns its contract and state?
3. Which later Phase may enhance it?
4. Which source, tests, evals, controls, evidence, and gate certify it?
5. Whether product source implementation may start without an unresolved architecture decision.

## 2. Non-negotiable constraints

- Existing capability details, acceptance criteria, security invariants, privacy invariants, tests, controls, and evidence obligations are not deleted.
- Existing requirement IDs remain stable whenever the responsibility remains materially the same.
- Requirements may move Phase, be narrowed to a concrete core, or be supplemented by new requirements.
- When an existing requirement must be split, its existing ID owns one concrete deliverable; new IDs own the remaining extensions and record their origin.
- A capability has one introduction Phase and one owning module. Later Phases may enhance it through versioned interfaces, not create a parallel implementation.
- Router generates a frozen RunPlan. Runtime executes it. Security constrains both and owns the final deny decision.
- Schema is the contract source of truth. Generated TypeScript must pass byte-level or structural parity checks.
- Runtime event log remains the authority for execution state. Memory is not a replacement for execution state.
- Independent GLM evaluation runs only after the local Phase gate passes in a clean checkout.

## 3. Selected approach

Use dependency-first Phases.

Rejected alternatives:

- Minimal patching was rejected because it leaves Phase 1 verticals dependent on a Router introduced in Phase 3.
- Vertical-first Phases were rejected because Router, Security, Memory, Tool/Skill discovery, and Eval would be repeatedly reimplemented for each product surface.

The selected approach creates a complete single-agent kernel in Phase 1 and progressively adds context, orchestration, memory, external effects, long-running missions, enterprise isolation, and production operations.

## 4. System boundary and unique execution path

The Agent Harness is one persistent product runtime. It is not rebuilt per task.

Normative execution path:

```text
Input
  -> TaskContract
  -> Intent/Profile
  -> Router
  -> Frozen RunPlan
  -> Runtime Loop
  -> ActionManifest
  -> Policy / Consent / Capability / PEP
  -> Tool or Skill Dispatch
  -> VFS / Sandbox / Provider
  -> Runtime Event Log
  -> Verification / Evidence
  -> Memory Write Proposal
```

A re-route always creates a new RunPlan revision and revokes capabilities bound to the old revision.

## 5. Module ownership

### 5.1 Contracts

Owns TaskContract, RunPlan, ToolSpec, SkillSpec, AgentGraph, ContextGraph, VerificationGraph, ActionManifest, EffectRisk, CapabilityToken, StreamEvent, and MemoryRecord.

Contracts do not implement runtime behavior. JSON Schema is authoritative; TypeScript and package exports are generated deterministically.

### 5.2 Router

Owns intent profiling, domain and experience resolution, candidate generation, resource binding, graph construction, constraint solving, and RunPlan freeze.

Router may produce derived risk assessment and required consent. It cannot define policy, sign capabilities, execute tools, or mutate runtime state.

### 5.3 Runtime

Owns Loop, durable Session, event sourcing, retry classification, pause/resume, steering, streaming, budget enforcement hooks, and plan revision execution.

Runtime accepts a frozen RunPlan and cannot silently expand tools, skills, resources, model access, or permissions.

### 5.4 Model/API Gateway

Owns provider adapters, model capability registry, provider health, usage metering, structured output normalization, fallback compatibility, and data-policy revalidation during model switches.

The Gateway resolves model requirements supplied by Router. It does not own routing policy or security policy.

### 5.5 Tool and Skill Fabric

Owns ToolRegistry, ToolSearch, ToolLoader, SkillRegistry, SkillSearch, SkillLoader, immutable registry snapshots, and four transports: native, CLI wrapper, MCP, and HTTP API.

Tool and Skill discovery uses progressive disclosure:

1. Always-loaded metadata: identity, short description, capabilities, risk, cost, version, and trust state.
2. Search-selected full specification: schemas, effects, dependencies, verification, and failure policy.
3. Execution-selected body and resources: skill instructions, referenced files, scripts, large schemas, or toolchain definitions.

CLI-composed and generated tools enter an untrusted registry. They are sandbox-only, have no secrets, no external write, and network denied by default. Usage counts never auto-promote trust.

### 5.6 Context and RAG

Owns ContextGraph compilation, token budgets, active-plan injection, mechanical offload, cache-aware compaction, context reset, and RAG ingest/index/retrieve/rerank/pack.

VFS permission filtering occurs before retrieval. RAG, tools, memory, and evidence cannot implement independent file permission paths.

### 5.7 Security

Owns identity, immutable policy, consent, Authorization Service, Capability issuance/revocation, PEP, Secrets Broker, credential exchange, security audit decisions, and deny-first behavior.

Security is not a Router. It enforces constraints:

- before routing;
- before RunPlan freeze;
- at every action dispatch.

### 5.8 VFS and Sandbox

VFS owns file-access authority, backend routing, path permissions, Overlay transactions, and evidence write constraints.

Sandbox owns process, filesystem, network, CPU, memory, output, timeout, cancellation, and platform isolation. Phase 1 uses OS-native adapters; Phase 2 may add a rootless OCI adapter; Phase 7 adds multi-tenant microVM isolation.

### 5.9 Memory

Owns memory proposals, provenance, trust, TTL, conflict resolution, deletion propagation, local-only enforcement, retrieval, and user control for episodic, semantic, procedural, preference, relationship, and goal memory.

Models cannot directly write high-trust memory. Runtime event state is not stored as semantic memory.

### 5.10 Evaluation and Assurance

Owns deterministic tests, integration scenarios, fault injection, adversarial tests, domain evals, routing evals, evidence packages, independent verifier input, and signed verification records.

The implementing model cannot score its own semantic completeness.

## 6. Router structure

There is one dependency-aware Router DAG, introduced as a static subset in Phase 1 and completed in Phase 3.

```text
Identity and immutable policy
  -> Intent / Task Profile
  -> Domain / Experience
  -> Context and capability probe
  -> Workflow and reasoning candidates
  -> Model / Tool / Skill / Environment binding
  -> AgentGraph
  -> ContextGraph
  -> Schedule binding
  -> VerificationGraph
  -> Joint constraint solver
  -> Policy validation
  -> Frozen RunPlan
```

Model, Tool, Skill, and RAG routing are resource-binding stages within this DAG:

- Model binding queries the Model Capability Registry.
- Tool binding queries ToolRegistry and ToolSearch.
- Skill binding queries SkillRegistry and SkillSearch.
- RAG binding selects retrieval and packing strategy for ContextGraph.
- Security supplies constraints and vetoes; it is never a candidate selector.

Phase 1 supports deterministic preflight, one optional structured Task Profiler call, Direct, ReAct, and Plan+Execute for one agent. Phase 3 adds global optimization, ReWOO where justified, static DAG, routing slip, workflow script, fan-out, and multi-agent context topologies.

## 7. Distinct control loops

Each loop has one state authority and one purpose.

1. Turn Loop, Phase 1: Reason -> Act -> Observe. Stops on goal, budget, cancel, deadline, refusal, malformed response, truncation, oscillation, or context reset.
2. Plan Loop, Phase 1: Plan -> Execute -> Verify -> Replan. Replanning produces a RunPlan revision.
3. Recovery Loop, Phase 1 and Phase 5: pre-dispatch failures may retry; in-flight effects require provider read-back; unknown effects enter reconciliation.
4. Context Loop, Phase 2: mechanical offload -> aligned compaction -> context reset. Security state is preserved exactly.
5. Orchestration Loop, Phase 3: DAG, routing slip, or workflow script. Child permissions and budgets only attenuate.
6. Learning Loop, Phase 4: outcome -> memory proposal -> verification -> approve/reject.
7. Mission Loop, Phase 6: run -> evaluate -> schedule -> sleep -> wake. Wake creates fresh context, capabilities, and authorization.
8. Evolution Loop, Phase 4+: candidate -> offline eval -> sandbox replay -> shadow -> approval -> limited activation.

These loops exchange typed events and artifacts. They do not write each other's private state stores.

## 8. State authorities

- Runtime event log: append-only authority for execution state.
- Snapshot: rebuildable runtime acceleration.
- Operation and ExternalEffect ledgers: authority for action/effect lifecycle.
- Memory Store: authority for approved cross-session knowledge.
- Mission and Schedule Store: authority for long-running mission and trigger state.
- Evidence Store: WORM authority for verification evidence.
- Registry snapshots: authority for the exact model/tool/skill versions bound to a RunPlan.

## 9. Permission pipeline

Every effectful action follows one pipeline:

```text
Schema validation
  -> EffectRisk extraction
  -> DerivedRiskTier
  -> Policy evaluation
  -> Pre-approval auto-review for T3+
  -> Consent
  -> Capability issuance
  -> PEP and TOCTOU revalidation
  -> single-use credential exchange
  -> VFS / Sandbox dispatch
  -> receipt
  -> postcondition verification
  -> immutable audit
```

The implementation must use schema-generated EffectRisk and Capability types. A hand-written parallel type system is forbidden.

## 10. Two evolution tracks

### 10.1 User adaptation

Learns user preferences, relationship context, goals, corrections, and approved procedures through memory proposals. Every record has provenance, trust, TTL, conflict policy, and delete behavior. Users can inspect, edit, delete, export, or disable this track.

User adaptation may change user-scoped defaults and recommendations. It cannot modify global safety policy, organization policy, or permission ceilings.

### 10.2 Agent capability evolution

Produces proposals for prompts, skills, route weights, tool wrappers, evals, and implementation cleanup. Proposals undergo offline evaluation, sandbox replay, isolated shadow comparison, independent verification, and human approval.

Capability evolution cannot modify Policy, expand tool/resource grants, raise risk ceilings, obtain secrets, enable external writes, bypass release gates, or automatically promote generated tools.

## 11. Normalized Phase responsibilities

### Phase 1: Single-Agent Product Kernel

Delivers a complete local single-agent execution system:

- TaskContract normalization and goal/success-criteria validation.
- Base intent profiler and Static Router.
- Direct, ReAct, and Plan+Execute strategies.
- Model adapter contract and ScriptedTestProvider.
- Loop Engine, durable linear Session, event log, snapshot, crash restore, progress bridge, retry, budget stop, and streaming.
- ToolRegistry, ToolSearch, four transport contracts, and nine base tools: read_file, list_directory, search_files, write_file, edit_file, execute_command_sandboxed, parse_document, create_artifact, ask_user.
- SkillRegistry, SkillSearch, SkillLoader, and baseline skills for repository exploration, bug fixing, feature implementation, test/verification, research/citation, document summarization, writing refinement, and dependency planning.
- Policy, Consent, Authorization Service, Capability, PEP, Secrets Broker, two-phase credential isolation, VFS, OS-native Sandbox, egress policy, audit, and evidence generation.
- Base evaluation runner using ScriptedTestProvider.
- Coding, local-document, provided-source research, writing, planning, and no-external-action personal-assistant verticals.
- Phase 1 UI surfaces already assigned to this Phase remain in scope.

Phase 1 explicitly excludes external writes, dynamic production tool generation, full RAG, multi-agent execution, long-term memory, and cron.

### Phase 2: Context, Knowledge, Multimodal, and Product UX

Enhances the Phase 1 kernel with:

- Context Compiler, nine-layer window model, active-plan injection, mechanical offload, delta checkpoints, cache-aware compaction, and context reset.
- Progressive disclosure engine for Tool and Skill content.
- RAG ingest, chunking, metadata, BM25, vector, optional graph index, ACL-before-retrieval, hybrid retrieval, reranking, packing, citation, deletion propagation, embedding migration, and injection isolation.
- Session tree, steering queues, pause/resume, full budget ledger, and model fallback revalidation.
- MCP stdio allowlist and registry source integration without creating a second registry.
- Web, document-generation, OCR, spreadsheet, presentation, image, speech, transcription, escalation, and behavior-verification tools already assigned to Phase 2.
- Multimodal ingestion and product UI/API/desktop/TUI surfaces already assigned to Phase 2.
- Rootless OCI sandbox adapter may be added behind the Phase 1 Sandbox interface; it does not replace OS-native adapters.

`AH-UI-MEMORY-001` moves from Phase 2 to Phase 4 because a production Memory Center cannot precede the Memory service. In Phase 4, `AH-UI-MEMORY-001` owns the frontend screen and `AH-MEM-UI-001` owns the backend API/service. Neither may duplicate the other's state or business rules.

### Phase 3: Adaptive Routing and Multi-Agent Orchestration

Completes the Router and orchestration layer:

- Full dependency-aware Router DAG and joint constraint solver.
- Static DAG, routing slip, workflow script, bounded mass fan-out, and topology selection.
- AgentGraph execution, subagent lifecycle, capability attenuation, dynamic subagent budgets, context isolation, cross-process message integrity, and merge conflict handling.
- Skill chaining, MCP discovery, agent Markdown authoring, tool masking, and cache-stable multi-agent execution.
- Eleven classified fallback types and blocked propagation rules.
- Router dataset with hard-constraint violation zero, routing regret ceiling, and unnecessary multi-agent ceiling.
- Video and music tools already assigned to Phase 3.

Phase 3 extends the Phase 1 Router, registries, runtime, security, and sandbox. It does not introduce replacements.

### Phase 4: Memory, Assurance, Observability, and Bounded Evolution

Delivers:

- Six memory types, proposal workflow, provenance, trust, TTL, conflict resolution, deletion propagation, local-only enforcement, retrieval, UI/API, and negative-memory quarantine.
- User adaptation track with user-visible control and rollback.
- Evaluation Harness extensions for datasets, scoring, regression comparison, failure attribution, and drift detection.
- Independent Verifier, assurance scoring, trace/event storage, redaction, replay, and OTel export.
- Capability evolution track: candidates, offline eval, sandbox replay, shadow, rollback, dedup scanner, tech-debt scanner, and eval-drift detector.
- Generated-tool proposals run only as untrusted sandbox candidates in the capability-evolution track. They have no secrets, external writes, or default network and cannot enter a production registry from usage counts.

Phase 4 may observe Phase 1–3 behavior but cannot mutate production behavior without the approved activation pipeline.

### Phase 5: Certified External Actions

Delivers external-effect safety and certified adapters:

- Credential custody and single-use exchange for external providers.
- ExternalEffect lifecycle, prepare/commit/in-flight/read-back/reconciliation states.
- Provider receipts, postcondition verification, compensation where truly available, and explicit non-compensable outcomes.
- Pre-approval auto-review for T3+ actions.
- Certified external adapters, staging verification, and external-write consent flows assigned to Phase 5.

### Phase 6: Mission Layer, Durable Scheduling, and Proactive Assistant

Delivers:

- Mission intake, decomposition, phase/step state, budgets, cancellation, cross-domain execution, templates, and Mission UI/API.
- Durable cron, interval, one-shot, condition watch, timezone/DST, leases, idempotency, missed-run handling, concurrency limits, and open-loop tracking.
- schedule_task as the model-callable interface over the scheduler.
- Sleep/wake with integrity-checked handoff, persistent workspace, fresh context, expired old capabilities, fresh attenuated capabilities, and reauthorization.
- Proactive suggestions, relationship follow-up, daily brief, mobile/channel steering, notifications, realtime voice, and voice cloning controls assigned to Phase 6.
- doc_cleanup_agent remains an evolution proposal agent and cannot directly modify protected branches.

### Phase 7: Enterprise and Multi-Tenant Hardening

Delivers:

- Organizations, tenants, members, groups, RBAC, managed policy, connector/model/tool allowlists, budgets, retention, regions, support controls, and enterprise audit ownership.
- Multi-tenant isolation, cross-tenant tests, enterprise KMS integration, and microVM backend.
- Canary deployment, enterprise SLOs, operational controls, and deployment infrastructure assigned to Phase 7.

### Phase 8: Production Certification and Launch

Delivers:

- Human-signed ReleaseApproval and immutable release evidence.
- Production certification for tools, providers, external adapters, data migrations, security controls, and operational runbooks.
- Manual review and certification is the only path by which a generated-tool proposal may become a published tool; publication never grants capabilities by itself.
- SLOs, alerting, incident response, backup/restore, disaster recovery, abuse handling, billing/limits, staged beta, and general production release.
- Phase 8 adds no new architectural subsystem. It certifies and operates the system delivered by Phase 1–7.

## 12. Repository normalization work

The implementation pass must update these authorities together:

1. `spec/architecture/`: harness boundary, runtime core/topology, routing, gateway, tool/skill fabric, context/RAG, VFS, action control, assurance, evolution, and deployment topology.
2. `spec/contracts/`: tighten TaskContract, RunPlan bindings, ToolSpec, SkillSpec, policy/capability bindings, registry snapshots, and progressive-disclosure fields.
3. `spec/requirements/requirements.ndjson`: move, split, and add requirements; correct maturity and nonexistent paths; preserve all existing detail.
4. `spec/requirements/requirement-schema.json`: add only the traceability fields required for split/moved requirements.
5. `spec/phases/phase-1.yaml` through `phase-8.yaml`: make each manifest match registry ownership and dependency order.
6. `spec/architecture/diagrams/`: update module, request-to-outcome, routing, gateway, tool/skill, runtime topology, VFS, evolution, mission/memory, and hook diagrams where labels or Phase ownership changed.
7. `spec/SPECIFICATION_INDEX.yaml`, `README.md`, and `AGENTS.md`: update navigation and implementation guidance.
8. `control/current-state.json`: regenerate from repository facts rather than manual claims.
9. Phase gates: add architecture consistency checks so count, path, maturity, manifest membership, source existence, and blocker state cannot drift.

## 13. Consistency rules and mechanical gates

Repository gates must fail when:

- a requirement is absent from its Phase manifest or appears in multiple Phase manifests;
- a source/test/eval path is claimed at implemented or verified maturity but does not exist;
- a Phase depends on a capability introduced later;
- two modules claim the same state authority or dispatcher;
- diagrams name obsolete counts, phases, or interfaces;
- ToolSpec or SkillSpec documentation differs from Schema;
- generated types drift from Schema;
- a Router stage is described without a requirement owner;
- a framework gap is allowed to pass using `requirement_pending`;
- current-state counts or blockers differ from recomputed repository facts;
- a Phase gate passes with an active stub, missing Evidence Package, or unverified security invariant.

## 14. Phase completion protocol

Every Phase completes in this order:

1. Contract generation and parity.
2. Build, lint, and unit tests.
3. Integration and end-to-end vertical tests.
4. Crash restore, fault injection, and effect-state recovery tests.
5. Adversarial and security tests.
6. Domain and routing evals applicable to the Phase.
7. Mutation testing and active-stub scan.
8. Evidence Package generation from actual command output.
9. Clean-checkout gate rerun.
10. Independent GLM 5.2 xhigh evaluation with requirements, output, evidence, tests, and success criteria only.
11. Signed verification record and Phase handoff.

The independent model does not replace local verification and is not called while a Phase is incomplete.

## 15. Architecture-ready criterion for source implementation

Source implementation may start when the normalization pass proves all of the following:

- requirements and Phase manifests have exact one-to-one membership;
- every foundational capability required by Phase 1 has a concrete requirement, source path, test path, owner, contract, and gate;
- Router, Tool/Skill discovery, Permission, VFS/Sandbox, Context, Memory, Eval, and Scheduler boundaries have no duplicate owner;
- contract and diagram consistency gates pass;
- registry maturity reflects filesystem facts;
- `current-state.json` is regenerated and Phase 1 is marked ready from computed facts;
- no active Agent is editing the same files selected for implementation.

Until these conditions pass, coding isolated components risks implementing against unstable contracts.
