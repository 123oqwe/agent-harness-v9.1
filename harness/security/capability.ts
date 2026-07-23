/**
 * AH-CAPABILITY-001: Capability Token Service
 *
 * Issues, verifies, and revokes single-use capability tokens bound to
 * run_id, step_id, attempt_id, tenant_id, and subject. Implements child
 * capability attenuation: child scope, lifetime, effects, and resources
 * must be subsets of the parent.
 *
 * Key invariants:
 *  - use_limit is always 1 (atomic single-use)
 *  - Token is bound to execution context (run/step/attempt/tenant/subject)
 *  - Expired tokens cannot be consumed
 *  - Revoked tokens cannot be consumed
 *  - Used tokens cannot be consumed again (replay prevention)
 *  - Child tokens cannot expand beyond parent scope
 *  - Token integrity is verified via internal HMAC
 */

import { createHmac, randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types (mirrors spec/contracts/capability-token.schema.json)
// ---------------------------------------------------------------------------

export interface CapabilityToken {
  token_id: string;
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
  issued_at: string;
  not_before: string;
  expires_at: string;
  execution_epoch: string;
  use_limit: 1;
  confirmation_key_thumbprint: string;
  parent_delegation_proof?: string | null;
}

export interface CapabilityContext {
  run_id: string;
  step_id: string;
  attempt_id: string;
  tenant_id: string;
  subject: string;
  execution_epoch: string;
  policy_version: string;
  now: Date;
}

export interface CapabilityIssueRequest {
  operation_id: string;
  manifest_hash: string;
  policy_decision_hash: string;
  tool_effect_contract_hash: string;
  tool_grant_hash: string;
  resource_grant_hash: string;
  budget_ceiling_hash: string;
  confirmation_key_thumbprint: string;
  audience: string;
  ttl_seconds: number;
  parent_token_id?: string;
}

export interface CapabilityServiceOptions {
  maxDelegationDepth?: number;
  signingKey?: string;
}

// ---------------------------------------------------------------------------
// Internal token state
// ---------------------------------------------------------------------------

interface TokenState {
  token: CapabilityToken;
  context: CapabilityContext;
  integrity_hash: string;
  used: boolean;
  revoked: boolean;
  delegation_depth: number;
  parent_tool_grant_hash: string | null;
  parent_resource_grant_hash: string | null;
  parent_expires_at: string | null;
}

// ---------------------------------------------------------------------------
// Capability Service
// ---------------------------------------------------------------------------

const DEFAULT_SIGNING_KEY = 'agent-harness-capability-signing-key-v1';
const DEFAULT_MAX_DEPTH = 10;

export class CapabilityService {
  private readonly tokens = new Map<string, TokenState>();
  private readonly signingKey: string;
  private readonly maxDelegationDepth: number;
  private replayCount = 0;

  constructor(opts: CapabilityServiceOptions = {}) {
    this.signingKey = opts.signingKey ?? DEFAULT_SIGNING_KEY;
    this.maxDelegationDepth = opts.maxDelegationDepth ?? DEFAULT_MAX_DEPTH;
  }

  issue(req: CapabilityIssueRequest, ctx: CapabilityContext): CapabilityToken {
    // Check parent if this is a child token
    let parentState: TokenState | null = null;
    let delegationDepth = 0;

    if (req.parent_token_id) {
      parentState = this.tokens.get(req.parent_token_id) ?? null;
      if (!parentState) {
        throw new Error('Cannot issue child: parent token not found');
      }
      if (parentState.used) {
        throw new Error('Cannot issue child: parent token already used');
      }
      if (parentState.revoked) {
        throw new Error('Cannot issue child: parent token revoked');
      }

      // Attenuation: child tool grants must match parent's (cannot expand)
      if (req.tool_grant_hash !== parentState.token.tool_grant_hash) {
        throw new Error(
          'Child capability attenuation violation: tool_grant_hash differs from parent (cannot expand grants)',
        );
      }

      // Attenuation: child resource grants must match parent's (cannot expand)
      if (req.resource_grant_hash !== parentState.token.resource_grant_hash) {
        throw new Error(
          'Child capability attenuation violation: resource_grant_hash differs from parent (cannot expand resources)',
        );
      }

      // Attenuation: child lifetime cannot exceed parent
      const parentExpiry = new Date(parentState.token.expires_at).getTime();
      const childExpiry = ctx.now.getTime() + req.ttl_seconds * 1000;
      if (childExpiry > parentExpiry) {
        throw new Error(
          'Child capability attenuation violation: lifetime exceeds parent (expires_at beyond parent)',
        );
      }

      delegationDepth = parentState.delegation_depth + 1;
      if (delegationDepth > this.maxDelegationDepth) {
        throw new Error(
          `Child capability delegation depth ${delegationDepth} exceeds max ${this.maxDelegationDepth}`,
        );
      }
    }

    const issuedAt = ctx.now.toISOString();
    const expiresAt = new Date(ctx.now.getTime() + req.ttl_seconds * 1000).toISOString();

    const token: CapabilityToken = {
      token_id: randomUUID(),
      operation_id: req.operation_id,
      attempt_id: ctx.attempt_id,
      manifest_hash: req.manifest_hash,
      policy_decision_hash: req.policy_decision_hash,
      tool_effect_contract_hash: req.tool_effect_contract_hash,
      subject_workload: ctx.subject,
      tenant_id: ctx.tenant_id,
      audience: req.audience,
      tool_grant_hash: req.tool_grant_hash,
      resource_grant_hash: req.resource_grant_hash,
      budget_ceiling_hash: req.budget_ceiling_hash,
      issued_at: issuedAt,
      not_before: issuedAt,
      expires_at: expiresAt,
      execution_epoch: ctx.execution_epoch,
      use_limit: 1,
      confirmation_key_thumbprint: req.confirmation_key_thumbprint,
      parent_delegation_proof: req.parent_token_id ?? null,
    };

    const integrityHash = this.computeIntegrityHash(token, ctx);

    const state: TokenState = {
      token,
      context: { ...ctx },
      integrity_hash: integrityHash,
      used: false,
      revoked: false,
      delegation_depth: delegationDepth,
      parent_tool_grant_hash: parentState?.token.tool_grant_hash ?? null,
      parent_resource_grant_hash: parentState?.token.resource_grant_hash ?? null,
      parent_expires_at: parentState?.token.expires_at ?? null,
    };

    this.tokens.set(token.token_id, state);
    return token;
  }

  verify(token: CapabilityToken, ctx: CapabilityContext): boolean {
    const state = this.tokens.get(token.token_id);
    if (!state) return false;

    // Check use_limit
    if (token.use_limit !== 1) return false;

    // Check required fields exist
    if (!token.manifest_hash || !token.token_id || !token.operation_id) return false;

    // Verify integrity hash (detects tampering)
    const expectedHash = this.computeIntegrityHash(token, ctx);
    if (expectedHash !== state.integrity_hash) return false;

    // Verify token hash matches stored hash
    if (token.manifest_hash !== state.token.manifest_hash) return false;

    // Verify context binding
    if (state.context.run_id !== ctx.run_id) return false;
    if (state.context.step_id !== ctx.step_id) return false;
    if (state.context.attempt_id !== ctx.attempt_id) return false;
    if (state.context.tenant_id !== ctx.tenant_id) return false;

    return true;
  }

  consume(token: CapabilityToken, ctx: CapabilityContext): boolean {
    const state = this.tokens.get(token.token_id);
    if (!state) return false;

    // Already used -> replay attempt
    if (state.used) {
      this.replayCount++;
      return false;
    }

    // Revoked
    if (state.revoked) return false;

    // Context must match
    if (state.context.run_id !== ctx.run_id) return false;
    if (state.context.step_id !== ctx.step_id) return false;
    if (state.context.attempt_id !== ctx.attempt_id) return false;
    if (state.context.tenant_id !== ctx.tenant_id) return false;

    // Token must be valid at current time
    const now = ctx.now.getTime();
    const expires = new Date(token.expires_at).getTime();
    if (now > expires) return false;

    const nbf = new Date(token.not_before).getTime();
    if (now < nbf) return false;

    // Verify use_limit
    if (token.use_limit !== 1) return false;

    // Mark as used
    state.used = true;
    return true;
  }

  revoke(tokenId: string): void {
    const state = this.tokens.get(tokenId);
    if (state) {
      state.revoked = true;
    }
  }

  isUsed(tokenId: string): boolean {
    return this.tokens.get(tokenId)?.used ?? false;
  }

  isRevoked(tokenId: string): boolean {
    return this.tokens.get(tokenId)?.revoked ?? false;
  }

  getDelegationDepth(tokenId: string): number {
    return this.tokens.get(tokenId)?.delegation_depth ?? 0;
  }

  get replayAttempts(): number {
    return this.replayCount;
  }

  private computeIntegrityHash(token: CapabilityToken, ctx: CapabilityContext): string {
    const payload = JSON.stringify({
      token_id: token.token_id,
      operation_id: token.operation_id,
      manifest_hash: token.manifest_hash,
      policy_decision_hash: token.policy_decision_hash,
      tool_grant_hash: token.tool_grant_hash,
      resource_grant_hash: token.resource_grant_hash,
      run_id: ctx.run_id,
      step_id: ctx.step_id,
      attempt_id: ctx.attempt_id,
      tenant_id: ctx.tenant_id,
      subject: ctx.subject,
      use_limit: token.use_limit,
    });
    return createHmac('sha256', this.signingKey).update(payload).digest('hex');
  }
}
