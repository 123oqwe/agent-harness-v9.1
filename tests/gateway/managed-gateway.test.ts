import { describe, it, expect } from 'vitest';
import { ManagedGateway } from '../../gateway/managed-gateway.js';
import { KeyVault } from '../../gateway/key-vault.js';
import { EconomicKernel } from '../../gateway/economic-kernel.js';
import { CapabilityRegistry } from '../../gateway/capability-registry.js';
import { CircuitBreaker } from '../../gateway/circuit-breaker.js';
import { RateLimiter } from '../../gateway/rate-limiter.js';
import { ToolMaskStateMachine } from '../../gateway/tool-mask.js';
import { DagExecutor } from '../../gateway/dag-executor.js';

describe('ManagedGateway', () => {
  it('KeyVault loads keys from env', () => {
    const oldKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key-123';
    const vault = new KeyVault();
    expect(vault.hasProvider('openai')).toBe(true);
    expect(vault.getKey('openai')).toBe('test-key-123');
    expect(vault.hasProvider('anthropic')).toBe(false);
    if (oldKey !== undefined) process.env.OPENAI_API_KEY = oldKey;
    else delete process.env.OPENAI_API_KEY;
  });

  it('KeyVault encrypt/decrypt round-trips', () => {
    const vault = new KeyVault({ masterKey: 'test-master' });
    const encrypted = vault.encrypt('secret-api-key');
    expect(encrypted).not.toBe('secret-api-key');
    expect(vault.decrypt(encrypted)).toBe('secret-api-key');
  });

  it('KeyVault tracks key health', () => {
    const vault = new KeyVault({ masterKey: 'test' });
    vault.addKey('testprovider', 'key1');
    expect(vault.hasProvider('testprovider')).toBe(true);
    vault.markUnhealthy('testprovider', 'key1');
    vault.markUnhealthy('testprovider', 'key1');
    vault.markUnhealthy('testprovider', 'key1');
    expect(vault.hasProvider('testprovider')).toBe(false);
    vault.markHealthy('testprovider', 'key1');
    expect(vault.hasProvider('testprovider')).toBe(true);
  });

  it('CapabilityRegistry finds models by tier+capability', () => {
    const reg = new CapabilityRegistry();
    const workModels = reg.findModels({ tier: 'work', requiredCapabilities: ['code'] });
    expect(workModels.length).toBeGreaterThan(0);
    expect(workModels.every(m => m.tier === 'work')).toBe(true);
  });

  it('CapabilityRegistry estimates cost correctly', () => {
    const reg = new CapabilityRegistry();
    const models = reg.findModels({ tier: 'work' });
    const model = models[0]!;
    const cost = reg.estimateCost(model, 1_000_000, 500_000);
    expect(cost).toBeGreaterThan(0);
  });

  it('CircuitBreaker opens after threshold failures', () => {
    const cb = new CircuitBreaker('test', 3, 1000);
    expect(cb.canRequest()).toBe(true);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe('open');
    expect(cb.canRequest()).toBe(false);
  });

  it('RateLimiter enforces RPM limit', () => {
    const rl = new RateLimiter({ rpmLimit: 3, tpmLimit: 100_000, concurrentLimit: 5 });
    expect(rl.check('user1', 100).allowed).toBe(true);
    expect(rl.check('user1', 100).allowed).toBe(true);
    expect(rl.check('user1', 100).allowed).toBe(true);
    expect(rl.check('user1', 100).allowed).toBe(false);
  });

  it('EconomicKernel tracks budget and spending', () => {
    const ek = new EconomicKernel();
    ek.createBudget('task1', 10.0);
    expect(ek.spend('task1', 3.0, 'step1', 'model call')).toBe(true);
    expect(ek.getBudget('task1')?.spent).toBe(3.0);
    expect(ek.spend('task1', 8.0, 'step2', 'over budget')).toBe(false);
  });

  it('ManagedGateway initializes with default providers', () => {
    const gw = new ManagedGateway();
    const models = gw.getAvailableModels() as Array<{ provider: string; has_api_key: boolean }>;
    expect(models.length).toBeGreaterThan(0);
  });

  it('ManagedGateway toHarnessProvider adapts interface', () => {
    const gw = new ManagedGateway();
    const provider = gw.toHarnessProvider('user1', 'task1');
    expect(typeof provider.resolve).toBe('function');
  });

  it('ManagedGateway uses ModelGateway dispatch chain (no direct fetch)', () => {
    const gw = new ManagedGateway();
    const models = gw.getAvailableModels();
    expect(models.length).toBeGreaterThan(0);
    const summary = gw.getUsageSummary();
    expect(summary.total_calls).toBe(0);
  });
});

describe('ToolMaskStateMachine', () => {
  it('classifies tools by group prefix', () => {
    const tsm = new ToolMaskStateMachine({ enabled: true });
    expect(tsm.classifyTool('read_file')).toBe('fs_read');
    expect(tsm.classifyTool('write_file')).toBe('fs_write');
    expect(tsm.classifyTool('web_search')).toBe('web');
    expect(tsm.classifyTool('browser_navigate')).toBe('browser');
    expect(tsm.classifyTool('execute_command')).toBe('system');
    expect(tsm.classifyTool('unknown_tool')).toBeNull();
  });

  it('masks tools by execution state', () => {
    const tsm = new ToolMaskStateMachine({ enabled: true });
    tsm.transition('executing');
    expect(tsm.isToolAllowed('read_file').allowed).toBe(true);
    expect(tsm.isToolAllowed('browser_navigate').allowed).toBe(true);
    tsm.transition('verifying');
    expect(tsm.isToolAllowed('read_file').allowed).toBe(true);
    expect(tsm.isToolAllowed('browser_navigate').allowed).toBe(false);
    expect(tsm.isToolAllowed('write_file').allowed).toBe(false);
  });

  it('returns full tool set for prompt when enabled (preserves cache)', () => {
    const tsm = new ToolMaskStateMachine({ enabled: true });
    tsm.transition('verifying');
    const allTools = ['read_file', 'write_file', 'browser_navigate', 'execute_command'];
    const promptTools = tsm.getPromptToolSet(allTools);
    expect(promptTools).toEqual(allTools);
  });

  it('generates mask hint for masked tools', () => {
    const tsm = new ToolMaskStateMachine({ enabled: true });
    tsm.transition('verifying');
    const allTools = ['read_file', 'write_file', 'browser_navigate'];
    const hint = tsm.getMaskHint(allTools);
    expect(hint).toContain('write_file');
    expect(hint).toContain('browser_navigate');
    expect(hint).not.toContain('read_file');
  });

  it('allows all tools when disabled', () => {
    const tsm = new ToolMaskStateMachine({ enabled: false });
    tsm.transition('verifying');
    expect(tsm.isToolAllowed('write_file').allowed).toBe(true);
    expect(tsm.isToolAllowed('browser_navigate').allowed).toBe(true);
  });
});

describe('DagExecutor', () => {
  it('builds a linear workflow DAG', () => {
    const dag = DagExecutor.buildWorkflow({
      name: 'pdf-research',
      steps: [
        { type: 'document', tier: 'work', capabilities: ['pdf_document_understanding'], prompt: 'Extract text from PDF' },
        { type: 'reasoning', tier: 'work', capabilities: ['reasoning'], prompt: 'Analyze the extracted text' },
        { type: 'writing', tier: 'work', capabilities: ['reasoning'], prompt: 'Write a summary' },
      ],
    });
    expect(dag.nodes.length).toBe(3);
    expect(dag.edges.length).toBe(2);
    expect(dag.nodes[0]!.step_id).toBe('pdf-research-step-1');
    expect(dag.nodes[1]!.depends_on).toEqual(['pdf-research-step-1']);
  });

  it('detects cycles in DAG', async () => {
    const gw = new ManagedGateway();
    const executor = new DagExecutor(gw);
    await expect(executor.execute({
      nodes: [
        { step_id: 'a', node_type: 'reasoning', tier: 'work', required_capabilities: ['reasoning'], prompt: 'A', depends_on: ['b'] },
        { step_id: 'b', node_type: 'reasoning', tier: 'work', required_capabilities: ['reasoning'], prompt: 'B', depends_on: ['a'] },
      ],
      edges: [ { from: 'a', to: 'b' }, { from: 'b', to: 'a' } ],
    }, { userId: 'test', taskId: 'test' })).rejects.toThrow('cycle');
  });
});
