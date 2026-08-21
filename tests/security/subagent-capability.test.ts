import { createHmac, generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { ChildTaskManifest } from '../../security/subagent.js';
import {
  DEFAULT_MAX_CONCURRENT,
  SubagentSpawner,
  childDelegationDepth,
  createSubagentDelegation,
  effectiveToolMask,
  remainingDepth,
  validateChildTaskManifest,
  verifySubagentDelegation,
  type SpawnedSubagent,
} from '../../security/subagent.js';
import {
  AuthorizationService,
  InMemoryCapabilityStateStore,
  hashCapabilityGrant,
  type CapabilityGrantSet,
  type CapabilityIssueRequest,
} from '../../security/authorization-service.js';
import { CapabilityDelegationError, CapabilityInvalidError } from '../../security/capability.js';

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

function fixture(overrides: { max_concurrent?: number; max_depth?: number } = {}) {
  const keys = generateKeyPairSync('ed25519');
  const service = new AuthorizationService({
    private_key: keys.privateKey,
    public_key: keys.publicKey,
    state_store: new InMemoryCapabilityStateStore(),
    now: () => NOW,
  });
  const spawner = new SubagentSpawner({ service, ...overrides });
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

describe('AH-SUBAGENT-001 lifecycle', () => {
  it('Authorization Service signs the child capability (NOT the parent)', async () => {
    const { service, spawner } = fixture();
    const { parent, manifest } = await manifestFor(service);
    const spawned = await spawner.spawn(manifest);

    // The child is service-signed and verifiable.
    await expect(service.verify(spawned.capability)).resolves.toEqual(spawned.capability.claims);
    // The parent capability is consumed by the issuance — it cannot be reused.
    await expect(service.verify(parent)).rejects.toThrow(/used/u);
    // The child is signed by the service, not any parent key: a different
    // service (different key + state) rejects it.
    const otherKeys = generateKeyPairSync('ed25519');
    const otherService = new AuthorizationService({
      private_key: otherKeys.privateKey,
      public_key: otherKeys.publicKey,
      state_store: new InMemoryCapabilityStateStore(),
      now: () => NOW,
    });
    await expect(otherService.verify(spawned.capability)).rejects.toBeInstanceOf(CapabilityInvalidError);
  });

  it('child capability binds manifest_hash, delegation proof, budget, subset grants, and depth', async () => {
    const { service, spawner } = fixture();
    const { manifest } = await manifestFor(service, {
      tool_grants: ['read_file'],
      resource_grants: ['workspace://project/src/'],
      budget_ceiling: { token_limit: 200, usd_micros: 100 },
    });
    const spawned = await spawner.spawn(manifest);

    expect(spawned.capability.claims.manifest_hash).toBe(manifest.manifest_hash);
    expect(spawned.capability.claims.parent_delegation_proof).toMatch(/\..+/u);
    expect(spawned.delegation_depth).toBe(1); // parent_depth 0 -> child depth 1
    // Grants bound by hash: the child carries exactly the granted subset.
    expect(spawned.capability.claims.tool_grant_hash).toBe(hashCapabilityGrant(['read_file']));
    expect(spawned.capability.claims.resource_grant_hash).toBe(hashCapabilityGrant(['workspace://project/src/']));
    expect(spawned.capability.claims.budget_ceiling_hash).toBe(
      hashCapabilityGrant({ token_limit: 200, usd_micros: 100 }),
    );
    // The child can consume its budget ceiling via the same service.
    await expect(service.consume(spawned.capability)).resolves.toMatchObject({
      token_id: spawned.capability.claims.token_id,
    });
  });

  it('disallowed_tool_refs deny wins over tool_grant_refs even when the parent grants the tool', async () => {
    const { service, spawner } = fixture();
    const parent_grants = grants({ tools: ['read_file', 'search_files', 'execute_command'] });
    const { manifest } = await manifestFor(service, {
      parent_grants,
      tool_grants: ['read_file', 'execute_command'],
      agent_config: { disallowed_tool_refs: ['execute_command'] },
    });

    expect(effectiveToolMask(manifest)).toEqual(['read_file']);
    const spawned = await spawner.spawn(manifest);
    expect(spawned.effective_tool_grants).toEqual(['read_file']);
    expect(spawned.capability.claims.tool_grant_hash).toBe(hashCapabilityGrant(['read_file']));
  });

  it('budget ceiling is enforced: a child budget above the parent is rejected', async () => {
    const { service, spawner } = fixture();
    const { manifest } = await manifestFor(service, {
      budget_ceiling: { token_limit: 2000, usd_micros: 100 },
    });
    await expect(spawner.spawn(manifest)).rejects.toBeInstanceOf(CapabilityDelegationError);
    // The rejected child never counted against concurrency.
    expect(spawner.active('operation-child')).toBe(0);
  });

  it('a malformed manifest is rejected at evaluation (no child is signed)', async () => {
    const { service, spawner } = fixture();
    const badHashes = ['short', 'G'.repeat(64)];
    for (const manifest_hash of badHashes) {
      const { manifest } = await manifestFor(service, { manifest_hash });
      expect(validateChildTaskManifest(manifest).join(';')).toContain('manifest_hash');
      await expect(spawner.spawn(manifest)).rejects.toBeInstanceOf(CapabilityInvalidError);
    }
    const badConfig = { effort: 'turbo', isolation: 'sandbox' } as unknown as ChildTaskManifest['agent_config'];
    const { manifest } = await manifestFor(service, { agent_config: badConfig });
    const errors = validateChildTaskManifest(manifest);
    expect(errors).toContain('invalid effort "turbo"');
    expect(errors).toContain('invalid isolation "sandbox"');
    await expect(spawner.spawn(manifest)).rejects.toBeInstanceOf(CapabilityInvalidError);
  });

  it('privacy: a subagent cannot inherit the parent private conversation', async () => {
    const { service, spawner } = fixture();
    for (const memory_scope of ['inherit', 'parent_conversation', 'inherit:conversation']) {
      const { manifest } = await manifestFor(service, { agent_config: { memory_scope } });
      expect(validateChildTaskManifest(manifest).join(';')).toContain('leaks parent private conversation');
      await expect(spawner.spawn(manifest)).rejects.toBeInstanceOf(CapabilityInvalidError);
    }
    // Explicit shared refs are bounded — no leak, spawn succeeds.
    const { manifest } = await manifestFor(service, { agent_config: { memory_scope: 'shared_selective' } });
    await expect(spawner.spawn(manifest)).resolves.toBeDefined();
  });
});

describe('AH-SUBAGENT-001 limits', () => {
  it('max concurrent subagents is 6 by default and the 7th is rejected', async () => {
    const { service, spawner } = fixture();
    expect(spawner.maxConcurrent()).toBe(DEFAULT_MAX_CONCURRENT);

    for (let i = 0; i < 6; i += 1) {
      const { manifest } = await manifestFor(service, { node_id: `child-${i}` });
      await expect(spawner.spawn(manifest)).resolves.toBeDefined();
    }
    expect(spawner.active('operation-child')).toBe(6);

    const seventh = await manifestFor(service, { node_id: 'child-7' });
    await expect(spawner.spawn(seventh.manifest)).rejects.toBeInstanceOf(CapabilityDelegationError);

    // Releasing a slot unblocks a later spawn.
    spawner.release('operation-child');
    const after = await manifestFor(service, { node_id: 'child-8' });
    await expect(spawner.spawn(after.manifest)).resolves.toBeDefined();
  });

  it('max depth is configurable and the remaining allowance decrements each hop', async () => {
    const { service, spawner } = fixture({ max_depth: 2 });
    expect(spawner.maxDepth()).toBe(2);

    // Root parent (depth 0) -> child depth 1, remaining 1: allowed.
    const child = await manifestFor(service);
    expect(childDelegationDepth(child.manifest)).toBe(1);
    expect(remainingDepth(2, 1)).toBe(1);
    await expect(spawner.spawn(child.manifest)).resolves.toBeDefined();

    // Depth-1 parent -> child depth 2, remaining 0: allowed but terminal.
    const grandchild = await manifestFor(service, { parent_delegation_depth: 1 });
    expect(childDelegationDepth(grandchild.manifest)).toBe(2);
    expect(remainingDepth(2, 2)).toBe(0);
    await expect(spawner.spawn(grandchild.manifest)).resolves.toBeDefined();

    // Depth-2 parent -> child depth 3: exceeds max depth 2, rejected.
    const great = await manifestFor(service, { parent_delegation_depth: 2 });
    await expect(spawner.spawn(great.manifest)).rejects.toThrow('delegation depth 3 exceeds max depth 2');
  });

  it('isolation=worktree yields a git worktree spawn directive', async () => {
    const { service, spawner } = fixture();
    const worktree = await manifestFor(service, { agent_config: { isolation: 'worktree' } });
    const spawned = await spawner.spawn(worktree.manifest);
    expect(spawned.spawn.worktree).toBe(true);
    expect(spawned.spawn.isolation).toBe('worktree');

    const plain = await manifestFor(service, { agent_config: { isolation: 'none' } });
    const spawnedPlain = await spawner.spawn(plain.manifest);
    expect(spawnedPlain.spawn.worktree).toBe(false);
  });
});

describe('AH-SUBAGENT-001 cross-process delegation (FG8)', () => {
  function hmacSigner(key = 'test-key') {
    return {
      sign: (payload: unknown): string =>
        createHmac('sha256', key).update(JSON.stringify(payload)).digest('base64url'),
      verify: (payload: unknown, signature: string): boolean =>
        createHmac('sha256', key).update(JSON.stringify(payload)).digest('base64url') === signature,
    };
  }

  async function spawnOnce(service: AuthorizationService, spawner: SubagentSpawner): Promise<SpawnedSubagent> {
    const { manifest } = await manifestFor(service);
    return spawner.spawn(manifest);
  }

  it('delegation carries the OBO token and a JWS signature; the chain is bounded', async () => {
    const { service, spawner } = fixture();
    const spawned = await spawnOnce(service, spawner);
    const signer = hmacSigner();

    const msg = createSubagentDelegation({
      from: 'parent',
      to: 'child',
      capability: spawned.capability,
      obo_token: 'user-session-abc',
      sign: signer.sign,
    });
    expect(msg.obo_token).toBe('user-session-abc');
    expect(msg.jws_signature.length).toBeGreaterThan(0);
    expect(msg.payload.child_manifest_hash).toBe(spawned.capability.claims.manifest_hash);
    expect(verifySubagentDelegation(msg, signer.verify)).toBe(true);
  });

  it('a tampered payload or missing OBO token fails verification', async () => {
    const { service, spawner } = fixture();
    const spawned = await spawnOnce(service, spawner);
    const signer = hmacSigner();

    const msg = createSubagentDelegation({
      from: 'parent',
      to: 'child',
      capability: spawned.capability,
      obo_token: 'user-session-abc',
      sign: signer.sign,
    });
    msg.payload.child_manifest_hash = '2'.repeat(64);
    expect(verifySubagentDelegation(msg, signer.verify)).toBe(false);

    const noObo = createSubagentDelegation({
      from: 'parent',
      to: 'child',
      capability: spawned.capability,
      obo_token: '',
      sign: signer.sign,
    });
    expect(verifySubagentDelegation(noObo, signer.verify)).toBe(false);
  });
});
