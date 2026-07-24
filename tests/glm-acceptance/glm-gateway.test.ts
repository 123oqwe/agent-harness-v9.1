import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLiveGlmGateway } from './glm-test-config.js';
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
    const { gateway, registry, usageMeter } = createLiveGlmGateway();
    const request = makeRequest(registry.snapshot.hash);
    const resolved = gateway.resolve(request);
    const result = await gateway.dispatch(resolved, request, { operation_id: 'op-glm-1' });
    expect(result.provider_id).toBe('glm');
    expect(result.response.content.length).toBeGreaterThan(0);
    expect(result.usage.input_tokens).toBeGreaterThan(0);
    expect(usageMeter.getRecords().length).toBe(1);
    expect(usageMeter.getRecords()[0]!.provider_id).toBe('glm');
  }, 120000);

  it('egress policy denies when GLM_ALLOW_REMOTE is not set', async () => {
    try {
      const { gateway, registry } = createLiveGlmGateway(false);
      const request = makeRequest(registry.snapshot.hash);
      // resolve may succeed, but dispatch must fail at egress check
      let resolved;
      try { resolved = gateway.resolve(request); } catch { return; }
      await expect(gateway.dispatch(resolved, request, { operation_id: 'op-glm-deny' })).rejects.toThrow();
    } finally { /* no mutable production configuration */ }
  });
});



describe('GLM provider: no default model fallback', () => {
  it('does not default to glm-4-plus when GLM_MODEL is not set', () => {
    const source = readFileSync(join(__dirname, '../../gateway/glm-provider.ts'), 'utf8');
    expect(source).not.toContain('glm-4-plus');
  });
});
