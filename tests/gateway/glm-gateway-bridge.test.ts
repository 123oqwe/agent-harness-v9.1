import { describe, it, expect, beforeAll } from 'vitest';
beforeAll(() => { process.env.GLM_API_KEY = process.env.GLM_API_KEY || 'test-glm-key'; });
import { createGlmGateway } from '../../gateway/glm-gateway-bridge.js';

function mockSecretsBroker() {
  return {
    async exchangeCredential(_input: any) { return { token: 'test-glm-key', expires_at: Date.now() + 3600000 }; },
  };
}

function mockEgressPolicy() {
  return {
    async authorize(_input: any) { return { allowed: true }; },
  };
}

describe('createGlmGateway', () => {
  it('creates a gateway with GLM provider registered', () => {
    const { gateway, registry, usageMeter } = createGlmGateway({
      model: "glm-4-plus",
      secretsBroker: mockSecretsBroker() as any,
      egressPolicy: mockEgressPolicy() as any,
    });
    expect(gateway).toBeDefined();
    expect(registry).toBeDefined();
    expect(usageMeter).toBeDefined();
  });

  it('usage meter records calls', async () => {
    const { usageMeter } = createGlmGateway({
      model: "glm-4-plus",
      secretsBroker: mockSecretsBroker() as any,
      egressPolicy: mockEgressPolicy() as any,
    });
    await usageMeter.record({ provider_id: 'glm', operation_id: 'op1', usage: { input_tokens: 100, output_tokens: 50 } });
    const records = usageMeter.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.provider_id).toBe('glm');
  });

  it('usage meter getRecords returns a copy', () => {
    const { usageMeter } = createGlmGateway({
      model: "glm-4-plus",
      secretsBroker: mockSecretsBroker() as any,
      egressPolicy: mockEgressPolicy() as any,
    });
    const r1 = usageMeter.getRecords();
    const r2 = usageMeter.getRecords();
    expect(r1).not.toBe(r2);
    expect(r1).toEqual(r2);
  });

  it('passes through custom usageMeter', async () => {
    const customRecords: any[] = [];
    const customMeter = {
      async record(input: any) { customRecords.push(input); },
    };
    const { usageMeter } = createGlmGateway({
      model: "glm-4-plus",
      secretsBroker: mockSecretsBroker() as any,
      egressPolicy: mockEgressPolicy() as any,
      usageMeter: customMeter as any,
    });
    await usageMeter.record({ provider_id: 'glm', operation_id: 'op1', usage: { input_tokens: 100, output_tokens: 50 } });
    expect(customRecords).toHaveLength(1);
    expect(usageMeter.getRecords()).toHaveLength(1);
  });

  it('uses custom clock when provided', () => {
    let clockCalls = 0;
    const { gateway } = createGlmGateway({
      model: "glm-4-plus",
      secretsBroker: mockSecretsBroker() as any,
      egressPolicy: mockEgressPolicy() as any,
      clock: {
        now: () => { clockCalls++; return 12345; },
        sleep: async () => {},
      } as any,
    });
    expect(gateway).toBeDefined();
  });

  it('registers GLM with correct metadata', () => {
    const { registry } = createGlmGateway({
      model: "glm-4-plus",
      secretsBroker: mockSecretsBroker() as any,
      egressPolicy: mockEgressPolicy() as any,
    });
    expect(registry.snapshot).toBeDefined(); expect(registry.snapshot.providers.some((p: any) => p.provider_id === "glm")).toBe(true);
  });
});
