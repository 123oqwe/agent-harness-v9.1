/**
 * AH-POLICY-ENGINE-001: Policy Engine V1 with deny-by-default and PEP
 *
 * Implements steps 3-4 of the 12-step Action Control pipeline:
 *   3. Risk derivation: EffectRisk + Policy + Context -> DerivedRiskTier (0-5)
 *   4. Policy evaluation: deny-by-default, only explicit allow permits
 *
 * Key invariants (from action-control.md + trust-boundaries.md):
 *   - PEP cannot be bypassed
 *   - Policy is an immutable constraint, NOT a Router output
 *   - Every action denied unless explicitly allowed by Policy
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// EffectRisk (mirrors spec/contracts/effect-risk.schema.json)
// ---------------------------------------------------------------------------

export type RiskLocality = 'local' | 'remote' | 'external';
export type RiskOperation = 'read' | 'create' | 'write' | 'delete' | 'execute' | 'publish' | 'communicate' | 'purchase';
export type RiskReversibility = 'guaranteed' | 'best_effort' | 'none';
export type RiskDataEgress = 'none' | 'metadata' | 'content' | 'sensitive';
export type RiskHumanImpact = 'none' | 'individual' | 'group' | 'public';
export type RiskExternalVisibility = 'none' | 'visible' | 'notifiable';
export type RiskRegulatorySensitivity = 'none' | 'pii' | 'financial' | 'health' | 'children';

export interface EgressDomainRule {
  action: 'allow' | 'deny';
  host: string;
}

export interface EgressPolicy {
  mode: 'disabled' | 'allowlist' | 'denylist' | 'open';
  domain_rules?: EgressDomainRule[];
  unix_sockets?: 'denied' | 'allowlist';
  allow_local_binding?: boolean;
  socks5?: boolean;
}

export interface EffectRisk {
  locality: RiskLocality;
  operation: RiskOperation;
  reversibility: RiskReversibility;
  data_egress: RiskDataEgress;
  network_access: boolean;
  egress_policy?: EgressPolicy;
  credential_access: boolean;
  blast_radius: 'self' | 'tenant' | 'cross_tenant' | 'global';
  financial_impact_usd_micros: number;
  human_impact: RiskHumanImpact;
  external_visibility: RiskExternalVisibility;
  regulatory_sensitivity: RiskRegulatorySensitivity;
}

// ---------------------------------------------------------------------------
// CapabilityToken (mirrors spec/contracts/capability-token.schema.json)
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

// ---------------------------------------------------------------------------
// Policy types
// ---------------------------------------------------------------------------

export type DerivedRiskTier = 0 | 1 | 2 | 3 | 4 | 5;

export interface PolicyRule {
  tool: string;
  allow: boolean;
  max_tier?: DerivedRiskTier;
  egress_override?: EgressPolicy;
}

export interface Policy {
  rules: PolicyRule[];
  default_decision: 'deny' | 'allow';
}

export interface PolicyContext {
  tenant_id: string;
  user_id: string;
  run_phase: 'setup' | 'agent';
  now: Date;
}

export interface PolicyDecision {
  allowed: boolean;
  reasons: string[];
  derived_risk_tier: DerivedRiskTier;
  egress_policy?: EgressPolicy;
  evaluated_rule?: PolicyRule;
  decided_at: string;
}

// ---------------------------------------------------------------------------
// Audit Log (P1-14): every policy evaluation is recorded for security audit
// ---------------------------------------------------------------------------

export interface AuditLogEntry {
  timestamp: string;
  tool_name: string;
  action_type: RiskOperation;
  verdict: 'allow' | 'deny';
  derived_risk_tier: DerivedRiskTier;
  reasons: string[];
  tenant_id: string;
  user_id: string;
  decided_at: string;
}

// ---------------------------------------------------------------------------
// Risk Tier Derivation (step 3)
// ---------------------------------------------------------------------------

export function deriveRiskTier(
  risk: EffectRisk,
  _policy: Policy,
  _ctx: PolicyContext,
): DerivedRiskTier {
  let score = 0;

  if (risk.locality === 'external') score += 2;
  else if (risk.locality === 'remote') score += 1;

  if (risk.operation === 'delete' || risk.operation === 'purchase') score += 3;
  else if (risk.operation === 'write' || risk.operation === 'execute') score += 2;
  else if (risk.operation === 'publish' || risk.operation === 'communicate') score += 2;
  else if (risk.operation === 'create') score += 1;

  if (risk.reversibility === 'none') score += 3;
  else if (risk.reversibility === 'best_effort') score += 1;

  if (risk.data_egress === 'sensitive') score += 3;
  else if (risk.data_egress === 'content') score += 2;
  else if (risk.data_egress === 'metadata') score += 1;

  if (risk.credential_access) score += 2;

  if (risk.blast_radius === 'global' || risk.blast_radius === 'cross_tenant') score += 3;
  else if (risk.blast_radius === 'tenant') score += 1;

  if (risk.financial_impact_usd_micros >= 1_000_000) score += 3;
  else if (risk.financial_impact_usd_micros >= 10_000) score += 1;

  if (risk.human_impact === 'public') score += 3;
  else if (risk.human_impact === 'group') score += 2;
  else if (risk.human_impact === 'individual') score += 1;

  if (risk.external_visibility === 'notifiable') score += 2;
  else if (risk.external_visibility === 'visible') score += 1;

  if (risk.regulatory_sensitivity === 'children') score += 3;
  else if (risk.regulatory_sensitivity === 'health') score += 2;
  else if (risk.regulatory_sensitivity === 'financial' || risk.regulatory_sensitivity === 'pii') score += 1;

  return Math.min(5, score) as DerivedRiskTier;
}

// ---------------------------------------------------------------------------
// Policy Engine (step 4)
// ---------------------------------------------------------------------------

export class PolicyEngine {
  private readonly policy: Policy;
  private readonly auditLog: AuditLogEntry[] = [];

  constructor(policy: Policy) {
    if (policy.default_decision !== 'deny') {
      throw new Error('PolicyEngine requires default_decision: deny (deny-by-default invariant)');
    }
    this.policy = {
      ...policy,
      rules: [...policy.rules],
    };
  }

 evaluate(toolName: string, risk: EffectRisk, ctx: PolicyContext): PolicyDecision {
   const tier = deriveRiskTier(risk, this.policy, ctx);
   const reasons: string[] = [];

   const rule = this.policy.rules.find(
     (r) => r.tool === toolName || r.tool === '*',
   );

   if (!rule) {
     reasons.push('No policy rule matches tool "' + toolName + '" - deny by default');
      return this.recordAudit(this.deny(tier, reasons, undefined), toolName, risk.operation, ctx);
   }

   if (!rule.allow) {
     reasons.push('Rule for "' + rule.tool + '" explicitly denies');
      return this.recordAudit(this.deny(tier, reasons, rule), toolName, risk.operation, ctx);
   }

   if (rule.max_tier !== undefined && tier > rule.max_tier) {
     reasons.push(
       'Derived risk tier ' + tier + ' exceeds max_tier ' + rule.max_tier + ' for tool "' + toolName + '"',
     );
      return this.recordAudit(this.deny(tier, reasons, rule), toolName, risk.operation, ctx);
   }

   const egress = resolveEgress(risk.egress_policy, rule.egress_override);

   if (risk.network_access && egress && egress.mode === 'disabled') {
     reasons.push('Tool "' + toolName + '" requires network but egress_policy is disabled');
      return this.recordAudit(this.deny(tier, reasons, rule), toolName, risk.operation, ctx);
   }

   reasons.push('Rule for "' + rule.tool + '" allows (tier ' + tier + ' <= ' + (rule.max_tier ?? 5) + ')');
    const decision: PolicyDecision = {
      allowed: true,
      reasons,
      derived_risk_tier: tier,
      egress_policy: egress,
      evaluated_rule: rule,
      decided_at: ctx.now.toISOString(),
    };
    return this.recordAudit(decision, toolName, risk.operation, ctx);
  }

  get rules(): readonly PolicyRule[] {
    return this.policy.rules;
  }

  /** Returns an immutable copy of the audit log (P1-14). */
  getAuditLog(): readonly AuditLogEntry[] {
    return [...this.auditLog];
  }

  private recordAudit(
    decision: PolicyDecision,
    toolName: string,
    actionType: RiskOperation,
    ctx: PolicyContext,
  ): PolicyDecision {
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      tool_name: toolName,
      action_type: actionType,
      verdict: decision.allowed ? 'allow' : 'deny',
      derived_risk_tier: decision.derived_risk_tier,
      reasons: [...decision.reasons],
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
      decided_at: decision.decided_at,
    });
    return decision;
  }

  private deny(
    tier: DerivedRiskTier,
    reasons: string[],
    rule: PolicyRule | undefined,
  ): PolicyDecision {
    return {
      allowed: false,
      reasons,
      derived_risk_tier: tier,
      evaluated_rule: rule,
      decided_at: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Egress resolution: stricter policy wins (FG3)
// ---------------------------------------------------------------------------

export function resolveEgress(
  riskEgress?: EgressPolicy,
  ruleEgress?: EgressPolicy,
): EgressPolicy | undefined {
  if (!riskEgress && !ruleEgress) return undefined;
  if (!riskEgress) return ruleEgress;
  if (!ruleEgress) return riskEgress;

  const modeRank: Record<EgressPolicy['mode'], number> = {
    disabled: 0,
    allowlist: 1,
    denylist: 2,
    open: 3,
  };
  const stricterMode = modeRank[riskEgress.mode] <= modeRank[ruleEgress.mode]
    ? riskEgress.mode
    : ruleEgress.mode;

  const allRules = [
    ...(riskEgress.domain_rules ?? []),
    ...(ruleEgress.domain_rules ?? []),
  ];
  const denyHosts = new Set(
    allRules.filter((r) => r.action === 'deny').map((r) => r.host),
  );
  const allowHosts = new Set(
    allRules.filter((r) => r.action === 'allow').map((r) => r.host),
  );

  const domain_rules: EgressDomainRule[] = [
    ...[...denyHosts].map((host) => ({ action: 'deny' as const, host })),
    ...[...allowHosts].map((host) => ({ action: 'allow' as const, host })),
  ];

  return {
    mode: stricterMode,
    domain_rules,
    unix_sockets: riskEgress.unix_sockets === 'denied' || ruleEgress.unix_sockets === 'denied'
      ? 'denied'
      : 'allowlist',
    allow_local_binding: riskEgress.allow_local_binding === false || ruleEgress.allow_local_binding === false
      ? false
      : (riskEgress.allow_local_binding ?? ruleEgress.allow_local_binding ?? false),
    socks5: riskEgress.socks5 === false || ruleEgress.socks5 === false
      ? false
      : (riskEgress.socks5 ?? ruleEgress.socks5 ?? false),
  };
}

export function isHostAllowed(host: string, egress: EgressPolicy): boolean {
  if (egress.mode === 'disabled') return false;

  const rules = egress.domain_rules ?? [];

  for (const rule of rules) {
    if (rule.action === 'deny' && hostMatches(host, rule.host)) {
      return false;
    }
  }

  if (egress.mode === 'open') return true;
  if (egress.mode === 'denylist') return true;

  for (const rule of rules) {
    if (rule.action === 'allow' && hostMatches(host, rule.host)) {
      return true;
    }
  }
  return false;
}

export function hostMatches(host: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) || host === pattern.slice(2);
  }
  return host === pattern;
}

export function hashDecision(decision: PolicyDecision): string {
  const canonical = JSON.stringify({
    allowed: decision.allowed,
    derived_risk_tier: decision.derived_risk_tier,
    evaluated_rule_tool: decision.evaluated_rule?.tool ?? null,
    decided_at: decision.decided_at,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export { PolicyEngine as PolicyEngineV1 };
