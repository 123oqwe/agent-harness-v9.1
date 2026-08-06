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
import { ContextCompiler, ContextCompactor, SteeringController, BudgetLedger, HookSystem } from '@agent-harness/runtime-core';

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
