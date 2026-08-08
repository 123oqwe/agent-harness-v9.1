import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Harness, type HarnessConfig } from '../../harness.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { SkillRegistry } from '../../skills/skill-registry.js';
import { PolicyEngine, type Policy } from '../../security/policy-engine.js';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import type { SandboxProfile } from '../../sandbox/process-sandbox.js';
import { createDefaultExecutionContext } from '../../runtime/harness-support.js';
import { createPhase1ToolDefinitions } from '../../tools/tool-definitions.js';
import { AuthorizationService } from '../../security/authorization-service.js';
import { InMemoryCapabilityStateStore } from '../../security/capability.js';
import { PolicyEnforcementPoint } from '../../security/pep.js';
import { ConsentService } from '../../security/consent.js';
import { AuditSink } from '../../security/audit-sink.js';
import { DeclaredPostconditionVerifier, ActionExecutor, OutputFormatValidator } from '../../security/action-executor.js';
import { VerificationEngine, CallbackVerificationAdapter } from '../../verification/verification-engine.js';
import { ManagedGateway } from '../../gateway/managed-gateway.js';
import { KeyVault } from '../../gateway/key-vault.js';
import { CapabilityRegistry } from '../../gateway/capability-registry.js';
import { EconomicKernel } from '../../gateway/economic-kernel.js';
import { RateLimiter } from '../../gateway/rate-limiter.js';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HarnessSecurityDeps } from '../../harness.js';

const originalFetch = globalThis.fetch;

function makeSecurityDeps(policyEngine: PolicyEngine, clock: () => string): HarnessSecurityDeps {
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
  for (const toolName of ['read_file','write_file','edit_file','execute_command','list_directory','search_files','create_artifact','parse_document','apply_patch','undo','web_fetch','web_search','screenshot']) {
    consent.allowAutoApprove(toolName);
  }
  return {
    authz, pep, stateStore, consent,
    auditSink: new AuditSink(),
    postconditionVerifier: new DeclaredPostconditionVerifier(),
  };
}

function makeGateway(): ManagedGateway {
  const keyVault = new KeyVault();
  keyVault.addKey('zhipu', 'test-key');
  const registry = new CapabilityRegistry();
  const economic = new EconomicKernel();
  const rateLimiter = new RateLimiter({ rpmLimit: 100, tpmLimit: 1_000_000, concurrentLimit: 10 });
  return new ManagedGateway({ keyVault, registry, economic, rateLimiter });
}

function makeConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  const toolRegistry = new ToolRegistry();
  for (const spec of createPhase1ToolDefinitions()) {
    toolRegistry.register(spec);
  }
  const skillRegistry = new SkillRegistry();
  skillRegistry.loadBaseSkills();
  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
  const workspaceDir = mkdtempSync(join(tmpdir(), 'test-harness-'));
  vfs.mount(new LocalBackend('/workspace', workspaceDir));
  const policy: Policy = {
    version: 'v1', default_decision: 'deny',
    allowed_tools: ['read_file','write_file','edit_file','execute_command','list_directory','search_files','create_artifact','parse_document','apply_patch','undo','web_fetch','web_search','screenshot'],
    allowed_resource_prefixes: ['/workspace'],
    rules: [{ id: 'allow-all', priority: 1, effect: 'allow', tools: ['*'], resource_prefixes: ['/workspace'] }],
  };
  const policyEngine = new PolicyEngine(policy);
  const sandbox: SandboxProfile = { workspaceRoot: workspaceDir, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
  const clock = () => new Date().toISOString();
  const security = makeSecurityDeps(policyEngine, clock);
  const verification = new VerificationEngine([
    new CallbackVerificationAdapter('test-verifier', ['deterministic'], async () => ({ passed: true, evidence: {} })),
  ]);
  const executionContext = createDefaultExecutionContext('test-task', clock);
  const gateway = makeGateway();
  return {
    toolRegistry, skillRegistry, policyEngine, vfs, sandbox,
    gateway: gateway.modelGatewayRef, security, executionContext, verification,
    ...overrides,
  };
}

describe('Harness NoCoverage path tests', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('creates a Harness instance with all config options', () => {
    const config = makeConfig();
    const harness = new Harness(config);
    expect(harness).toBeDefined();
  });

  it('creates a Harness with dataDir', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harness-data-'));
    const config = makeConfig({ dataDir, sessionMasterKey: Buffer.alloc(32, 7) });
    const harness = new Harness(config);
    expect(harness).toBeDefined();
  });

  it('creates a Harness with sessionLogPath and sessionMasterKey', () => {
    const sessionLogPath = mkdtempSync(join(tmpdir(), 'harness-session-'));
    const config = makeConfig({
      sessionLogPath,
      sessionMasterKey: Buffer.alloc(32, 7),
    });
    const harness = new Harness(config);
    expect(harness).toBeDefined();
  });

  it('creates a Harness with maxOutputTokensPerCall', () => {
    const config = makeConfig({ maxOutputTokensPerCall: 4096 });
    const harness = new Harness(config);
    expect(harness).toBeDefined();
  });

  it('creates a Harness with maxSkillRiskTier', () => {
    const config = makeConfig({ maxSkillRiskTier: 3 });
    const harness = new Harness(config);
    expect(harness).toBeDefined();
  });

  it('creates a Harness with buildCommitSha', () => {
    const config = makeConfig({ buildCommitSha: '0123456789abcdef0123456789abcdef01234567' });
    const harness = new Harness(config);
    expect(harness).toBeDefined();
  });

  it('creates a Harness with signal', () => {
    const controller = new AbortController();
    const config = makeConfig({ signal: controller.signal });
    const harness = new Harness(config);
    expect(harness).toBeDefined();
  });

  it('withStreaming returns a new Harness with streaming callbacks', () => {
    const config = makeConfig();
    const harness = new Harness(config);
    const streamed = harness.withStreaming({
      onModelDelta: vi.fn(),
      onToolOutput: vi.fn(),
    });
    expect(streamed).toBeDefined();
    expect(streamed).toBeDefined();
  });

  it('rejects empty goal in task contract', async () => {
    const config = makeConfig();
    const harness = new Harness(config);
    await expect(harness.run({
      goal: '',
      success_criteria: [{ criterion: 'test', verification_method: 'deterministic' }],
      constraints: [],
    }, 'test-run')).rejects.toThrow();
  });

  it('handles empty success_criteria gracefully', async () => {
    const config = makeConfig();
    const harness = new Harness(config);
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 10 },
      }),
      text: async () => '',
      headers: new Headers(),
    } as Response)) as any;
    const result = await harness.run({
      goal: 'test goal',
      success_criteria: [],
      constraints: [],
    }, 'test-empty-criteria');
    expect(result).toBeDefined();
  }, 30000);

  it('handles a simple task with mocked gateway', async () => {
    const config = makeConfig();
    const harness = new Harness(config);
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: 'Task completed successfully' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
      text: async () => '',
      headers: new Headers(),
    } as Response)) as any;
    const result = await harness.run({
      goal: 'Say hello',
      success_criteria: [{ criterion: 'responds with hello', verification_method: 'deterministic' }],
      constraints: [{ type: 'budget', value: '1.0' }],
    }, 'test-run-1');
    expect(result).toBeDefined();
    expect(result.run_plan).toBeDefined();
    expect(result.loop_result).toBeDefined();
  }, 30000);

  it('handles a task with budget constraint', async () => {
    const config = makeConfig();
    const harness = new Harness(config);
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 10 },
      }),
      text: async () => '',
      headers: new Headers(),
    } as Response)) as any;
    const result = await harness.run({
      goal: 'Complete the task',
      success_criteria: [{ criterion: 'task done', verification_method: 'deterministic' }],
      constraints: [{ type: 'budget', value: '0.5' }],
    }, 'test-run-2');
    expect(result).toBeDefined();
  }, 30000);

  it('handles a task with sessionLogPath set', async () => {
    const sessionLogPath = join(mkdtempSync(join(tmpdir(), 'harness-log-')), 'session.log');
    const config = makeConfig({
      sessionLogPath,
      sessionMasterKey: Buffer.alloc(32, 7),
    });
    const harness = new Harness(config);
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: 'logged task' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 10 },
      }),
      text: async () => '',
      headers: new Headers(),
    } as Response)) as any;
    const result = await harness.run({
      goal: 'Test with logging',
      success_criteria: [{ criterion: 'done', verification_method: 'deterministic' }],
      constraints: [],
    }, 'test-run-logged');
    expect(result).toBeDefined();
  }, 30000);

  it('handles task with streaming enabled', async () => {
    const config = makeConfig();
    const harness = new Harness(config);
    const encoder = new TextEncoder();
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"streamed"}}]}\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":10}}\n'));
          controller.close();
        },
      }),
      json: async () => ({}), text: async () => '', headers: new Headers(),
    } as Response)) as any;
    const streamed = harness.withStreaming({
      onModelDelta: vi.fn(),
      onToolOutput: vi.fn(),
    });
    const result = await streamed.run({
      goal: 'Stream test',
      success_criteria: [{ criterion: 'done', verification_method: 'deterministic' }],
      constraints: [],
    }, 'test-stream-1');
    expect(result).toBeDefined();
  }, 30000);

  it('handles task that triggers skill activation', async () => {
    const config = makeConfig({ maxSkillRiskTier: 3 });
    const harness = new Harness(config);
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: 'skill activated' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 10 },
      }),
      text: async () => '',
      headers: new Headers(),
    } as Response)) as any;
    const result = await harness.run({
      goal: 'Use a skill to complete this task',
      success_criteria: [{ criterion: 'done', verification_method: 'deterministic' }],
      constraints: [],
    }, 'test-skill-1');
    expect(result).toBeDefined();
  }, 30000);

  it('handles aborted signal', async () => {
    const controller = new AbortController();
    const config = makeConfig({ signal: controller.signal });
    const harness = new Harness(config);
    controller.abort();
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: 'should not reach' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 10 },
      }),
      text: async () => '',
      headers: new Headers(),
    } as Response)) as any;
    const result = await harness.run({
      goal: 'This should be aborted',
      success_criteria: [{ criterion: 'done', verification_method: 'deterministic' }],
      constraints: [],
    }, 'test-abort-1');
    expect(result).toBeDefined();
  }, 30000);

  it('handles task with dataDir for workspace persistence', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harness-data-'));
    const config = makeConfig({ dataDir, sessionMasterKey: Buffer.alloc(32, 7) });
    const harness = new Harness(config);
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: 'persisted' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 10 },
      }),
      text: async () => '',
      headers: new Headers(),
    } as Response)) as any;
    const result = await harness.run({
      goal: 'Test with dataDir',
      success_criteria: [{ criterion: 'done', verification_method: 'deterministic' }],
      constraints: [],
    }, 'test-datadir-1');
    expect(result).toBeDefined();
  }, 30000);
});
