import { ManagedGateway } from './managed-gateway.js';
import { GatewayWsServer } from './ws-server.js';
import { KeyVault } from './key-vault.js';
import { EconomicKernel } from './economic-kernel.js';
import { Harness, type HarnessConfig } from '../harness.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { SkillRegistry } from '../skills/skill-registry.js';
import { PolicyEngine, type Policy } from '../security/policy-engine.js';
import { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import { LocalBackend } from '../vfs/virtual-filesystem.js';
import type { SandboxProfile } from '../sandbox/process-sandbox.js';
import { createDefaultExecutionContext } from '../runtime/harness-support.js';
import { createPhase1ToolDefinitions } from '../tools/tool-definitions.js';
import { generateKeyPairSync } from 'node:crypto';
import { AuthorizationService } from '../security/authorization-service.js';
import { InMemoryCapabilityStateStore } from '../security/capability.js';
import { PolicyEnforcementPoint } from '../security/pep.js';
import { ConsentService } from '../security/consent.js';
import { AuditSink } from '../security/audit-sink.js';
import { DeclaredPostconditionVerifier } from '../security/action-executor.js';
import type { HarnessSecurityDeps } from '../harness.js';
import { CallbackVerificationAdapter, VerificationEngine } from '../verification/verification-engine.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// N32 fix: import Phase 2 components for injection into HarnessConfig
import { ContextCompiler } from '@agent-harness/runtime-core';
import { HookSystem } from '@agent-harness/runtime-core';
import { ContextCompactor } from '@agent-harness/runtime-core';
import { SteeringController } from '@agent-harness/runtime-core';
import { BudgetLedger } from '@agent-harness/runtime-core';
import { ModelFallbackController } from '@agent-harness/runtime-core';
import { PauseResumeController } from '@agent-harness/runtime-core';
import type { BudgetJournalPort, BudgetEvent } from '@agent-harness/runtime-core';
import type { SteeringJournalPort, SteeringEvent } from '@agent-harness/runtime-core';
import type { CompactionVfsPort, BeforeCompactPort, FreshSessionPort } from '@agent-harness/runtime-core';
import type { PauseResumeJournalPort, PauseResumeEffectRecord, EffectReadBackPort, EffectResolution, EffectReconciliationPort } from '@agent-harness/runtime-core';
import { ModelFallbackGatewayAdapter } from '../runtime/model-fallback-port.js';
import { InMemoryPauseResumeJournal, DefaultEffectReadBack, DefaultEffectReconciliation } from '../runtime/pause-resume-port.js';
import { CompactionHookRuntimeAdapter } from '../runtime/compaction-port.js';
import type { RuntimeBudgetPricing } from '../runtime/budget-port.js';

/** In-memory BudgetJournal for local server usage. */
class InMemoryBudgetJournal implements BudgetJournalPort {
  private readonly events: BudgetEvent[] = [];
  read(): readonly BudgetEvent[] { return [...this.events]; }
  append(event: BudgetEvent): void { this.events.push({ ...event }); }
}

/** In-memory SteeringJournal for local server usage. */
class InMemorySteeringJournal implements SteeringJournalPort {
  private readonly events: SteeringEvent[] = [];
  read(): readonly SteeringEvent[] { return [...this.events]; }
  append(event: SteeringEvent): void { this.events.push({ ...event }); }
}

/** No-op CompactionVfsPort for local server usage. */
const noopCompactionVfs: CompactionVfsPort = {
  write: () => {},
};

/** No-op FreshSessionPort for local server usage. */
const noopFreshSession: FreshSessionPort = {
  prepare: (input) => ({
    session_id: `fresh-${input.previous_session_id}-${input.context_generation}`,
    commit: () => {},
  }),
};

/** Default budget pricing (USD micros per million tokens, conservative). */
const DEFAULT_BUDGET_PRICING: RuntimeBudgetPricing = {
  cached_input_micros_per_million: 0,
  uncached_input_micros_per_million: 70,
  output_micros_per_million: 70,
};

export interface ServerOptions {
  port?: number;
  workspaceDir?: string;
}

const ALLOWED_TOOLS = [
  'read_file', 'write_file', 'edit_file', 'execute_command',
  'list_directory', 'search_files', 'create_artifact', 'parse_document',
  'apply_patch', 'undo', 'web_fetch', 'web_search', 'screenshot',
];

export function createManagedGateway(): ManagedGateway {
  const keyVault = new KeyVault();
  const economic = new EconomicKernel();
  return new ManagedGateway({ keyVault, economic });
}

export function createSecurityDeps(policyEngine: PolicyEngine, clock: () => string): HarnessSecurityDeps {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const stateStore = new InMemoryCapabilityStateStore();
  const consumedTokens = new Set<string>();

  const authz = new AuthorizationService({
    private_key: privateKey, public_key: publicKey,
    state_store: stateStore, now: clock, max_ttl_ms: 300_000,
  });

  const pep = new PolicyEnforcementPoint({
    policy_engine: policyEngine,
    capability_authority: {
      verify_signature: async (token: { token_id: string }) => {
        try { const r = await stateStore.read(token.token_id); return !!r; } catch { return false; }
      },
      consume: async (tokenId: string) => {
        if (consumedTokens.has(tokenId)) return false;
        consumedTokens.add(tokenId); return true;
      },
    },
    audit_sink: { write: async () => {} },
    now: clock,
  });

  const consent = new ConsentService();
  for (const toolName of ALLOWED_TOOLS) consent.allowAutoApprove(toolName);

  return {
    authz, pep, stateStore, consent,
    auditSink: new AuditSink(),
    postconditionVerifier: new DeclaredPostconditionVerifier(),
  };
}

export function createVerificationEngine(): VerificationEngine {
  return new VerificationEngine([
    new CallbackVerificationAdapter(
      'managed-gateway-verifier.v1',
      ['deterministic', 'test', 'semantic', 'human_review'],
      async (request) => ({
        passed: request.loopResult.termination_reason === 'completed' ||
                request.loopResult.termination_reason === 'goal_satisfied',
        evidence: { source: 'managed-gateway-verifier', criterion_index: request.criterionIndex },
      }),
    ),
  ]);
}

export function createHarnessForTask(
  managedGateway: ManagedGateway,
  userId: string,
  taskId: string,
  workspaceDir: string,
): Harness {
  const toolRegistry = new ToolRegistry();
  for (const spec of createPhase1ToolDefinitions()) {
    if (ALLOWED_TOOLS.includes(spec.name)) toolRegistry.register(spec);
  }

  const skillRegistry = new SkillRegistry();
  skillRegistry.loadBaseSkills();

  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
  vfs.mount(new LocalBackend('/workspace', workspaceDir));

  const policy: Policy = {
    version: 'v1',
    default_decision: 'deny',
    allowed_tools: ALLOWED_TOOLS,
    allowed_resource_prefixes: ['/workspace'],
    rules: [{ id: 'allow-all', priority: 1, effect: 'allow', tools: ['*'], resource_prefixes: ['/workspace'] }],
  };
  const policyEngine = new PolicyEngine(policy);

  const sandbox: SandboxProfile = {
    workspaceRoot: workspaceDir,
    allowNetwork: false,
    allowUnixSockets: false,
    allowRead: [],
  };

  const clock = () => new Date().toISOString();
  const security = createSecurityDeps(policyEngine, clock);
  const verification = createVerificationEngine();
  const executionContext = createDefaultExecutionContext(taskId, clock);

  // This is the key wiring: ManagedGateway.modelGatewayRef gives us the
  // inner ModelGateway (with FrozenProviderRegistry built from KeyVault +
  // CapabilityRegistry), which the Harness uses for resolve() + dispatch().
  // ManagedGateway's product-layer components (KeyVault, CircuitBreaker,
  // RateLimiter, EconomicKernel, CacheManager, ToolMask, DagExecutor)
  // are active because ManagedGateway built the registry and ports.
  // N32 fix: instantiate Phase 2 components for injection into HarnessConfig
  const contextCompiler = new ContextCompiler();
  const hookSystem = new HookSystem([], {});
  // N30: PauseResumeController with in-memory journal ports
  const pauseResumeJournal = new InMemoryPauseResumeJournal();
  const pauseResume = new PauseResumeController({
    journal: pauseResumeJournal,
    readBack: new DefaultEffectReadBack(),
    reconciliation: new DefaultEffectReconciliation(),
  });
  // N32: BudgetLedger with in-memory journal
  const budgetScope = {
    tenant_id: executionContext.tenant_id,
    run_id: taskId,
    session_id: taskId,
  };
  const budgetLedger = new BudgetLedger({
    scope: budgetScope,
    ceiling: { usd_micros: 1_000_000 }, // $1 budget
    journal: new InMemoryBudgetJournal(),
    degradation_matrix: [
      { remaining_ratio_at_or_below: 0.2, action: 'reduce_output', max_output_tokens: 1024 },
    ],
  });
  // N32: SteeringController with in-memory journal
  const steeringController = new SteeringController({
    scope: budgetScope,
    journal: new InMemorySteeringJournal(),
  });
  // N32: ContextCompactor with no-op VFS + hook adapter
  const contextCompactor = new ContextCompactor({
    vfs: noopCompactionVfs,
    beforeCompact: new CompactionHookRuntimeAdapter({}),
    freshSession: noopFreshSession,
  });
  // N32: ModelFallbackController wrapping the ManagedGateway's ModelGateway
  const modelFallback = new ModelFallbackController({
    gateway: new ModelFallbackGatewayAdapter(managedGateway.modelGatewayRef),
    cache: { invalidate: () => {} },
    context: {
      recompile: async (input: {
        readonly provider_id: string;
        readonly context_generation: number;
        readonly full_recompute: true;
        readonly validation_dimensions: readonly string[];
      }) => ({
        provider_id: input.provider_id,
        context_generation: input.context_generation,
        manifest_hash: 'noop',
      }),
    },
  });

  const config: HarnessConfig = {
    toolRegistry,
    skillRegistry,
    policyEngine,
    vfs,
    sandbox,
    gateway: managedGateway.modelGatewayRef,
    security,
    executionContext,
    verification,
    // N32 fix: Phase 2 components now injected and active in execution path
    contextCompiler,
    hookSystem,
    // N30: PauseResumeController wired into harness run() for approval_required
    pauseResume,
    // N32: BudgetLedger + pricing for sophisticated budget tracking
    budgetLedger,
    budgetLedgerPricing: DEFAULT_BUDGET_PRICING,
    // N32: SteeringController for runtime steering
    steeringController,
    // N32: ContextCompactor for context compaction
    contextCompactor,
    // N32: ModelFallbackController for provider fallback
    modelFallback,
  };

  return new Harness(config);
}

export function startServer(opts: ServerOptions = {}): { server: GatewayWsServer; managedGateway: ManagedGateway } {
  const port = opts.port ?? 8080;
  const workspaceDir = opts.workspaceDir ?? mkdtempSync(join(tmpdir(), 'agent-harness-'));
  const managedGateway = createManagedGateway();
  const economic = managedGateway.economicRef;

  const server = new GatewayWsServer({
    port,
    gateway: managedGateway,
    economic,
    harnessFactory: (gw, userId, taskId) => createHarnessForTask(gw, userId, taskId, workspaceDir),
  });

  server.start();
  return { server, managedGateway };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.argv[2] ?? '8080', 10);
  const { server } = startServer({ port });
  process.on('SIGINT', () => { server.stop(); process.exit(0); });
  process.on('SIGTERM', () => { server.stop(); process.exit(0); });
}
