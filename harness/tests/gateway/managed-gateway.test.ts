import { describe, it, expect } from 'vitest';
import { ManagedGateway } from '../../gateway/managed-gateway.js';
import { KeyVault } from '../../gateway/key-vault.js';
import { EconomicKernel } from '../../gateway/economic-kernel.js';
import { CapabilityRegistry } from '../../gateway/capability-registry.js';
import { CircuitBreaker } from '../../gateway/circuit-breaker.js';
import { RateLimiter } from '../../gateway/rate-limiter.js';

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
    expect(vault.hasProvider('testprovider')).toBe(true); // fail_count=1, still healthy
    vault.markUnhealthy('testprovider', 'key1');
    vault.markUnhealthy('testprovider', 'key1'); // fail_count=3, unhealthy
    expect(vault.hasProvider('testprovider')).toBe(false);
    vault.markHealthy('testprovider', 'key1');
    expect(vault.hasProvider('testprovider')).toBe(true);
  });

  it('CapabilityRegistry finds models by tier+capability', () => {
    const reg = new CapabilityRegistry();
    const workModels = reg.findModels({ tier: 'work', requiredCapabilities: ['code'] });
    expect(workModels.length).toBeGreaterThan(0);
    expect(workModels.every(m => m.tier === 'work')).toBe(true);

    const routeModels = reg.findModels({ tier: 'route' });
    expect(routeModels.length).toBeGreaterThan(0);
    expect(routeModels.every(m => m.tier === 'route')).toBe(true);
  });

  it('CapabilityRegistry estimates cost correctly', () => {
    const reg = new CapabilityRegistry();
    const models = reg.findModels({ tier: 'work' });
    const model = models[0]!;
    const cost = reg.estimateCost(model, 1_000_000, 500_000);
    expect(cost).toBeGreaterThan(0);
    // cost = 1M * price_input + 0.5M * price_output
    expect(cost).toBeCloseTo(1_000_000 / 1_000_000 * model.price_input + 500_000 / 1_000_000 * model.price_output, 4);
  });

  it('CircuitBreaker opens after threshold failures', () => {
    const cb = new CircuitBreaker('test', 3, 1000);
    expect(cb.canRequest()).toBe(true);
    expect(cb.state).toBe('closed');

    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe('closed');

    cb.recordFailure();
    expect(cb.state).toBe('open');
    expect(cb.canRequest()).toBe(false);
  });

  it('CircuitBreaker recovers after timeout', () => {
    const cb = new CircuitBreaker('test', 1, 50); // 50ms recovery
    cb.recordFailure();
    expect(cb.state).toBe('open');
    expect(cb.canRequest()).toBe(false);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cb.canRequest()).toBe(true);
        expect(cb.state).toBe('half_open');
        cb.recordSuccess();
        expect(cb.state).toBe('closed');
        resolve();
      }, 60);
    });
  });

  it('RateLimiter enforces RPM limit', () => {
    const rl = new RateLimiter({ rpmLimit: 3, tpmLimit: 100_000, concurrentLimit: 5 });
    expect(rl.check('user1', 100).allowed).toBe(true);
    expect(rl.check('user1', 100).allowed).toBe(true);
    expect(rl.check('user1', 100).allowed).toBe(true);
    const result = rl.check('user1', 100);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('RPM');
  });

  it('RateLimiter enforces concurrent limit', () => {
    const rl = new RateLimiter({ rpmLimit: 100, tpmLimit: 100_000, concurrentLimit: 2 });
    expect(rl.check('user1', 100).allowed).toBe(true);
    expect(rl.check('user1', 100).allowed).toBe(true);
    const result = rl.check('user1', 100);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Concurrent');
    rl.release('user1');
    expect(rl.check('user1', 100).allowed).toBe(true);
  });

  it('EconomicKernel tracks budget and spending', () => {
    const ek = new EconomicKernel();
    ek.createBudget('task1', 10.0);
    expect(ek.getBudget('task1')?.spent).toBe(0);

    expect(ek.spend('task1', 3.0, 'step1', 'model call')).toBe(true);
    expect(ek.getBudget('task1')?.spent).toBe(3.0);

    expect(ek.spend('task1', 8.0, 'step2', 'over budget')).toBe(false);
    expect(ek.getBudget('task1')?.spent).toBe(3.0);

    expect(ek.spend('task1', 7.0, 'step3', 'exactly budget')).toBe(true);
    expect(ek.getBudget('task1')?.status).toBe('exhausted');
  });

  it('EconomicKernel settles tasks', () => {
    const ek = new EconomicKernel();
    ek.createBudget('task1', 10.0);
    ek.spend('task1', 4.0, 'step1', 'call');
    const settlement = ek.settle('task1');
    expect(settlement).toBeDefined();
    expect(settlement!.budgeted).toBe(10.0);
    expect(settlement!.actual).toBe(4.0);
    expect(settlement!.variance).toBe(6.0);
  });

  it('ManagedGateway initializes with default providers', () => {
    const gw = new ManagedGateway();
    const models = gw.getAvailableModels() as Array<{ provider: string; has_api_key: boolean }>;
    expect(models.length).toBeGreaterThan(0);
    // No env keys set in test, so has_api_key should be false for all
    const summary = gw.getUsageSummary();
    expect(summary.total_calls).toBe(0);
  });

  it('ManagedGateway toHarnessProvider adapts interface', () => {
    const gw = new ManagedGateway();
    const provider = gw.toHarnessProvider('user1', 'task1');
    expect(typeof provider.resolve).toBe('function');
  });
});
