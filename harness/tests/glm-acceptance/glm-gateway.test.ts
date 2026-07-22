import { describe, it, expect } from 'vitest';
import { createGlmGateway } from '../../gateway/glm-gateway-bridge.js';
import type { ProviderSelectionRequest } from '../../gateway/model-gateway.js';

const SKIP = !process.env.GLM_API_KEY;

function makeRequest(snapshotHash: string): ProviderSelectionRequest {
  return {
    registry_snapshot_hash: snapshotHash,
    request: { messages: [{ role: 'system', content: 'Reply with exactly: OK' }, { role: 'user', content: 'Say OK' }] },
    estimated_input_tokens: 10,
    required_capabilities: ['text_reasoning'],
    requires_structured_output: false,
    data_policy: { local_only: false, allowed_regions: ['cn'], max_retention_days: 30, training_allowed: false },
    policy: { allowed_provider_ids: undefined, denied_provider_ids: [] },
    run_plan: { allowed_provider_ids: undefined, required_capabilities: ['text_reasoning'] },
  } as unknown as ProviderSelectionRequest;
}

describe.skipIf(SKIP)('GLM via ModelGateway', () => {
  it('dispatches through the full gateway chain (egress + credential + usage)', async () => {
    const { gateway, registry, usageMeter } = createGlmGateway();
    const request = makeRequest(registry.snapshot.hash);
    const resolved = gateway.resolve(request);
    const result = await gateway.dispatch(resolved, request, { operation_id: 'op-glm-1' });
    expect(result.provider_id).toBe('glm');
    expect(result.response.content.length).toBeGreaterThan(0);
    expect(result.usage.input_tokens).toBeGreaterThan(0);
    expect(usageMeter.getRecords().length).toBe(1);
    expect(usageMeter.getRecords()[0]!.provider_id).toBe('glm');
  }, 30000);

  it('egress policy denies when GLM_ALLOW_REMOTE is not set', async () => {
    const oldVal = process.env.GLM_ALLOW_REMOTE;
    delete process.env.GLM_ALLOW_REMOTE;
    try {
      const { gateway, registry } = createGlmGateway();
      const request = makeRequest(registry.snapshot.hash);
      // resolve may succeed, but dispatch must fail at egress check
      let resolved;
      try { resolved = gateway.resolve(request); } catch { return; }
      await expect(gateway.dispatch(resolved, request, { operation_id: 'op-glm-deny' })).rejects.toThrow();
    } finally {
      if (oldVal !== undefined) process.env.GLM_ALLOW_REMOTE = oldVal;
    }
  });
});
