# Agent Harness

Agent Harness is a security-first TypeScript runtime for routed, tool-using AI
agents. This repository branch contains the complete Phase 1 runtime and the
Phase 2 batch-zero source scaffold; it does not claim that Phase 2 capabilities
are implemented. The Factory is not part of the runtime or release package.

## Phase 1 execution path

```text
TaskContract
  -> Policy + StaticRouter
  -> frozen RunPlan (direct | react | plan_execute)
  -> ModelGateway
  -> Tool/Skill search and activation
  -> ToolDispatcher
  -> Authorization + Capability + PEP
  -> VFS / OS process sandbox
  -> durable Session
  -> independent Verification
  -> Evidence + Outcome
```

The model cannot call a host tool directly. `ToolDispatcher` is deliberately an
internal composition detail: the public `Harness` wires search, schema
validation, authorization, capability consumption, execution, receipts,
verification, and evidence into one path.

## Included in Phase 1

- Three reasoning strategies: `direct`, `react`, and DAG-based `plan_execute`.
- A model gateway with provider selection, cancellation, retries, usage, and
  provider error normalization.
- Nine local tools: file read/write/edit/search/list, command execution,
  artifact creation, user questions, and document parsing.
- Eight declarative skills with registry search, risk-tier checks, dependency
  validation, activation, and progressive instruction loading.
- Policy, authorization, capability, consent, PEP, audit, and secrets controls.
- Transactional VFS, platform-aware process sandboxing, and deny-by-default
  network profiles.
- Durable encrypted sessions, crash recovery, idempotency, receipts, and
  evidence generation.
- Coding, documents, research, writing, planning, and personal-assistant
  vertical adapters.

Long-term memory/RAG, cron jobs, cross-run personalization, agent capability
self-evolution, and multi-agent orchestration belong to later phases. They are
not silently simulated by this Phase 1 package.

## Install and verify

Node.js 20 or newer is required.
Linux command execution additionally requires Bubblewrap and the util-linux
`prlimit` utility. The harness fails closed when an OS sandbox authority is
unavailable.

The authoritative Phase 2 source gate additionally requires protected
`/usr/bin/git` and `/usr/bin/python3`. Each executable, its resolved symlink
target, and every ancestor must be root-owned and not group/world writable;
the release gate fails explicitly when either protected tool is unavailable.

Session persistence now has a fail-closed construction requirement: create a
dedicated current-user/root-owned mode-`0700` directory with
`createTrustedSessionStateRoot`, and pass that authority as `state_root` to
`SqliteSessionStore` and `SqliteSessionTreeAuthority`. Databases outside that
root, symlinked paths, changed directory/file identities, and unsafe ancestors
are rejected. Because `better-sqlite3` opens pathnames rather than caller-owned
descriptors, a malicious same-UID host process can still race an identity check;
complete resistance requires an independent OS account, the Phase 2 rootless
OCI boundary (`AH-SANDBOX-OCI-001`), or a descriptor-capable SQLite broker. The
typed `SESSION_STORAGE_TRUST_BOUNDARY` export makes that residual boundary
machine-visible.

```bash
npm ci
npm run typecheck
npm run check:cycles
npm run build
npm test
npm run test:coverage
```

Production dependency audit:

```bash
npm audit --omit=dev --audit-level=high
```

Mutation testing is intentionally separate because it is substantially slower:

```bash
npm run test:mutation:phase1
```

Live GLM acceptance is never run implicitly or in pull-request CI. It requires
an explicitly supplied `GLM_API_KEY`, `GLM_MODEL=glm-5.2`,
`GLM_REASONING_EFFORT=xhigh`, and `GLM_ALLOW_REMOTE=1`.

## Registry smoke example

```ts
import {
  SkillLoader,
  SkillRegistry,
  ToolRegistry,
  createPhase1ToolDefinitions,
} from 'agent-harness';

const tools = new ToolRegistry();
const definitions = createPhase1ToolDefinitions();
for (const definition of definitions) tools.register(definition);

const skills = new SkillRegistry();
skills.loadBaseSkills();
const snapshot = skills.freezeSnapshot();
const effects = Object.fromEntries(
  definitions.map((definition) => [
    definition.name,
    definition.effect_model.operation,
  ]),
);
const loader = new SkillLoader(
  skills,
  snapshot,
  tools.listNames(),
  2,
  undefined,
  effects,
);

const candidates = skills.skill_search('repository');
const activated = await loader.activate('repository-exploration');
```

Constructing `Harness` additionally requires the caller to inject real policy,
gateway, verification, identity, capability, audit, VFS, and sandbox
authorities. The package does not create permissive security defaults.

## Source layout

The root `agent-harness` package is the only formal Phase 1 release artifact and publication authority.
Private `packages/*` and `apps/*` workspaces are Phase 2 composition
and migration boundaries, not duplicate implementations. Each later requirement
must make an atomic authority migration from its root module to one workspace,
with the requirement, tests, exports, and authority state changing in the same commit;
the same runtime authority must never be implemented in both places.

```text
gateway/       model providers and the only model-call gateway
router/        task normalization and deterministic routing
runtime/       loop lifecycle and reasoning strategies
tools/         tool registry, definitions, dispatcher, and local hosts
skills/        skill registry, declarative skills, and activation
security/      policy, identity, capabilities, consent, PEP, audit, secrets
vfs/           virtual and transactional workspace boundaries
sandbox/       OS process isolation
session/       durable event log, snapshots, and recovery
verification/  independent checks and evidence
domains/       six thin product vertical adapters
ingestion/     document ingestion capability
contracts/     generated TypeScript contracts
spec/          authoritative schemas, APIs, state machines, and threat model
tests/         unit, integration, security, packaging, and acceptance tests
packages/      private Phase 2 module boundaries; not separately released
apps/          private API, Web, Desktop, and TUI composition boundaries
evals/         seven Phase 2 domain evaluation definitions
data-tests/    Phase 2 real-data manifest definitions
fixtures/phase-2/        deterministic Phase 2 test inputs and frozen snapshots
verification/gates/      sole Phase 2 gate authority manifest
```

`fixtures/phase-2/valid/phase2-gate.json` is a byte-frozen test snapshot of
`verification/gates/phase2-gate.json`; it is not a second authority.

The package is private and `UNLICENSED`; no open-source license grant is
implied. See [SECURITY.md](SECURITY.md) for vulnerability reporting.
