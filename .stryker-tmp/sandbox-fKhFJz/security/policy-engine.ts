// @ts-nocheck
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import type { EffectRisk } from '../../spec/types/effect-risk.js';
export type DerivedRiskTier = 0 | 1 | 2 | 3 | 4 | 5;
export type EgressPolicy = NonNullable<EffectRisk['egress_policy']>;
export type NormalizedEgressPolicy = Readonly<{
  mode: 'disabled' | 'allowlist' | 'denylist' | 'open';
  domain_rules: readonly Readonly<{
    action: 'allow' | 'deny';
    host: string;
  }>[];
  unix_sockets: 'denied' | 'allowlist';
  allow_local_binding: boolean;
  socks5: boolean;
}>;
export interface PolicyRule {
  id: string;
  priority: number;
  effect: 'allow' | 'deny';
  tools: string[];
  resource_prefixes: string[];
  maximum_risk_tier?: DerivedRiskTier;
  egress_policy?: EgressPolicy;
}
export interface Policy {
  version: string;
  default_decision: 'deny';
  allowed_tools: string[];
  allowed_resource_prefixes: string[];
  rules: PolicyRule[];
  minimum_risk_tier?: DerivedRiskTier;
  egress_policy?: EgressPolicy;
}
export interface PolicyContext {
  tenant_id: string;
  user_id: string;
  run_phase: 'setup' | 'agent';
  trust_level: 'trusted' | 'untrusted' | 'quarantined';
  now: string;
}
export interface PolicyEvaluationRequest {
  tool_name: string;
  resource_ids: string[];
  risk: EffectRisk;
  context: PolicyContext;
}
export interface PolicyDecision {
  readonly allowed: boolean;
  readonly reason_code: 'allowed' | 'default_deny' | 'explicit_deny' | 'tool_not_allowed' | 'resource_not_allowed' | 'risk_tier_exceeded' | 'missing_egress_policy' | 'egress_disabled';
  readonly derived_risk_tier: DerivedRiskTier;
  readonly policy_version: string;
  readonly policy_hash: string;
  readonly decided_at: string;
  readonly matched_rule_id: string | null;
  readonly egress_policy?: NormalizedEgressPolicy;
  readonly decision_hash: string;
}
export interface EgressDecision {
  readonly allowed: boolean;
  readonly reason_code: 'egress_allowed' | 'invalid_destination' | 'host_not_allowed' | 'private_or_local_address' | 'dns_resolution_failed' | 'dns_rebinding' | 'unix_socket_denied' | 'socks5_denied';
  readonly canonical_host?: string;
  readonly resolved_addresses?: readonly string[];
}
export class PolicyConfigurationError extends Error {
  constructor(message: string) {
    if (stryMutAct_9fa48("3255")) {
      {}
    } else {
      stryCov_9fa48("3255");
      super(message);
      this.name = stryMutAct_9fa48("3256") ? "" : (stryCov_9fa48("3256"), 'PolicyConfigurationError');
    }
  }
}
export class PolicyInputError extends Error {
  constructor(message: string) {
    if (stryMutAct_9fa48("3257")) {
      {}
    } else {
      stryCov_9fa48("3257");
      super(message);
      this.name = stryMutAct_9fa48("3258") ? "" : (stryCov_9fa48("3258"), 'PolicyInputError');
    }
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (stryMutAct_9fa48("3259")) {
    {}
  } else {
    stryCov_9fa48("3259");
    return stryMutAct_9fa48("3262") ? typeof value === 'object' && value !== null || !Array.isArray(value) : stryMutAct_9fa48("3261") ? false : stryMutAct_9fa48("3260") ? true : (stryCov_9fa48("3260", "3261", "3262"), (stryMutAct_9fa48("3264") ? typeof value === 'object' || value !== null : stryMutAct_9fa48("3263") ? true : (stryCov_9fa48("3263", "3264"), (stryMutAct_9fa48("3266") ? typeof value !== 'object' : stryMutAct_9fa48("3265") ? true : (stryCov_9fa48("3265", "3266"), typeof value === (stryMutAct_9fa48("3267") ? "" : (stryCov_9fa48("3267"), 'object')))) && (stryMutAct_9fa48("3269") ? value === null : stryMutAct_9fa48("3268") ? true : (stryCov_9fa48("3268", "3269"), value !== null)))) && (stryMutAct_9fa48("3270") ? Array.isArray(value) : (stryCov_9fa48("3270"), !Array.isArray(value))));
  }
}
function canonicalize(value: unknown): unknown {
  if (stryMutAct_9fa48("3271")) {
    {}
  } else {
    stryCov_9fa48("3271");
    if (stryMutAct_9fa48("3273") ? false : stryMutAct_9fa48("3272") ? true : (stryCov_9fa48("3272", "3273"), Array.isArray(value))) return value.map(canonicalize);
    if (stryMutAct_9fa48("3276") ? false : stryMutAct_9fa48("3275") ? true : stryMutAct_9fa48("3274") ? isRecord(value) : (stryCov_9fa48("3274", "3275", "3276"), !isRecord(value))) return value;
    return Object.fromEntries(stryMutAct_9fa48("3277") ? Object.keys(value).map(key => [key, canonicalize(value[key])]) : (stryCov_9fa48("3277"), Object.keys(value).sort().map(stryMutAct_9fa48("3278") ? () => undefined : (stryCov_9fa48("3278"), key => stryMutAct_9fa48("3279") ? [] : (stryCov_9fa48("3279"), [key, canonicalize(value[key])])))));
  }
}
function hashValue(value: unknown): string {
  if (stryMutAct_9fa48("3280")) {
    {}
  } else {
    stryCov_9fa48("3280");
    return createHash(stryMutAct_9fa48("3281") ? "" : (stryCov_9fa48("3281"), 'sha256')).update(JSON.stringify(canonicalize(value))).digest(stryMutAct_9fa48("3282") ? "" : (stryCov_9fa48("3282"), 'hex'));
  }
}
function deepFreeze<T>(value: T): T {
  if (stryMutAct_9fa48("3283")) {
    {}
  } else {
    stryCov_9fa48("3283");
    if (stryMutAct_9fa48("3286") ? typeof value !== 'object' && typeof value !== 'function' && value === null : stryMutAct_9fa48("3285") ? false : stryMutAct_9fa48("3284") ? true : (stryCov_9fa48("3284", "3285", "3286"), (stryMutAct_9fa48("3288") ? typeof value !== 'object' || typeof value !== 'function' : stryMutAct_9fa48("3287") ? false : (stryCov_9fa48("3287", "3288"), (stryMutAct_9fa48("3290") ? typeof value === 'object' : stryMutAct_9fa48("3289") ? true : (stryCov_9fa48("3289", "3290"), typeof value !== (stryMutAct_9fa48("3291") ? "" : (stryCov_9fa48("3291"), 'object')))) && (stryMutAct_9fa48("3293") ? typeof value === 'function' : stryMutAct_9fa48("3292") ? true : (stryCov_9fa48("3292", "3293"), typeof value !== (stryMutAct_9fa48("3294") ? "" : (stryCov_9fa48("3294"), 'function')))))) || (stryMutAct_9fa48("3296") ? value !== null : stryMutAct_9fa48("3295") ? false : (stryCov_9fa48("3295", "3296"), value === null)))) return value;
    if (stryMutAct_9fa48("3298") ? false : stryMutAct_9fa48("3297") ? true : (stryCov_9fa48("3297", "3298"), Object.isFrozen(value))) return value;
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value);
  }
}
function clone<T>(value: T): T {
  if (stryMutAct_9fa48("3299")) {
    {}
  } else {
    stryCov_9fa48("3299");
    return structuredClone(value);
  }
}
function requireNonEmpty(value: unknown, label: string): asserts value is string {
  if (stryMutAct_9fa48("3300")) {
    {}
  } else {
    stryCov_9fa48("3300");
    if (stryMutAct_9fa48("3303") ? typeof value !== 'string' && value.trim().length === 0 : stryMutAct_9fa48("3302") ? false : stryMutAct_9fa48("3301") ? true : (stryCov_9fa48("3301", "3302", "3303"), (stryMutAct_9fa48("3305") ? typeof value === 'string' : stryMutAct_9fa48("3304") ? false : (stryCov_9fa48("3304", "3305"), typeof value !== (stryMutAct_9fa48("3306") ? "" : (stryCov_9fa48("3306"), 'string')))) || (stryMutAct_9fa48("3308") ? value.trim().length !== 0 : stryMutAct_9fa48("3307") ? false : (stryCov_9fa48("3307", "3308"), (stryMutAct_9fa48("3309") ? value.length : (stryCov_9fa48("3309"), value.trim().length)) === 0)))) {
      if (stryMutAct_9fa48("3310")) {
        {}
      } else {
        stryCov_9fa48("3310");
        throw new PolicyConfigurationError(stryMutAct_9fa48("3311") ? `` : (stryCov_9fa48("3311"), `${label} must be a non-empty string`));
      }
    }
  }
}
function validateUniqueStrings(value: unknown, label: string): asserts value is string[] {
  if (stryMutAct_9fa48("3312")) {
    {}
  } else {
    stryCov_9fa48("3312");
    if (stryMutAct_9fa48("3315") ? !Array.isArray(value) && value.length === 0 : stryMutAct_9fa48("3314") ? false : stryMutAct_9fa48("3313") ? true : (stryCov_9fa48("3313", "3314", "3315"), (stryMutAct_9fa48("3316") ? Array.isArray(value) : (stryCov_9fa48("3316"), !Array.isArray(value))) || (stryMutAct_9fa48("3318") ? value.length !== 0 : stryMutAct_9fa48("3317") ? false : (stryCov_9fa48("3317", "3318"), value.length === 0)))) {
      if (stryMutAct_9fa48("3319")) {
        {}
      } else {
        stryCov_9fa48("3319");
        throw new PolicyConfigurationError(stryMutAct_9fa48("3320") ? `` : (stryCov_9fa48("3320"), `${label} must be a non-empty array`));
      }
    }
    for (const entry of value) requireNonEmpty(entry, stryMutAct_9fa48("3321") ? `` : (stryCov_9fa48("3321"), `${label} entry`));
    if (stryMutAct_9fa48("3324") ? new Set(value).size === value.length : stryMutAct_9fa48("3323") ? false : stryMutAct_9fa48("3322") ? true : (stryCov_9fa48("3322", "3323", "3324"), new Set(value).size !== value.length)) {
      if (stryMutAct_9fa48("3325")) {
        {}
      } else {
        stryCov_9fa48("3325");
        throw new PolicyConfigurationError(stryMutAct_9fa48("3326") ? `` : (stryCov_9fa48("3326"), `${label} must not contain duplicates`));
      }
    }
  }
}
function isTier(value: unknown): value is DerivedRiskTier {
  if (stryMutAct_9fa48("3327")) {
    {}
  } else {
    stryCov_9fa48("3327");
    return stryMutAct_9fa48("3330") ? Number.isInteger(value) && Number(value) >= 0 || Number(value) <= 5 : stryMutAct_9fa48("3329") ? false : stryMutAct_9fa48("3328") ? true : (stryCov_9fa48("3328", "3329", "3330"), (stryMutAct_9fa48("3332") ? Number.isInteger(value) || Number(value) >= 0 : stryMutAct_9fa48("3331") ? true : (stryCov_9fa48("3331", "3332"), Number.isInteger(value) && (stryMutAct_9fa48("3335") ? Number(value) < 0 : stryMutAct_9fa48("3334") ? Number(value) > 0 : stryMutAct_9fa48("3333") ? true : (stryCov_9fa48("3333", "3334", "3335"), Number(value) >= 0)))) && (stryMutAct_9fa48("3338") ? Number(value) > 5 : stryMutAct_9fa48("3337") ? Number(value) < 5 : stryMutAct_9fa48("3336") ? true : (stryCov_9fa48("3336", "3337", "3338"), Number(value) <= 5)));
  }
}
function validatePolicy(policy: Policy): void {
  if (stryMutAct_9fa48("3339")) {
    {}
  } else {
    stryCov_9fa48("3339");
    if (stryMutAct_9fa48("3342") ? false : stryMutAct_9fa48("3341") ? true : stryMutAct_9fa48("3340") ? isRecord(policy) : (stryCov_9fa48("3340", "3341", "3342"), !isRecord(policy))) throw new PolicyConfigurationError(stryMutAct_9fa48("3343") ? "" : (stryCov_9fa48("3343"), 'policy must be an object'));
    requireNonEmpty(policy.version, stryMutAct_9fa48("3344") ? "" : (stryCov_9fa48("3344"), 'policy.version'));
    if (stryMutAct_9fa48("3347") ? policy.default_decision === 'deny' : stryMutAct_9fa48("3346") ? false : stryMutAct_9fa48("3345") ? true : (stryCov_9fa48("3345", "3346", "3347"), policy.default_decision !== (stryMutAct_9fa48("3348") ? "" : (stryCov_9fa48("3348"), 'deny')))) {
      if (stryMutAct_9fa48("3349")) {
        {}
      } else {
        stryCov_9fa48("3349");
        throw new PolicyConfigurationError(stryMutAct_9fa48("3350") ? "" : (stryCov_9fa48("3350"), 'policy must enforce deny-by-default'));
      }
    }
    validateUniqueStrings(policy.allowed_tools, stryMutAct_9fa48("3351") ? "" : (stryCov_9fa48("3351"), 'policy.allowed_tools'));
    validateUniqueStrings(policy.allowed_resource_prefixes, stryMutAct_9fa48("3352") ? "" : (stryCov_9fa48("3352"), 'policy.allowed_resource_prefixes'));
    if (stryMutAct_9fa48("3355") ? false : stryMutAct_9fa48("3354") ? true : stryMutAct_9fa48("3353") ? Array.isArray(policy.rules) : (stryCov_9fa48("3353", "3354", "3355"), !Array.isArray(policy.rules))) throw new PolicyConfigurationError(stryMutAct_9fa48("3356") ? "" : (stryCov_9fa48("3356"), 'policy.rules must be an array'));
    if (stryMutAct_9fa48("3359") ? policy.minimum_risk_tier !== undefined || !isTier(policy.minimum_risk_tier) : stryMutAct_9fa48("3358") ? false : stryMutAct_9fa48("3357") ? true : (stryCov_9fa48("3357", "3358", "3359"), (stryMutAct_9fa48("3361") ? policy.minimum_risk_tier === undefined : stryMutAct_9fa48("3360") ? true : (stryCov_9fa48("3360", "3361"), policy.minimum_risk_tier !== undefined)) && (stryMutAct_9fa48("3362") ? isTier(policy.minimum_risk_tier) : (stryCov_9fa48("3362"), !isTier(policy.minimum_risk_tier))))) {
      if (stryMutAct_9fa48("3363")) {
        {}
      } else {
        stryCov_9fa48("3363");
        throw new PolicyConfigurationError(stryMutAct_9fa48("3364") ? "" : (stryCov_9fa48("3364"), 'policy.minimum_risk_tier must be between 0 and 5'));
      }
    }
    const identifiers = new Set<string>();
    for (const rule of policy.rules) {
      if (stryMutAct_9fa48("3365")) {
        {}
      } else {
        stryCov_9fa48("3365");
        if (stryMutAct_9fa48("3368") ? false : stryMutAct_9fa48("3367") ? true : stryMutAct_9fa48("3366") ? isRecord(rule) : (stryCov_9fa48("3366", "3367", "3368"), !isRecord(rule))) throw new PolicyConfigurationError(stryMutAct_9fa48("3369") ? "" : (stryCov_9fa48("3369"), 'policy rule must be an object'));
        requireNonEmpty(rule.id, stryMutAct_9fa48("3370") ? "" : (stryCov_9fa48("3370"), 'policy rule id'));
        if (stryMutAct_9fa48("3372") ? false : stryMutAct_9fa48("3371") ? true : (stryCov_9fa48("3371", "3372"), identifiers.has(rule.id))) throw new PolicyConfigurationError(stryMutAct_9fa48("3373") ? "" : (stryCov_9fa48("3373"), 'policy rule ids must be unique'));
        identifiers.add(rule.id);
        if (stryMutAct_9fa48("3376") ? false : stryMutAct_9fa48("3375") ? true : stryMutAct_9fa48("3374") ? Number.isSafeInteger(rule.priority) : (stryCov_9fa48("3374", "3375", "3376"), !Number.isSafeInteger(rule.priority))) {
          if (stryMutAct_9fa48("3377")) {
            {}
          } else {
            stryCov_9fa48("3377");
            throw new PolicyConfigurationError(stryMutAct_9fa48("3378") ? "" : (stryCov_9fa48("3378"), 'policy rule priority must be a safe integer'));
          }
        }
        if (stryMutAct_9fa48("3381") ? rule.effect !== 'allow' || rule.effect !== 'deny' : stryMutAct_9fa48("3380") ? false : stryMutAct_9fa48("3379") ? true : (stryCov_9fa48("3379", "3380", "3381"), (stryMutAct_9fa48("3383") ? rule.effect === 'allow' : stryMutAct_9fa48("3382") ? true : (stryCov_9fa48("3382", "3383"), rule.effect !== (stryMutAct_9fa48("3384") ? "" : (stryCov_9fa48("3384"), 'allow')))) && (stryMutAct_9fa48("3386") ? rule.effect === 'deny' : stryMutAct_9fa48("3385") ? true : (stryCov_9fa48("3385", "3386"), rule.effect !== (stryMutAct_9fa48("3387") ? "" : (stryCov_9fa48("3387"), 'deny')))))) {
          if (stryMutAct_9fa48("3388")) {
            {}
          } else {
            stryCov_9fa48("3388");
            throw new PolicyConfigurationError(stryMutAct_9fa48("3389") ? "" : (stryCov_9fa48("3389"), 'policy rule effect must be allow or deny'));
          }
        }
        validateUniqueStrings(rule.tools, stryMutAct_9fa48("3390") ? "" : (stryCov_9fa48("3390"), 'policy rule tools'));
        validateUniqueStrings(rule.resource_prefixes, stryMutAct_9fa48("3391") ? "" : (stryCov_9fa48("3391"), 'policy rule resource_prefixes'));
        if (stryMutAct_9fa48("3394") ? rule.maximum_risk_tier !== undefined || !isTier(rule.maximum_risk_tier) : stryMutAct_9fa48("3393") ? false : stryMutAct_9fa48("3392") ? true : (stryCov_9fa48("3392", "3393", "3394"), (stryMutAct_9fa48("3396") ? rule.maximum_risk_tier === undefined : stryMutAct_9fa48("3395") ? true : (stryCov_9fa48("3395", "3396"), rule.maximum_risk_tier !== undefined)) && (stryMutAct_9fa48("3397") ? isTier(rule.maximum_risk_tier) : (stryCov_9fa48("3397"), !isTier(rule.maximum_risk_tier))))) {
          if (stryMutAct_9fa48("3398")) {
            {}
          } else {
            stryCov_9fa48("3398");
            throw new PolicyConfigurationError(stryMutAct_9fa48("3399") ? "" : (stryCov_9fa48("3399"), 'policy rule maximum_risk_tier must be between 0 and 5'));
          }
        }
        if (stryMutAct_9fa48("3402") ? rule.egress_policy === undefined : stryMutAct_9fa48("3401") ? false : stryMutAct_9fa48("3400") ? true : (stryCov_9fa48("3400", "3401", "3402"), rule.egress_policy !== undefined)) normalizeEgress(rule.egress_policy);
      }
    }
    if (stryMutAct_9fa48("3405") ? policy.egress_policy === undefined : stryMutAct_9fa48("3404") ? false : stryMutAct_9fa48("3403") ? true : (stryCov_9fa48("3403", "3404", "3405"), policy.egress_policy !== undefined)) normalizeEgress(policy.egress_policy);
  }
}
function validateContext(context: PolicyContext): void {
  if (stryMutAct_9fa48("3406")) {
    {}
  } else {
    stryCov_9fa48("3406");
    if (stryMutAct_9fa48("3409") ? false : stryMutAct_9fa48("3408") ? true : stryMutAct_9fa48("3407") ? isRecord(context) : (stryCov_9fa48("3407", "3408", "3409"), !isRecord(context))) throw new PolicyInputError(stryMutAct_9fa48("3410") ? "" : (stryCov_9fa48("3410"), 'context must be an object'));
    if (stryMutAct_9fa48("3413") ? false : stryMutAct_9fa48("3412") ? true : stryMutAct_9fa48("3411") ? ['setup', 'agent'].includes(context.run_phase) : (stryCov_9fa48("3411", "3412", "3413"), !(stryMutAct_9fa48("3414") ? [] : (stryCov_9fa48("3414"), [stryMutAct_9fa48("3415") ? "" : (stryCov_9fa48("3415"), 'setup'), stryMutAct_9fa48("3416") ? "" : (stryCov_9fa48("3416"), 'agent')])).includes(context.run_phase))) throw new PolicyInputError(stryMutAct_9fa48("3417") ? "" : (stryCov_9fa48("3417"), 'invalid run phase'));
    if (stryMutAct_9fa48("3420") ? false : stryMutAct_9fa48("3419") ? true : stryMutAct_9fa48("3418") ? ['trusted', 'untrusted', 'quarantined'].includes(context.trust_level) : (stryCov_9fa48("3418", "3419", "3420"), !(stryMutAct_9fa48("3421") ? [] : (stryCov_9fa48("3421"), [stryMutAct_9fa48("3422") ? "" : (stryCov_9fa48("3422"), 'trusted'), stryMutAct_9fa48("3423") ? "" : (stryCov_9fa48("3423"), 'untrusted'), stryMutAct_9fa48("3424") ? "" : (stryCov_9fa48("3424"), 'quarantined')])).includes(context.trust_level))) {
      if (stryMutAct_9fa48("3425")) {
        {}
      } else {
        stryCov_9fa48("3425");
        throw new PolicyInputError(stryMutAct_9fa48("3426") ? "" : (stryCov_9fa48("3426"), 'invalid trust level'));
      }
    }
    if (stryMutAct_9fa48("3429") ? false : stryMutAct_9fa48("3428") ? true : stryMutAct_9fa48("3427") ? isStrictDateTime(context.now) : (stryCov_9fa48("3427", "3428", "3429"), !isStrictDateTime(context.now))) throw new PolicyInputError(stryMutAct_9fa48("3430") ? "" : (stryCov_9fa48("3430"), 'context.now must be an ISO date-time'));
    if (stryMutAct_9fa48("3433") ? context.tenant_id.length === 0 && context.user_id.length === 0 : stryMutAct_9fa48("3432") ? false : stryMutAct_9fa48("3431") ? true : (stryCov_9fa48("3431", "3432", "3433"), (stryMutAct_9fa48("3435") ? context.tenant_id.length !== 0 : stryMutAct_9fa48("3434") ? false : (stryCov_9fa48("3434", "3435"), context.tenant_id.length === 0)) || (stryMutAct_9fa48("3437") ? context.user_id.length !== 0 : stryMutAct_9fa48("3436") ? false : (stryCov_9fa48("3436", "3437"), context.user_id.length === 0)))) {
      if (stryMutAct_9fa48("3438")) {
        {}
      } else {
        stryCov_9fa48("3438");
        throw new PolicyInputError(stryMutAct_9fa48("3439") ? "" : (stryCov_9fa48("3439"), 'context identity is required'));
      }
    }
  }
}
export function isStrictDateTime(value: unknown): value is string {
  if (stryMutAct_9fa48("3440")) {
    {}
  } else {
    stryCov_9fa48("3440");
    if (stryMutAct_9fa48("3443") ? typeof value === 'string' : stryMutAct_9fa48("3442") ? false : stryMutAct_9fa48("3441") ? true : (stryCov_9fa48("3441", "3442", "3443"), typeof value !== (stryMutAct_9fa48("3444") ? "" : (stryCov_9fa48("3444"), 'string')))) return stryMutAct_9fa48("3445") ? true : (stryCov_9fa48("3445"), false);
    const match = (stryMutAct_9fa48("3462") ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\D{3})?Z)$/u : stryMutAct_9fa48("3461") ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d)?Z)$/u : stryMutAct_9fa48("3460") ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})Z)$/u : stryMutAct_9fa48("3459") ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\D{2}(?:\.\d{3})?Z)$/u : stryMutAct_9fa48("3458") ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d(?:\.\d{3})?Z)$/u : stryMutAct_9fa48("3457") ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\D{2}:\d{2}(?:\.\d{3})?Z)$/u : stryMutAct_9fa48("3456") ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d:\d{2}(?:\.\d{3})?Z)$/u : stryMutAct_9fa48("3455") ? /^(\d{4}-\d{2}-\d{2}T\D{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/u : stryMutAct_9fa48("3454") ? /^(\d{4}-\d{2}-\d{2}T\d:\d{2}:\d{2}(?:\.\d{3})?Z)$/u : stryMutAct_9fa48("3453") ? /^(\d{4}-\d{2}-\D{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/u : stryMutAct_9fa48("3452") ? /^(\d{4}-\d{2}-\dT\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/u : stryMutAct_9fa48("3451") ? /^(\d{4}-\D{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/u : stryMutAct_9fa48("3450") ? /^(\d{4}-\d-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/u : stryMutAct_9fa48("3449") ? /^(\D{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/u : stryMutAct_9fa48("3448") ? /^(\d-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/u : stryMutAct_9fa48("3447") ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)/u : stryMutAct_9fa48("3446") ? /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/u : (stryCov_9fa48("3446", "3447", "3448", "3449", "3450", "3451", "3452", "3453", "3454", "3455", "3456", "3457", "3458", "3459", "3460", "3461", "3462"), /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/u)).test(value);
    return stryMutAct_9fa48("3465") ? match || Number.isFinite(Date.parse(value)) : stryMutAct_9fa48("3464") ? false : stryMutAct_9fa48("3463") ? true : (stryCov_9fa48("3463", "3464", "3465"), match && Number.isFinite(Date.parse(value)));
  }
}
function parseFinancialImpact(value: string): bigint {
  if (stryMutAct_9fa48("3466")) {
    {}
  } else {
    stryCov_9fa48("3466");
    if (stryMutAct_9fa48("3469") ? false : stryMutAct_9fa48("3468") ? true : stryMutAct_9fa48("3467") ? /^(?:0|[1-9]\d*)$/u.test(value) : (stryCov_9fa48("3467", "3468", "3469"), !(stryMutAct_9fa48("3474") ? /^(?:0|[1-9]\D*)$/u : stryMutAct_9fa48("3473") ? /^(?:0|[1-9]\d)$/u : stryMutAct_9fa48("3472") ? /^(?:0|[^1-9]\d*)$/u : stryMutAct_9fa48("3471") ? /^(?:0|[1-9]\d*)/u : stryMutAct_9fa48("3470") ? /(?:0|[1-9]\d*)$/u : (stryCov_9fa48("3470", "3471", "3472", "3473", "3474"), /^(?:0|[1-9]\d*)$/u)).test(value))) {
      if (stryMutAct_9fa48("3475")) {
        {}
      } else {
        stryCov_9fa48("3475");
        throw new PolicyInputError(stryMutAct_9fa48("3476") ? "" : (stryCov_9fa48("3476"), 'financial impact must be a non-negative decimal integer string'));
      }
    }
    return BigInt(value);
  }
}
function validateEffectRisk(risk: EffectRisk): void {
  if (stryMutAct_9fa48("3477")) {
    {}
  } else {
    stryCov_9fa48("3477");
    if (stryMutAct_9fa48("3480") ? false : stryMutAct_9fa48("3479") ? true : stryMutAct_9fa48("3478") ? isRecord(risk) : (stryCov_9fa48("3478", "3479", "3480"), !isRecord(risk))) throw new PolicyInputError(stryMutAct_9fa48("3481") ? "" : (stryCov_9fa48("3481"), 'EffectRisk must be an object'));
    const knownKeys = new Set(stryMutAct_9fa48("3482") ? [] : (stryCov_9fa48("3482"), [stryMutAct_9fa48("3483") ? "" : (stryCov_9fa48("3483"), 'locality'), stryMutAct_9fa48("3484") ? "" : (stryCov_9fa48("3484"), 'operation'), stryMutAct_9fa48("3485") ? "" : (stryCov_9fa48("3485"), 'reversibility'), stryMutAct_9fa48("3486") ? "" : (stryCov_9fa48("3486"), 'data_egress'), stryMutAct_9fa48("3487") ? "" : (stryCov_9fa48("3487"), 'network_access'), stryMutAct_9fa48("3488") ? "" : (stryCov_9fa48("3488"), 'egress_policy'), stryMutAct_9fa48("3489") ? "" : (stryCov_9fa48("3489"), 'screen_access'), stryMutAct_9fa48("3490") ? "" : (stryCov_9fa48("3490"), 'credential_access'), stryMutAct_9fa48("3491") ? "" : (stryCov_9fa48("3491"), 'blast_radius'), stryMutAct_9fa48("3492") ? "" : (stryCov_9fa48("3492"), 'financial_impact_usd_micros'), stryMutAct_9fa48("3493") ? "" : (stryCov_9fa48("3493"), 'human_impact'), stryMutAct_9fa48("3494") ? "" : (stryCov_9fa48("3494"), 'external_visibility'), stryMutAct_9fa48("3495") ? "" : (stryCov_9fa48("3495"), 'regulatory_sensitivity')]));
    if (stryMutAct_9fa48("3498") ? Object.keys(risk).every(key => !knownKeys.has(key)) : stryMutAct_9fa48("3497") ? false : stryMutAct_9fa48("3496") ? true : (stryCov_9fa48("3496", "3497", "3498"), Object.keys(risk).some(stryMutAct_9fa48("3499") ? () => undefined : (stryCov_9fa48("3499"), key => stryMutAct_9fa48("3500") ? knownKeys.has(key) : (stryCov_9fa48("3500"), !knownKeys.has(key)))))) {
      if (stryMutAct_9fa48("3501")) {
        {}
      } else {
        stryCov_9fa48("3501");
        throw new PolicyInputError(stryMutAct_9fa48("3502") ? "" : (stryCov_9fa48("3502"), 'EffectRisk contains an unknown field'));
      }
    }
    const enumChecks: Array<[unknown, readonly string[], string]> = stryMutAct_9fa48("3503") ? [] : (stryCov_9fa48("3503"), [stryMutAct_9fa48("3504") ? [] : (stryCov_9fa48("3504"), [risk.locality, stryMutAct_9fa48("3505") ? [] : (stryCov_9fa48("3505"), [stryMutAct_9fa48("3506") ? "" : (stryCov_9fa48("3506"), 'local'), stryMutAct_9fa48("3507") ? "" : (stryCov_9fa48("3507"), 'remote'), stryMutAct_9fa48("3508") ? "" : (stryCov_9fa48("3508"), 'external')]), stryMutAct_9fa48("3509") ? "" : (stryCov_9fa48("3509"), 'locality')]), stryMutAct_9fa48("3510") ? [] : (stryCov_9fa48("3510"), [risk.operation, stryMutAct_9fa48("3511") ? [] : (stryCov_9fa48("3511"), [stryMutAct_9fa48("3512") ? "" : (stryCov_9fa48("3512"), 'read'), stryMutAct_9fa48("3513") ? "" : (stryCov_9fa48("3513"), 'create'), stryMutAct_9fa48("3514") ? "" : (stryCov_9fa48("3514"), 'write'), stryMutAct_9fa48("3515") ? "" : (stryCov_9fa48("3515"), 'delete'), stryMutAct_9fa48("3516") ? "" : (stryCov_9fa48("3516"), 'execute'), stryMutAct_9fa48("3517") ? "" : (stryCov_9fa48("3517"), 'publish'), stryMutAct_9fa48("3518") ? "" : (stryCov_9fa48("3518"), 'communicate'), stryMutAct_9fa48("3519") ? "" : (stryCov_9fa48("3519"), 'purchase')]), stryMutAct_9fa48("3520") ? "" : (stryCov_9fa48("3520"), 'operation')]), stryMutAct_9fa48("3521") ? [] : (stryCov_9fa48("3521"), [risk.reversibility, stryMutAct_9fa48("3522") ? [] : (stryCov_9fa48("3522"), [stryMutAct_9fa48("3523") ? "" : (stryCov_9fa48("3523"), 'guaranteed'), stryMutAct_9fa48("3524") ? "" : (stryCov_9fa48("3524"), 'best_effort'), stryMutAct_9fa48("3525") ? "" : (stryCov_9fa48("3525"), 'none')]), stryMutAct_9fa48("3526") ? "" : (stryCov_9fa48("3526"), 'reversibility')]), stryMutAct_9fa48("3527") ? [] : (stryCov_9fa48("3527"), [risk.data_egress, stryMutAct_9fa48("3528") ? [] : (stryCov_9fa48("3528"), [stryMutAct_9fa48("3529") ? "" : (stryCov_9fa48("3529"), 'none'), stryMutAct_9fa48("3530") ? "" : (stryCov_9fa48("3530"), 'metadata'), stryMutAct_9fa48("3531") ? "" : (stryCov_9fa48("3531"), 'content'), stryMutAct_9fa48("3532") ? "" : (stryCov_9fa48("3532"), 'sensitive')]), stryMutAct_9fa48("3533") ? "" : (stryCov_9fa48("3533"), 'data_egress')]), stryMutAct_9fa48("3534") ? [] : (stryCov_9fa48("3534"), [risk.blast_radius, stryMutAct_9fa48("3535") ? [] : (stryCov_9fa48("3535"), [stryMutAct_9fa48("3536") ? "" : (stryCov_9fa48("3536"), 'single_resource'), stryMutAct_9fa48("3537") ? "" : (stryCov_9fa48("3537"), 'bounded_set'), stryMutAct_9fa48("3538") ? "" : (stryCov_9fa48("3538"), 'workspace'), stryMutAct_9fa48("3539") ? "" : (stryCov_9fa48("3539"), 'organization'), stryMutAct_9fa48("3540") ? "" : (stryCov_9fa48("3540"), 'public'), stryMutAct_9fa48("3541") ? "" : (stryCov_9fa48("3541"), 'unbounded')]), stryMutAct_9fa48("3542") ? "" : (stryCov_9fa48("3542"), 'blast_radius')]), stryMutAct_9fa48("3543") ? [] : (stryCov_9fa48("3543"), [risk.human_impact, stryMutAct_9fa48("3544") ? [] : (stryCov_9fa48("3544"), [stryMutAct_9fa48("3545") ? "" : (stryCov_9fa48("3545"), 'none'), stryMutAct_9fa48("3546") ? "" : (stryCov_9fa48("3546"), 'self'), stryMutAct_9fa48("3547") ? "" : (stryCov_9fa48("3547"), 'internal_people'), stryMutAct_9fa48("3548") ? "" : (stryCov_9fa48("3548"), 'external_people'), stryMutAct_9fa48("3549") ? "" : (stryCov_9fa48("3549"), 'public')]), stryMutAct_9fa48("3550") ? "" : (stryCov_9fa48("3550"), 'human_impact')]), stryMutAct_9fa48("3551") ? [] : (stryCov_9fa48("3551"), [risk.external_visibility, stryMutAct_9fa48("3552") ? [] : (stryCov_9fa48("3552"), [stryMutAct_9fa48("3553") ? "" : (stryCov_9fa48("3553"), 'private'), stryMutAct_9fa48("3554") ? "" : (stryCov_9fa48("3554"), 'shared'), stryMutAct_9fa48("3555") ? "" : (stryCov_9fa48("3555"), 'public')]), stryMutAct_9fa48("3556") ? "" : (stryCov_9fa48("3556"), 'external_visibility')])]);
    for (const [value, allowed, label] of enumChecks) {
      if (stryMutAct_9fa48("3557")) {
        {}
      } else {
        stryCov_9fa48("3557");
        if (stryMutAct_9fa48("3560") ? typeof value !== 'string' && !allowed.includes(value) : stryMutAct_9fa48("3559") ? false : stryMutAct_9fa48("3558") ? true : (stryCov_9fa48("3558", "3559", "3560"), (stryMutAct_9fa48("3562") ? typeof value === 'string' : stryMutAct_9fa48("3561") ? false : (stryCov_9fa48("3561", "3562"), typeof value !== (stryMutAct_9fa48("3563") ? "" : (stryCov_9fa48("3563"), 'string')))) || (stryMutAct_9fa48("3564") ? allowed.includes(value) : (stryCov_9fa48("3564"), !allowed.includes(value))))) {
          if (stryMutAct_9fa48("3565")) {
            {}
          } else {
            stryCov_9fa48("3565");
            throw new PolicyInputError(stryMutAct_9fa48("3566") ? `` : (stryCov_9fa48("3566"), `EffectRisk.${label} is invalid`));
          }
        }
      }
    }
    if (stryMutAct_9fa48("3569") ? typeof risk.network_access !== 'boolean' && typeof risk.credential_access !== 'boolean' : stryMutAct_9fa48("3568") ? false : stryMutAct_9fa48("3567") ? true : (stryCov_9fa48("3567", "3568", "3569"), (stryMutAct_9fa48("3571") ? typeof risk.network_access === 'boolean' : stryMutAct_9fa48("3570") ? false : (stryCov_9fa48("3570", "3571"), typeof risk.network_access !== (stryMutAct_9fa48("3572") ? "" : (stryCov_9fa48("3572"), 'boolean')))) || (stryMutAct_9fa48("3574") ? typeof risk.credential_access === 'boolean' : stryMutAct_9fa48("3573") ? false : (stryCov_9fa48("3573", "3574"), typeof risk.credential_access !== (stryMutAct_9fa48("3575") ? "" : (stryCov_9fa48("3575"), 'boolean')))))) {
      if (stryMutAct_9fa48("3576")) {
        {}
      } else {
        stryCov_9fa48("3576");
        throw new PolicyInputError(stryMutAct_9fa48("3577") ? "" : (stryCov_9fa48("3577"), 'EffectRisk access flags must be boolean'));
      }
    }
    if (stryMutAct_9fa48("3580") ? !Array.isArray(risk.regulatory_sensitivity) && risk.regulatory_sensitivity.some(entry => typeof entry !== 'string') : stryMutAct_9fa48("3579") ? false : stryMutAct_9fa48("3578") ? true : (stryCov_9fa48("3578", "3579", "3580"), (stryMutAct_9fa48("3581") ? Array.isArray(risk.regulatory_sensitivity) : (stryCov_9fa48("3581"), !Array.isArray(risk.regulatory_sensitivity))) || (stryMutAct_9fa48("3582") ? risk.regulatory_sensitivity.every(entry => typeof entry !== 'string') : (stryCov_9fa48("3582"), risk.regulatory_sensitivity.some(stryMutAct_9fa48("3583") ? () => undefined : (stryCov_9fa48("3583"), entry => stryMutAct_9fa48("3586") ? typeof entry === 'string' : stryMutAct_9fa48("3585") ? false : stryMutAct_9fa48("3584") ? true : (stryCov_9fa48("3584", "3585", "3586"), typeof entry !== (stryMutAct_9fa48("3587") ? "" : (stryCov_9fa48("3587"), 'string'))))))))) {
      if (stryMutAct_9fa48("3588")) {
        {}
      } else {
        stryCov_9fa48("3588");
        throw new PolicyInputError(stryMutAct_9fa48("3589") ? "" : (stryCov_9fa48("3589"), 'EffectRisk.regulatory_sensitivity must be a string array'));
      }
    }
    if (stryMutAct_9fa48("3592") ? risk.egress_policy === undefined : stryMutAct_9fa48("3591") ? false : stryMutAct_9fa48("3590") ? true : (stryCov_9fa48("3590", "3591", "3592"), risk.egress_policy !== undefined)) normalizeEgress(risk.egress_policy);
    if (stryMutAct_9fa48("3595") ? risk.screen_access === undefined : stryMutAct_9fa48("3594") ? false : stryMutAct_9fa48("3593") ? true : (stryCov_9fa48("3593", "3594", "3595"), risk.screen_access !== undefined)) {
      if (stryMutAct_9fa48("3596")) {
        {}
      } else {
        stryCov_9fa48("3596");
        if (stryMutAct_9fa48("3599") ? false : stryMutAct_9fa48("3598") ? true : stryMutAct_9fa48("3597") ? isRecord(risk.screen_access) : (stryCov_9fa48("3597", "3598", "3599"), !isRecord(risk.screen_access))) {
          if (stryMutAct_9fa48("3600")) {
            {}
          } else {
            stryCov_9fa48("3600");
            throw new PolicyInputError(stryMutAct_9fa48("3601") ? "" : (stryCov_9fa48("3601"), 'EffectRisk.screen_access must be an object'));
          }
        }
        const screenKeys = new Set(stryMutAct_9fa48("3602") ? [] : (stryCov_9fa48("3602"), [stryMutAct_9fa48("3603") ? "" : (stryCov_9fa48("3603"), 'surface'), stryMutAct_9fa48("3604") ? "" : (stryCov_9fa48("3604"), 'input_modes'), stryMutAct_9fa48("3605") ? "" : (stryCov_9fa48("3605"), 'app_scope')]));
        if (stryMutAct_9fa48("3608") ? Object.keys(risk.screen_access).every(key => !screenKeys.has(key)) : stryMutAct_9fa48("3607") ? false : stryMutAct_9fa48("3606") ? true : (stryCov_9fa48("3606", "3607", "3608"), Object.keys(risk.screen_access).some(stryMutAct_9fa48("3609") ? () => undefined : (stryCov_9fa48("3609"), key => stryMutAct_9fa48("3610") ? screenKeys.has(key) : (stryCov_9fa48("3610"), !screenKeys.has(key)))))) {
          if (stryMutAct_9fa48("3611")) {
            {}
          } else {
            stryCov_9fa48("3611");
            throw new PolicyInputError(stryMutAct_9fa48("3612") ? "" : (stryCov_9fa48("3612"), 'EffectRisk.screen_access contains an unknown field'));
          }
        }
        if (stryMutAct_9fa48("3615") ? risk.screen_access.surface !== undefined || !['none', 'browser', 'native_app', 'desktop', 'fullscreen'].includes(risk.screen_access.surface) : stryMutAct_9fa48("3614") ? false : stryMutAct_9fa48("3613") ? true : (stryCov_9fa48("3613", "3614", "3615"), (stryMutAct_9fa48("3617") ? risk.screen_access.surface === undefined : stryMutAct_9fa48("3616") ? true : (stryCov_9fa48("3616", "3617"), risk.screen_access.surface !== undefined)) && (stryMutAct_9fa48("3618") ? ['none', 'browser', 'native_app', 'desktop', 'fullscreen'].includes(risk.screen_access.surface) : (stryCov_9fa48("3618"), !(stryMutAct_9fa48("3619") ? [] : (stryCov_9fa48("3619"), [stryMutAct_9fa48("3620") ? "" : (stryCov_9fa48("3620"), 'none'), stryMutAct_9fa48("3621") ? "" : (stryCov_9fa48("3621"), 'browser'), stryMutAct_9fa48("3622") ? "" : (stryCov_9fa48("3622"), 'native_app'), stryMutAct_9fa48("3623") ? "" : (stryCov_9fa48("3623"), 'desktop'), stryMutAct_9fa48("3624") ? "" : (stryCov_9fa48("3624"), 'fullscreen')])).includes(risk.screen_access.surface))))) {
          if (stryMutAct_9fa48("3625")) {
            {}
          } else {
            stryCov_9fa48("3625");
            throw new PolicyInputError(stryMutAct_9fa48("3626") ? "" : (stryCov_9fa48("3626"), 'EffectRisk.screen_access.surface is invalid'));
          }
        }
        if (stryMutAct_9fa48("3629") ? risk.screen_access.input_modes !== undefined || !Array.isArray(risk.screen_access.input_modes) || risk.screen_access.input_modes.some(mode => !['screenshot', 'click', 'type', 'key', 'clipboard'].includes(mode)) : stryMutAct_9fa48("3628") ? false : stryMutAct_9fa48("3627") ? true : (stryCov_9fa48("3627", "3628", "3629"), (stryMutAct_9fa48("3631") ? risk.screen_access.input_modes === undefined : stryMutAct_9fa48("3630") ? true : (stryCov_9fa48("3630", "3631"), risk.screen_access.input_modes !== undefined)) && (stryMutAct_9fa48("3633") ? !Array.isArray(risk.screen_access.input_modes) && risk.screen_access.input_modes.some(mode => !['screenshot', 'click', 'type', 'key', 'clipboard'].includes(mode)) : stryMutAct_9fa48("3632") ? true : (stryCov_9fa48("3632", "3633"), (stryMutAct_9fa48("3634") ? Array.isArray(risk.screen_access.input_modes) : (stryCov_9fa48("3634"), !Array.isArray(risk.screen_access.input_modes))) || (stryMutAct_9fa48("3635") ? risk.screen_access.input_modes.every(mode => !['screenshot', 'click', 'type', 'key', 'clipboard'].includes(mode)) : (stryCov_9fa48("3635"), risk.screen_access.input_modes.some(stryMutAct_9fa48("3636") ? () => undefined : (stryCov_9fa48("3636"), mode => stryMutAct_9fa48("3637") ? ['screenshot', 'click', 'type', 'key', 'clipboard'].includes(mode) : (stryCov_9fa48("3637"), !(stryMutAct_9fa48("3638") ? [] : (stryCov_9fa48("3638"), [stryMutAct_9fa48("3639") ? "" : (stryCov_9fa48("3639"), 'screenshot'), stryMutAct_9fa48("3640") ? "" : (stryCov_9fa48("3640"), 'click'), stryMutAct_9fa48("3641") ? "" : (stryCov_9fa48("3641"), 'type'), stryMutAct_9fa48("3642") ? "" : (stryCov_9fa48("3642"), 'key'), stryMutAct_9fa48("3643") ? "" : (stryCov_9fa48("3643"), 'clipboard')])).includes(mode)))))))))) {
          if (stryMutAct_9fa48("3644")) {
            {}
          } else {
            stryCov_9fa48("3644");
            throw new PolicyInputError(stryMutAct_9fa48("3645") ? "" : (stryCov_9fa48("3645"), 'EffectRisk.screen_access.input_modes is invalid'));
          }
        }
        if (stryMutAct_9fa48("3648") ? risk.screen_access.app_scope !== undefined || !['per_app_approved', 'workspace', 'system'].includes(risk.screen_access.app_scope) : stryMutAct_9fa48("3647") ? false : stryMutAct_9fa48("3646") ? true : (stryCov_9fa48("3646", "3647", "3648"), (stryMutAct_9fa48("3650") ? risk.screen_access.app_scope === undefined : stryMutAct_9fa48("3649") ? true : (stryCov_9fa48("3649", "3650"), risk.screen_access.app_scope !== undefined)) && (stryMutAct_9fa48("3651") ? ['per_app_approved', 'workspace', 'system'].includes(risk.screen_access.app_scope) : (stryCov_9fa48("3651"), !(stryMutAct_9fa48("3652") ? [] : (stryCov_9fa48("3652"), [stryMutAct_9fa48("3653") ? "" : (stryCov_9fa48("3653"), 'per_app_approved'), stryMutAct_9fa48("3654") ? "" : (stryCov_9fa48("3654"), 'workspace'), stryMutAct_9fa48("3655") ? "" : (stryCov_9fa48("3655"), 'system')])).includes(risk.screen_access.app_scope))))) {
          if (stryMutAct_9fa48("3656")) {
            {}
          } else {
            stryCov_9fa48("3656");
            throw new PolicyInputError(stryMutAct_9fa48("3657") ? "" : (stryCov_9fa48("3657"), 'EffectRisk.screen_access.app_scope is invalid'));
          }
        }
      }
    }
  }
}
export function deriveRiskTier(risk: EffectRisk, policy: Policy, context: PolicyContext): DerivedRiskTier {
  if (stryMutAct_9fa48("3658")) {
    {}
  } else {
    stryCov_9fa48("3658");
    validateContext(context);
    validateEffectRisk(risk);
    const financialImpact = parseFinancialImpact(risk.financial_impact_usd_micros);
    let score = 0;
    if (stryMutAct_9fa48("3661") ? risk.locality !== 'remote' : stryMutAct_9fa48("3660") ? false : stryMutAct_9fa48("3659") ? true : (stryCov_9fa48("3659", "3660", "3661"), risk.locality === (stryMutAct_9fa48("3662") ? "" : (stryCov_9fa48("3662"), 'remote')))) stryMutAct_9fa48("3663") ? score -= 1 : (stryCov_9fa48("3663"), score += 1);
    if (stryMutAct_9fa48("3666") ? risk.locality !== 'external' : stryMutAct_9fa48("3665") ? false : stryMutAct_9fa48("3664") ? true : (stryCov_9fa48("3664", "3665", "3666"), risk.locality === (stryMutAct_9fa48("3667") ? "" : (stryCov_9fa48("3667"), 'external')))) stryMutAct_9fa48("3668") ? score -= 2 : (stryCov_9fa48("3668"), score += 2);
    if (stryMutAct_9fa48("3671") ? risk.operation !== 'create' : stryMutAct_9fa48("3670") ? false : stryMutAct_9fa48("3669") ? true : (stryCov_9fa48("3669", "3670", "3671"), risk.operation === (stryMutAct_9fa48("3672") ? "" : (stryCov_9fa48("3672"), 'create')))) stryMutAct_9fa48("3673") ? score -= 1 : (stryCov_9fa48("3673"), score += 1);
    if (stryMutAct_9fa48("3676") ? risk.operation === 'write' && risk.operation === 'execute' : stryMutAct_9fa48("3675") ? false : stryMutAct_9fa48("3674") ? true : (stryCov_9fa48("3674", "3675", "3676"), (stryMutAct_9fa48("3678") ? risk.operation !== 'write' : stryMutAct_9fa48("3677") ? false : (stryCov_9fa48("3677", "3678"), risk.operation === (stryMutAct_9fa48("3679") ? "" : (stryCov_9fa48("3679"), 'write')))) || (stryMutAct_9fa48("3681") ? risk.operation !== 'execute' : stryMutAct_9fa48("3680") ? false : (stryCov_9fa48("3680", "3681"), risk.operation === (stryMutAct_9fa48("3682") ? "" : (stryCov_9fa48("3682"), 'execute')))))) stryMutAct_9fa48("3683") ? score -= 2 : (stryCov_9fa48("3683"), score += 2);
    if (stryMutAct_9fa48("3686") ? risk.operation === 'delete' && risk.operation === 'purchase' : stryMutAct_9fa48("3685") ? false : stryMutAct_9fa48("3684") ? true : (stryCov_9fa48("3684", "3685", "3686"), (stryMutAct_9fa48("3688") ? risk.operation !== 'delete' : stryMutAct_9fa48("3687") ? false : (stryCov_9fa48("3687", "3688"), risk.operation === (stryMutAct_9fa48("3689") ? "" : (stryCov_9fa48("3689"), 'delete')))) || (stryMutAct_9fa48("3691") ? risk.operation !== 'purchase' : stryMutAct_9fa48("3690") ? false : (stryCov_9fa48("3690", "3691"), risk.operation === (stryMutAct_9fa48("3692") ? "" : (stryCov_9fa48("3692"), 'purchase')))))) stryMutAct_9fa48("3693") ? score -= 3 : (stryCov_9fa48("3693"), score += 3);
    if (stryMutAct_9fa48("3696") ? risk.operation === 'publish' && risk.operation === 'communicate' : stryMutAct_9fa48("3695") ? false : stryMutAct_9fa48("3694") ? true : (stryCov_9fa48("3694", "3695", "3696"), (stryMutAct_9fa48("3698") ? risk.operation !== 'publish' : stryMutAct_9fa48("3697") ? false : (stryCov_9fa48("3697", "3698"), risk.operation === (stryMutAct_9fa48("3699") ? "" : (stryCov_9fa48("3699"), 'publish')))) || (stryMutAct_9fa48("3701") ? risk.operation !== 'communicate' : stryMutAct_9fa48("3700") ? false : (stryCov_9fa48("3700", "3701"), risk.operation === (stryMutAct_9fa48("3702") ? "" : (stryCov_9fa48("3702"), 'communicate')))))) stryMutAct_9fa48("3703") ? score -= 2 : (stryCov_9fa48("3703"), score += 2);
    if (stryMutAct_9fa48("3706") ? risk.reversibility !== 'best_effort' : stryMutAct_9fa48("3705") ? false : stryMutAct_9fa48("3704") ? true : (stryCov_9fa48("3704", "3705", "3706"), risk.reversibility === (stryMutAct_9fa48("3707") ? "" : (stryCov_9fa48("3707"), 'best_effort')))) stryMutAct_9fa48("3708") ? score -= 1 : (stryCov_9fa48("3708"), score += 1);
    if (stryMutAct_9fa48("3711") ? risk.reversibility !== 'none' : stryMutAct_9fa48("3710") ? false : stryMutAct_9fa48("3709") ? true : (stryCov_9fa48("3709", "3710", "3711"), risk.reversibility === (stryMutAct_9fa48("3712") ? "" : (stryCov_9fa48("3712"), 'none')))) stryMutAct_9fa48("3713") ? score -= 2 : (stryCov_9fa48("3713"), score += 2);
    if (stryMutAct_9fa48("3716") ? risk.data_egress !== 'metadata' : stryMutAct_9fa48("3715") ? false : stryMutAct_9fa48("3714") ? true : (stryCov_9fa48("3714", "3715", "3716"), risk.data_egress === (stryMutAct_9fa48("3717") ? "" : (stryCov_9fa48("3717"), 'metadata')))) stryMutAct_9fa48("3718") ? score -= 1 : (stryCov_9fa48("3718"), score += 1);
    if (stryMutAct_9fa48("3721") ? risk.data_egress !== 'content' : stryMutAct_9fa48("3720") ? false : stryMutAct_9fa48("3719") ? true : (stryCov_9fa48("3719", "3720", "3721"), risk.data_egress === (stryMutAct_9fa48("3722") ? "" : (stryCov_9fa48("3722"), 'content')))) stryMutAct_9fa48("3723") ? score -= 2 : (stryCov_9fa48("3723"), score += 2);
    if (stryMutAct_9fa48("3726") ? risk.data_egress !== 'sensitive' : stryMutAct_9fa48("3725") ? false : stryMutAct_9fa48("3724") ? true : (stryCov_9fa48("3724", "3725", "3726"), risk.data_egress === (stryMutAct_9fa48("3727") ? "" : (stryCov_9fa48("3727"), 'sensitive')))) stryMutAct_9fa48("3728") ? score -= 3 : (stryCov_9fa48("3728"), score += 3);
    if (stryMutAct_9fa48("3730") ? false : stryMutAct_9fa48("3729") ? true : (stryCov_9fa48("3729", "3730"), risk.network_access)) stryMutAct_9fa48("3731") ? score -= 1 : (stryCov_9fa48("3731"), score += 1);
    if (stryMutAct_9fa48("3733") ? false : stryMutAct_9fa48("3732") ? true : (stryCov_9fa48("3732", "3733"), risk.credential_access)) stryMutAct_9fa48("3734") ? score -= 2 : (stryCov_9fa48("3734"), score += 2);
    if (stryMutAct_9fa48("3737") ? risk.blast_radius !== 'bounded_set' : stryMutAct_9fa48("3736") ? false : stryMutAct_9fa48("3735") ? true : (stryCov_9fa48("3735", "3736", "3737"), risk.blast_radius === (stryMutAct_9fa48("3738") ? "" : (stryCov_9fa48("3738"), 'bounded_set')))) stryMutAct_9fa48("3739") ? score -= 1 : (stryCov_9fa48("3739"), score += 1);
    if (stryMutAct_9fa48("3742") ? risk.blast_radius !== 'workspace' : stryMutAct_9fa48("3741") ? false : stryMutAct_9fa48("3740") ? true : (stryCov_9fa48("3740", "3741", "3742"), risk.blast_radius === (stryMutAct_9fa48("3743") ? "" : (stryCov_9fa48("3743"), 'workspace')))) stryMutAct_9fa48("3744") ? score -= 2 : (stryCov_9fa48("3744"), score += 2);
    if (stryMutAct_9fa48("3747") ? risk.blast_radius === 'organization' && risk.blast_radius === 'public' : stryMutAct_9fa48("3746") ? false : stryMutAct_9fa48("3745") ? true : (stryCov_9fa48("3745", "3746", "3747"), (stryMutAct_9fa48("3749") ? risk.blast_radius !== 'organization' : stryMutAct_9fa48("3748") ? false : (stryCov_9fa48("3748", "3749"), risk.blast_radius === (stryMutAct_9fa48("3750") ? "" : (stryCov_9fa48("3750"), 'organization')))) || (stryMutAct_9fa48("3752") ? risk.blast_radius !== 'public' : stryMutAct_9fa48("3751") ? false : (stryCov_9fa48("3751", "3752"), risk.blast_radius === (stryMutAct_9fa48("3753") ? "" : (stryCov_9fa48("3753"), 'public')))))) stryMutAct_9fa48("3754") ? score -= 3 : (stryCov_9fa48("3754"), score += 3);
    if (stryMutAct_9fa48("3757") ? risk.blast_radius !== 'unbounded' : stryMutAct_9fa48("3756") ? false : stryMutAct_9fa48("3755") ? true : (stryCov_9fa48("3755", "3756", "3757"), risk.blast_radius === (stryMutAct_9fa48("3758") ? "" : (stryCov_9fa48("3758"), 'unbounded')))) stryMutAct_9fa48("3759") ? score -= 4 : (stryCov_9fa48("3759"), score += 4);
    if (stryMutAct_9fa48("3763") ? financialImpact < 1_000_000n : stryMutAct_9fa48("3762") ? financialImpact > 1_000_000n : stryMutAct_9fa48("3761") ? false : stryMutAct_9fa48("3760") ? true : (stryCov_9fa48("3760", "3761", "3762", "3763"), financialImpact >= 1_000_000n)) stryMutAct_9fa48("3764") ? score -= 3 : (stryCov_9fa48("3764"), score += 3);else if (stryMutAct_9fa48("3768") ? financialImpact < 10_000n : stryMutAct_9fa48("3767") ? financialImpact > 10_000n : stryMutAct_9fa48("3766") ? false : stryMutAct_9fa48("3765") ? true : (stryCov_9fa48("3765", "3766", "3767", "3768"), financialImpact >= 10_000n)) stryMutAct_9fa48("3769") ? score -= 1 : (stryCov_9fa48("3769"), score += 1);
    if (stryMutAct_9fa48("3772") ? risk.human_impact !== 'self' : stryMutAct_9fa48("3771") ? false : stryMutAct_9fa48("3770") ? true : (stryCov_9fa48("3770", "3771", "3772"), risk.human_impact === (stryMutAct_9fa48("3773") ? "" : (stryCov_9fa48("3773"), 'self')))) stryMutAct_9fa48("3774") ? score -= 1 : (stryCov_9fa48("3774"), score += 1);
    if (stryMutAct_9fa48("3777") ? risk.human_impact !== 'internal_people' : stryMutAct_9fa48("3776") ? false : stryMutAct_9fa48("3775") ? true : (stryCov_9fa48("3775", "3776", "3777"), risk.human_impact === (stryMutAct_9fa48("3778") ? "" : (stryCov_9fa48("3778"), 'internal_people')))) stryMutAct_9fa48("3779") ? score -= 2 : (stryCov_9fa48("3779"), score += 2);
    if (stryMutAct_9fa48("3782") ? risk.human_impact === 'external_people' && risk.human_impact === 'public' : stryMutAct_9fa48("3781") ? false : stryMutAct_9fa48("3780") ? true : (stryCov_9fa48("3780", "3781", "3782"), (stryMutAct_9fa48("3784") ? risk.human_impact !== 'external_people' : stryMutAct_9fa48("3783") ? false : (stryCov_9fa48("3783", "3784"), risk.human_impact === (stryMutAct_9fa48("3785") ? "" : (stryCov_9fa48("3785"), 'external_people')))) || (stryMutAct_9fa48("3787") ? risk.human_impact !== 'public' : stryMutAct_9fa48("3786") ? false : (stryCov_9fa48("3786", "3787"), risk.human_impact === (stryMutAct_9fa48("3788") ? "" : (stryCov_9fa48("3788"), 'public')))))) stryMutAct_9fa48("3789") ? score -= 3 : (stryCov_9fa48("3789"), score += 3);
    if (stryMutAct_9fa48("3792") ? risk.external_visibility !== 'shared' : stryMutAct_9fa48("3791") ? false : stryMutAct_9fa48("3790") ? true : (stryCov_9fa48("3790", "3791", "3792"), risk.external_visibility === (stryMutAct_9fa48("3793") ? "" : (stryCov_9fa48("3793"), 'shared')))) stryMutAct_9fa48("3794") ? score -= 1 : (stryCov_9fa48("3794"), score += 1);
    if (stryMutAct_9fa48("3797") ? risk.external_visibility !== 'public' : stryMutAct_9fa48("3796") ? false : stryMutAct_9fa48("3795") ? true : (stryCov_9fa48("3795", "3796", "3797"), risk.external_visibility === (stryMutAct_9fa48("3798") ? "" : (stryCov_9fa48("3798"), 'public')))) stryMutAct_9fa48("3799") ? score -= 2 : (stryCov_9fa48("3799"), score += 2);
    if (stryMutAct_9fa48("3803") ? risk.regulatory_sensitivity.length <= 0 : stryMutAct_9fa48("3802") ? risk.regulatory_sensitivity.length >= 0 : stryMutAct_9fa48("3801") ? false : stryMutAct_9fa48("3800") ? true : (stryCov_9fa48("3800", "3801", "3802", "3803"), risk.regulatory_sensitivity.length > 0)) stryMutAct_9fa48("3804") ? score -= 1 : (stryCov_9fa48("3804"), score += 1);
    if (stryMutAct_9fa48("3807") ? risk.regulatory_sensitivity.every(entry => /health|children/iu.test(entry)) : stryMutAct_9fa48("3806") ? false : stryMutAct_9fa48("3805") ? true : (stryCov_9fa48("3805", "3806", "3807"), risk.regulatory_sensitivity.some(stryMutAct_9fa48("3808") ? () => undefined : (stryCov_9fa48("3808"), entry => /health|children/iu.test(entry))))) stryMutAct_9fa48("3809") ? score -= 2 : (stryCov_9fa48("3809"), score += 2);
    if (stryMutAct_9fa48("3812") ? risk.screen_access?.surface !== 'browser' : stryMutAct_9fa48("3811") ? false : stryMutAct_9fa48("3810") ? true : (stryCov_9fa48("3810", "3811", "3812"), (stryMutAct_9fa48("3813") ? risk.screen_access.surface : (stryCov_9fa48("3813"), risk.screen_access?.surface)) === (stryMutAct_9fa48("3814") ? "" : (stryCov_9fa48("3814"), 'browser')))) stryMutAct_9fa48("3815") ? score -= 1 : (stryCov_9fa48("3815"), score += 1);
    if (stryMutAct_9fa48("3818") ? risk.screen_access?.surface !== 'native_app' : stryMutAct_9fa48("3817") ? false : stryMutAct_9fa48("3816") ? true : (stryCov_9fa48("3816", "3817", "3818"), (stryMutAct_9fa48("3819") ? risk.screen_access.surface : (stryCov_9fa48("3819"), risk.screen_access?.surface)) === (stryMutAct_9fa48("3820") ? "" : (stryCov_9fa48("3820"), 'native_app')))) stryMutAct_9fa48("3821") ? score -= 2 : (stryCov_9fa48("3821"), score += 2);
    if (stryMutAct_9fa48("3824") ? risk.screen_access?.surface === 'desktop' && risk.screen_access?.surface === 'fullscreen' : stryMutAct_9fa48("3823") ? false : stryMutAct_9fa48("3822") ? true : (stryCov_9fa48("3822", "3823", "3824"), (stryMutAct_9fa48("3826") ? risk.screen_access?.surface !== 'desktop' : stryMutAct_9fa48("3825") ? false : (stryCov_9fa48("3825", "3826"), (stryMutAct_9fa48("3827") ? risk.screen_access.surface : (stryCov_9fa48("3827"), risk.screen_access?.surface)) === (stryMutAct_9fa48("3828") ? "" : (stryCov_9fa48("3828"), 'desktop')))) || (stryMutAct_9fa48("3830") ? risk.screen_access?.surface !== 'fullscreen' : stryMutAct_9fa48("3829") ? false : (stryCov_9fa48("3829", "3830"), (stryMutAct_9fa48("3831") ? risk.screen_access.surface : (stryCov_9fa48("3831"), risk.screen_access?.surface)) === (stryMutAct_9fa48("3832") ? "" : (stryCov_9fa48("3832"), 'fullscreen')))))) stryMutAct_9fa48("3833") ? score -= 3 : (stryCov_9fa48("3833"), score += 3);
    if (stryMutAct_9fa48("3838") ? risk.screen_access.input_modes?.some(mode => ['click', 'type', 'key'].includes(mode)) : stryMutAct_9fa48("3837") ? risk.screen_access?.input_modes.some(mode => ['click', 'type', 'key'].includes(mode)) : stryMutAct_9fa48("3836") ? risk.screen_access?.input_modes?.every(mode => ['click', 'type', 'key'].includes(mode)) : stryMutAct_9fa48("3835") ? false : stryMutAct_9fa48("3834") ? true : (stryCov_9fa48("3834", "3835", "3836", "3837", "3838"), risk.screen_access?.input_modes?.some(stryMutAct_9fa48("3839") ? () => undefined : (stryCov_9fa48("3839"), mode => (stryMutAct_9fa48("3840") ? [] : (stryCov_9fa48("3840"), [stryMutAct_9fa48("3841") ? "" : (stryCov_9fa48("3841"), 'click'), stryMutAct_9fa48("3842") ? "" : (stryCov_9fa48("3842"), 'type'), stryMutAct_9fa48("3843") ? "" : (stryCov_9fa48("3843"), 'key')])).includes(mode))))) stryMutAct_9fa48("3844") ? score -= 1 : (stryCov_9fa48("3844"), score += 1);
    if (stryMutAct_9fa48("3848") ? risk.screen_access.input_modes?.includes('clipboard') : stryMutAct_9fa48("3847") ? risk.screen_access?.input_modes.includes('clipboard') : stryMutAct_9fa48("3846") ? false : stryMutAct_9fa48("3845") ? true : (stryCov_9fa48("3845", "3846", "3847", "3848"), risk.screen_access?.input_modes?.includes(stryMutAct_9fa48("3849") ? "" : (stryCov_9fa48("3849"), 'clipboard')))) stryMutAct_9fa48("3850") ? score -= 1 : (stryCov_9fa48("3850"), score += 1);
    if (stryMutAct_9fa48("3853") ? risk.screen_access?.app_scope !== 'workspace' : stryMutAct_9fa48("3852") ? false : stryMutAct_9fa48("3851") ? true : (stryCov_9fa48("3851", "3852", "3853"), (stryMutAct_9fa48("3854") ? risk.screen_access.app_scope : (stryCov_9fa48("3854"), risk.screen_access?.app_scope)) === (stryMutAct_9fa48("3855") ? "" : (stryCov_9fa48("3855"), 'workspace')))) stryMutAct_9fa48("3856") ? score -= 1 : (stryCov_9fa48("3856"), score += 1);
    if (stryMutAct_9fa48("3859") ? risk.screen_access?.app_scope !== 'system' : stryMutAct_9fa48("3858") ? false : stryMutAct_9fa48("3857") ? true : (stryCov_9fa48("3857", "3858", "3859"), (stryMutAct_9fa48("3860") ? risk.screen_access.app_scope : (stryCov_9fa48("3860"), risk.screen_access?.app_scope)) === (stryMutAct_9fa48("3861") ? "" : (stryCov_9fa48("3861"), 'system')))) stryMutAct_9fa48("3862") ? score -= 2 : (stryCov_9fa48("3862"), score += 2);
    if (stryMutAct_9fa48("3865") ? context.trust_level !== 'untrusted' : stryMutAct_9fa48("3864") ? false : stryMutAct_9fa48("3863") ? true : (stryCov_9fa48("3863", "3864", "3865"), context.trust_level === (stryMutAct_9fa48("3866") ? "" : (stryCov_9fa48("3866"), 'untrusted')))) stryMutAct_9fa48("3867") ? score -= 1 : (stryCov_9fa48("3867"), score += 1);
    if (stryMutAct_9fa48("3870") ? context.trust_level !== 'quarantined' : stryMutAct_9fa48("3869") ? false : stryMutAct_9fa48("3868") ? true : (stryCov_9fa48("3868", "3869", "3870"), context.trust_level === (stryMutAct_9fa48("3871") ? "" : (stryCov_9fa48("3871"), 'quarantined')))) stryMutAct_9fa48("3872") ? score -= 3 : (stryCov_9fa48("3872"), score += 3);
    score = stryMutAct_9fa48("3873") ? Math.min(score, policy.minimum_risk_tier ?? 0) : (stryCov_9fa48("3873"), Math.max(score, stryMutAct_9fa48("3874") ? policy.minimum_risk_tier && 0 : (stryCov_9fa48("3874"), policy.minimum_risk_tier ?? 0)));
    return Math.min(5, score) as DerivedRiskTier;
  }
}
function normalizeHost(host: string, allowWildcard: boolean): string {
  if (stryMutAct_9fa48("3875")) {
    {}
  } else {
    stryCov_9fa48("3875");
    if (stryMutAct_9fa48("3878") ? typeof host === 'string' : stryMutAct_9fa48("3877") ? false : stryMutAct_9fa48("3876") ? true : (stryCov_9fa48("3876", "3877", "3878"), typeof host !== (stryMutAct_9fa48("3879") ? "" : (stryCov_9fa48("3879"), 'string')))) throw new PolicyInputError(stryMutAct_9fa48("3880") ? "" : (stryCov_9fa48("3880"), 'host must be a string'));
    let candidate = stryMutAct_9fa48("3882") ? host.replace(/\.+$/u, '').toLowerCase() : stryMutAct_9fa48("3881") ? host.trim().replace(/\.+$/u, '').toUpperCase() : (stryCov_9fa48("3881", "3882"), host.trim().replace(stryMutAct_9fa48("3884") ? /\.$/u : stryMutAct_9fa48("3883") ? /\.+/u : (stryCov_9fa48("3883", "3884"), /\.+$/u), stryMutAct_9fa48("3885") ? "Stryker was here!" : (stryCov_9fa48("3885"), '')).toLowerCase());
    if (stryMutAct_9fa48("3888") ? candidate.length !== 0 : stryMutAct_9fa48("3887") ? false : stryMutAct_9fa48("3886") ? true : (stryCov_9fa48("3886", "3887", "3888"), candidate.length === 0)) throw new PolicyInputError(stryMutAct_9fa48("3889") ? "" : (stryCov_9fa48("3889"), 'host must not be empty'));
    if (stryMutAct_9fa48("3892") ? candidate !== '*' : stryMutAct_9fa48("3891") ? false : stryMutAct_9fa48("3890") ? true : (stryCov_9fa48("3890", "3891", "3892"), candidate === (stryMutAct_9fa48("3893") ? "" : (stryCov_9fa48("3893"), '*')))) {
      if (stryMutAct_9fa48("3894")) {
        {}
      } else {
        stryCov_9fa48("3894");
        if (stryMutAct_9fa48("3897") ? false : stryMutAct_9fa48("3896") ? true : stryMutAct_9fa48("3895") ? allowWildcard : (stryCov_9fa48("3895", "3896", "3897"), !allowWildcard)) throw new PolicyInputError(stryMutAct_9fa48("3898") ? "" : (stryCov_9fa48("3898"), 'wildcard is not a destination'));
        return candidate;
      }
    }
    let wildcard = stryMutAct_9fa48("3899") ? true : (stryCov_9fa48("3899"), false);
    if (stryMutAct_9fa48("3902") ? candidate.endsWith('*.') : stryMutAct_9fa48("3901") ? false : stryMutAct_9fa48("3900") ? true : (stryCov_9fa48("3900", "3901", "3902"), candidate.startsWith(stryMutAct_9fa48("3903") ? "" : (stryCov_9fa48("3903"), '*.')))) {
      if (stryMutAct_9fa48("3904")) {
        {}
      } else {
        stryCov_9fa48("3904");
        if (stryMutAct_9fa48("3907") ? false : stryMutAct_9fa48("3906") ? true : stryMutAct_9fa48("3905") ? allowWildcard : (stryCov_9fa48("3905", "3906", "3907"), !allowWildcard)) throw new PolicyInputError(stryMutAct_9fa48("3908") ? "" : (stryCov_9fa48("3908"), 'wildcard is not a destination'));
        wildcard = stryMutAct_9fa48("3909") ? false : (stryCov_9fa48("3909"), true);
        candidate = stryMutAct_9fa48("3910") ? candidate : (stryCov_9fa48("3910"), candidate.slice(2));
      }
    } else if (stryMutAct_9fa48("3912") ? false : stryMutAct_9fa48("3911") ? true : (stryCov_9fa48("3911", "3912"), candidate.includes(stryMutAct_9fa48("3913") ? "" : (stryCov_9fa48("3913"), '*')))) {
      if (stryMutAct_9fa48("3914")) {
        {}
      } else {
        stryCov_9fa48("3914");
        throw new PolicyInputError(stryMutAct_9fa48("3915") ? "" : (stryCov_9fa48("3915"), 'invalid wildcard host pattern'));
      }
    }
    const bracketless = (stryMutAct_9fa48("3918") ? candidate.startsWith('[') || candidate.endsWith(']') : stryMutAct_9fa48("3917") ? false : stryMutAct_9fa48("3916") ? true : (stryCov_9fa48("3916", "3917", "3918"), (stryMutAct_9fa48("3919") ? candidate.endsWith('[') : (stryCov_9fa48("3919"), candidate.startsWith(stryMutAct_9fa48("3920") ? "" : (stryCov_9fa48("3920"), '[')))) && (stryMutAct_9fa48("3921") ? candidate.startsWith(']') : (stryCov_9fa48("3921"), candidate.endsWith(stryMutAct_9fa48("3922") ? "" : (stryCov_9fa48("3922"), ']')))))) ? stryMutAct_9fa48("3923") ? candidate : (stryCov_9fa48("3923"), candidate.slice(1, stryMutAct_9fa48("3924") ? +1 : (stryCov_9fa48("3924"), -1))) : candidate;
    const ipVersion = isIP(bracketless);
    const ascii = (stryMutAct_9fa48("3927") ? ipVersion !== 6 : stryMutAct_9fa48("3926") ? false : stryMutAct_9fa48("3925") ? true : (stryCov_9fa48("3925", "3926", "3927"), ipVersion === 6)) ? stryMutAct_9fa48("3928") ? new URL(`http://[${bracketless}]/`).hostname : (stryCov_9fa48("3928"), new URL(stryMutAct_9fa48("3929") ? `` : (stryCov_9fa48("3929"), `http://[${bracketless}]/`)).hostname.slice(1, stryMutAct_9fa48("3930") ? +1 : (stryCov_9fa48("3930"), -1))) : (stryMutAct_9fa48("3933") ? ipVersion !== 4 : stryMutAct_9fa48("3932") ? false : stryMutAct_9fa48("3931") ? true : (stryCov_9fa48("3931", "3932", "3933"), ipVersion === 4)) ? bracketless : domainToASCII(bracketless);
    if (stryMutAct_9fa48("3936") ? ascii.length === 0 && /[\s/@]/u.test(ascii) : stryMutAct_9fa48("3935") ? false : stryMutAct_9fa48("3934") ? true : (stryCov_9fa48("3934", "3935", "3936"), (stryMutAct_9fa48("3938") ? ascii.length !== 0 : stryMutAct_9fa48("3937") ? false : (stryCov_9fa48("3937", "3938"), ascii.length === 0)) || (stryMutAct_9fa48("3940") ? /[\S/@]/u : stryMutAct_9fa48("3939") ? /[^\s/@]/u : (stryCov_9fa48("3939", "3940"), /[\s/@]/u)).test(ascii))) throw new PolicyInputError(stryMutAct_9fa48("3941") ? "" : (stryCov_9fa48("3941"), 'invalid host'));
    return wildcard ? stryMutAct_9fa48("3942") ? `` : (stryCov_9fa48("3942"), `*.${ascii}`) : ascii;
  }
}
export function hostMatches(host: string, pattern: string): boolean {
  if (stryMutAct_9fa48("3943")) {
    {}
  } else {
    stryCov_9fa48("3943");
    const normalizedHost = normalizeHost(host, stryMutAct_9fa48("3944") ? true : (stryCov_9fa48("3944"), false));
    const normalizedPattern = normalizeHost(pattern, stryMutAct_9fa48("3945") ? false : (stryCov_9fa48("3945"), true));
    if (stryMutAct_9fa48("3948") ? normalizedPattern !== '*' : stryMutAct_9fa48("3947") ? false : stryMutAct_9fa48("3946") ? true : (stryCov_9fa48("3946", "3947", "3948"), normalizedPattern === (stryMutAct_9fa48("3949") ? "" : (stryCov_9fa48("3949"), '*')))) return stryMutAct_9fa48("3950") ? false : (stryCov_9fa48("3950"), true);
    if (stryMutAct_9fa48("3953") ? normalizedPattern.endsWith('*.') : stryMutAct_9fa48("3952") ? false : stryMutAct_9fa48("3951") ? true : (stryCov_9fa48("3951", "3952", "3953"), normalizedPattern.startsWith(stryMutAct_9fa48("3954") ? "" : (stryCov_9fa48("3954"), '*.')))) {
      if (stryMutAct_9fa48("3955")) {
        {}
      } else {
        stryCov_9fa48("3955");
        return stryMutAct_9fa48("3956") ? normalizedHost.startsWith(`.${normalizedPattern.slice(2)}`) : (stryCov_9fa48("3956"), normalizedHost.endsWith(stryMutAct_9fa48("3957") ? `` : (stryCov_9fa48("3957"), `.${stryMutAct_9fa48("3958") ? normalizedPattern : (stryCov_9fa48("3958"), normalizedPattern.slice(2))}`)));
      }
    }
    return stryMutAct_9fa48("3961") ? normalizedHost !== normalizedPattern : stryMutAct_9fa48("3960") ? false : stryMutAct_9fa48("3959") ? true : (stryCov_9fa48("3959", "3960", "3961"), normalizedHost === normalizedPattern);
  }
}
function normalizeEgress(policy: EgressPolicy | NormalizedEgressPolicy): NormalizedEgressPolicy {
  if (stryMutAct_9fa48("3962")) {
    {}
  } else {
    stryCov_9fa48("3962");
    if (stryMutAct_9fa48("3965") ? false : stryMutAct_9fa48("3964") ? true : stryMutAct_9fa48("3963") ? isRecord(policy) : (stryCov_9fa48("3963", "3964", "3965"), !isRecord(policy))) throw new PolicyConfigurationError(stryMutAct_9fa48("3966") ? "" : (stryCov_9fa48("3966"), 'egress policy must be an object'));
    const knownKeys = new Set(stryMutAct_9fa48("3967") ? [] : (stryCov_9fa48("3967"), [stryMutAct_9fa48("3968") ? "" : (stryCov_9fa48("3968"), 'mode'), stryMutAct_9fa48("3969") ? "" : (stryCov_9fa48("3969"), 'domain_rules'), stryMutAct_9fa48("3970") ? "" : (stryCov_9fa48("3970"), 'unix_sockets'), stryMutAct_9fa48("3971") ? "" : (stryCov_9fa48("3971"), 'allow_local_binding'), stryMutAct_9fa48("3972") ? "" : (stryCov_9fa48("3972"), 'socks5')]));
    if (stryMutAct_9fa48("3975") ? Object.keys(policy).every(key => !knownKeys.has(key)) : stryMutAct_9fa48("3974") ? false : stryMutAct_9fa48("3973") ? true : (stryCov_9fa48("3973", "3974", "3975"), Object.keys(policy).some(stryMutAct_9fa48("3976") ? () => undefined : (stryCov_9fa48("3976"), key => stryMutAct_9fa48("3977") ? knownKeys.has(key) : (stryCov_9fa48("3977"), !knownKeys.has(key)))))) {
      if (stryMutAct_9fa48("3978")) {
        {}
      } else {
        stryCov_9fa48("3978");
        throw new PolicyConfigurationError(stryMutAct_9fa48("3979") ? "" : (stryCov_9fa48("3979"), 'egress policy contains an unknown field'));
      }
    }
    const mode = stryMutAct_9fa48("3980") ? policy.mode && 'disabled' : (stryCov_9fa48("3980"), policy.mode ?? (stryMutAct_9fa48("3981") ? "" : (stryCov_9fa48("3981"), 'disabled')));
    if (stryMutAct_9fa48("3984") ? false : stryMutAct_9fa48("3983") ? true : stryMutAct_9fa48("3982") ? ['disabled', 'allowlist', 'denylist', 'open'].includes(mode) : (stryCov_9fa48("3982", "3983", "3984"), !(stryMutAct_9fa48("3985") ? [] : (stryCov_9fa48("3985"), [stryMutAct_9fa48("3986") ? "" : (stryCov_9fa48("3986"), 'disabled'), stryMutAct_9fa48("3987") ? "" : (stryCov_9fa48("3987"), 'allowlist'), stryMutAct_9fa48("3988") ? "" : (stryCov_9fa48("3988"), 'denylist'), stryMutAct_9fa48("3989") ? "" : (stryCov_9fa48("3989"), 'open')])).includes(mode))) {
      if (stryMutAct_9fa48("3990")) {
        {}
      } else {
        stryCov_9fa48("3990");
        throw new PolicyConfigurationError(stryMutAct_9fa48("3991") ? "" : (stryCov_9fa48("3991"), 'invalid egress mode'));
      }
    }
    const domainRules = stryMutAct_9fa48("3992") ? policy.domain_rules && [] : (stryCov_9fa48("3992"), policy.domain_rules ?? (stryMutAct_9fa48("3993") ? ["Stryker was here"] : (stryCov_9fa48("3993"), [])));
    if (stryMutAct_9fa48("3996") ? false : stryMutAct_9fa48("3995") ? true : stryMutAct_9fa48("3994") ? Array.isArray(domainRules) : (stryCov_9fa48("3994", "3995", "3996"), !Array.isArray(domainRules))) throw new PolicyConfigurationError(stryMutAct_9fa48("3997") ? "" : (stryCov_9fa48("3997"), 'egress domain_rules must be an array'));
    if (stryMutAct_9fa48("4000") ? policy.unix_sockets !== undefined || !['denied', 'allowlist'].includes(policy.unix_sockets) : stryMutAct_9fa48("3999") ? false : stryMutAct_9fa48("3998") ? true : (stryCov_9fa48("3998", "3999", "4000"), (stryMutAct_9fa48("4002") ? policy.unix_sockets === undefined : stryMutAct_9fa48("4001") ? true : (stryCov_9fa48("4001", "4002"), policy.unix_sockets !== undefined)) && (stryMutAct_9fa48("4003") ? ['denied', 'allowlist'].includes(policy.unix_sockets) : (stryCov_9fa48("4003"), !(stryMutAct_9fa48("4004") ? [] : (stryCov_9fa48("4004"), [stryMutAct_9fa48("4005") ? "" : (stryCov_9fa48("4005"), 'denied'), stryMutAct_9fa48("4006") ? "" : (stryCov_9fa48("4006"), 'allowlist')])).includes(policy.unix_sockets))))) {
      if (stryMutAct_9fa48("4007")) {
        {}
      } else {
        stryCov_9fa48("4007");
        throw new PolicyConfigurationError(stryMutAct_9fa48("4008") ? "" : (stryCov_9fa48("4008"), 'invalid egress unix_sockets setting'));
      }
    }
    if (stryMutAct_9fa48("4011") ? policy.allow_local_binding !== undefined || typeof policy.allow_local_binding !== 'boolean' : stryMutAct_9fa48("4010") ? false : stryMutAct_9fa48("4009") ? true : (stryCov_9fa48("4009", "4010", "4011"), (stryMutAct_9fa48("4013") ? policy.allow_local_binding === undefined : stryMutAct_9fa48("4012") ? true : (stryCov_9fa48("4012", "4013"), policy.allow_local_binding !== undefined)) && (stryMutAct_9fa48("4015") ? typeof policy.allow_local_binding === 'boolean' : stryMutAct_9fa48("4014") ? true : (stryCov_9fa48("4014", "4015"), typeof policy.allow_local_binding !== (stryMutAct_9fa48("4016") ? "" : (stryCov_9fa48("4016"), 'boolean')))))) {
      if (stryMutAct_9fa48("4017")) {
        {}
      } else {
        stryCov_9fa48("4017");
        throw new PolicyConfigurationError(stryMutAct_9fa48("4018") ? "" : (stryCov_9fa48("4018"), 'invalid egress allow_local_binding setting'));
      }
    }
    if (stryMutAct_9fa48("4021") ? policy.socks5 !== undefined || typeof policy.socks5 !== 'boolean' : stryMutAct_9fa48("4020") ? false : stryMutAct_9fa48("4019") ? true : (stryCov_9fa48("4019", "4020", "4021"), (stryMutAct_9fa48("4023") ? policy.socks5 === undefined : stryMutAct_9fa48("4022") ? true : (stryCov_9fa48("4022", "4023"), policy.socks5 !== undefined)) && (stryMutAct_9fa48("4025") ? typeof policy.socks5 === 'boolean' : stryMutAct_9fa48("4024") ? true : (stryCov_9fa48("4024", "4025"), typeof policy.socks5 !== (stryMutAct_9fa48("4026") ? "" : (stryCov_9fa48("4026"), 'boolean')))))) {
      if (stryMutAct_9fa48("4027")) {
        {}
      } else {
        stryCov_9fa48("4027");
        throw new PolicyConfigurationError(stryMutAct_9fa48("4028") ? "" : (stryCov_9fa48("4028"), 'invalid egress socks5 setting'));
      }
    }
    const normalizedRules = domainRules.map(rule => {
      if (stryMutAct_9fa48("4029")) {
        {}
      } else {
        stryCov_9fa48("4029");
        if (stryMutAct_9fa48("4032") ? (!isRecord(rule) || Object.keys(rule).some(key => key !== 'action' && key !== 'host') || rule.action !== 'allow' && rule.action !== 'deny') && typeof rule.host !== 'string' : stryMutAct_9fa48("4031") ? false : stryMutAct_9fa48("4030") ? true : (stryCov_9fa48("4030", "4031", "4032"), (stryMutAct_9fa48("4034") ? (!isRecord(rule) || Object.keys(rule).some(key => key !== 'action' && key !== 'host')) && rule.action !== 'allow' && rule.action !== 'deny' : stryMutAct_9fa48("4033") ? false : (stryCov_9fa48("4033", "4034"), (stryMutAct_9fa48("4036") ? !isRecord(rule) && Object.keys(rule).some(key => key !== 'action' && key !== 'host') : stryMutAct_9fa48("4035") ? false : (stryCov_9fa48("4035", "4036"), (stryMutAct_9fa48("4037") ? isRecord(rule) : (stryCov_9fa48("4037"), !isRecord(rule))) || (stryMutAct_9fa48("4038") ? Object.keys(rule).every(key => key !== 'action' && key !== 'host') : (stryCov_9fa48("4038"), Object.keys(rule).some(stryMutAct_9fa48("4039") ? () => undefined : (stryCov_9fa48("4039"), key => stryMutAct_9fa48("4042") ? key !== 'action' || key !== 'host' : stryMutAct_9fa48("4041") ? false : stryMutAct_9fa48("4040") ? true : (stryCov_9fa48("4040", "4041", "4042"), (stryMutAct_9fa48("4044") ? key === 'action' : stryMutAct_9fa48("4043") ? true : (stryCov_9fa48("4043", "4044"), key !== (stryMutAct_9fa48("4045") ? "" : (stryCov_9fa48("4045"), 'action')))) && (stryMutAct_9fa48("4047") ? key === 'host' : stryMutAct_9fa48("4046") ? true : (stryCov_9fa48("4046", "4047"), key !== (stryMutAct_9fa48("4048") ? "" : (stryCov_9fa48("4048"), 'host'))))))))))) || (stryMutAct_9fa48("4050") ? rule.action !== 'allow' || rule.action !== 'deny' : stryMutAct_9fa48("4049") ? false : (stryCov_9fa48("4049", "4050"), (stryMutAct_9fa48("4052") ? rule.action === 'allow' : stryMutAct_9fa48("4051") ? true : (stryCov_9fa48("4051", "4052"), rule.action !== (stryMutAct_9fa48("4053") ? "" : (stryCov_9fa48("4053"), 'allow')))) && (stryMutAct_9fa48("4055") ? rule.action === 'deny' : stryMutAct_9fa48("4054") ? true : (stryCov_9fa48("4054", "4055"), rule.action !== (stryMutAct_9fa48("4056") ? "" : (stryCov_9fa48("4056"), 'deny')))))))) || (stryMutAct_9fa48("4058") ? typeof rule.host === 'string' : stryMutAct_9fa48("4057") ? false : (stryCov_9fa48("4057", "4058"), typeof rule.host !== (stryMutAct_9fa48("4059") ? "" : (stryCov_9fa48("4059"), 'string')))))) {
          if (stryMutAct_9fa48("4060")) {
            {}
          } else {
            stryCov_9fa48("4060");
            throw new PolicyConfigurationError(stryMutAct_9fa48("4061") ? "" : (stryCov_9fa48("4061"), 'invalid egress domain rule'));
          }
        }
        try {
          if (stryMutAct_9fa48("4062")) {
            {}
          } else {
            stryCov_9fa48("4062");
            return stryMutAct_9fa48("4063") ? {} : (stryCov_9fa48("4063"), {
              action: rule.action as 'allow' | 'deny',
              host: normalizeHost(rule.host, stryMutAct_9fa48("4064") ? false : (stryCov_9fa48("4064"), true))
            });
          }
        } catch (error) {
          if (stryMutAct_9fa48("4065")) {
            {}
          } else {
            stryCov_9fa48("4065");
            throw new PolicyConfigurationError(error instanceof Error ? stryMutAct_9fa48("4066") ? `` : (stryCov_9fa48("4066"), `invalid egress host: ${error.message}`) : stryMutAct_9fa48("4067") ? "" : (stryCov_9fa48("4067"), 'invalid egress host'));
          }
        }
      }
    });
    stryMutAct_9fa48("4068") ? normalizedRules : (stryCov_9fa48("4068"), normalizedRules.sort(stryMutAct_9fa48("4069") ? () => undefined : (stryCov_9fa48("4069"), (left, right) => (stryMutAct_9fa48("4070") ? `` : (stryCov_9fa48("4070"), `${left.action}:${left.host}`)).localeCompare(stryMutAct_9fa48("4071") ? `` : (stryCov_9fa48("4071"), `${right.action}:${right.host}`), stryMutAct_9fa48("4072") ? "" : (stryCov_9fa48("4072"), 'en')))));
    const uniqueRules = stryMutAct_9fa48("4073") ? normalizedRules : (stryCov_9fa48("4073"), normalizedRules.filter(stryMutAct_9fa48("4074") ? () => undefined : (stryCov_9fa48("4074"), (rule, index) => stryMutAct_9fa48("4077") ? index === 0 && `${rule.action}:${rule.host}` !== `${normalizedRules[index - 1]!.action}:${normalizedRules[index - 1]!.host}` : stryMutAct_9fa48("4076") ? false : stryMutAct_9fa48("4075") ? true : (stryCov_9fa48("4075", "4076", "4077"), (stryMutAct_9fa48("4079") ? index !== 0 : stryMutAct_9fa48("4078") ? false : (stryCov_9fa48("4078", "4079"), index === 0)) || (stryMutAct_9fa48("4081") ? `${rule.action}:${rule.host}` === `${normalizedRules[index - 1]!.action}:${normalizedRules[index - 1]!.host}` : stryMutAct_9fa48("4080") ? false : (stryCov_9fa48("4080", "4081"), (stryMutAct_9fa48("4082") ? `` : (stryCov_9fa48("4082"), `${rule.action}:${rule.host}`)) !== (stryMutAct_9fa48("4083") ? `` : (stryCov_9fa48("4083"), `${normalizedRules[stryMutAct_9fa48("4084") ? index + 1 : (stryCov_9fa48("4084"), index - 1)]!.action}:${normalizedRules[stryMutAct_9fa48("4085") ? index + 1 : (stryCov_9fa48("4085"), index - 1)]!.host}`))))))));
    return deepFreeze(stryMutAct_9fa48("4086") ? {} : (stryCov_9fa48("4086"), {
      mode,
      domain_rules: uniqueRules,
      unix_sockets: stryMutAct_9fa48("4087") ? policy.unix_sockets && 'denied' : (stryCov_9fa48("4087"), policy.unix_sockets ?? (stryMutAct_9fa48("4088") ? "" : (stryCov_9fa48("4088"), 'denied'))),
      allow_local_binding: stryMutAct_9fa48("4089") ? policy.allow_local_binding && false : (stryCov_9fa48("4089"), policy.allow_local_binding ?? (stryMutAct_9fa48("4090") ? true : (stryCov_9fa48("4090"), false))),
      socks5: stryMutAct_9fa48("4091") ? policy.socks5 && false : (stryCov_9fa48("4091"), policy.socks5 ?? (stryMutAct_9fa48("4092") ? true : (stryCov_9fa48("4092"), false)))
    }));
  }
}
function patternIntersection(left: string, right: string): string | undefined {
  if (stryMutAct_9fa48("4093")) {
    {}
  } else {
    stryCov_9fa48("4093");
    if (stryMutAct_9fa48("4096") ? left !== '*' : stryMutAct_9fa48("4095") ? false : stryMutAct_9fa48("4094") ? true : (stryCov_9fa48("4094", "4095", "4096"), left === (stryMutAct_9fa48("4097") ? "" : (stryCov_9fa48("4097"), '*')))) return right;
    if (stryMutAct_9fa48("4100") ? right !== '*' : stryMutAct_9fa48("4099") ? false : stryMutAct_9fa48("4098") ? true : (stryCov_9fa48("4098", "4099", "4100"), right === (stryMutAct_9fa48("4101") ? "" : (stryCov_9fa48("4101"), '*')))) return left;
    if (stryMutAct_9fa48("4104") ? left !== right : stryMutAct_9fa48("4103") ? false : stryMutAct_9fa48("4102") ? true : (stryCov_9fa48("4102", "4103", "4104"), left === right)) return left;
    if (stryMutAct_9fa48("4107") ? left.startsWith('*.') || hostMatches(right, left) : stryMutAct_9fa48("4106") ? false : stryMutAct_9fa48("4105") ? true : (stryCov_9fa48("4105", "4106", "4107"), (stryMutAct_9fa48("4108") ? left.endsWith('*.') : (stryCov_9fa48("4108"), left.startsWith(stryMutAct_9fa48("4109") ? "" : (stryCov_9fa48("4109"), '*.')))) && hostMatches(right, left))) return right;
    if (stryMutAct_9fa48("4112") ? right.startsWith('*.') || hostMatches(left, right) : stryMutAct_9fa48("4111") ? false : stryMutAct_9fa48("4110") ? true : (stryCov_9fa48("4110", "4111", "4112"), (stryMutAct_9fa48("4113") ? right.endsWith('*.') : (stryCov_9fa48("4113"), right.startsWith(stryMutAct_9fa48("4114") ? "" : (stryCov_9fa48("4114"), '*.')))) && hostMatches(left, right))) return left;
    if (stryMutAct_9fa48("4117") ? left.startsWith('*.') || right.startsWith('*.') : stryMutAct_9fa48("4116") ? false : stryMutAct_9fa48("4115") ? true : (stryCov_9fa48("4115", "4116", "4117"), (stryMutAct_9fa48("4118") ? left.endsWith('*.') : (stryCov_9fa48("4118"), left.startsWith(stryMutAct_9fa48("4119") ? "" : (stryCov_9fa48("4119"), '*.')))) && (stryMutAct_9fa48("4120") ? right.endsWith('*.') : (stryCov_9fa48("4120"), right.startsWith(stryMutAct_9fa48("4121") ? "" : (stryCov_9fa48("4121"), '*.')))))) {
      if (stryMutAct_9fa48("4122")) {
        {}
      } else {
        stryCov_9fa48("4122");
        const leftSuffix = stryMutAct_9fa48("4123") ? left : (stryCov_9fa48("4123"), left.slice(2));
        const rightSuffix = stryMutAct_9fa48("4124") ? right : (stryCov_9fa48("4124"), right.slice(2));
        if (stryMutAct_9fa48("4127") ? leftSuffix.startsWith(`.${rightSuffix}`) : stryMutAct_9fa48("4126") ? false : stryMutAct_9fa48("4125") ? true : (stryCov_9fa48("4125", "4126", "4127"), leftSuffix.endsWith(stryMutAct_9fa48("4128") ? `` : (stryCov_9fa48("4128"), `.${rightSuffix}`)))) return left;
        if (stryMutAct_9fa48("4131") ? rightSuffix.startsWith(`.${leftSuffix}`) : stryMutAct_9fa48("4130") ? false : stryMutAct_9fa48("4129") ? true : (stryCov_9fa48("4129", "4130", "4131"), rightSuffix.endsWith(stryMutAct_9fa48("4132") ? `` : (stryCov_9fa48("4132"), `.${leftSuffix}`)))) return right;
      }
    }
    return undefined;
  }
}
export function resolveEgress(first?: EgressPolicy | NormalizedEgressPolicy, second?: EgressPolicy | NormalizedEgressPolicy): NormalizedEgressPolicy | undefined {
  if (stryMutAct_9fa48("4133")) {
    {}
  } else {
    stryCov_9fa48("4133");
    if (stryMutAct_9fa48("4136") ? first === undefined || second === undefined : stryMutAct_9fa48("4135") ? false : stryMutAct_9fa48("4134") ? true : (stryCov_9fa48("4134", "4135", "4136"), (stryMutAct_9fa48("4138") ? first !== undefined : stryMutAct_9fa48("4137") ? true : (stryCov_9fa48("4137", "4138"), first === undefined)) && (stryMutAct_9fa48("4140") ? second !== undefined : stryMutAct_9fa48("4139") ? true : (stryCov_9fa48("4139", "4140"), second === undefined)))) return undefined;
    if (stryMutAct_9fa48("4143") ? first !== undefined : stryMutAct_9fa48("4142") ? false : stryMutAct_9fa48("4141") ? true : (stryCov_9fa48("4141", "4142", "4143"), first === undefined)) return normalizeEgress(second!);
    if (stryMutAct_9fa48("4146") ? second !== undefined : stryMutAct_9fa48("4145") ? false : stryMutAct_9fa48("4144") ? true : (stryCov_9fa48("4144", "4145", "4146"), second === undefined)) return normalizeEgress(first);
    const left = normalizeEgress(first);
    const right = normalizeEgress(second);
    if (stryMutAct_9fa48("4149") ? left.mode === 'disabled' && right.mode === 'disabled' : stryMutAct_9fa48("4148") ? false : stryMutAct_9fa48("4147") ? true : (stryCov_9fa48("4147", "4148", "4149"), (stryMutAct_9fa48("4151") ? left.mode !== 'disabled' : stryMutAct_9fa48("4150") ? false : (stryCov_9fa48("4150", "4151"), left.mode === (stryMutAct_9fa48("4152") ? "" : (stryCov_9fa48("4152"), 'disabled')))) || (stryMutAct_9fa48("4154") ? right.mode !== 'disabled' : stryMutAct_9fa48("4153") ? false : (stryCov_9fa48("4153", "4154"), right.mode === (stryMutAct_9fa48("4155") ? "" : (stryCov_9fa48("4155"), 'disabled')))))) return normalizeEgress(stryMutAct_9fa48("4156") ? {} : (stryCov_9fa48("4156"), {
      mode: stryMutAct_9fa48("4157") ? "" : (stryCov_9fa48("4157"), 'disabled')
    }));
    const denyRules = stryMutAct_9fa48("4158") ? [...left.domain_rules, ...right.domain_rules] : (stryCov_9fa48("4158"), (stryMutAct_9fa48("4159") ? [] : (stryCov_9fa48("4159"), [...left.domain_rules, ...right.domain_rules])).filter(stryMutAct_9fa48("4160") ? () => undefined : (stryCov_9fa48("4160"), rule => stryMutAct_9fa48("4163") ? rule.action !== 'deny' : stryMutAct_9fa48("4162") ? false : stryMutAct_9fa48("4161") ? true : (stryCov_9fa48("4161", "4162", "4163"), rule.action === (stryMutAct_9fa48("4164") ? "" : (stryCov_9fa48("4164"), 'deny'))))));
    const leftAllows = stryMutAct_9fa48("4165") ? left.domain_rules.map(rule => rule.host) : (stryCov_9fa48("4165"), left.domain_rules.filter(stryMutAct_9fa48("4166") ? () => undefined : (stryCov_9fa48("4166"), rule => stryMutAct_9fa48("4169") ? rule.action !== 'allow' : stryMutAct_9fa48("4168") ? false : stryMutAct_9fa48("4167") ? true : (stryCov_9fa48("4167", "4168", "4169"), rule.action === (stryMutAct_9fa48("4170") ? "" : (stryCov_9fa48("4170"), 'allow'))))).map(stryMutAct_9fa48("4171") ? () => undefined : (stryCov_9fa48("4171"), rule => rule.host)));
    const rightAllows = stryMutAct_9fa48("4172") ? right.domain_rules.map(rule => rule.host) : (stryCov_9fa48("4172"), right.domain_rules.filter(stryMutAct_9fa48("4173") ? () => undefined : (stryCov_9fa48("4173"), rule => stryMutAct_9fa48("4176") ? rule.action !== 'allow' : stryMutAct_9fa48("4175") ? false : stryMutAct_9fa48("4174") ? true : (stryCov_9fa48("4174", "4175", "4176"), rule.action === (stryMutAct_9fa48("4177") ? "" : (stryCov_9fa48("4177"), 'allow'))))).map(stryMutAct_9fa48("4178") ? () => undefined : (stryCov_9fa48("4178"), rule => rule.host)));
    let allowHosts: string[] = stryMutAct_9fa48("4179") ? ["Stryker was here"] : (stryCov_9fa48("4179"), []);
    if (stryMutAct_9fa48("4182") ? left.mode === 'allowlist' || right.mode === 'allowlist' : stryMutAct_9fa48("4181") ? false : stryMutAct_9fa48("4180") ? true : (stryCov_9fa48("4180", "4181", "4182"), (stryMutAct_9fa48("4184") ? left.mode !== 'allowlist' : stryMutAct_9fa48("4183") ? true : (stryCov_9fa48("4183", "4184"), left.mode === (stryMutAct_9fa48("4185") ? "" : (stryCov_9fa48("4185"), 'allowlist')))) && (stryMutAct_9fa48("4187") ? right.mode !== 'allowlist' : stryMutAct_9fa48("4186") ? true : (stryCov_9fa48("4186", "4187"), right.mode === (stryMutAct_9fa48("4188") ? "" : (stryCov_9fa48("4188"), 'allowlist')))))) {
      if (stryMutAct_9fa48("4189")) {
        {}
      } else {
        stryCov_9fa48("4189");
        allowHosts = leftAllows.flatMap(stryMutAct_9fa48("4190") ? () => undefined : (stryCov_9fa48("4190"), leftHost => stryMutAct_9fa48("4191") ? rightAllows.map(rightHost => patternIntersection(leftHost, rightHost)) : (stryCov_9fa48("4191"), rightAllows.map(stryMutAct_9fa48("4192") ? () => undefined : (stryCov_9fa48("4192"), rightHost => patternIntersection(leftHost, rightHost))).filter(stryMutAct_9fa48("4193") ? () => undefined : (stryCov_9fa48("4193"), (entry): entry is string => stryMutAct_9fa48("4196") ? entry === undefined : stryMutAct_9fa48("4195") ? false : stryMutAct_9fa48("4194") ? true : (stryCov_9fa48("4194", "4195", "4196"), entry !== undefined))))));
      }
    } else if (stryMutAct_9fa48("4199") ? left.mode !== 'allowlist' : stryMutAct_9fa48("4198") ? false : stryMutAct_9fa48("4197") ? true : (stryCov_9fa48("4197", "4198", "4199"), left.mode === (stryMutAct_9fa48("4200") ? "" : (stryCov_9fa48("4200"), 'allowlist')))) {
      if (stryMutAct_9fa48("4201")) {
        {}
      } else {
        stryCov_9fa48("4201");
        allowHosts = leftAllows;
      }
    } else if (stryMutAct_9fa48("4204") ? right.mode !== 'allowlist' : stryMutAct_9fa48("4203") ? false : stryMutAct_9fa48("4202") ? true : (stryCov_9fa48("4202", "4203", "4204"), right.mode === (stryMutAct_9fa48("4205") ? "" : (stryCov_9fa48("4205"), 'allowlist')))) {
      if (stryMutAct_9fa48("4206")) {
        {}
      } else {
        stryCov_9fa48("4206");
        allowHosts = rightAllows;
      }
    }
    const mode = (stryMutAct_9fa48("4209") ? left.mode === 'allowlist' && right.mode === 'allowlist' : stryMutAct_9fa48("4208") ? false : stryMutAct_9fa48("4207") ? true : (stryCov_9fa48("4207", "4208", "4209"), (stryMutAct_9fa48("4211") ? left.mode !== 'allowlist' : stryMutAct_9fa48("4210") ? false : (stryCov_9fa48("4210", "4211"), left.mode === (stryMutAct_9fa48("4212") ? "" : (stryCov_9fa48("4212"), 'allowlist')))) || (stryMutAct_9fa48("4214") ? right.mode !== 'allowlist' : stryMutAct_9fa48("4213") ? false : (stryCov_9fa48("4213", "4214"), right.mode === (stryMutAct_9fa48("4215") ? "" : (stryCov_9fa48("4215"), 'allowlist')))))) ? stryMutAct_9fa48("4216") ? "" : (stryCov_9fa48("4216"), 'allowlist') : (stryMutAct_9fa48("4219") ? left.mode === 'denylist' && right.mode === 'denylist' : stryMutAct_9fa48("4218") ? false : stryMutAct_9fa48("4217") ? true : (stryCov_9fa48("4217", "4218", "4219"), (stryMutAct_9fa48("4221") ? left.mode !== 'denylist' : stryMutAct_9fa48("4220") ? false : (stryCov_9fa48("4220", "4221"), left.mode === (stryMutAct_9fa48("4222") ? "" : (stryCov_9fa48("4222"), 'denylist')))) || (stryMutAct_9fa48("4224") ? right.mode !== 'denylist' : stryMutAct_9fa48("4223") ? false : (stryCov_9fa48("4223", "4224"), right.mode === (stryMutAct_9fa48("4225") ? "" : (stryCov_9fa48("4225"), 'denylist')))))) ? stryMutAct_9fa48("4226") ? "" : (stryCov_9fa48("4226"), 'denylist') : stryMutAct_9fa48("4227") ? "" : (stryCov_9fa48("4227"), 'open');
    return normalizeEgress(stryMutAct_9fa48("4228") ? {} : (stryCov_9fa48("4228"), {
      mode,
      domain_rules: stryMutAct_9fa48("4229") ? [] : (stryCov_9fa48("4229"), [...denyRules, ...allowHosts.map(stryMutAct_9fa48("4230") ? () => undefined : (stryCov_9fa48("4230"), host => stryMutAct_9fa48("4231") ? {} : (stryCov_9fa48("4231"), {
        action: 'allow' as const,
        host
      })))]),
      unix_sockets: (stryMutAct_9fa48("4234") ? left.unix_sockets === 'allowlist' || right.unix_sockets === 'allowlist' : stryMutAct_9fa48("4233") ? false : stryMutAct_9fa48("4232") ? true : (stryCov_9fa48("4232", "4233", "4234"), (stryMutAct_9fa48("4236") ? left.unix_sockets !== 'allowlist' : stryMutAct_9fa48("4235") ? true : (stryCov_9fa48("4235", "4236"), left.unix_sockets === (stryMutAct_9fa48("4237") ? "" : (stryCov_9fa48("4237"), 'allowlist')))) && (stryMutAct_9fa48("4239") ? right.unix_sockets !== 'allowlist' : stryMutAct_9fa48("4238") ? true : (stryCov_9fa48("4238", "4239"), right.unix_sockets === (stryMutAct_9fa48("4240") ? "" : (stryCov_9fa48("4240"), 'allowlist')))))) ? stryMutAct_9fa48("4241") ? "" : (stryCov_9fa48("4241"), 'allowlist') : stryMutAct_9fa48("4242") ? "" : (stryCov_9fa48("4242"), 'denied'),
      allow_local_binding: stryMutAct_9fa48("4245") ? left.allow_local_binding || right.allow_local_binding : stryMutAct_9fa48("4244") ? false : stryMutAct_9fa48("4243") ? true : (stryCov_9fa48("4243", "4244", "4245"), left.allow_local_binding && right.allow_local_binding),
      socks5: stryMutAct_9fa48("4248") ? left.socks5 || right.socks5 : stryMutAct_9fa48("4247") ? false : stryMutAct_9fa48("4246") ? true : (stryCov_9fa48("4246", "4247", "4248"), left.socks5 && right.socks5)
    }));
  }
}
export function isHostAllowed(host: string, policy: EgressPolicy | NormalizedEgressPolicy): boolean {
  if (stryMutAct_9fa48("4249")) {
    {}
  } else {
    stryCov_9fa48("4249");
    const normalized = normalizeEgress(policy);
    if (stryMutAct_9fa48("4252") ? normalized.mode !== 'disabled' : stryMutAct_9fa48("4251") ? false : stryMutAct_9fa48("4250") ? true : (stryCov_9fa48("4250", "4251", "4252"), normalized.mode === (stryMutAct_9fa48("4253") ? "" : (stryCov_9fa48("4253"), 'disabled')))) return stryMutAct_9fa48("4254") ? true : (stryCov_9fa48("4254"), false);
    if (stryMutAct_9fa48("4257") ? normalized.domain_rules.every(rule => rule.action === 'deny' && hostMatches(host, rule.host)) : stryMutAct_9fa48("4256") ? false : stryMutAct_9fa48("4255") ? true : (stryCov_9fa48("4255", "4256", "4257"), normalized.domain_rules.some(stryMutAct_9fa48("4258") ? () => undefined : (stryCov_9fa48("4258"), rule => stryMutAct_9fa48("4261") ? rule.action === 'deny' || hostMatches(host, rule.host) : stryMutAct_9fa48("4260") ? false : stryMutAct_9fa48("4259") ? true : (stryCov_9fa48("4259", "4260", "4261"), (stryMutAct_9fa48("4263") ? rule.action !== 'deny' : stryMutAct_9fa48("4262") ? true : (stryCov_9fa48("4262", "4263"), rule.action === (stryMutAct_9fa48("4264") ? "" : (stryCov_9fa48("4264"), 'deny')))) && hostMatches(host, rule.host)))))) return stryMutAct_9fa48("4265") ? true : (stryCov_9fa48("4265"), false);
    if (stryMutAct_9fa48("4268") ? normalized.mode === 'open' && normalized.mode === 'denylist' : stryMutAct_9fa48("4267") ? false : stryMutAct_9fa48("4266") ? true : (stryCov_9fa48("4266", "4267", "4268"), (stryMutAct_9fa48("4270") ? normalized.mode !== 'open' : stryMutAct_9fa48("4269") ? false : (stryCov_9fa48("4269", "4270"), normalized.mode === (stryMutAct_9fa48("4271") ? "" : (stryCov_9fa48("4271"), 'open')))) || (stryMutAct_9fa48("4273") ? normalized.mode !== 'denylist' : stryMutAct_9fa48("4272") ? false : (stryCov_9fa48("4272", "4273"), normalized.mode === (stryMutAct_9fa48("4274") ? "" : (stryCov_9fa48("4274"), 'denylist')))))) return stryMutAct_9fa48("4275") ? false : (stryCov_9fa48("4275"), true);
    return stryMutAct_9fa48("4276") ? normalized.domain_rules.every(rule => rule.action === 'allow' && hostMatches(host, rule.host)) : (stryCov_9fa48("4276"), normalized.domain_rules.some(stryMutAct_9fa48("4277") ? () => undefined : (stryCov_9fa48("4277"), rule => stryMutAct_9fa48("4280") ? rule.action === 'allow' || hostMatches(host, rule.host) : stryMutAct_9fa48("4279") ? false : stryMutAct_9fa48("4278") ? true : (stryCov_9fa48("4278", "4279", "4280"), (stryMutAct_9fa48("4282") ? rule.action !== 'allow' : stryMutAct_9fa48("4281") ? true : (stryCov_9fa48("4281", "4282"), rule.action === (stryMutAct_9fa48("4283") ? "" : (stryCov_9fa48("4283"), 'allow')))) && hostMatches(host, rule.host)))));
  }
}
function isPrivateOrLocalAddress(address: string): boolean {
  if (stryMutAct_9fa48("4284")) {
    {}
  } else {
    stryCov_9fa48("4284");
    const normalized = stryMutAct_9fa48("4285") ? normalizeHost(address, false).toUpperCase() : (stryCov_9fa48("4285"), normalizeHost(address, stryMutAct_9fa48("4286") ? true : (stryCov_9fa48("4286"), false)).toLowerCase());
    const version = isIP(normalized);
    if (stryMutAct_9fa48("4289") ? version !== 4 : stryMutAct_9fa48("4288") ? false : stryMutAct_9fa48("4287") ? true : (stryCov_9fa48("4287", "4288", "4289"), version === 4)) {
      if (stryMutAct_9fa48("4290")) {
        {}
      } else {
        stryCov_9fa48("4290");
        const octets = normalized.split(stryMutAct_9fa48("4291") ? "" : (stryCov_9fa48("4291"), '.')).map(Number);
        const [a, b] = octets;
        return stryMutAct_9fa48("4294") ? (a === 0 || a === 10 || a === 127 || a === 100 && b !== undefined && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b !== undefined && b >= 16 && b <= 31) && a === 192 && b === 168 : stryMutAct_9fa48("4293") ? false : stryMutAct_9fa48("4292") ? true : (stryCov_9fa48("4292", "4293", "4294"), (stryMutAct_9fa48("4296") ? (a === 0 || a === 10 || a === 127 || a === 100 && b !== undefined && b >= 64 && b <= 127 || a === 169 && b === 254) && a === 172 && b !== undefined && b >= 16 && b <= 31 : stryMutAct_9fa48("4295") ? false : (stryCov_9fa48("4295", "4296"), (stryMutAct_9fa48("4298") ? (a === 0 || a === 10 || a === 127 || a === 100 && b !== undefined && b >= 64 && b <= 127) && a === 169 && b === 254 : stryMutAct_9fa48("4297") ? false : (stryCov_9fa48("4297", "4298"), (stryMutAct_9fa48("4300") ? (a === 0 || a === 10 || a === 127) && a === 100 && b !== undefined && b >= 64 && b <= 127 : stryMutAct_9fa48("4299") ? false : (stryCov_9fa48("4299", "4300"), (stryMutAct_9fa48("4302") ? (a === 0 || a === 10) && a === 127 : stryMutAct_9fa48("4301") ? false : (stryCov_9fa48("4301", "4302"), (stryMutAct_9fa48("4304") ? a === 0 && a === 10 : stryMutAct_9fa48("4303") ? false : (stryCov_9fa48("4303", "4304"), (stryMutAct_9fa48("4306") ? a !== 0 : stryMutAct_9fa48("4305") ? false : (stryCov_9fa48("4305", "4306"), a === 0)) || (stryMutAct_9fa48("4308") ? a !== 10 : stryMutAct_9fa48("4307") ? false : (stryCov_9fa48("4307", "4308"), a === 10)))) || (stryMutAct_9fa48("4310") ? a !== 127 : stryMutAct_9fa48("4309") ? false : (stryCov_9fa48("4309", "4310"), a === 127)))) || (stryMutAct_9fa48("4312") ? a === 100 && b !== undefined && b >= 64 || b <= 127 : stryMutAct_9fa48("4311") ? false : (stryCov_9fa48("4311", "4312"), (stryMutAct_9fa48("4314") ? a === 100 && b !== undefined || b >= 64 : stryMutAct_9fa48("4313") ? true : (stryCov_9fa48("4313", "4314"), (stryMutAct_9fa48("4316") ? a === 100 || b !== undefined : stryMutAct_9fa48("4315") ? true : (stryCov_9fa48("4315", "4316"), (stryMutAct_9fa48("4318") ? a !== 100 : stryMutAct_9fa48("4317") ? true : (stryCov_9fa48("4317", "4318"), a === 100)) && (stryMutAct_9fa48("4320") ? b === undefined : stryMutAct_9fa48("4319") ? true : (stryCov_9fa48("4319", "4320"), b !== undefined)))) && (stryMutAct_9fa48("4323") ? b < 64 : stryMutAct_9fa48("4322") ? b > 64 : stryMutAct_9fa48("4321") ? true : (stryCov_9fa48("4321", "4322", "4323"), b >= 64)))) && (stryMutAct_9fa48("4326") ? b > 127 : stryMutAct_9fa48("4325") ? b < 127 : stryMutAct_9fa48("4324") ? true : (stryCov_9fa48("4324", "4325", "4326"), b <= 127)))))) || (stryMutAct_9fa48("4328") ? a === 169 || b === 254 : stryMutAct_9fa48("4327") ? false : (stryCov_9fa48("4327", "4328"), (stryMutAct_9fa48("4330") ? a !== 169 : stryMutAct_9fa48("4329") ? true : (stryCov_9fa48("4329", "4330"), a === 169)) && (stryMutAct_9fa48("4332") ? b !== 254 : stryMutAct_9fa48("4331") ? true : (stryCov_9fa48("4331", "4332"), b === 254)))))) || (stryMutAct_9fa48("4334") ? a === 172 && b !== undefined && b >= 16 || b <= 31 : stryMutAct_9fa48("4333") ? false : (stryCov_9fa48("4333", "4334"), (stryMutAct_9fa48("4336") ? a === 172 && b !== undefined || b >= 16 : stryMutAct_9fa48("4335") ? true : (stryCov_9fa48("4335", "4336"), (stryMutAct_9fa48("4338") ? a === 172 || b !== undefined : stryMutAct_9fa48("4337") ? true : (stryCov_9fa48("4337", "4338"), (stryMutAct_9fa48("4340") ? a !== 172 : stryMutAct_9fa48("4339") ? true : (stryCov_9fa48("4339", "4340"), a === 172)) && (stryMutAct_9fa48("4342") ? b === undefined : stryMutAct_9fa48("4341") ? true : (stryCov_9fa48("4341", "4342"), b !== undefined)))) && (stryMutAct_9fa48("4345") ? b < 16 : stryMutAct_9fa48("4344") ? b > 16 : stryMutAct_9fa48("4343") ? true : (stryCov_9fa48("4343", "4344", "4345"), b >= 16)))) && (stryMutAct_9fa48("4348") ? b > 31 : stryMutAct_9fa48("4347") ? b < 31 : stryMutAct_9fa48("4346") ? true : (stryCov_9fa48("4346", "4347", "4348"), b <= 31)))))) || (stryMutAct_9fa48("4350") ? a === 192 || b === 168 : stryMutAct_9fa48("4349") ? false : (stryCov_9fa48("4349", "4350"), (stryMutAct_9fa48("4352") ? a !== 192 : stryMutAct_9fa48("4351") ? true : (stryCov_9fa48("4351", "4352"), a === 192)) && (stryMutAct_9fa48("4354") ? b !== 168 : stryMutAct_9fa48("4353") ? true : (stryCov_9fa48("4353", "4354"), b === 168)))));
      }
    }
    if (stryMutAct_9fa48("4357") ? version !== 6 : stryMutAct_9fa48("4356") ? false : stryMutAct_9fa48("4355") ? true : (stryCov_9fa48("4355", "4356", "4357"), version === 6)) {
      if (stryMutAct_9fa48("4358")) {
        {}
      } else {
        stryCov_9fa48("4358");
        const mapped = (stryMutAct_9fa48("4364") ? /^::ffff:([0-9a-f]{1,4}):([^0-9a-f]{1,4})$/u : stryMutAct_9fa48("4363") ? /^::ffff:([0-9a-f]{1,4}):([0-9a-f])$/u : stryMutAct_9fa48("4362") ? /^::ffff:([^0-9a-f]{1,4}):([0-9a-f]{1,4})$/u : stryMutAct_9fa48("4361") ? /^::ffff:([0-9a-f]):([0-9a-f]{1,4})$/u : stryMutAct_9fa48("4360") ? /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})/u : stryMutAct_9fa48("4359") ? /::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u : (stryCov_9fa48("4359", "4360", "4361", "4362", "4363", "4364"), /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u)).exec(normalized);
        if (stryMutAct_9fa48("4366") ? false : stryMutAct_9fa48("4365") ? true : (stryCov_9fa48("4365", "4366"), mapped)) {
          if (stryMutAct_9fa48("4367")) {
            {}
          } else {
            stryCov_9fa48("4367");
            const high = Number.parseInt(mapped[1]!, 16);
            const low = Number.parseInt(mapped[2]!, 16);
            return isPrivateOrLocalAddress(stryMutAct_9fa48("4368") ? `` : (stryCov_9fa48("4368"), `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`));
          }
        }
        return stryMutAct_9fa48("4371") ? (normalized === '::' || normalized === '::1' || /^f[cd]/u.test(normalized)) && /^fe[89ab]/u.test(normalized) : stryMutAct_9fa48("4370") ? false : stryMutAct_9fa48("4369") ? true : (stryCov_9fa48("4369", "4370", "4371"), (stryMutAct_9fa48("4373") ? (normalized === '::' || normalized === '::1') && /^f[cd]/u.test(normalized) : stryMutAct_9fa48("4372") ? false : (stryCov_9fa48("4372", "4373"), (stryMutAct_9fa48("4375") ? normalized === '::' && normalized === '::1' : stryMutAct_9fa48("4374") ? false : (stryCov_9fa48("4374", "4375"), (stryMutAct_9fa48("4377") ? normalized !== '::' : stryMutAct_9fa48("4376") ? false : (stryCov_9fa48("4376", "4377"), normalized === (stryMutAct_9fa48("4378") ? "" : (stryCov_9fa48("4378"), '::')))) || (stryMutAct_9fa48("4380") ? normalized !== '::1' : stryMutAct_9fa48("4379") ? false : (stryCov_9fa48("4379", "4380"), normalized === (stryMutAct_9fa48("4381") ? "" : (stryCov_9fa48("4381"), '::1')))))) || (stryMutAct_9fa48("4383") ? /^f[^cd]/u : stryMutAct_9fa48("4382") ? /f[cd]/u : (stryCov_9fa48("4382", "4383"), /^f[cd]/u)).test(normalized))) || (stryMutAct_9fa48("4385") ? /^fe[^89ab]/u : stryMutAct_9fa48("4384") ? /fe[89ab]/u : (stryCov_9fa48("4384", "4385"), /^fe[89ab]/u)).test(normalized));
      }
    }
    throw new PolicyInputError(stryMutAct_9fa48("4386") ? "" : (stryCov_9fa48("4386"), 'DNS resolver returned a non-IP address'));
  }
}
export async function validateEgressTarget(input: {
  destination: string;
  policy: EgressPolicy | NormalizedEgressPolicy;
  resolve_host: (host: string) => Promise<string[]>;
  pinned_addresses?: string[];
  redirect_from?: string;
}): Promise<EgressDecision> {
  if (stryMutAct_9fa48("4387")) {
    {}
  } else {
    stryCov_9fa48("4387");
    const normalizedPolicy = normalizeEgress(input.policy);
    const lowerDestination = stryMutAct_9fa48("4389") ? input.destination.toLowerCase() : stryMutAct_9fa48("4388") ? input.destination.trim().toUpperCase() : (stryCov_9fa48("4388", "4389"), input.destination.trim().toLowerCase());
    if (stryMutAct_9fa48("4392") ? lowerDestination.startsWith('unix:') && lowerDestination.startsWith('http+unix:') : stryMutAct_9fa48("4391") ? false : stryMutAct_9fa48("4390") ? true : (stryCov_9fa48("4390", "4391", "4392"), (stryMutAct_9fa48("4393") ? lowerDestination.endsWith('unix:') : (stryCov_9fa48("4393"), lowerDestination.startsWith(stryMutAct_9fa48("4394") ? "" : (stryCov_9fa48("4394"), 'unix:')))) || (stryMutAct_9fa48("4395") ? lowerDestination.endsWith('http+unix:') : (stryCov_9fa48("4395"), lowerDestination.startsWith(stryMutAct_9fa48("4396") ? "" : (stryCov_9fa48("4396"), 'http+unix:')))))) {
      if (stryMutAct_9fa48("4397")) {
        {}
      } else {
        stryCov_9fa48("4397");
        return deepFreeze(stryMutAct_9fa48("4398") ? {} : (stryCov_9fa48("4398"), {
          allowed: stryMutAct_9fa48("4399") ? true : (stryCov_9fa48("4399"), false),
          reason_code: stryMutAct_9fa48("4400") ? "" : (stryCov_9fa48("4400"), 'unix_socket_denied')
        }));
      }
    }
    if (stryMutAct_9fa48("4403") ? lowerDestination.startsWith('socks5:') || !normalizedPolicy.socks5 : stryMutAct_9fa48("4402") ? false : stryMutAct_9fa48("4401") ? true : (stryCov_9fa48("4401", "4402", "4403"), (stryMutAct_9fa48("4404") ? lowerDestination.endsWith('socks5:') : (stryCov_9fa48("4404"), lowerDestination.startsWith(stryMutAct_9fa48("4405") ? "" : (stryCov_9fa48("4405"), 'socks5:')))) && (stryMutAct_9fa48("4406") ? normalizedPolicy.socks5 : (stryCov_9fa48("4406"), !normalizedPolicy.socks5)))) {
      if (stryMutAct_9fa48("4407")) {
        {}
      } else {
        stryCov_9fa48("4407");
        return deepFreeze(stryMutAct_9fa48("4408") ? {} : (stryCov_9fa48("4408"), {
          allowed: stryMutAct_9fa48("4409") ? true : (stryCov_9fa48("4409"), false),
          reason_code: stryMutAct_9fa48("4410") ? "" : (stryCov_9fa48("4410"), 'socks5_denied')
        }));
      }
    }
    let parsed: URL;
    try {
      if (stryMutAct_9fa48("4411")) {
        {}
      } else {
        stryCov_9fa48("4411");
        parsed = new URL(input.destination);
      }
    } catch {
      if (stryMutAct_9fa48("4412")) {
        {}
      } else {
        stryCov_9fa48("4412");
        return deepFreeze(stryMutAct_9fa48("4413") ? {} : (stryCov_9fa48("4413"), {
          allowed: stryMutAct_9fa48("4414") ? true : (stryCov_9fa48("4414"), false),
          reason_code: stryMutAct_9fa48("4415") ? "" : (stryCov_9fa48("4415"), 'invalid_destination')
        }));
      }
    }
    if (stryMutAct_9fa48("4418") ? (!['https:', 'http:', 'socks5:'].includes(parsed.protocol) || parsed.username) && parsed.password : stryMutAct_9fa48("4417") ? false : stryMutAct_9fa48("4416") ? true : (stryCov_9fa48("4416", "4417", "4418"), (stryMutAct_9fa48("4420") ? !['https:', 'http:', 'socks5:'].includes(parsed.protocol) && parsed.username : stryMutAct_9fa48("4419") ? false : (stryCov_9fa48("4419", "4420"), (stryMutAct_9fa48("4421") ? ['https:', 'http:', 'socks5:'].includes(parsed.protocol) : (stryCov_9fa48("4421"), !(stryMutAct_9fa48("4422") ? [] : (stryCov_9fa48("4422"), [stryMutAct_9fa48("4423") ? "" : (stryCov_9fa48("4423"), 'https:'), stryMutAct_9fa48("4424") ? "" : (stryCov_9fa48("4424"), 'http:'), stryMutAct_9fa48("4425") ? "" : (stryCov_9fa48("4425"), 'socks5:')])).includes(parsed.protocol))) || parsed.username)) || parsed.password)) {
      if (stryMutAct_9fa48("4426")) {
        {}
      } else {
        stryCov_9fa48("4426");
        return deepFreeze(stryMutAct_9fa48("4427") ? {} : (stryCov_9fa48("4427"), {
          allowed: stryMutAct_9fa48("4428") ? true : (stryCov_9fa48("4428"), false),
          reason_code: stryMutAct_9fa48("4429") ? "" : (stryCov_9fa48("4429"), 'invalid_destination')
        }));
      }
    }
    let canonicalHost: string;
    try {
      if (stryMutAct_9fa48("4430")) {
        {}
      } else {
        stryCov_9fa48("4430");
        canonicalHost = normalizeHost(parsed.hostname, stryMutAct_9fa48("4431") ? true : (stryCov_9fa48("4431"), false));
      }
    } catch {
      if (stryMutAct_9fa48("4432")) {
        {}
      } else {
        stryCov_9fa48("4432");
        return deepFreeze(stryMutAct_9fa48("4433") ? {} : (stryCov_9fa48("4433"), {
          allowed: stryMutAct_9fa48("4434") ? true : (stryCov_9fa48("4434"), false),
          reason_code: stryMutAct_9fa48("4435") ? "" : (stryCov_9fa48("4435"), 'invalid_destination')
        }));
      }
    }
    if (stryMutAct_9fa48("4438") ? false : stryMutAct_9fa48("4437") ? true : stryMutAct_9fa48("4436") ? isHostAllowed(canonicalHost, normalizedPolicy) : (stryCov_9fa48("4436", "4437", "4438"), !isHostAllowed(canonicalHost, normalizedPolicy))) {
      if (stryMutAct_9fa48("4439")) {
        {}
      } else {
        stryCov_9fa48("4439");
        return deepFreeze(stryMutAct_9fa48("4440") ? {} : (stryCov_9fa48("4440"), {
          allowed: stryMutAct_9fa48("4441") ? true : (stryCov_9fa48("4441"), false),
          reason_code: stryMutAct_9fa48("4442") ? "" : (stryCov_9fa48("4442"), 'host_not_allowed')
        }));
      }
    }
    let resolved: string[];
    if (stryMutAct_9fa48("4444") ? false : stryMutAct_9fa48("4443") ? true : (stryCov_9fa48("4443", "4444"), isIP(canonicalHost))) {
      if (stryMutAct_9fa48("4445")) {
        {}
      } else {
        stryCov_9fa48("4445");
        resolved = stryMutAct_9fa48("4446") ? [] : (stryCov_9fa48("4446"), [canonicalHost]);
      }
    } else {
      if (stryMutAct_9fa48("4447")) {
        {}
      } else {
        stryCov_9fa48("4447");
        try {
          if (stryMutAct_9fa48("4448")) {
            {}
          } else {
            stryCov_9fa48("4448");
            resolved = await input.resolve_host(canonicalHost);
          }
        } catch {
          if (stryMutAct_9fa48("4449")) {
            {}
          } else {
            stryCov_9fa48("4449");
            return deepFreeze(stryMutAct_9fa48("4450") ? {} : (stryCov_9fa48("4450"), {
              allowed: stryMutAct_9fa48("4451") ? true : (stryCov_9fa48("4451"), false),
              reason_code: stryMutAct_9fa48("4452") ? "" : (stryCov_9fa48("4452"), 'dns_resolution_failed')
            }));
          }
        }
      }
    }
    if (stryMutAct_9fa48("4455") ? !Array.isArray(resolved) && resolved.length === 0 : stryMutAct_9fa48("4454") ? false : stryMutAct_9fa48("4453") ? true : (stryCov_9fa48("4453", "4454", "4455"), (stryMutAct_9fa48("4456") ? Array.isArray(resolved) : (stryCov_9fa48("4456"), !Array.isArray(resolved))) || (stryMutAct_9fa48("4458") ? resolved.length !== 0 : stryMutAct_9fa48("4457") ? false : (stryCov_9fa48("4457", "4458"), resolved.length === 0)))) {
      if (stryMutAct_9fa48("4459")) {
        {}
      } else {
        stryCov_9fa48("4459");
        return deepFreeze(stryMutAct_9fa48("4460") ? {} : (stryCov_9fa48("4460"), {
          allowed: stryMutAct_9fa48("4461") ? true : (stryCov_9fa48("4461"), false),
          reason_code: stryMutAct_9fa48("4462") ? "" : (stryCov_9fa48("4462"), 'dns_resolution_failed')
        }));
      }
    }
    let normalizedAddresses: string[];
    try {
      if (stryMutAct_9fa48("4463")) {
        {}
      } else {
        stryCov_9fa48("4463");
        normalizedAddresses = stryMutAct_9fa48("4464") ? [...new Set(resolved.map(address => normalizeHost(address, false)))] : (stryCov_9fa48("4464"), (stryMutAct_9fa48("4465") ? [] : (stryCov_9fa48("4465"), [...new Set(resolved.map(stryMutAct_9fa48("4466") ? () => undefined : (stryCov_9fa48("4466"), address => normalizeHost(address, stryMutAct_9fa48("4467") ? true : (stryCov_9fa48("4467"), false)))))])).sort());
        if (stryMutAct_9fa48("4470") ? !normalizedPolicy.allow_local_binding || normalizedAddresses.some(isPrivateOrLocalAddress) : stryMutAct_9fa48("4469") ? false : stryMutAct_9fa48("4468") ? true : (stryCov_9fa48("4468", "4469", "4470"), (stryMutAct_9fa48("4471") ? normalizedPolicy.allow_local_binding : (stryCov_9fa48("4471"), !normalizedPolicy.allow_local_binding)) && (stryMutAct_9fa48("4472") ? normalizedAddresses.every(isPrivateOrLocalAddress) : (stryCov_9fa48("4472"), normalizedAddresses.some(isPrivateOrLocalAddress))))) {
          if (stryMutAct_9fa48("4473")) {
            {}
          } else {
            stryCov_9fa48("4473");
            return deepFreeze(stryMutAct_9fa48("4474") ? {} : (stryCov_9fa48("4474"), {
              allowed: stryMutAct_9fa48("4475") ? true : (stryCov_9fa48("4475"), false),
              reason_code: stryMutAct_9fa48("4476") ? "" : (stryCov_9fa48("4476"), 'private_or_local_address')
            }));
          }
        }
      }
    } catch {
      if (stryMutAct_9fa48("4477")) {
        {}
      } else {
        stryCov_9fa48("4477");
        return deepFreeze(stryMutAct_9fa48("4478") ? {} : (stryCov_9fa48("4478"), {
          allowed: stryMutAct_9fa48("4479") ? true : (stryCov_9fa48("4479"), false),
          reason_code: stryMutAct_9fa48("4480") ? "" : (stryCov_9fa48("4480"), 'dns_resolution_failed')
        }));
      }
    }
    if (stryMutAct_9fa48("4483") ? input.pinned_addresses === undefined : stryMutAct_9fa48("4482") ? false : stryMutAct_9fa48("4481") ? true : (stryCov_9fa48("4481", "4482", "4483"), input.pinned_addresses !== undefined)) {
      if (stryMutAct_9fa48("4484")) {
        {}
      } else {
        stryCov_9fa48("4484");
        let pinned: string[];
        try {
          if (stryMutAct_9fa48("4485")) {
            {}
          } else {
            stryCov_9fa48("4485");
            pinned = stryMutAct_9fa48("4486") ? [...new Set(input.pinned_addresses.map(address => normalizeHost(address, false)))] : (stryCov_9fa48("4486"), (stryMutAct_9fa48("4487") ? [] : (stryCov_9fa48("4487"), [...new Set(input.pinned_addresses.map(stryMutAct_9fa48("4488") ? () => undefined : (stryCov_9fa48("4488"), address => normalizeHost(address, stryMutAct_9fa48("4489") ? true : (stryCov_9fa48("4489"), false)))))])).sort());
          }
        } catch {
          if (stryMutAct_9fa48("4490")) {
            {}
          } else {
            stryCov_9fa48("4490");
            return deepFreeze(stryMutAct_9fa48("4491") ? {} : (stryCov_9fa48("4491"), {
              allowed: stryMutAct_9fa48("4492") ? true : (stryCov_9fa48("4492"), false),
              reason_code: stryMutAct_9fa48("4493") ? "" : (stryCov_9fa48("4493"), 'dns_rebinding')
            }));
          }
        }
        if (stryMutAct_9fa48("4496") ? JSON.stringify(pinned) === JSON.stringify(normalizedAddresses) : stryMutAct_9fa48("4495") ? false : stryMutAct_9fa48("4494") ? true : (stryCov_9fa48("4494", "4495", "4496"), JSON.stringify(pinned) !== JSON.stringify(normalizedAddresses))) {
          if (stryMutAct_9fa48("4497")) {
            {}
          } else {
            stryCov_9fa48("4497");
            return deepFreeze(stryMutAct_9fa48("4498") ? {} : (stryCov_9fa48("4498"), {
              allowed: stryMutAct_9fa48("4499") ? true : (stryCov_9fa48("4499"), false),
              reason_code: stryMutAct_9fa48("4500") ? "" : (stryCov_9fa48("4500"), 'dns_rebinding')
            }));
          }
        }
      }
    }
    return deepFreeze(stryMutAct_9fa48("4501") ? {} : (stryCov_9fa48("4501"), {
      allowed: stryMutAct_9fa48("4502") ? false : (stryCov_9fa48("4502"), true),
      reason_code: stryMutAct_9fa48("4503") ? "" : (stryCov_9fa48("4503"), 'egress_allowed'),
      canonical_host: canonicalHost,
      resolved_addresses: normalizedAddresses
    }));
  }
}
function resourceAllowed(resourceIds: string[], prefixes: readonly string[]): boolean {
  if (stryMutAct_9fa48("4504")) {
    {}
  } else {
    stryCov_9fa48("4504");
    return stryMutAct_9fa48("4507") ? resourceIds.length > 0 || resourceIds.every(resource => prefixes.some(prefix => resource.startsWith(prefix))) : stryMutAct_9fa48("4506") ? false : stryMutAct_9fa48("4505") ? true : (stryCov_9fa48("4505", "4506", "4507"), (stryMutAct_9fa48("4510") ? resourceIds.length <= 0 : stryMutAct_9fa48("4509") ? resourceIds.length >= 0 : stryMutAct_9fa48("4508") ? true : (stryCov_9fa48("4508", "4509", "4510"), resourceIds.length > 0)) && (stryMutAct_9fa48("4511") ? resourceIds.some(resource => prefixes.some(prefix => resource.startsWith(prefix))) : (stryCov_9fa48("4511"), resourceIds.every(stryMutAct_9fa48("4512") ? () => undefined : (stryCov_9fa48("4512"), resource => stryMutAct_9fa48("4513") ? prefixes.every(prefix => resource.startsWith(prefix)) : (stryCov_9fa48("4513"), prefixes.some(stryMutAct_9fa48("4514") ? () => undefined : (stryCov_9fa48("4514"), prefix => stryMutAct_9fa48("4515") ? resource.endsWith(prefix) : (stryCov_9fa48("4515"), resource.startsWith(prefix))))))))));
  }
}
function ruleMatches(rule: Readonly<PolicyRule>, request: PolicyEvaluationRequest): boolean {
  if (stryMutAct_9fa48("4516")) {
    {}
  } else {
    stryCov_9fa48("4516");
    const toolMatches = stryMutAct_9fa48("4519") ? rule.tools.includes('*') && rule.tools.includes(request.tool_name) : stryMutAct_9fa48("4518") ? false : stryMutAct_9fa48("4517") ? true : (stryCov_9fa48("4517", "4518", "4519"), rule.tools.includes(stryMutAct_9fa48("4520") ? "" : (stryCov_9fa48("4520"), '*')) || rule.tools.includes(request.tool_name));
    return stryMutAct_9fa48("4523") ? toolMatches || resourceAllowed(request.resource_ids, rule.resource_prefixes) : stryMutAct_9fa48("4522") ? false : stryMutAct_9fa48("4521") ? true : (stryCov_9fa48("4521", "4522", "4523"), toolMatches && resourceAllowed(request.resource_ids, rule.resource_prefixes));
  }
}
export class PolicyEngine {
  readonly snapshot: Readonly<Policy>;
  readonly version: string;
  readonly policy_hash: string;
  constructor(policy: Policy) {
    if (stryMutAct_9fa48("4524")) {
      {}
    } else {
      stryCov_9fa48("4524");
      validatePolicy(policy);
      const snapshot = clone(policy);
      stryMutAct_9fa48("4525") ? snapshot.allowed_tools : (stryCov_9fa48("4525"), snapshot.allowed_tools.sort());
      stryMutAct_9fa48("4526") ? snapshot.allowed_resource_prefixes : (stryCov_9fa48("4526"), snapshot.allowed_resource_prefixes.sort());
      stryMutAct_9fa48("4527") ? snapshot.rules : (stryCov_9fa48("4527"), snapshot.rules.sort(stryMutAct_9fa48("4528") ? () => undefined : (stryCov_9fa48("4528"), (left, right) => stryMutAct_9fa48("4531") ? right.priority - left.priority && left.id.localeCompare(right.id, 'en') : stryMutAct_9fa48("4530") ? false : stryMutAct_9fa48("4529") ? true : (stryCov_9fa48("4529", "4530", "4531"), (stryMutAct_9fa48("4532") ? right.priority + left.priority : (stryCov_9fa48("4532"), right.priority - left.priority)) || left.id.localeCompare(right.id, stryMutAct_9fa48("4533") ? "" : (stryCov_9fa48("4533"), 'en'))))));
      this.snapshot = deepFreeze(snapshot);
      this.version = snapshot.version;
      this.policy_hash = hashValue(snapshot);
    }
  }
  evaluate(request: PolicyEvaluationRequest): PolicyDecision {
    if (stryMutAct_9fa48("4534")) {
      {}
    } else {
      stryCov_9fa48("4534");
      if (stryMutAct_9fa48("4537") ? (!isRecord(request) || typeof request.tool_name !== 'string') && request.tool_name.length === 0 : stryMutAct_9fa48("4536") ? false : stryMutAct_9fa48("4535") ? true : (stryCov_9fa48("4535", "4536", "4537"), (stryMutAct_9fa48("4539") ? !isRecord(request) && typeof request.tool_name !== 'string' : stryMutAct_9fa48("4538") ? false : (stryCov_9fa48("4538", "4539"), (stryMutAct_9fa48("4540") ? isRecord(request) : (stryCov_9fa48("4540"), !isRecord(request))) || (stryMutAct_9fa48("4542") ? typeof request.tool_name === 'string' : stryMutAct_9fa48("4541") ? false : (stryCov_9fa48("4541", "4542"), typeof request.tool_name !== (stryMutAct_9fa48("4543") ? "" : (stryCov_9fa48("4543"), 'string')))))) || (stryMutAct_9fa48("4545") ? request.tool_name.length !== 0 : stryMutAct_9fa48("4544") ? false : (stryCov_9fa48("4544", "4545"), request.tool_name.length === 0)))) {
        if (stryMutAct_9fa48("4546")) {
          {}
        } else {
          stryCov_9fa48("4546");
          throw new PolicyInputError(stryMutAct_9fa48("4547") ? "" : (stryCov_9fa48("4547"), 'invalid policy evaluation request'));
        }
      }
      if (stryMutAct_9fa48("4550") ? !Array.isArray(request.resource_ids) && request.resource_ids.some(entry => typeof entry !== 'string') : stryMutAct_9fa48("4549") ? false : stryMutAct_9fa48("4548") ? true : (stryCov_9fa48("4548", "4549", "4550"), (stryMutAct_9fa48("4551") ? Array.isArray(request.resource_ids) : (stryCov_9fa48("4551"), !Array.isArray(request.resource_ids))) || (stryMutAct_9fa48("4552") ? request.resource_ids.every(entry => typeof entry !== 'string') : (stryCov_9fa48("4552"), request.resource_ids.some(stryMutAct_9fa48("4553") ? () => undefined : (stryCov_9fa48("4553"), entry => stryMutAct_9fa48("4556") ? typeof entry === 'string' : stryMutAct_9fa48("4555") ? false : stryMutAct_9fa48("4554") ? true : (stryCov_9fa48("4554", "4555", "4556"), typeof entry !== (stryMutAct_9fa48("4557") ? "" : (stryCov_9fa48("4557"), 'string'))))))))) {
        if (stryMutAct_9fa48("4558")) {
          {}
        } else {
          stryCov_9fa48("4558");
          throw new PolicyInputError(stryMutAct_9fa48("4559") ? "" : (stryCov_9fa48("4559"), 'invalid resource ids'));
        }
      }
      const tier = deriveRiskTier(request.risk, this.snapshot as Policy, request.context);
      if (stryMutAct_9fa48("4562") ? false : stryMutAct_9fa48("4561") ? true : stryMutAct_9fa48("4560") ? this.snapshot.allowed_tools.includes(request.tool_name) : (stryCov_9fa48("4560", "4561", "4562"), !this.snapshot.allowed_tools.includes(request.tool_name))) {
        if (stryMutAct_9fa48("4563")) {
          {}
        } else {
          stryCov_9fa48("4563");
          return this.decision(stryMutAct_9fa48("4564") ? true : (stryCov_9fa48("4564"), false), stryMutAct_9fa48("4565") ? "" : (stryCov_9fa48("4565"), 'tool_not_allowed'), tier, request, null);
        }
      }
      if (stryMutAct_9fa48("4568") ? false : stryMutAct_9fa48("4567") ? true : stryMutAct_9fa48("4566") ? resourceAllowed(request.resource_ids, this.snapshot.allowed_resource_prefixes) : (stryCov_9fa48("4566", "4567", "4568"), !resourceAllowed(request.resource_ids, this.snapshot.allowed_resource_prefixes))) {
        if (stryMutAct_9fa48("4569")) {
          {}
        } else {
          stryCov_9fa48("4569");
          return this.decision(stryMutAct_9fa48("4570") ? true : (stryCov_9fa48("4570"), false), stryMutAct_9fa48("4571") ? "" : (stryCov_9fa48("4571"), 'resource_not_allowed'), tier, request, null);
        }
      }
      const matching = stryMutAct_9fa48("4572") ? this.snapshot.rules : (stryCov_9fa48("4572"), this.snapshot.rules.filter(stryMutAct_9fa48("4573") ? () => undefined : (stryCov_9fa48("4573"), rule => ruleMatches(rule, request))));
      const denied = matching.find(stryMutAct_9fa48("4574") ? () => undefined : (stryCov_9fa48("4574"), rule => stryMutAct_9fa48("4577") ? rule.effect !== 'deny' : stryMutAct_9fa48("4576") ? false : stryMutAct_9fa48("4575") ? true : (stryCov_9fa48("4575", "4576", "4577"), rule.effect === (stryMutAct_9fa48("4578") ? "" : (stryCov_9fa48("4578"), 'deny')))));
      if (stryMutAct_9fa48("4580") ? false : stryMutAct_9fa48("4579") ? true : (stryCov_9fa48("4579", "4580"), denied)) return this.decision(stryMutAct_9fa48("4581") ? true : (stryCov_9fa48("4581"), false), stryMutAct_9fa48("4582") ? "" : (stryCov_9fa48("4582"), 'explicit_deny'), tier, request, denied);
      const allowed = matching.find(stryMutAct_9fa48("4583") ? () => undefined : (stryCov_9fa48("4583"), rule => stryMutAct_9fa48("4586") ? rule.effect !== 'allow' : stryMutAct_9fa48("4585") ? false : stryMutAct_9fa48("4584") ? true : (stryCov_9fa48("4584", "4585", "4586"), rule.effect === (stryMutAct_9fa48("4587") ? "" : (stryCov_9fa48("4587"), 'allow')))));
      if (stryMutAct_9fa48("4590") ? false : stryMutAct_9fa48("4589") ? true : stryMutAct_9fa48("4588") ? allowed : (stryCov_9fa48("4588", "4589", "4590"), !allowed)) return this.decision(stryMutAct_9fa48("4591") ? true : (stryCov_9fa48("4591"), false), stryMutAct_9fa48("4592") ? "" : (stryCov_9fa48("4592"), 'default_deny'), tier, request, null);
      if (stryMutAct_9fa48("4595") ? allowed.maximum_risk_tier !== undefined || tier > allowed.maximum_risk_tier : stryMutAct_9fa48("4594") ? false : stryMutAct_9fa48("4593") ? true : (stryCov_9fa48("4593", "4594", "4595"), (stryMutAct_9fa48("4597") ? allowed.maximum_risk_tier === undefined : stryMutAct_9fa48("4596") ? true : (stryCov_9fa48("4596", "4597"), allowed.maximum_risk_tier !== undefined)) && (stryMutAct_9fa48("4600") ? tier <= allowed.maximum_risk_tier : stryMutAct_9fa48("4599") ? tier >= allowed.maximum_risk_tier : stryMutAct_9fa48("4598") ? true : (stryCov_9fa48("4598", "4599", "4600"), tier > allowed.maximum_risk_tier)))) {
        if (stryMutAct_9fa48("4601")) {
          {}
        } else {
          stryCov_9fa48("4601");
          return this.decision(stryMutAct_9fa48("4602") ? true : (stryCov_9fa48("4602"), false), stryMutAct_9fa48("4603") ? "" : (stryCov_9fa48("4603"), 'risk_tier_exceeded'), tier, request, allowed);
        }
      }
      const authorityEgress = resolveEgress(this.snapshot.egress_policy, allowed.egress_policy);
      const effectiveEgress = resolveEgress(request.risk.egress_policy, authorityEgress);
      if (stryMutAct_9fa48("4606") ? request.risk.network_access || request.risk.egress_policy === undefined : stryMutAct_9fa48("4605") ? false : stryMutAct_9fa48("4604") ? true : (stryCov_9fa48("4604", "4605", "4606"), request.risk.network_access && (stryMutAct_9fa48("4608") ? request.risk.egress_policy !== undefined : stryMutAct_9fa48("4607") ? true : (stryCov_9fa48("4607", "4608"), request.risk.egress_policy === undefined)))) {
        if (stryMutAct_9fa48("4609")) {
          {}
        } else {
          stryCov_9fa48("4609");
          return this.decision(stryMutAct_9fa48("4610") ? true : (stryCov_9fa48("4610"), false), stryMutAct_9fa48("4611") ? "" : (stryCov_9fa48("4611"), 'missing_egress_policy'), tier, request, allowed);
        }
      }
      if (stryMutAct_9fa48("4614") ? request.risk.network_access || effectiveEgress?.mode === 'disabled' : stryMutAct_9fa48("4613") ? false : stryMutAct_9fa48("4612") ? true : (stryCov_9fa48("4612", "4613", "4614"), request.risk.network_access && (stryMutAct_9fa48("4616") ? effectiveEgress?.mode !== 'disabled' : stryMutAct_9fa48("4615") ? true : (stryCov_9fa48("4615", "4616"), (stryMutAct_9fa48("4617") ? effectiveEgress.mode : (stryCov_9fa48("4617"), effectiveEgress?.mode)) === (stryMutAct_9fa48("4618") ? "" : (stryCov_9fa48("4618"), 'disabled')))))) {
        if (stryMutAct_9fa48("4619")) {
          {}
        } else {
          stryCov_9fa48("4619");
          return this.decision(stryMutAct_9fa48("4620") ? true : (stryCov_9fa48("4620"), false), stryMutAct_9fa48("4621") ? "" : (stryCov_9fa48("4621"), 'egress_disabled'), tier, request, allowed, effectiveEgress);
        }
      }
      return this.decision(stryMutAct_9fa48("4622") ? false : (stryCov_9fa48("4622"), true), stryMutAct_9fa48("4623") ? "" : (stryCov_9fa48("4623"), 'allowed'), tier, request, allowed, effectiveEgress);
    }
  }
  private decision(allowed: boolean, reasonCode: PolicyDecision['reason_code'], tier: DerivedRiskTier, request: PolicyEvaluationRequest, rule: Readonly<PolicyRule> | null, egressPolicy?: NormalizedEgressPolicy): PolicyDecision {
    if (stryMutAct_9fa48("4624")) {
      {}
    } else {
      stryCov_9fa48("4624");
      const semanticDecision = stryMutAct_9fa48("4625") ? {} : (stryCov_9fa48("4625"), {
        allowed,
        reason_code: reasonCode,
        derived_risk_tier: tier,
        policy_version: this.version,
        policy_hash: this.policy_hash,
        matched_rule_id: stryMutAct_9fa48("4626") ? rule?.id && null : (stryCov_9fa48("4626"), (stryMutAct_9fa48("4627") ? rule.id : (stryCov_9fa48("4627"), rule?.id)) ?? null),
        ...((stryMutAct_9fa48("4630") ? egressPolicy !== undefined : stryMutAct_9fa48("4629") ? false : stryMutAct_9fa48("4628") ? true : (stryCov_9fa48("4628", "4629", "4630"), egressPolicy === undefined)) ? {} : stryMutAct_9fa48("4631") ? {} : (stryCov_9fa48("4631"), {
          egress_policy: egressPolicy
        }))
      });
      return deepFreeze(stryMutAct_9fa48("4632") ? {} : (stryCov_9fa48("4632"), {
        ...semanticDecision,
        decided_at: request.context.now,
        decision_hash: hashValue(semanticDecision)
      }));
    }
  }
}