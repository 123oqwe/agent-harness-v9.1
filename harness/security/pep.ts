import type { ActionManifest } from '../contracts/index.js';
import type { CapabilityToken } from '../contracts/index.js';
import type { EffectRisk } from '../contracts/index.js';
import {
  PolicyEngine,
  isStrictDateTime,
  validateEgressTarget,
  type DerivedRiskTier,
  type PolicyContext,
} from './policy-engine.js';

export interface PepExecutionContext extends PolicyContext {
  operation_id: string;
  attempt_id: string;
  audience: string;
  subject_workload: string;
  execution_epoch: string;
  policy_hash: string;
  tool_effect_contract_hash: string;
  tool_grant_hash: string;
  resource_grant_hash: string;
  budget_ceiling_hash: string;
  confirmation_key_thumbprint: string;
}

export interface PepRequest {
  manifest: ActionManifest;
  risk: EffectRisk;
  token: CapabilityToken;
  context: PepExecutionContext;
  egress?: {
    destination: string;
    resolve_host: (host: string) => Promise<string[]>;
    pinned_addresses?: string[];
    redirect_from?: string;
  };
}

export interface PepAuthorization {
  readonly policy_decision_hash: string;
  readonly policy_hash: string;
  readonly token_id: string;
  readonly manifest_hash: string;
  readonly egress?: {
    readonly destination: string;
    readonly canonical_host: string;
    readonly resolved_addresses: readonly string[];
  };
}

export interface AuditEvent {
  readonly timestamp: string;
  readonly outcome: 'allow' | 'deny';
  readonly reason_code: string;
  readonly policy_hash: string;
  readonly policy_version: string;
  readonly token_id: string;
  readonly manifest_hash: string;
  readonly operation_id: string;
  readonly attempt_id: string;
  readonly tool_name: string;
  readonly derived_risk_tier: DerivedRiskTier | null;
}

export interface CapabilityAuthorityPort {
  verify_signature(token: CapabilityToken): Promise<boolean>;
  consume(tokenId: string): Promise<boolean>;
}

export interface AuditSinkPort {
  write(event: AuditEvent): Promise<void>;
}

export class PepDeniedError extends Error {
  readonly reason_code: string;

  constructor(reasonCode: string) {
    super(`Policy enforcement denied: ${reasonCode}`);
    this.name = 'PepDeniedError';
    this.reason_code = reasonCode;
  }
}

function deepFreeze<T>(value: T): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value;
  if (Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function strictTimestamp(value: unknown): number | undefined {
  return isStrictDateTime(value) ? Date.parse(value) : undefined;
}

export class PolicyEnforcementPoint {
  readonly #policyEngine: PolicyEngine;
  readonly #verifySignature: CapabilityAuthorityPort['verify_signature'];
  readonly #consume: CapabilityAuthorityPort['consume'];
  readonly #writeAudit: AuditSinkPort['write'];
  readonly #now: () => string;

  constructor(options: {
    policy_engine: PolicyEngine;
    capability_authority: CapabilityAuthorityPort;
    audit_sink: AuditSinkPort;
    now: () => string;
  }) {
    if (!(options.policy_engine instanceof PolicyEngine)) {
      throw new TypeError('policy_engine is required');
    }
    if (
      typeof options.capability_authority?.verify_signature !== 'function' ||
      typeof options.capability_authority.consume !== 'function'
    ) {
      throw new TypeError('capability_authority is required');
    }
    if (typeof options.audit_sink?.write !== 'function') throw new TypeError('audit_sink is required');
    if (typeof options.now !== 'function') throw new TypeError('now is required');
    this.#policyEngine = options.policy_engine;
    this.#verifySignature = options.capability_authority.verify_signature.bind(options.capability_authority);
    this.#consume = options.capability_authority.consume.bind(options.capability_authority);
    this.#writeAudit = options.audit_sink.write.bind(options.audit_sink);
    this.#now = options.now;
  }

  async enforce<T>(request: PepRequest, execute: (authorization: PepAuthorization) => Promise<T>): Promise<T> {
    if (typeof execute !== 'function') throw new TypeError('execute must be a function');
    const now = this.#now();
    const policyContext = { ...request.context, now };
    let tier: DerivedRiskTier | null = null;
    let decision;
    try {
      decision = this.#policyEngine.evaluate({
        tool_name: request.manifest.tool_name,
        resource_ids: request.manifest.resource_ids,
        risk: request.risk,
        context: policyContext,
      });
      tier = decision.derived_risk_tier;
    } catch {
      return this.#deny(request, 'invalid_policy_input', tier);
    }
    if (!decision.allowed) return this.#deny(request, 'policy_denied', tier);

    if (request.context.policy_hash !== this.#policyEngine.policy_hash) {
      return this.#deny(request, 'wrong_policy_hash', tier);
    }
    if (request.manifest.policy_version !== this.#policyEngine.version) {
      return this.#deny(request, 'wrong_policy_version', tier);
    }

    let signatureValid: boolean;
    try {
      signatureValid = await this.#verifySignature(request.token);
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) return this.#deny(request, 'invalid_signature', tier);

    const issuedAt = strictTimestamp(request.token.issued_at);
    const notBefore = strictTimestamp(request.token.not_before);
    const expiresAt = strictTimestamp(request.token.expires_at);
    const nowValue = strictTimestamp(now);
    if (
      issuedAt === undefined ||
      notBefore === undefined ||
      expiresAt === undefined ||
      nowValue === undefined
    ) {
      return this.#deny(request, 'invalid_time', tier);
    }
   // Allow 10s clock skew tolerance for issued_at vs not_before
   if (issuedAt > notBefore + 10_000 || notBefore >= expiresAt) {
     return this.#deny(request, 'invalid_time_order', tier);
    }
    if (nowValue < notBefore) return this.#deny(request, 'not_yet_valid', tier);
    if (nowValue >= expiresAt) return this.#deny(request, 'expired', tier);
    const manifestExpiresAt = strictTimestamp(request.manifest.expires_at);
    if (manifestExpiresAt === undefined) return this.#deny(request, 'invalid_manifest_time', tier);
    if (nowValue >= manifestExpiresAt) return this.#deny(request, 'manifest_expired', tier);
    if (request.token.use_limit !== 1) return this.#deny(request, 'invalid_use_limit', tier);

    const mismatches: Array<[boolean, string]> = [
      [request.token.tenant_id !== request.context.tenant_id, 'wrong_tenant'],
      [request.token.audience !== request.context.audience, 'wrong_audience'],
      [request.token.subject_workload !== request.context.subject_workload, 'wrong_workload'],
      [request.token.operation_id !== request.context.operation_id, 'wrong_operation'],
      [request.token.attempt_id !== request.context.attempt_id, 'wrong_attempt'],
      [request.token.execution_epoch !== request.context.execution_epoch, 'wrong_execution_epoch'],
      [request.token.manifest_hash !== request.manifest.manifest_hash, 'wrong_manifest_hash'],
      [request.token.tool_grant_hash !== request.context.tool_grant_hash, 'wrong_tool_grant'],
      [request.token.resource_grant_hash !== request.context.resource_grant_hash, 'wrong_resource_grant'],
      [request.token.budget_ceiling_hash !== request.context.budget_ceiling_hash, 'wrong_budget_ceiling'],
      [
        request.token.tool_effect_contract_hash !== request.context.tool_effect_contract_hash,
        'wrong_tool_effect_contract',
      ],
      [
        request.token.confirmation_key_thumbprint !== request.context.confirmation_key_thumbprint,
        'wrong_confirmation_key',
      ],
      [request.token.policy_decision_hash !== decision.decision_hash, 'wrong_policy_decision'],
    ];
    const mismatch = mismatches.find(([failed]) => failed);
    if (mismatch) return this.#deny(request, mismatch[1], tier);

    let authorizedEgress:
      | { destination: string; canonical_host: string; resolved_addresses: readonly string[] }
      | undefined;
    if (request.risk.network_access) {
      if (request.egress === undefined || decision.egress_policy === undefined) {
        return this.#deny(request, 'egress_target_required', tier);
      }
      const egressDecision = await validateEgressTarget({
        destination: request.egress.destination,
        policy: decision.egress_policy,
        resolve_host: request.egress.resolve_host,
        ...(request.egress.pinned_addresses === undefined
          ? {}
          : { pinned_addresses: request.egress.pinned_addresses }),
        ...(request.egress.redirect_from === undefined
          ? {}
          : { redirect_from: request.egress.redirect_from }),
      });
      if (!egressDecision.allowed) {
        return this.#deny(request, `egress_${egressDecision.reason_code}`, tier);
      }
      authorizedEgress = {
        destination: request.egress.destination,
        canonical_host: egressDecision.canonical_host!,
        resolved_addresses: egressDecision.resolved_addresses!,
      };
    }

    let consumed: boolean;
    try {
      consumed = await this.#consume(request.token.token_id);
    } catch {
      return this.#deny(request, 'capability_consume_failed', tier);
    }
    if (!consumed) return this.#deny(request, 'capability_used', tier);

    const authorization = deepFreeze({
      policy_decision_hash: decision.decision_hash,
      policy_hash: this.#policyEngine.policy_hash,
      token_id: request.token.token_id,
      manifest_hash: request.manifest.manifest_hash,
      ...(authorizedEgress === undefined ? {} : { egress: authorizedEgress }),
    } satisfies PepAuthorization);
    await this.#audit(request, 'allow', 'authorized', tier);
    return execute(authorization);
  }

  async #deny(request: PepRequest, reasonCode: string, tier: DerivedRiskTier | null): Promise<never> {
    await this.#audit(request, 'deny', reasonCode, tier);
    throw new PepDeniedError(reasonCode);
  }

  async #audit(
    request: PepRequest,
    outcome: AuditEvent['outcome'],
    reasonCode: string,
    tier: DerivedRiskTier | null,
  ): Promise<void> {
    const event = deepFreeze({
      timestamp: this.#now(),
      outcome,
      reason_code: reasonCode,
      policy_hash: this.#policyEngine.policy_hash,
      policy_version: this.#policyEngine.version,
      token_id: request.token.token_id,
      manifest_hash: request.manifest.manifest_hash,
      operation_id: request.context.operation_id,
      attempt_id: request.context.attempt_id,
      tool_name: request.manifest.tool_name,
      derived_risk_tier: tier,
    } satisfies AuditEvent);
    try {
      await this.#writeAudit(event);
    } catch {
      throw new PepDeniedError('audit_failed');
    }
  }
}
