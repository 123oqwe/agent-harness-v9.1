import { randomUUID, sign, verify, type KeyObject } from 'node:crypto';

import type { CapabilityToken } from '../../spec/types/capability-token.js';
import type { ChildCapabilityRequest } from '../../spec/types/child-capability-request.js';
import { isStrictDateTime } from './policy-engine.js';
import {
  CapabilityDelegationError,
  CapabilityExpiredError,
  CapabilityInvalidError,
  CapabilityNotYetValidError,
  CapabilityRevokedError,
  type CapabilityStateRecord,
  type CapabilityStateStore,
  CapabilityUsedError,
  CredentialDispatchError,
  FileCapabilityStateStore,
  InMemoryCapabilityStateStore,
  type SignedCapabilityToken,
  canonicalizeCapabilityValue,
  hashCapabilityValue,
  isUuid,
  signCapabilityClaims,
  verifyCapabilityClaims,
} from './capability.js';

export { FileCapabilityStateStore, InMemoryCapabilityStateStore };

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const ISSUE_FIELDS = new Set([
  'operation_id',
  'attempt_id',
  'manifest_hash',
  'policy_decision_hash',
  'tool_effect_contract_hash',
  'subject_workload',
  'tenant_id',
  'audience',
  'tool_grant_hash',
  'resource_grant_hash',
  'budget_ceiling_hash',
  'execution_epoch',
  'confirmation_key_thumbprint',
  'not_before',
  'expires_at',
]);

export interface CapabilityIssueRequest {
  operation_id: string;
  attempt_id: string;
  manifest_hash: string;
  policy_decision_hash: string;
  tool_effect_contract_hash: string;
  subject_workload: string;
  tenant_id: string;
  audience: string;
  tool_grant_hash: string;
  resource_grant_hash: string;
  budget_ceiling_hash: string;
  execution_epoch: string;
  confirmation_key_thumbprint: string;
  not_before: string;
  expires_at: string;
}

export interface CapabilityGrantSet {
  readonly tools: readonly string[];
  readonly resources: readonly string[];
  readonly budget: Readonly<Record<string, unknown>>;
}

export interface DisposableCredential {
  readonly value: Uint8Array;
  dispose(): Promise<void> | void;
}

export interface CredentialExchangeContext {
  readonly token_id: string;
  readonly operation_id: string;
  readonly attempt_id: string;
  readonly run_phase: 'agent';
  readonly single_use: true;
}

export interface CredentialDispatchRequest<T> {
  capability: SignedCapabilityToken;
  confirmation_key_thumbprint: string;
  exchange(context: CredentialExchangeContext): Promise<DisposableCredential>;
  dispatch(credential: Uint8Array): Promise<T>;
}

interface DelegationProof {
  parent_token_id: string;
  parent_token_hash: string;
  child_manifest_hash: string;
  delegation_depth: number;
  expires_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CapabilityInvalidError(`${label} must be a non-empty string`);
  }
}

function requireHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new CapabilityInvalidError(`${label} must be a lowercase SHA-256 hash`);
  }
}

function strictTimestamp(value: unknown, label: string): number {
  if (!isStrictDateTime(value)) throw new CapabilityInvalidError(`${label} must be an ISO date-time`);
  return Date.parse(value);
}

function validateIssueRequest(request: CapabilityIssueRequest): void {
  if (!isRecord(request)) throw new CapabilityInvalidError('capability request must be an object');
  const unknown = Object.keys(request).filter((key) => !ISSUE_FIELDS.has(key));
  if (unknown.length > 0 || Object.keys(request).length !== ISSUE_FIELDS.size) {
    throw new CapabilityInvalidError('capability request contains unknown or missing fields');
  }
  for (const field of [
    'operation_id',
    'attempt_id',
    'subject_workload',
    'tenant_id',
    'audience',
    'execution_epoch',
    'confirmation_key_thumbprint',
  ] as const) {
    requireNonEmpty(request[field], field);
  }
  for (const field of [
    'manifest_hash',
    'policy_decision_hash',
    'tool_effect_contract_hash',
    'tool_grant_hash',
    'resource_grant_hash',
    'budget_ceiling_hash',
  ] as const) {
    requireHash(request[field], field);
  }
  const notBefore = strictTimestamp(request.not_before, 'not_before');
  const expiresAt = strictTimestamp(request.expires_at, 'expires_at');
  if (notBefore >= expiresAt) throw new CapabilityInvalidError('capability validity window is empty');
}

function validateClaimsShape(claims: CapabilityToken): void {
  if (!isRecord(claims)) throw new CapabilityInvalidError('capability claims must be an object');
  const required = [
    'token_id',
    'operation_id',
    'attempt_id',
    'manifest_hash',
    'policy_decision_hash',
    'tool_effect_contract_hash',
    'subject_workload',
    'tenant_id',
    'audience',
    'tool_grant_hash',
    'resource_grant_hash',
    'budget_ceiling_hash',
    'issued_at',
    'not_before',
    'expires_at',
    'execution_epoch',
    'use_limit',
    'confirmation_key_thumbprint',
  ];
  const allowed = new Set([...required, 'parent_delegation_proof']);
  if (required.some((field) => !(field in claims)) || Object.keys(claims).some((field) => !allowed.has(field))) {
    throw new CapabilityInvalidError('capability claims contain unknown or missing fields');
  }
  if (!isUuid(claims.token_id)) throw new CapabilityInvalidError('token_id must be a UUID');
  validateIssueRequest({
    operation_id: claims.operation_id,
    attempt_id: claims.attempt_id,
    manifest_hash: claims.manifest_hash,
    policy_decision_hash: claims.policy_decision_hash,
    tool_effect_contract_hash: claims.tool_effect_contract_hash,
    subject_workload: claims.subject_workload,
    tenant_id: claims.tenant_id,
    audience: claims.audience,
    tool_grant_hash: claims.tool_grant_hash,
    resource_grant_hash: claims.resource_grant_hash,
    budget_ceiling_hash: claims.budget_ceiling_hash,
    execution_epoch: claims.execution_epoch,
    confirmation_key_thumbprint: claims.confirmation_key_thumbprint,
    not_before: claims.not_before,
    expires_at: claims.expires_at,
  });
  const issuedAt = strictTimestamp(claims.issued_at, 'issued_at');
  if (issuedAt > Date.parse(claims.not_before)) {
    throw new CapabilityInvalidError('issued_at must not be after not_before');
  }
  if (claims.use_limit !== 1) throw new CapabilityInvalidError('use_limit must be 1');
  if (
    claims.parent_delegation_proof !== undefined &&
    claims.parent_delegation_proof !== null &&
    (typeof claims.parent_delegation_proof !== 'string' || claims.parent_delegation_proof.length === 0)
  ) {
    throw new CapabilityInvalidError('parent_delegation_proof must be a non-empty string or null');
  }
}

function deepFreeze<T>(value: T): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value;
  if (Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function statusError(status: CapabilityStateRecord['status']): CapabilityUsedError | CapabilityRevokedError {
  return status === 'revoked'
    ? new CapabilityRevokedError('capability has been revoked')
    : new CapabilityUsedError('capability has already been used');
}

function validateGrantSet(grants: CapabilityGrantSet): void {
  if (!isRecord(grants)) throw new CapabilityDelegationError('grant set must be an object');
  if (!Array.isArray(grants.tools) || !Array.isArray(grants.resources) || !isRecord(grants.budget)) {
    throw new CapabilityDelegationError('grant set is malformed');
  }
  for (const entry of [...grants.tools, ...grants.resources]) requireNonEmpty(entry, 'grant');
  if (new Set(grants.tools).size !== grants.tools.length || new Set(grants.resources).size !== grants.resources.length) {
    throw new CapabilityDelegationError('grant set contains duplicates');
  }
}

function budgetAttenuates(child: Record<string, unknown>, parent: Record<string, unknown>): boolean {
  for (const [key, childValue] of Object.entries(child)) {
    if (!(key in parent)) return false;
    const parentValue = parent[key];
    if (typeof childValue === 'number' && typeof parentValue === 'number') {
      if (!Number.isFinite(childValue) || childValue < 0 || childValue > parentValue) return false;
    } else if (typeof childValue === 'string' && typeof parentValue === 'string') {
      if (/^(?:0|[1-9]\d*)$/u.test(childValue) && /^(?:0|[1-9]\d*)$/u.test(parentValue)) {
        if (BigInt(childValue) > BigInt(parentValue)) return false;
      } else if (childValue !== parentValue) {
        return false;
      }
    } else if (isRecord(childValue) && isRecord(parentValue)) {
      if (!budgetAttenuates(childValue, parentValue)) return false;
    } else if (childValue !== parentValue) {
      return false;
    }
  }
  return true;
}

function resourceAttenuates(child: string, parents: readonly string[]): boolean {
  return parents.some((parent) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`));
}

export function hashCapabilityGrant(value: unknown): string {
  return hashCapabilityValue(value);
}

export class AuthorizationService {
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  readonly #state: CapabilityStateStore;
  readonly #now: () => string;
  readonly #randomUuid: () => string;
  readonly #maxTtlMs: number;

  constructor(options: {
    private_key: KeyObject;
    public_key: KeyObject;
    state_store: CapabilityStateStore;
    now?: () => string;
    random_uuid?: () => string;
    max_ttl_ms?: number;
  }) {
    if (options.private_key?.type !== 'private' || options.public_key?.type !== 'public') {
      throw new CapabilityInvalidError('Authorization Service requires an asymmetric key pair');
    }
    if (options.private_key.asymmetricKeyType !== 'ed25519' || options.public_key.asymmetricKeyType !== 'ed25519') {
      throw new CapabilityInvalidError('Authorization Service requires Ed25519 keys');
    }
    if (
      !options.state_store ||
      typeof options.state_store.register !== 'function' ||
      typeof options.state_store.read !== 'function' ||
      typeof options.state_store.consume !== 'function' ||
      typeof options.state_store.revoke !== 'function'
    ) {
      throw new CapabilityInvalidError('state_store is required');
    }
    this.#privateKey = options.private_key;
    this.#publicKey = options.public_key;
    this.#state = options.state_store;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#randomUuid = options.random_uuid ?? randomUUID;
    this.#maxTtlMs = options.max_ttl_ms ?? 300_000;
    if (!Number.isSafeInteger(this.#maxTtlMs) || this.#maxTtlMs <= 0) {
      throw new CapabilityInvalidError('max_ttl_ms must be a positive safe integer');
    }
  }

  async issue(request: CapabilityIssueRequest): Promise<SignedCapabilityToken> {
    return this.#issue(request);
  }

  async #issue(
    request: CapabilityIssueRequest,
    parentDelegationProof?: string,
  ): Promise<SignedCapabilityToken> {
    validateIssueRequest(request);
    const issuedAt = this.#now();
    const issuedAtValue = strictTimestamp(issuedAt, 'current time');
    const notBefore = Date.parse(request.not_before);
    const expiresAt = Date.parse(request.expires_at);
    if (issuedAtValue > notBefore || issuedAtValue >= expiresAt) {
      throw new CapabilityInvalidError('capability is not valid at issuance time');
    }
    if (expiresAt - issuedAtValue > this.#maxTtlMs) {
      throw new CapabilityInvalidError('capability lifetime exceeds Authorization Service policy');
    }
    const tokenId = this.#randomUuid();
    if (!isUuid(tokenId)) throw new CapabilityInvalidError('random_uuid returned an invalid UUID');
    const claims = cloneFreeze({
      token_id: tokenId,
      ...structuredClone(request),
      ...(parentDelegationProof === undefined ? {} : { parent_delegation_proof: parentDelegationProof }),
      issued_at: issuedAt,
      use_limit: 1,
    } satisfies CapabilityToken);
    validateClaimsShape(claims);
    const signature = signCapabilityClaims(claims, this.#privateKey);
    const signed = cloneFreeze({ algorithm: 'Ed25519', claims, signature } satisfies SignedCapabilityToken);
    await this.#state.register(tokenId, {
      token_hash: hashCapabilityValue(claims),
      signature,
      status: 'issued',
    });
    return signed;
  }

  async verify(
    capability: SignedCapabilityToken,
    options: { confirmation_key_thumbprint?: string } = {},
  ): Promise<CapabilityToken> {
    this.#validateEnvelope(capability);
    const record = await this.#state.read(capability.claims.token_id);
    if (
      record === undefined ||
      record.token_hash !== hashCapabilityValue(capability.claims) ||
      record.signature !== capability.signature
    ) {
      throw new CapabilityInvalidError('capability is unknown or state binding failed');
    }
    if (record.status !== 'issued') throw statusError(record.status);
    const now = strictTimestamp(this.#now(), 'current time');
    const notBefore = Date.parse(capability.claims.not_before);
    const expiresAt = Date.parse(capability.claims.expires_at);
    if (now < notBefore) throw new CapabilityNotYetValidError('capability is not yet valid');
    if (now >= expiresAt) throw new CapabilityExpiredError('capability has expired');
    if (
      options.confirmation_key_thumbprint !== undefined &&
      options.confirmation_key_thumbprint !== capability.claims.confirmation_key_thumbprint
    ) {
      throw new CapabilityInvalidError('confirmation key mismatch');
    }
    return cloneFreeze(capability.claims);
  }

  async verify_signature(token: CapabilityToken): Promise<boolean> {
    try {
      validateClaimsShape(token);
      const record = await this.#state.read(token.token_id);
      return (
        record?.status === 'issued' &&
        record.token_hash === hashCapabilityValue(token) &&
        verifyCapabilityClaims(token, record.signature, this.#publicKey)
      );
    } catch {
      return false;
    }
  }

  async consume(
    capability: SignedCapabilityToken,
    options?: { confirmation_key_thumbprint?: string },
  ): Promise<CapabilityToken>;
  async consume(tokenId: string): Promise<boolean>;
  async consume(
    capabilityOrTokenId: SignedCapabilityToken | string,
    options: { confirmation_key_thumbprint?: string } = {},
  ): Promise<CapabilityToken | boolean> {
    if (typeof capabilityOrTokenId === 'string') {
      return (await this.#state.consume(capabilityOrTokenId, (await this.#state.read(capabilityOrTokenId))?.token_hash ?? '')) === 'consumed';
    }
    const claims = await this.verify(capabilityOrTokenId, options);
    const outcome = await this.#state.consume(claims.token_id, hashCapabilityValue(claims));
    if (outcome === 'consumed') return claims;
    if (outcome === 'revoked') throw new CapabilityRevokedError('capability has been revoked');
    if (outcome === 'used') throw new CapabilityUsedError('capability has already been used');
    throw new CapabilityInvalidError('capability state binding failed');
  }

  async revoke(tokenId: string): Promise<boolean> {
    if (!isUuid(tokenId)) throw new CapabilityInvalidError('token id must be a UUID');
    return this.#state.revoke(tokenId);
  }

  async authorizeDelegation(options: {
    parent: SignedCapabilityToken;
    parent_grants: CapabilityGrantSet;
    child_manifest_hash: string;
    delegation_depth: number;
  }): Promise<string> {
    const parent = await this.verify(options.parent);
    validateGrantSet(options.parent_grants);
    this.#verifyGrantHashes(parent, options.parent_grants);
    requireHash(options.child_manifest_hash, 'child_manifest_hash');
    if (!Number.isSafeInteger(options.delegation_depth) || options.delegation_depth < 1) {
      throw new CapabilityDelegationError('delegation_depth must be a positive safe integer');
    }
    const proof: DelegationProof = {
      parent_token_id: parent.token_id,
      parent_token_hash: hashCapabilityValue(parent),
      child_manifest_hash: options.child_manifest_hash,
      delegation_depth: options.delegation_depth,
      expires_at: parent.expires_at,
    };
    const payload = Buffer.from(JSON.stringify(canonicalizeCapabilityValue(proof))).toString('base64url');
    const signature = sign(null, Buffer.from(payload), this.#privateKey).toString('base64url');
    return `${payload}.${signature}`;
  }

  async issueChild(options: {
    parent: SignedCapabilityToken;
    parent_grants: CapabilityGrantSet;
    request: ChildCapabilityRequest;
    claims: CapabilityIssueRequest;
  }): Promise<SignedCapabilityToken> {
    const parent = await this.verify(options.parent);
    validateGrantSet(options.parent_grants);
    this.#verifyGrantHashes(parent, options.parent_grants);
    const childGrants = this.#validateChildRequest(options.request);
    this.#verifyDelegationProof(options.request, parent);
    if (!childGrants.tools.every((tool) => options.parent_grants.tools.includes(tool))) {
      throw new CapabilityDelegationError('child tool grants exceed parent');
    }
    if (!childGrants.resources.every((resource) => resourceAttenuates(resource, options.parent_grants.resources))) {
      throw new CapabilityDelegationError('child resource grants exceed parent');
    }
    if (!budgetAttenuates(childGrants.budget, options.parent_grants.budget)) {
      throw new CapabilityDelegationError('child budget exceeds parent');
    }
    validateIssueRequest(options.claims);
    if (
      options.claims.manifest_hash !== options.request.child_manifest_hash ||
      options.claims.tool_grant_hash !== hashCapabilityGrant(childGrants.tools) ||
      options.claims.resource_grant_hash !== hashCapabilityGrant(childGrants.resources) ||
      options.claims.budget_ceiling_hash !== hashCapabilityGrant(childGrants.budget)
    ) {
      throw new CapabilityInvalidError('child claim hashes do not match delegation request');
    }
    for (const field of [
      'tenant_id',
      'audience',
      'subject_workload',
      'execution_epoch',
      'confirmation_key_thumbprint',
    ] as const) {
      if (options.claims[field] !== parent[field]) {
        throw new CapabilityDelegationError(`child ${field} must match parent`);
      }
    }
    if (
      Date.parse(options.claims.not_before) < Date.parse(parent.not_before) ||
      Date.parse(options.claims.expires_at) > Date.parse(parent.expires_at)
    ) {
      throw new CapabilityDelegationError('child validity must be bounded by parent');
    }
    await this.consume(options.parent);
    return this.#issue(options.claims, options.request.parent_delegation_proof);
  }

  async dispatchWithExchangedCredential<T>(request: CredentialDispatchRequest<T>): Promise<T> {
    let claims: CapabilityToken;
    try {
      claims = await this.consume(request.capability, {
        confirmation_key_thumbprint: request.confirmation_key_thumbprint,
      });
    } catch (error) {
      throw new CredentialDispatchError('capability rejected before credential exchange', error);
    }
    let credential: DisposableCredential | undefined;
    try {
      credential = await request.exchange({
        token_id: claims.token_id,
        operation_id: claims.operation_id,
        attempt_id: claims.attempt_id,
        run_phase: 'agent',
        single_use: true,
      });
      if (!(credential.value instanceof Uint8Array) || typeof credential.dispose !== 'function') {
        throw new CredentialDispatchError('credential exchange returned an invalid disposable credential');
      }
      return await request.dispatch(credential.value);
    } finally {
      if (credential !== undefined) {
        if (credential.value instanceof Uint8Array) credential.value.fill(0);
        await credential.dispose();
      }
    }
  }

  #validateEnvelope(capability: SignedCapabilityToken): void {
    if (!isRecord(capability) || capability.algorithm !== 'Ed25519') {
      throw new CapabilityInvalidError('invalid signed capability envelope');
    }
    if (Object.keys(capability).sort().join(',') !== 'algorithm,claims,signature') {
      throw new CapabilityInvalidError('signed capability contains unknown or missing fields');
    }
    validateClaimsShape(capability.claims);
    if (!verifyCapabilityClaims(capability.claims, capability.signature, this.#publicKey)) {
      throw new CapabilityInvalidError('capability signature is invalid');
    }
  }

  #verifyGrantHashes(parent: CapabilityToken, grants: CapabilityGrantSet): void {
    if (
      parent.tool_grant_hash !== hashCapabilityGrant(grants.tools) ||
      parent.resource_grant_hash !== hashCapabilityGrant(grants.resources) ||
      parent.budget_ceiling_hash !== hashCapabilityGrant(grants.budget)
    ) {
      throw new CapabilityDelegationError('parent grant material does not match signed hashes');
    }
  }

  #validateChildRequest(request: ChildCapabilityRequest): CapabilityGrantSet {
    if (!isRecord(request)) throw new CapabilityDelegationError('child request must be an object');
    const keys = [
      'budget_ceiling',
      'child_manifest_hash',
      'delegation_depth',
      'parent_delegation_proof',
      'resource_grants',
      'tool_grants',
    ];
    if (Object.keys(request).sort().join(',') !== keys.join(',')) {
      throw new CapabilityDelegationError('child request contains unknown or missing fields');
    }
    requireHash(request.child_manifest_hash, 'child_manifest_hash');
    requireNonEmpty(request.parent_delegation_proof, 'parent_delegation_proof');
    if (!Number.isSafeInteger(request.delegation_depth) || request.delegation_depth < 1) {
      throw new CapabilityDelegationError('delegation_depth must be a positive safe integer');
    }
    const grants: CapabilityGrantSet = {
      tools: request.tool_grants as string[],
      resources: request.resource_grants as string[],
      budget: request.budget_ceiling,
    };
    validateGrantSet(grants);
    return grants;
  }

  #verifyDelegationProof(request: ChildCapabilityRequest, parent: CapabilityToken): void {
    const [payload, signature, extra] = request.parent_delegation_proof.split('.');
    if (payload === undefined || signature === undefined || extra !== undefined) {
      throw new CapabilityDelegationError('invalid delegation proof envelope');
    }
    if (
      !verify(null, Buffer.from(payload), this.#publicKey, Buffer.from(signature, 'base64url'))
    ) {
      throw new CapabilityDelegationError('delegation proof signature is invalid');
    }
    let proof: unknown;
    try {
      proof = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw new CapabilityDelegationError('delegation proof payload is invalid');
    }
    if (
      !isRecord(proof) ||
      proof.parent_token_id !== parent.token_id ||
      proof.parent_token_hash !== hashCapabilityValue(parent) ||
      proof.child_manifest_hash !== request.child_manifest_hash ||
      proof.delegation_depth !== request.delegation_depth ||
      proof.expires_at !== parent.expires_at ||
      Object.keys(proof).sort().join(',') !==
        'child_manifest_hash,delegation_depth,expires_at,parent_token_hash,parent_token_id'
    ) {
      throw new CapabilityDelegationError('delegation proof does not bind this request');
    }
  }
}
