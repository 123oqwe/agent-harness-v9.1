/**
 * Test fixture: creates default security components for HarnessConfig.
 * This is a TEST fixture, not production code. Production callers must
 * inject real AuthorizationService, PEP, and CapabilityStateStore.
 *
 * The clock function must be shared between the test security components
 * and the Harness execution context so that capability issuance time
 * validation doesn't fail due to clock mismatch.
 */
import { generateKeyPairSync } from 'node:crypto';
import { AuthorizationService } from '../../security/authorization-service.js';
import { InMemoryCapabilityStateStore } from '../../security/capability.js';
import { PolicyEnforcementPoint } from '../../security/pep.js';
import type { PolicyEngine } from '../../security/policy-engine.js';
import type { HarnessSecurityDeps } from '../../harness.js';

export function createTestSecurityDeps(
  policyEngine: PolicyEngine,
  clock?: () => string,
): HarnessSecurityDeps {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const stateStore = new InMemoryCapabilityStateStore();
  const consumedTokens = new Set<string>();
  const now = clock ?? (() => new Date().toISOString());

  const authz = new AuthorizationService({
    private_key: privateKey,
    public_key: publicKey,
    state_store: stateStore,
    now,
    max_ttl_ms: 600_000, // 10 minutes to avoid lifetime issues in slow tests
  });

  const pep = new PolicyEnforcementPoint({
    policy_engine: policyEngine,
    capability_authority: {
      verify_signature: async (token: { token_id: string }) => {
        try { const r = await stateStore.read(token.token_id); return !!r; } catch { return false; }
      },
      consume: async (tokenId: string) => {
        if (consumedTokens.has(tokenId)) return false;
        consumedTokens.add(tokenId);
        return true;
      },
    },
    audit_sink: { write: async () => {} },
    now,
  });

  return { authz, pep, stateStore };
}
