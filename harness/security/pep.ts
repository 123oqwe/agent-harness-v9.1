/**
 * AH-POLICY-ENGINE-001: Policy Enforcement Point (PEP)
 *
 * Implements step 7 of the 12-step Action Control pipeline:
 *   7. PEP validation (verify token valid, not expired, not used)
 *   7b. TOCTOU re-validation (recompute manifest hash, compare to approved hash)
 *
 * Key invariants:
 *   - PEP cannot be bypassed (every action MUST go through validate())
 *   - Logs every decision (allow and deny)
 *   - Enforces egress_policy for network-touching tools (FG3)
 *   - Expired capability rejected
 *   - Used capability rejected (single-use, use_limit=1)
 */

import type {
  PolicyEngine} from './policy-engine.js';
import {
  type CapabilityToken,
  type EgressPolicy,
  type PolicyDecision,
  type PolicyContext,
  type EffectRisk,
  type DerivedRiskTier,
  hashDecision,
  isHostAllowed,
} from './policy-engine.js';

// ---------------------------------------------------------------------------
// PEP types
// ---------------------------------------------------------------------------

export type PepVerdict = 'allow' | 'deny';

export interface PepLogEntry {
  timestamp: string;
  token_id: string;
  tool_name: string;
  verdict: PepVerdict;
  reasons: string[];
  risk_tier: DerivedRiskTier;
  manifest_hash_match: boolean;
  egress_enforced: boolean;
}

export class PepValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PepValidationError';
    Object.setPrototypeOf(this, PepValidationError.prototype);
  }
}

export class ManifestTamperedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestTamperedError';
    Object.setPrototypeOf(this, ManifestTamperedError.prototype);
  }
}

// ---------------------------------------------------------------------------
// PEP
// ---------------------------------------------------------------------------

/**
 * Policy Enforcement Point. Every tool execution MUST pass through validate().
 * The PEP is the single chokepoint — there is no alternative path.
 */
export class PolicyEnforcementPoint {
  private readonly usedTokens = new Set<string>();
  private readonly log: PepLogEntry[] = [];
  private readonly engine: PolicyEngine;

  constructor(engine: PolicyEngine) {
    this.engine = engine;
  }

  /**
   * Validate a capability token before tool dispatch.
   * Throws on any validation failure — the caller MUST NOT execute the tool.
   * Returns the validated decision on success.
   */
  validate(
    token: CapabilityToken,
    toolName: string,
    risk: EffectRisk,
    decision: PolicyDecision,
    ctx: PolicyContext,
    currentManifestHash: string,
  ): PolicyDecision {
    const reasons: string[] = [];

    // 1. Token not already used (single-use, use_limit=1)
    if (this.usedTokens.has(token.token_id)) {
      reasons.push('Capability token already used (use_limit=1)');
      this.logEntry(token, toolName, 'deny', reasons, decision.derived_risk_tier, false, false);
      throw new PepValidationError('Capability token already used');
    }

    // 2. Token not expired
    const now = ctx.now.getTime();
    const expires = new Date(token.expires_at).getTime();
    if (now > expires) {
      reasons.push('Capability token expired');
      this.logEntry(token, toolName, 'deny', reasons, decision.derived_risk_tier, false, false);
      throw new PepValidationError('Capability token expired');
    }

    // 3. Token not before nbf
    const nbf = new Date(token.not_before).getTime();
    if (now < nbf) {
      reasons.push('Capability token not yet valid (not_before in future)');
      this.logEntry(token, toolName, 'deny', reasons, decision.derived_risk_tier, false, false);
      throw new PepValidationError('Capability token not yet valid');
    }

    // 4. use_limit must be 1 (atomic single-use invariant)
    if (token.use_limit !== 1) {
      reasons.push('Capability token use_limit must be 1, got ' + token.use_limit);
      this.logEntry(token, toolName, 'deny', reasons, decision.derived_risk_tier, false, false);
      throw new PepValidationError('Invalid use_limit: must be 1');
    }

    // 5. TOCTOU: manifest hash must match the one captured at approval time
    const hashMatch = token.manifest_hash === currentManifestHash;
    if (!hashMatch) {
      reasons.push('ActionManifest hash mismatch (TOCTOU detected)');
      this.logEntry(token, toolName, 'deny', reasons, decision.derived_risk_tier, false, false);
      throw new ManifestTamperedError('ActionManifest hash mismatch — TOCTOU detected');
    }

    // 6. Policy decision hash must match the engine's current decision
    const expectedHash = hashDecision(decision);
    if (token.policy_decision_hash !== expectedHash) {
      reasons.push('Policy decision hash mismatch — token was issued for a different decision');
      this.logEntry(token, toolName, 'deny', reasons, decision.derived_risk_tier, hashMatch, false);
      throw new PepValidationError('Policy decision hash mismatch');
    }

    // 7. Egress enforcement for network-touching tools (FG3)
    let egressEnforced = false;
    if (risk.network_access && decision.egress_policy) {
      egressEnforced = true;
      // If egress is disabled, deny (should have been caught by policy engine,
      // but PEP double-checks as defense-in-depth)
      if (decision.egress_policy.mode === 'disabled') {
        reasons.push('PEP: egress_policy disabled for network-touching tool');
        this.logEntry(token, toolName, 'deny', reasons, decision.derived_risk_tier, hashMatch, egressEnforced);
        throw new PepValidationError('Egress disabled for network tool');
      }
    }

    // 8. Mark token as used (atomic — before dispatch, not after)
    this.usedTokens.add(token.token_id);

    reasons.push('PEP: all checks passed (valid, not expired, not used, hash match, egress enforced)');
    this.logEntry(token, toolName, 'allow', reasons, decision.derived_risk_tier, hashMatch, egressEnforced);

    return decision;
  }

  /**
   * Check egress for a specific host before a network call.
   * Called by tools that touch the network (FG3 enforcement).
   */
  checkEgress(host: string, egress: EgressPolicy): boolean {
    return isHostAllowed(host, egress);
  }

  /** Is a token already consumed? */
  isUsed(tokenId: string): boolean {
    return this.usedTokens.has(tokenId);
  }

  /** Immutable copy of the decision log. */
  get decisionLog(): readonly PepLogEntry[] {
    return [...this.log];
  }

  get logCount(): number {
    return this.log.length;
  }

  private logEntry(
    token: CapabilityToken,
    toolName: string,
    verdict: PepVerdict,
    reasons: string[],
    riskTier: DerivedRiskTier,
    hashMatch: boolean,
    egressEnforced: boolean,
  ): void {
    this.log.push({
      timestamp: new Date().toISOString(),
      token_id: token.token_id,
      tool_name: toolName,
      verdict,
      reasons,
      risk_tier: riskTier,
      manifest_hash_match: hashMatch,
      egress_enforced: egressEnforced,
    });
  }
}

export { PolicyEnforcementPoint as PEP };
