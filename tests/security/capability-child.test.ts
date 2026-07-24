import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { ChildCapabilityRequest } from '../../contracts/index.js';
import {
  AuthorizationService,
  InMemoryCapabilityStateStore,
  hashCapabilityGrant,
  type CapabilityGrantSet,
  type CapabilityIssueRequest,
} from '../../security/authorization-service.js';
import {
  CapabilityDelegationError,
  CapabilityError,
  CapabilityInvalidError,
  hashCapabilityValue,
} from '../../security/capability.js';

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

function setup() {
  const keys = generateKeyPairSync('ed25519');
  return new AuthorizationService({
    private_key: keys.privateKey,
    public_key: keys.publicKey,
    state_store: new InMemoryCapabilityStateStore(),
    now: () => NOW,
  });
}

function setupWithKeys() {
  const keys = generateKeyPairSync('ed25519');
  const service = new AuthorizationService({
    private_key: keys.privateKey,
    public_key: keys.publicKey,
    state_store: new InMemoryCapabilityStateStore(),
    now: () => NOW,
  });
  return { keys, service };
}

describe('Authorization Service child capabilities', () => {
  it('issues an attenuated child with a service-signed parent delegation proof', async () => {
    const service = setup();
    const parentGrants = grants();
    const parent = await service.issue(claims(parentGrants));
    const childGrants = grants({
      tools: ['read_file'],
      resources: ['workspace://project/src/'],
      budget: { token_limit: 200, usd_micros: 100 },
    });
    const childManifestHash = '1'.repeat(64);
    const proof = await service.authorizeDelegation({
      parent,
      parent_grants: parentGrants,
      child_manifest_hash: childManifestHash,
      delegation_depth: 1,
    });
    const childRequest: ChildCapabilityRequest = {
      child_manifest_hash: childManifestHash,
      parent_delegation_proof: proof,
      budget_ceiling: childGrants.budget,
      tool_grants: [...childGrants.tools],
      resource_grants: [...childGrants.resources],
      delegation_depth: 1,
    };
    const child = await service.issueChild({
      parent,
      parent_grants: parentGrants,
      request: childRequest,
      claims: claims(childGrants, {
        operation_id: 'operation-child',
        manifest_hash: childManifestHash,
      }),
    });

    expect(child.claims.parent_delegation_proof).toBe(proof);
    await expect(service.verify(child)).resolves.toEqual(child.claims);
    await expect(service.verify(parent)).rejects.toThrow(/used/u);
  });

  it('allows only one child issuance when the same parent is raced', async () => {
    const service = setup();
    const parentGrants = grants();
    const parent = await service.issue(claims(parentGrants));
    const childGrants = grants({ tools: ['read_file'] });
    const childManifestHash = '1'.repeat(64);
    const proof = await service.authorizeDelegation({
      parent,
      parent_grants: parentGrants,
      child_manifest_hash: childManifestHash,
      delegation_depth: 1,
    });
    const request: ChildCapabilityRequest = {
      child_manifest_hash: childManifestHash,
      parent_delegation_proof: proof,
      budget_ceiling: childGrants.budget,
      tool_grants: [...childGrants.tools],
      resource_grants: [...childGrants.resources],
      delegation_depth: 1,
    };
    const issue = () =>
      service.issueChild({
        parent,
        parent_grants: parentGrants,
        request,
        claims: claims(childGrants, {
          operation_id: 'operation-child',
          manifest_hash: childManifestHash,
        }),
      });

    const results = await Promise.allSettled([issue(), issue()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('rejects forged delegation proof and prevents a parent from self-signing a child', async () => {
    const service = setup();
    const parentGrants = grants();
    const parent = await service.issue(claims(parentGrants));
    const childGrants = grants({ tools: ['read_file'] });
    const request: ChildCapabilityRequest = {
      child_manifest_hash: '1'.repeat(64),
      parent_delegation_proof: 'parent-created-value',
      budget_ceiling: childGrants.budget,
      tool_grants: [...childGrants.tools],
      resource_grants: [...childGrants.resources],
      delegation_depth: 1,
    };

    await expect(
      service.issueChild({
        parent,
        parent_grants: parentGrants,
        request,
        claims: claims(childGrants, { manifest_hash: request.child_manifest_hash }),
      }),
    ).rejects.toBeInstanceOf(CapabilityDelegationError);
    expect('sign' in parent).toBe(false);
    expect('private_key' in parent).toBe(false);
  });

  it('strictly validates parent grant material, proof scope and child request shape', async () => {
    const service = setup();
    const parentGrants = grants();
    const parent = await service.issue(claims(parentGrants));
    await expect(
      service.authorizeDelegation({
        parent,
        parent_grants: grants({ tools: ['read_file'] }),
        child_manifest_hash: '1'.repeat(64),
        delegation_depth: 1,
      }),
    ).rejects.toBeInstanceOf(CapabilityDelegationError);
    for (const invalidGrants of [
      null,
      { tools: 'read_file', resources: [], budget: {} },
      { tools: [''], resources: [], budget: {} },
      { tools: ['read_file', 'read_file'], resources: [], budget: {} },
      { tools: [], resources: ['workspace://project/', 'workspace://project/'], budget: {} },
    ]) {
      await expect(
        service.authorizeDelegation({
          parent,
          parent_grants: invalidGrants as never,
          child_manifest_hash: '1'.repeat(64),
          delegation_depth: 1,
        }),
      ).rejects.toBeInstanceOf(CapabilityError);
    }
    await expect(
      service.authorizeDelegation({
        parent,
        parent_grants: parentGrants,
        child_manifest_hash: 'bad',
        delegation_depth: 1,
      }),
    ).rejects.toBeInstanceOf(CapabilityInvalidError);
    for (const depth of [0, -1, 1.5]) {
      await expect(
        service.authorizeDelegation({
          parent,
          parent_grants: parentGrants,
          child_manifest_hash: '1'.repeat(64),
          delegation_depth: depth,
        }),
      ).rejects.toBeInstanceOf(CapabilityDelegationError);
    }

    const childGrants = grants({ tools: ['read_file'] });
    const proof = await service.authorizeDelegation({
      parent,
      parent_grants: parentGrants,
      child_manifest_hash: '2'.repeat(64),
      delegation_depth: 1,
    });
    const baseRequest: ChildCapabilityRequest = {
      child_manifest_hash: '1'.repeat(64),
      parent_delegation_proof: proof,
      budget_ceiling: childGrants.budget,
      tool_grants: [...childGrants.tools],
      resource_grants: [...childGrants.resources],
      delegation_depth: 1,
    };
    const malformedRequests: unknown[] = [
      null,
      { ...baseRequest, extra: true },
      { ...baseRequest, child_manifest_hash: 'bad' },
      { ...baseRequest, parent_delegation_proof: '' },
      { ...baseRequest, delegation_depth: 0 },
      { ...baseRequest, tool_grants: 'read_file' },
      { ...baseRequest, parent_delegation_proof: 'one.two.three' },
      { ...baseRequest, parent_delegation_proof: `${proof.slice(0, -1)}A` },
      baseRequest,
    ];
    for (const requestValue of malformedRequests) {
      await expect(
        service.issueChild({
          parent,
          parent_grants: parentGrants,
          request: requestValue as ChildCapabilityRequest,
          claims: claims(childGrants, { manifest_hash: '1'.repeat(64) }),
        }),
      ).rejects.toBeInstanceOf(CapabilityError);
    }
  });

  it('rejects expanded tools, resources, budget, identity changes and mismatched child hashes', async () => {
    const service = setup();
    const parentGrants = grants();
    const parent = await service.issue(claims(parentGrants));
    const childManifestHash = '1'.repeat(64);
    const proof = await service.authorizeDelegation({
      parent,
      parent_grants: parentGrants,
      child_manifest_hash: childManifestHash,
      delegation_depth: 1,
    });
    const makeRequest = (childGrants: CapabilityGrantSet): ChildCapabilityRequest => ({
      child_manifest_hash: childManifestHash,
      parent_delegation_proof: proof,
      budget_ceiling: childGrants.budget,
      tool_grants: [...childGrants.tools],
      resource_grants: [...childGrants.resources],
      delegation_depth: 1,
    });

    for (const childGrants of [
      grants({ tools: ['execute_command'] }),
      grants({ resources: ['workspace://other/'] }),
      grants({ budget: { token_limit: 1001, usd_micros: 1000 } }),
    ]) {
      await expect(
        service.issueChild({
          parent,
          parent_grants: parentGrants,
          request: makeRequest(childGrants),
          claims: claims(childGrants, { manifest_hash: childManifestHash }),
        }),
      ).rejects.toBeInstanceOf(CapabilityDelegationError);
    }

    const validChild = grants({ tools: ['read_file'] });
    await expect(
      service.issueChild({
        parent,
        parent_grants: parentGrants,
        request: makeRequest(validChild),
        claims: claims(validChild, {
          manifest_hash: childManifestHash,
          tenant_id: 'other-tenant',
        }),
      }),
    ).rejects.toBeInstanceOf(CapabilityDelegationError);
    await expect(
      service.issueChild({
        parent,
        parent_grants: parentGrants,
        request: makeRequest(validChild),
        claims: claims(validChild, {
          manifest_hash: childManifestHash,
          tool_grant_hash: '9'.repeat(64),
        }),
      }),
    ).rejects.toBeInstanceOf(CapabilityInvalidError);

    const boundedProof = await service.authorizeDelegation({
      parent,
      parent_grants: parentGrants,
      child_manifest_hash: childManifestHash,
      delegation_depth: 1,
    });
    const boundedRequest = makeRequest(validChild);
    boundedRequest.parent_delegation_proof = boundedProof;
    for (const validity of [
      { not_before: '2025-12-31T23:59:59.000Z' },
      { expires_at: '2026-01-01T00:01:01.000Z' },
    ]) {
      await expect(
        service.issueChild({
          parent,
          parent_grants: parentGrants,
          request: boundedRequest,
          claims: claims(validChild, { manifest_hash: childManifestHash, ...validity }),
        }),
      ).rejects.toBeInstanceOf(CapabilityDelegationError);
    }
  });

  async function issueChildWithBudget(
    parentBudget: Record<string, unknown>,
    childBudget: Record<string, unknown>,
  ) {
    const service = setup();
    const parentGrants = grants({ budget: parentBudget });
    const parent = await service.issue(claims(parentGrants));
    const childGrants = grants({
      tools: ['read_file'],
      resources: ['workspace://project/src/'],
      budget: childBudget,
    });
    const childManifestHash = '1'.repeat(64);
    const proof = await service.authorizeDelegation({
      parent,
      parent_grants: parentGrants,
      child_manifest_hash: childManifestHash,
      delegation_depth: 1,
    });
    return service.issueChild({
      parent,
      parent_grants: parentGrants,
      request: {
        child_manifest_hash: childManifestHash,
        parent_delegation_proof: proof,
        budget_ceiling: childBudget,
        tool_grants: [...childGrants.tools],
        resource_grants: [...childGrants.resources],
        delegation_depth: 1,
      },
      claims: claims(childGrants, {
        operation_id: 'operation-child',
        manifest_hash: childManifestHash,
      }),
    });
  }

  it('accepts every supported attenuated budget value at exact boundaries', async () => {
    const accepted: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ token_limit: 100 }, {}],
      [{ token_limit: 100 }, { token_limit: 0 }],
      [{ token_limit: 100 }, { token_limit: 100 }],
      [{ usd_micros: '100' }, { usd_micros: '0' }],
      [{ usd_micros: '100' }, { usd_micros: '100' }],
      [{ currency: 'USD' }, { currency: 'USD' }],
      [{ nested: { token_limit: 10 } }, { nested: { token_limit: 9 } }],
      [{ enabled: true }, { enabled: true }],
    ];

    for (const [parentBudget, childBudget] of accepted) {
      await expect(issueChildWithBudget(parentBudget, childBudget)).resolves.toBeDefined();
    }
  });

  it('rejects every expansion and type-confusion budget boundary exactly', async () => {
    const rejected: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ token_limit: 100 }, { unknown: 1 }],
      [{ token_limit: 100 }, { token_limit: -1 }],
      [{ token_limit: 100 }, { token_limit: 101 }],
      [{ token_limit: 100 }, { token_limit: Number.NaN }],
      [{ token_limit: 100 }, { token_limit: Number.POSITIVE_INFINITY }],
      [{ usd_micros: '100' }, { usd_micros: '101' }],
      [{ usd_micros: '100' }, { usd_micros: '01' }],
      [{ currency: 'USD' }, { currency: 'EUR' }],
      [{ token_limit: 100 }, { token_limit: '100' }],
      [{ nested: { token_limit: 10 } }, { nested: { token_limit: 11 } }],
      [{ nested: { token_limit: 10 } }, { nested: 10 }],
      [{ enabled: true }, { enabled: false }],
    ];

    for (const [parentBudget, childBudget] of rejected) {
      await expect(issueChildWithBudget(parentBudget, childBudget)).rejects.toMatchObject({
        name: 'CapabilityDelegationError',
        message: 'child budget exceeds parent',
      });
    }
  });

  it('treats resources as path segments rather than unsafe string prefixes', async () => {
    const issueForResource = async (resource: string) => {
      const service = setup();
      const parentGrants = grants({
        resources: ['workspace://project'],
      });
      const parent = await service.issue(claims(parentGrants));
      const childGrants = grants({
        tools: ['read_file'],
        resources: [resource],
        budget: { token_limit: 100 },
      });
      const childManifestHash = '1'.repeat(64);
      const proof = await service.authorizeDelegation({
        parent,
        parent_grants: parentGrants,
        child_manifest_hash: childManifestHash,
        delegation_depth: 1,
      });
      return service.issueChild({
        parent,
        parent_grants: parentGrants,
        request: {
          child_manifest_hash: childManifestHash,
          parent_delegation_proof: proof,
          budget_ceiling: childGrants.budget,
          tool_grants: [...childGrants.tools],
          resource_grants: [...childGrants.resources],
          delegation_depth: 1,
        },
        claims: claims(childGrants, {
          operation_id: 'operation-child',
          manifest_hash: childManifestHash,
        }),
      });
    };

    await expect(issueForResource('workspace://project')).resolves.toBeDefined();
    await expect(issueForResource('workspace://project/src/file.ts')).resolves.toBeDefined();
    await expect(issueForResource('workspace://project-evil/file.ts')).rejects.toMatchObject({
      name: 'CapabilityDelegationError',
      message: 'child resource grants exceed parent',
    });
  });

  it('reports every malformed grant-set and child-request boundary exactly', async () => {
    const service = setup();
    const parentGrants = grants();
    const parent = await service.issue(claims(parentGrants));
    const delegationOptions = {
      parent,
      child_manifest_hash: '1'.repeat(64),
      delegation_depth: 1,
    };
    const invalidGrantSets: Array<[unknown, string]> = [
      [null, 'grant set must be an object'],
      [{ tools: 'read_file', resources: [], budget: {} }, 'grant set is malformed'],
      [{ tools: [], resources: 'workspace://project', budget: {} }, 'grant set is malformed'],
      [{ tools: [], resources: [], budget: [] }, 'grant set is malformed'],
      [{ tools: [''], resources: [], budget: {} }, 'grant must be a non-empty string'],
      [{ tools: [], resources: [' '], budget: {} }, 'grant must be a non-empty string'],
      [{ tools: ['read_file', 'read_file'], resources: [], budget: {} }, 'grant set contains duplicates'],
      [
        { tools: [], resources: ['workspace://project', 'workspace://project'], budget: {} },
        'grant set contains duplicates',
      ],
    ];
    for (const [parent_grants, message] of invalidGrantSets) {
      await expect(
        service.authorizeDelegation({
          ...delegationOptions,
          parent_grants: parent_grants as CapabilityGrantSet,
        }),
      ).rejects.toMatchObject({ message });
    }

    await expect(
      service.authorizeDelegation({
        ...delegationOptions,
        parent_grants: parentGrants,
        child_manifest_hash: 'bad',
      }),
    ).rejects.toMatchObject({
      message: 'child_manifest_hash must be a lowercase SHA-256 hash',
    });
    for (const delegation_depth of [0, -1, 1.5]) {
      await expect(
        service.authorizeDelegation({
          ...delegationOptions,
          parent_grants: parentGrants,
          delegation_depth,
        }),
      ).rejects.toMatchObject({
        message: 'delegation_depth must be a positive safe integer',
      });
    }
  });

  it('rejects mixed child tool and resource grants when any one grant exceeds the parent', async () => {
    const issueMixed = async (childGrants: CapabilityGrantSet) => {
      const service = setup();
      const parentGrants = grants();
      const parent = await service.issue(claims(parentGrants));
      const childManifestHash = '1'.repeat(64);
      const proof = await service.authorizeDelegation({
        parent,
        parent_grants: parentGrants,
        child_manifest_hash: childManifestHash,
        delegation_depth: 1,
      });
      return service.issueChild({
        parent,
        parent_grants: parentGrants,
        request: {
          child_manifest_hash: childManifestHash,
          parent_delegation_proof: proof,
          budget_ceiling: childGrants.budget,
          tool_grants: [...childGrants.tools],
          resource_grants: [...childGrants.resources],
          delegation_depth: 1,
        },
        claims: claims(childGrants, { manifest_hash: childManifestHash }),
      });
    };

    await expect(
      issueMixed(grants({ tools: ['read_file', 'execute_command'] })),
    ).rejects.toMatchObject({ message: 'child tool grants exceed parent' });
    await expect(
      issueMixed(
        grants({
          resources: ['workspace://project/src/', 'workspace://other/'],
        }),
      ),
    ).rejects.toMatchObject({ message: 'child resource grants exceed parent' });
  });

  it('binds every parent grant hash, child claim hash, and inherited identity field', async () => {
    for (const parentMismatch of [
      grants({ tools: ['read_file'] }),
      grants({ resources: ['workspace://project/'] }),
      grants({ budget: { token_limit: 999 } }),
    ]) {
      const service = setup();
      const parentGrants = grants();
      const parent = await service.issue(claims(parentGrants));
      await expect(
        service.authorizeDelegation({
          parent,
          parent_grants: parentMismatch,
          child_manifest_hash: '1'.repeat(64),
          delegation_depth: 1,
        }),
      ).rejects.toMatchObject({
        message: 'parent grant material does not match signed hashes',
      });
    }

    const claimHashFields = [
      'manifest_hash',
      'tool_grant_hash',
      'resource_grant_hash',
      'budget_ceiling_hash',
    ] as const;
    for (const field of claimHashFields) {
      const service = setup();
      const parentGrants = grants();
      const parent = await service.issue(claims(parentGrants));
      const childGrants = grants({ tools: ['read_file'] });
      const childManifestHash = '1'.repeat(64);
      const proof = await service.authorizeDelegation({
        parent,
        parent_grants: parentGrants,
        child_manifest_hash: childManifestHash,
        delegation_depth: 1,
      });
      const childClaims = claims(childGrants, { manifest_hash: childManifestHash });
      await expect(
        service.issueChild({
          parent,
          parent_grants: parentGrants,
          request: {
            child_manifest_hash: childManifestHash,
            parent_delegation_proof: proof,
            budget_ceiling: childGrants.budget,
            tool_grants: [...childGrants.tools],
            resource_grants: [...childGrants.resources],
            delegation_depth: 1,
          },
          claims: { ...childClaims, [field]: '9'.repeat(64) },
        }),
      ).rejects.toMatchObject({
        message: 'child claim hashes do not match delegation request',
      });
    }

    for (const field of [
      'tenant_id',
      'audience',
      'subject_workload',
      'execution_epoch',
      'confirmation_key_thumbprint',
    ] as const) {
      const service = setup();
      const parentGrants = grants();
      const parent = await service.issue(claims(parentGrants));
      const childGrants = grants({ tools: ['read_file'] });
      const childManifestHash = '1'.repeat(64);
      const proof = await service.authorizeDelegation({
        parent,
        parent_grants: parentGrants,
        child_manifest_hash: childManifestHash,
        delegation_depth: 1,
      });
      await expect(
        service.issueChild({
          parent,
          parent_grants: parentGrants,
          request: {
            child_manifest_hash: childManifestHash,
            parent_delegation_proof: proof,
            budget_ceiling: childGrants.budget,
            tool_grants: [...childGrants.tools],
            resource_grants: [...childGrants.resources],
            delegation_depth: 1,
          },
          claims: claims(childGrants, {
            manifest_hash: childManifestHash,
            [field]: 'different',
          }),
        }),
      ).rejects.toMatchObject({
        message: `child ${field} must match parent`,
      });
    }
  });

  it('validates every signed delegation-proof binding and ignores JSON key order', async () => {
    const createFixture = async () => {
      const { keys, service } = setupWithKeys();
      const parentGrants = grants();
      const parent = await service.issue(claims(parentGrants));
      const childGrants = grants({ tools: ['read_file'] });
      const childManifestHash = '1'.repeat(64);
      const childClaims = claims(childGrants, { manifest_hash: childManifestHash });
      const makeProof = (value: unknown, raw = false) => {
        const payload = Buffer.from(raw ? String(value) : JSON.stringify(value)).toString('base64url');
        const signature = sign(null, Buffer.from(payload), keys.privateKey).toString('base64url');
        return `${payload}.${signature}`;
      };
      const issue = (parent_delegation_proof: string) =>
        service.issueChild({
          parent,
          parent_grants: parentGrants,
          request: {
            child_manifest_hash: childManifestHash,
            parent_delegation_proof,
            budget_ceiling: childGrants.budget,
            tool_grants: [...childGrants.tools],
            resource_grants: [...childGrants.resources],
            delegation_depth: 1,
          },
          claims: childClaims,
        });
      const proof = {
        expires_at: parent.claims.expires_at,
        delegation_depth: 1,
        child_manifest_hash: childManifestHash,
        parent_token_hash: hashCapabilityValue(parent.claims),
        parent_token_id: parent.claims.token_id,
      };
      return { issue, makeProof, proof };
    };

    const valid = await createFixture();
    await expect(valid.issue(valid.makeProof(valid.proof))).resolves.toBeDefined();

    const invalidJson = await createFixture();
    await expect(invalidJson.issue(invalidJson.makeProof('{', true))).rejects.toMatchObject({
      message: 'delegation proof payload is invalid',
    });

    for (const mutate of [
      () => null,
      (proof: Record<string, unknown>) => ({ ...proof, parent_token_id: 'other' }),
      (proof: Record<string, unknown>) => ({ ...proof, parent_token_hash: '9'.repeat(64) }),
      (proof: Record<string, unknown>) => ({ ...proof, child_manifest_hash: '2'.repeat(64) }),
      (proof: Record<string, unknown>) => ({ ...proof, delegation_depth: 2 }),
      (proof: Record<string, unknown>) => ({ ...proof, expires_at: '2026-01-01T00:00:59.000Z' }),
      (proof: Record<string, unknown>) => ({ ...proof, extra: true }),
    ]) {
      const fixture = await createFixture();
      const altered = mutate(fixture.proof);
      await expect(fixture.issue(fixture.makeProof(altered))).rejects.toMatchObject({
        message: 'delegation proof does not bind this request',
      });
    }
  });
});
