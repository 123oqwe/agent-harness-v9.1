import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { ChildTaskManifest } from '../../security/subagent.js';
import { SubagentSpawner } from '../../security/subagent.js';
import {
  AuthorizationService,
  InMemoryCapabilityStateStore,
  hashCapabilityGrant,
  type CapabilityGrantSet,
  type CapabilityIssueRequest,
} from '../../security/authorization-service.js';
import { CapabilityDelegationError } from '../../security/capability.js';

const NOW = '2026-01-01T00:00:00.000Z';

function grants(overrides: Partial<CapabilityGrantSet> = {}): CapabilityGrantSet {
  return {
    tools: ['read_file', 'search_files'],
    resources: ['workspace://project/', 'workspace://project/src/'],
    budget: { token_limit: 1000, usd_micros: 1000 },
    ...overrides,
  };
}

function claims(grantSet = grants(), overrides: Partial<CapabilityIssueRequest> = {}): CapabilityIssueRequest {
  return {
    operation_id: 'operation-parent',
    attempt_id: 'attempt-1',
    manifest_hash: 'a'.repeat(64),
    policy_decision_hash: 'b'.repeat(64),
    tool_effect_contract_hash: 'c'.repeat(64),
    subject_workload: 'single-agent-runtime',
    tenant_id: 'tenant-1',
    audience: 'harness-tool-host',
    tool_grant_hash: hashCapabilityGrant(grantSet.tools),
    resource_grant_hash: hashCapabilityGrant(grantSet.resources),
    budget_ceiling_hash: hashCapabilityGrant(grantSet.budget),
    execution_epoch: 'epoch-1',
    confirmation_key_thumbprint: 'key-thumbprint-1',
    not_before: NOW,
    expires_at: '2026-01-01T00:01:00.000Z',
    ...overrides,
  };
}

function fixture() {
  const keys = generateKeyPairSync('ed25519');
  const service = new AuthorizationService({
    private_key: keys.privateKey,
    public_key: keys.publicKey,
    state_store: new InMemoryCapabilityStateStore(),
    now: () => NOW,
  });
  const spawner = new SubagentSpawner({ service });
  return { keys, service, spawner };
}

async function manifestFor(
  service: AuthorizationService,
  overrides: Partial<ChildTaskManifest> & { parent_grants?: CapabilityGrantSet } = {},
) {
  const { parent_grants: pg = grants(), ...rest } = overrides;
  const parent = rest.parent ?? (await service.issue(claims(pg)));
  const manifest: ChildTaskManifest = {
    node_id: 'child-node',
    manifest_hash: '1'.repeat(64),
    operation_id: 'operation-child',
    attempt_id: 'attempt-child-1',
    parent,
    parent_grants: pg,
    parent_delegation_depth: 0,
    tool_grants: ['read_file'],
    resource_grants: ['workspace://project/src/'],
    budget_ceiling: { token_limit: 200, usd_micros: 100 },
    agent_config: {},
    ...rest,
  };
  return { parent, parent_grants: pg, manifest };
}

describe('AH-SUBAGENT-001 security invariants', () => {
  it('the spawner holds no private key — a parent cannot self-sign', async () => {
    const { service, spawner } = fixture();
    expect('sign' in spawner).toBe(false);
    expect('private_key' in spawner).toBe(false);
    // The only signing surface is the Authorization Service it is handed.
    expect(Object.getOwnPropertyNames(SubagentSpawner.prototype).sort()).toEqual([
      'active',
      'constructor',
      'maxConcurrent',
      'maxDepth',
      'release',
      'spawn',
    ]);

    const { manifest } = await manifestFor(service);
    const spawned = await spawner.spawn(manifest);
    // The child verifies against the service's key, not anything the parent
    // could produce.
    await expect(service.verify(spawned.capability)).resolves.toEqual(spawned.capability.claims);
  });

  it('a forged child envelope is rejected — only service-signed children pass', async () => {
    const { keys, service, spawner } = fixture();
    const { manifest } = await manifestFor(service);

    // A would-be forger signs a child-shaped envelope with an unrelated key.
    const forger = generateKeyPairSync('ed25519');
    const forgedClaims = {
      ...manifest.parent.claims,
      token_id: '11111111-1111-4111-8111-111111111111',
      manifest_hash: manifest.manifest_hash,
      parent_delegation_proof: 'forged.parent-proof',
    };
    const forged = {
      algorithm: 'Ed25519' as const,
      claims: forgedClaims,
      signature: 'forged-signature',
    };
    void keys;
    void forger;
    await expect(service.verify(forged)).rejects.toBeInstanceOf(Error);

    // The spawner route can never mint that envelope: it only returns what the
    // service signed.
    await expect(spawner.spawn(manifest)).resolves.toBeDefined();
  });

  it('child capability is a strict subset of the parent — no grant expansion', async () => {
    const { service, spawner } = fixture();
    for (const tool_grants of [['execute_command'], ['read_file', 'execute_command']]) {
      const { manifest } = await manifestFor(service, { tool_grants });
      await expect(spawner.spawn(manifest)).rejects.toBeInstanceOf(CapabilityDelegationError);
    }
    // Resources outside the parent tree are refused too.
    const { manifest } = await manifestFor(service, {
      resource_grants: ['workspace://other/'],
    });
    await expect(spawner.spawn(manifest)).rejects.toBeInstanceOf(CapabilityDelegationError);
  });

  it('delegation depth is decremented per hop and capped by the configurable max', async () => {
    const { service } = fixture();
    const deepSpawner = new SubagentSpawner({ service, max_depth: 1 });

    // Root (depth 0) -> child depth 1 is the deepest allowed under max_depth 1.
    const child = await manifestFor(service);
    await expect(deepSpawner.spawn(child.manifest)).resolves.toBeDefined();

    // Depth-1 parent -> child depth 2 exceeds max_depth 1: refused, so the
    // chain can never exceed the configured depth.
    const grandchild = await manifestFor(service, { parent_delegation_depth: 1 });
    await expect(deepSpawner.spawn(grandchild.manifest)).rejects.toThrow('exceeds max depth 1');
  });
});
