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
import type { ActionManifest } from '../../spec/types/action-manifest.js';
import type { CapabilityToken } from '../../spec/types/capability-token.js';
import type { EffectRisk } from '../../spec/types/effect-risk.js';
import { PolicyEngine, isStrictDateTime, validateEgressTarget, type DerivedRiskTier, type PolicyContext } from './policy-engine.js';
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
    if (stryMutAct_9fa48("3006")) {
      {}
    } else {
      stryCov_9fa48("3006");
      super(stryMutAct_9fa48("3007") ? `` : (stryCov_9fa48("3007"), `Policy enforcement denied: ${reasonCode}`));
      this.name = stryMutAct_9fa48("3008") ? "" : (stryCov_9fa48("3008"), 'PepDeniedError');
      this.reason_code = reasonCode;
    }
  }
}
function deepFreeze<T>(value: T): T {
  if (stryMutAct_9fa48("3009")) {
    {}
  } else {
    stryCov_9fa48("3009");
    if (stryMutAct_9fa48("3012") ? typeof value !== 'object' && typeof value !== 'function' && value === null : stryMutAct_9fa48("3011") ? false : stryMutAct_9fa48("3010") ? true : (stryCov_9fa48("3010", "3011", "3012"), (stryMutAct_9fa48("3014") ? typeof value !== 'object' || typeof value !== 'function' : stryMutAct_9fa48("3013") ? false : (stryCov_9fa48("3013", "3014"), (stryMutAct_9fa48("3016") ? typeof value === 'object' : stryMutAct_9fa48("3015") ? true : (stryCov_9fa48("3015", "3016"), typeof value !== (stryMutAct_9fa48("3017") ? "" : (stryCov_9fa48("3017"), 'object')))) && (stryMutAct_9fa48("3019") ? typeof value === 'function' : stryMutAct_9fa48("3018") ? true : (stryCov_9fa48("3018", "3019"), typeof value !== (stryMutAct_9fa48("3020") ? "" : (stryCov_9fa48("3020"), 'function')))))) || (stryMutAct_9fa48("3022") ? value !== null : stryMutAct_9fa48("3021") ? false : (stryCov_9fa48("3021", "3022"), value === null)))) return value;
    if (stryMutAct_9fa48("3024") ? false : stryMutAct_9fa48("3023") ? true : (stryCov_9fa48("3023", "3024"), Object.isFrozen(value))) return value;
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value);
  }
}
function strictTimestamp(value: unknown): number | undefined {
  if (stryMutAct_9fa48("3025")) {
    {}
  } else {
    stryCov_9fa48("3025");
    return isStrictDateTime(value) ? Date.parse(value) : undefined;
  }
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
    if (stryMutAct_9fa48("3026")) {
      {}
    } else {
      stryCov_9fa48("3026");
      if (stryMutAct_9fa48("3029") ? false : stryMutAct_9fa48("3028") ? true : stryMutAct_9fa48("3027") ? options.policy_engine instanceof PolicyEngine : (stryCov_9fa48("3027", "3028", "3029"), !(options.policy_engine instanceof PolicyEngine))) {
        if (stryMutAct_9fa48("3030")) {
          {}
        } else {
          stryCov_9fa48("3030");
          throw new TypeError(stryMutAct_9fa48("3031") ? "" : (stryCov_9fa48("3031"), 'policy_engine is required'));
        }
      }
      if (stryMutAct_9fa48("3034") ? typeof options.capability_authority?.verify_signature !== 'function' && typeof options.capability_authority.consume !== 'function' : stryMutAct_9fa48("3033") ? false : stryMutAct_9fa48("3032") ? true : (stryCov_9fa48("3032", "3033", "3034"), (stryMutAct_9fa48("3036") ? typeof options.capability_authority?.verify_signature === 'function' : stryMutAct_9fa48("3035") ? false : (stryCov_9fa48("3035", "3036"), typeof (stryMutAct_9fa48("3037") ? options.capability_authority.verify_signature : (stryCov_9fa48("3037"), options.capability_authority?.verify_signature)) !== (stryMutAct_9fa48("3038") ? "" : (stryCov_9fa48("3038"), 'function')))) || (stryMutAct_9fa48("3040") ? typeof options.capability_authority.consume === 'function' : stryMutAct_9fa48("3039") ? false : (stryCov_9fa48("3039", "3040"), typeof options.capability_authority.consume !== (stryMutAct_9fa48("3041") ? "" : (stryCov_9fa48("3041"), 'function')))))) {
        if (stryMutAct_9fa48("3042")) {
          {}
        } else {
          stryCov_9fa48("3042");
          throw new TypeError(stryMutAct_9fa48("3043") ? "" : (stryCov_9fa48("3043"), 'capability_authority is required'));
        }
      }
      if (stryMutAct_9fa48("3046") ? typeof options.audit_sink?.write === 'function' : stryMutAct_9fa48("3045") ? false : stryMutAct_9fa48("3044") ? true : (stryCov_9fa48("3044", "3045", "3046"), typeof (stryMutAct_9fa48("3047") ? options.audit_sink.write : (stryCov_9fa48("3047"), options.audit_sink?.write)) !== (stryMutAct_9fa48("3048") ? "" : (stryCov_9fa48("3048"), 'function')))) throw new TypeError(stryMutAct_9fa48("3049") ? "" : (stryCov_9fa48("3049"), 'audit_sink is required'));
      if (stryMutAct_9fa48("3052") ? typeof options.now === 'function' : stryMutAct_9fa48("3051") ? false : stryMutAct_9fa48("3050") ? true : (stryCov_9fa48("3050", "3051", "3052"), typeof options.now !== (stryMutAct_9fa48("3053") ? "" : (stryCov_9fa48("3053"), 'function')))) throw new TypeError(stryMutAct_9fa48("3054") ? "" : (stryCov_9fa48("3054"), 'now is required'));
      this.#policyEngine = options.policy_engine;
      this.#verifySignature = options.capability_authority.verify_signature.bind(options.capability_authority);
      this.#consume = options.capability_authority.consume.bind(options.capability_authority);
      this.#writeAudit = options.audit_sink.write.bind(options.audit_sink);
      this.#now = options.now;
    }
  }
  async enforce<T>(request: PepRequest, execute: (authorization: PepAuthorization) => Promise<T>): Promise<T> {
    if (stryMutAct_9fa48("3055")) {
      {}
    } else {
      stryCov_9fa48("3055");
      if (stryMutAct_9fa48("3058") ? typeof execute === 'function' : stryMutAct_9fa48("3057") ? false : stryMutAct_9fa48("3056") ? true : (stryCov_9fa48("3056", "3057", "3058"), typeof execute !== (stryMutAct_9fa48("3059") ? "" : (stryCov_9fa48("3059"), 'function')))) throw new TypeError(stryMutAct_9fa48("3060") ? "" : (stryCov_9fa48("3060"), 'execute must be a function'));
      const now = this.#now();
      const policyContext = stryMutAct_9fa48("3061") ? {} : (stryCov_9fa48("3061"), {
        ...request.context,
        now
      });
      let tier: DerivedRiskTier | null = null;
      let decision;
      try {
        if (stryMutAct_9fa48("3062")) {
          {}
        } else {
          stryCov_9fa48("3062");
          decision = this.#policyEngine.evaluate(stryMutAct_9fa48("3063") ? {} : (stryCov_9fa48("3063"), {
            tool_name: request.manifest.tool_name,
            resource_ids: request.manifest.resource_ids,
            risk: request.risk,
            context: policyContext
          }));
          tier = decision.derived_risk_tier;
        }
      } catch {
        if (stryMutAct_9fa48("3064")) {
          {}
        } else {
          stryCov_9fa48("3064");
          return this.#deny(request, stryMutAct_9fa48("3065") ? "" : (stryCov_9fa48("3065"), 'invalid_policy_input'), tier);
        }
      }
      if (stryMutAct_9fa48("3068") ? false : stryMutAct_9fa48("3067") ? true : stryMutAct_9fa48("3066") ? decision.allowed : (stryCov_9fa48("3066", "3067", "3068"), !decision.allowed)) return this.#deny(request, stryMutAct_9fa48("3069") ? "" : (stryCov_9fa48("3069"), 'policy_denied'), tier);
      if (stryMutAct_9fa48("3072") ? request.context.policy_hash === this.#policyEngine.policy_hash : stryMutAct_9fa48("3071") ? false : stryMutAct_9fa48("3070") ? true : (stryCov_9fa48("3070", "3071", "3072"), request.context.policy_hash !== this.#policyEngine.policy_hash)) {
        if (stryMutAct_9fa48("3073")) {
          {}
        } else {
          stryCov_9fa48("3073");
          return this.#deny(request, stryMutAct_9fa48("3074") ? "" : (stryCov_9fa48("3074"), 'wrong_policy_hash'), tier);
        }
      }
      if (stryMutAct_9fa48("3077") ? request.manifest.policy_version === this.#policyEngine.version : stryMutAct_9fa48("3076") ? false : stryMutAct_9fa48("3075") ? true : (stryCov_9fa48("3075", "3076", "3077"), request.manifest.policy_version !== this.#policyEngine.version)) {
        if (stryMutAct_9fa48("3078")) {
          {}
        } else {
          stryCov_9fa48("3078");
          return this.#deny(request, stryMutAct_9fa48("3079") ? "" : (stryCov_9fa48("3079"), 'wrong_policy_version'), tier);
        }
      }
      let signatureValid: boolean;
      try {
        if (stryMutAct_9fa48("3080")) {
          {}
        } else {
          stryCov_9fa48("3080");
          signatureValid = await this.#verifySignature(request.token);
        }
      } catch {
        if (stryMutAct_9fa48("3081")) {
          {}
        } else {
          stryCov_9fa48("3081");
          signatureValid = stryMutAct_9fa48("3082") ? true : (stryCov_9fa48("3082"), false);
        }
      }
      if (stryMutAct_9fa48("3085") ? false : stryMutAct_9fa48("3084") ? true : stryMutAct_9fa48("3083") ? signatureValid : (stryCov_9fa48("3083", "3084", "3085"), !signatureValid)) return this.#deny(request, stryMutAct_9fa48("3086") ? "" : (stryCov_9fa48("3086"), 'invalid_signature'), tier);
      const issuedAt = strictTimestamp(request.token.issued_at);
      const notBefore = strictTimestamp(request.token.not_before);
      const expiresAt = strictTimestamp(request.token.expires_at);
      const nowValue = strictTimestamp(now);
      if (stryMutAct_9fa48("3089") ? (issuedAt === undefined || notBefore === undefined || expiresAt === undefined) && nowValue === undefined : stryMutAct_9fa48("3088") ? false : stryMutAct_9fa48("3087") ? true : (stryCov_9fa48("3087", "3088", "3089"), (stryMutAct_9fa48("3091") ? (issuedAt === undefined || notBefore === undefined) && expiresAt === undefined : stryMutAct_9fa48("3090") ? false : (stryCov_9fa48("3090", "3091"), (stryMutAct_9fa48("3093") ? issuedAt === undefined && notBefore === undefined : stryMutAct_9fa48("3092") ? false : (stryCov_9fa48("3092", "3093"), (stryMutAct_9fa48("3095") ? issuedAt !== undefined : stryMutAct_9fa48("3094") ? false : (stryCov_9fa48("3094", "3095"), issuedAt === undefined)) || (stryMutAct_9fa48("3097") ? notBefore !== undefined : stryMutAct_9fa48("3096") ? false : (stryCov_9fa48("3096", "3097"), notBefore === undefined)))) || (stryMutAct_9fa48("3099") ? expiresAt !== undefined : stryMutAct_9fa48("3098") ? false : (stryCov_9fa48("3098", "3099"), expiresAt === undefined)))) || (stryMutAct_9fa48("3101") ? nowValue !== undefined : stryMutAct_9fa48("3100") ? false : (stryCov_9fa48("3100", "3101"), nowValue === undefined)))) {
        if (stryMutAct_9fa48("3102")) {
          {}
        } else {
          stryCov_9fa48("3102");
          return this.#deny(request, stryMutAct_9fa48("3103") ? "" : (stryCov_9fa48("3103"), 'invalid_time'), tier);
        }
      }
      if (stryMutAct_9fa48("3106") ? issuedAt > notBefore && notBefore >= expiresAt : stryMutAct_9fa48("3105") ? false : stryMutAct_9fa48("3104") ? true : (stryCov_9fa48("3104", "3105", "3106"), (stryMutAct_9fa48("3109") ? issuedAt <= notBefore : stryMutAct_9fa48("3108") ? issuedAt >= notBefore : stryMutAct_9fa48("3107") ? false : (stryCov_9fa48("3107", "3108", "3109"), issuedAt > notBefore)) || (stryMutAct_9fa48("3112") ? notBefore < expiresAt : stryMutAct_9fa48("3111") ? notBefore > expiresAt : stryMutAct_9fa48("3110") ? false : (stryCov_9fa48("3110", "3111", "3112"), notBefore >= expiresAt)))) {
        if (stryMutAct_9fa48("3113")) {
          {}
        } else {
          stryCov_9fa48("3113");
          return this.#deny(request, stryMutAct_9fa48("3114") ? "" : (stryCov_9fa48("3114"), 'invalid_time_order'), tier);
        }
      }
      if (stryMutAct_9fa48("3118") ? nowValue >= notBefore : stryMutAct_9fa48("3117") ? nowValue <= notBefore : stryMutAct_9fa48("3116") ? false : stryMutAct_9fa48("3115") ? true : (stryCov_9fa48("3115", "3116", "3117", "3118"), nowValue < notBefore)) return this.#deny(request, stryMutAct_9fa48("3119") ? "" : (stryCov_9fa48("3119"), 'not_yet_valid'), tier);
      if (stryMutAct_9fa48("3123") ? nowValue < expiresAt : stryMutAct_9fa48("3122") ? nowValue > expiresAt : stryMutAct_9fa48("3121") ? false : stryMutAct_9fa48("3120") ? true : (stryCov_9fa48("3120", "3121", "3122", "3123"), nowValue >= expiresAt)) return this.#deny(request, stryMutAct_9fa48("3124") ? "" : (stryCov_9fa48("3124"), 'expired'), tier);
      const manifestExpiresAt = strictTimestamp(request.manifest.expires_at);
      if (stryMutAct_9fa48("3127") ? manifestExpiresAt !== undefined : stryMutAct_9fa48("3126") ? false : stryMutAct_9fa48("3125") ? true : (stryCov_9fa48("3125", "3126", "3127"), manifestExpiresAt === undefined)) return this.#deny(request, stryMutAct_9fa48("3128") ? "" : (stryCov_9fa48("3128"), 'invalid_manifest_time'), tier);
      if (stryMutAct_9fa48("3132") ? nowValue < manifestExpiresAt : stryMutAct_9fa48("3131") ? nowValue > manifestExpiresAt : stryMutAct_9fa48("3130") ? false : stryMutAct_9fa48("3129") ? true : (stryCov_9fa48("3129", "3130", "3131", "3132"), nowValue >= manifestExpiresAt)) return this.#deny(request, stryMutAct_9fa48("3133") ? "" : (stryCov_9fa48("3133"), 'manifest_expired'), tier);
      if (stryMutAct_9fa48("3136") ? request.token.use_limit === 1 : stryMutAct_9fa48("3135") ? false : stryMutAct_9fa48("3134") ? true : (stryCov_9fa48("3134", "3135", "3136"), request.token.use_limit !== 1)) return this.#deny(request, stryMutAct_9fa48("3137") ? "" : (stryCov_9fa48("3137"), 'invalid_use_limit'), tier);
      const mismatches: Array<[boolean, string]> = stryMutAct_9fa48("3138") ? [] : (stryCov_9fa48("3138"), [stryMutAct_9fa48("3139") ? [] : (stryCov_9fa48("3139"), [stryMutAct_9fa48("3142") ? request.token.tenant_id === request.context.tenant_id : stryMutAct_9fa48("3141") ? false : stryMutAct_9fa48("3140") ? true : (stryCov_9fa48("3140", "3141", "3142"), request.token.tenant_id !== request.context.tenant_id), stryMutAct_9fa48("3143") ? "" : (stryCov_9fa48("3143"), 'wrong_tenant')]), stryMutAct_9fa48("3144") ? [] : (stryCov_9fa48("3144"), [stryMutAct_9fa48("3147") ? request.token.audience === request.context.audience : stryMutAct_9fa48("3146") ? false : stryMutAct_9fa48("3145") ? true : (stryCov_9fa48("3145", "3146", "3147"), request.token.audience !== request.context.audience), stryMutAct_9fa48("3148") ? "" : (stryCov_9fa48("3148"), 'wrong_audience')]), stryMutAct_9fa48("3149") ? [] : (stryCov_9fa48("3149"), [stryMutAct_9fa48("3152") ? request.token.subject_workload === request.context.subject_workload : stryMutAct_9fa48("3151") ? false : stryMutAct_9fa48("3150") ? true : (stryCov_9fa48("3150", "3151", "3152"), request.token.subject_workload !== request.context.subject_workload), stryMutAct_9fa48("3153") ? "" : (stryCov_9fa48("3153"), 'wrong_workload')]), stryMutAct_9fa48("3154") ? [] : (stryCov_9fa48("3154"), [stryMutAct_9fa48("3157") ? request.token.operation_id === request.context.operation_id : stryMutAct_9fa48("3156") ? false : stryMutAct_9fa48("3155") ? true : (stryCov_9fa48("3155", "3156", "3157"), request.token.operation_id !== request.context.operation_id), stryMutAct_9fa48("3158") ? "" : (stryCov_9fa48("3158"), 'wrong_operation')]), stryMutAct_9fa48("3159") ? [] : (stryCov_9fa48("3159"), [stryMutAct_9fa48("3162") ? request.token.attempt_id === request.context.attempt_id : stryMutAct_9fa48("3161") ? false : stryMutAct_9fa48("3160") ? true : (stryCov_9fa48("3160", "3161", "3162"), request.token.attempt_id !== request.context.attempt_id), stryMutAct_9fa48("3163") ? "" : (stryCov_9fa48("3163"), 'wrong_attempt')]), stryMutAct_9fa48("3164") ? [] : (stryCov_9fa48("3164"), [stryMutAct_9fa48("3167") ? request.token.execution_epoch === request.context.execution_epoch : stryMutAct_9fa48("3166") ? false : stryMutAct_9fa48("3165") ? true : (stryCov_9fa48("3165", "3166", "3167"), request.token.execution_epoch !== request.context.execution_epoch), stryMutAct_9fa48("3168") ? "" : (stryCov_9fa48("3168"), 'wrong_execution_epoch')]), stryMutAct_9fa48("3169") ? [] : (stryCov_9fa48("3169"), [stryMutAct_9fa48("3172") ? request.token.manifest_hash === request.manifest.manifest_hash : stryMutAct_9fa48("3171") ? false : stryMutAct_9fa48("3170") ? true : (stryCov_9fa48("3170", "3171", "3172"), request.token.manifest_hash !== request.manifest.manifest_hash), stryMutAct_9fa48("3173") ? "" : (stryCov_9fa48("3173"), 'wrong_manifest_hash')]), stryMutAct_9fa48("3174") ? [] : (stryCov_9fa48("3174"), [stryMutAct_9fa48("3177") ? request.token.tool_grant_hash === request.context.tool_grant_hash : stryMutAct_9fa48("3176") ? false : stryMutAct_9fa48("3175") ? true : (stryCov_9fa48("3175", "3176", "3177"), request.token.tool_grant_hash !== request.context.tool_grant_hash), stryMutAct_9fa48("3178") ? "" : (stryCov_9fa48("3178"), 'wrong_tool_grant')]), stryMutAct_9fa48("3179") ? [] : (stryCov_9fa48("3179"), [stryMutAct_9fa48("3182") ? request.token.resource_grant_hash === request.context.resource_grant_hash : stryMutAct_9fa48("3181") ? false : stryMutAct_9fa48("3180") ? true : (stryCov_9fa48("3180", "3181", "3182"), request.token.resource_grant_hash !== request.context.resource_grant_hash), stryMutAct_9fa48("3183") ? "" : (stryCov_9fa48("3183"), 'wrong_resource_grant')]), stryMutAct_9fa48("3184") ? [] : (stryCov_9fa48("3184"), [stryMutAct_9fa48("3187") ? request.token.budget_ceiling_hash === request.context.budget_ceiling_hash : stryMutAct_9fa48("3186") ? false : stryMutAct_9fa48("3185") ? true : (stryCov_9fa48("3185", "3186", "3187"), request.token.budget_ceiling_hash !== request.context.budget_ceiling_hash), stryMutAct_9fa48("3188") ? "" : (stryCov_9fa48("3188"), 'wrong_budget_ceiling')]), stryMutAct_9fa48("3189") ? [] : (stryCov_9fa48("3189"), [stryMutAct_9fa48("3192") ? request.token.tool_effect_contract_hash === request.context.tool_effect_contract_hash : stryMutAct_9fa48("3191") ? false : stryMutAct_9fa48("3190") ? true : (stryCov_9fa48("3190", "3191", "3192"), request.token.tool_effect_contract_hash !== request.context.tool_effect_contract_hash), stryMutAct_9fa48("3193") ? "" : (stryCov_9fa48("3193"), 'wrong_tool_effect_contract')]), stryMutAct_9fa48("3194") ? [] : (stryCov_9fa48("3194"), [stryMutAct_9fa48("3197") ? request.token.confirmation_key_thumbprint === request.context.confirmation_key_thumbprint : stryMutAct_9fa48("3196") ? false : stryMutAct_9fa48("3195") ? true : (stryCov_9fa48("3195", "3196", "3197"), request.token.confirmation_key_thumbprint !== request.context.confirmation_key_thumbprint), stryMutAct_9fa48("3198") ? "" : (stryCov_9fa48("3198"), 'wrong_confirmation_key')]), stryMutAct_9fa48("3199") ? [] : (stryCov_9fa48("3199"), [stryMutAct_9fa48("3202") ? request.token.policy_decision_hash === decision.decision_hash : stryMutAct_9fa48("3201") ? false : stryMutAct_9fa48("3200") ? true : (stryCov_9fa48("3200", "3201", "3202"), request.token.policy_decision_hash !== decision.decision_hash), stryMutAct_9fa48("3203") ? "" : (stryCov_9fa48("3203"), 'wrong_policy_decision')])]);
      const mismatch = mismatches.find(stryMutAct_9fa48("3204") ? () => undefined : (stryCov_9fa48("3204"), ([failed]) => failed));
      if (stryMutAct_9fa48("3206") ? false : stryMutAct_9fa48("3205") ? true : (stryCov_9fa48("3205", "3206"), mismatch)) return this.#deny(request, mismatch[1], tier);
      let authorizedEgress: {
        destination: string;
        canonical_host: string;
        resolved_addresses: readonly string[];
      } | undefined;
      if (stryMutAct_9fa48("3208") ? false : stryMutAct_9fa48("3207") ? true : (stryCov_9fa48("3207", "3208"), request.risk.network_access)) {
        if (stryMutAct_9fa48("3209")) {
          {}
        } else {
          stryCov_9fa48("3209");
          if (stryMutAct_9fa48("3212") ? request.egress === undefined && decision.egress_policy === undefined : stryMutAct_9fa48("3211") ? false : stryMutAct_9fa48("3210") ? true : (stryCov_9fa48("3210", "3211", "3212"), (stryMutAct_9fa48("3214") ? request.egress !== undefined : stryMutAct_9fa48("3213") ? false : (stryCov_9fa48("3213", "3214"), request.egress === undefined)) || (stryMutAct_9fa48("3216") ? decision.egress_policy !== undefined : stryMutAct_9fa48("3215") ? false : (stryCov_9fa48("3215", "3216"), decision.egress_policy === undefined)))) {
            if (stryMutAct_9fa48("3217")) {
              {}
            } else {
              stryCov_9fa48("3217");
              return this.#deny(request, stryMutAct_9fa48("3218") ? "" : (stryCov_9fa48("3218"), 'egress_target_required'), tier);
            }
          }
          const egressDecision = await validateEgressTarget(stryMutAct_9fa48("3219") ? {} : (stryCov_9fa48("3219"), {
            destination: request.egress.destination,
            policy: decision.egress_policy,
            resolve_host: request.egress.resolve_host,
            ...((stryMutAct_9fa48("3222") ? request.egress.pinned_addresses !== undefined : stryMutAct_9fa48("3221") ? false : stryMutAct_9fa48("3220") ? true : (stryCov_9fa48("3220", "3221", "3222"), request.egress.pinned_addresses === undefined)) ? {} : stryMutAct_9fa48("3223") ? {} : (stryCov_9fa48("3223"), {
              pinned_addresses: request.egress.pinned_addresses
            })),
            ...((stryMutAct_9fa48("3226") ? request.egress.redirect_from !== undefined : stryMutAct_9fa48("3225") ? false : stryMutAct_9fa48("3224") ? true : (stryCov_9fa48("3224", "3225", "3226"), request.egress.redirect_from === undefined)) ? {} : stryMutAct_9fa48("3227") ? {} : (stryCov_9fa48("3227"), {
              redirect_from: request.egress.redirect_from
            }))
          }));
          if (stryMutAct_9fa48("3230") ? false : stryMutAct_9fa48("3229") ? true : stryMutAct_9fa48("3228") ? egressDecision.allowed : (stryCov_9fa48("3228", "3229", "3230"), !egressDecision.allowed)) {
            if (stryMutAct_9fa48("3231")) {
              {}
            } else {
              stryCov_9fa48("3231");
              return this.#deny(request, stryMutAct_9fa48("3232") ? `` : (stryCov_9fa48("3232"), `egress_${egressDecision.reason_code}`), tier);
            }
          }
          authorizedEgress = stryMutAct_9fa48("3233") ? {} : (stryCov_9fa48("3233"), {
            destination: request.egress.destination,
            canonical_host: egressDecision.canonical_host!,
            resolved_addresses: egressDecision.resolved_addresses!
          });
        }
      }
      let consumed: boolean;
      try {
        if (stryMutAct_9fa48("3234")) {
          {}
        } else {
          stryCov_9fa48("3234");
          consumed = await this.#consume(request.token.token_id);
        }
      } catch {
        if (stryMutAct_9fa48("3235")) {
          {}
        } else {
          stryCov_9fa48("3235");
          return this.#deny(request, stryMutAct_9fa48("3236") ? "" : (stryCov_9fa48("3236"), 'capability_consume_failed'), tier);
        }
      }
      if (stryMutAct_9fa48("3239") ? false : stryMutAct_9fa48("3238") ? true : stryMutAct_9fa48("3237") ? consumed : (stryCov_9fa48("3237", "3238", "3239"), !consumed)) return this.#deny(request, stryMutAct_9fa48("3240") ? "" : (stryCov_9fa48("3240"), 'capability_used'), tier);
      const authorization = deepFreeze((stryMutAct_9fa48("3241") ? {} : (stryCov_9fa48("3241"), {
        policy_decision_hash: decision.decision_hash,
        policy_hash: this.#policyEngine.policy_hash,
        token_id: request.token.token_id,
        manifest_hash: request.manifest.manifest_hash,
        ...((stryMutAct_9fa48("3244") ? authorizedEgress !== undefined : stryMutAct_9fa48("3243") ? false : stryMutAct_9fa48("3242") ? true : (stryCov_9fa48("3242", "3243", "3244"), authorizedEgress === undefined)) ? {} : stryMutAct_9fa48("3245") ? {} : (stryCov_9fa48("3245"), {
          egress: authorizedEgress
        }))
      })) satisfies PepAuthorization);
      await this.#audit(request, stryMutAct_9fa48("3246") ? "" : (stryCov_9fa48("3246"), 'allow'), stryMutAct_9fa48("3247") ? "" : (stryCov_9fa48("3247"), 'authorized'), tier);
      return execute(authorization);
    }
  }
  async #deny(request: PepRequest, reasonCode: string, tier: DerivedRiskTier | null): Promise<never> {
    if (stryMutAct_9fa48("3248")) {
      {}
    } else {
      stryCov_9fa48("3248");
      await this.#audit(request, stryMutAct_9fa48("3249") ? "" : (stryCov_9fa48("3249"), 'deny'), reasonCode, tier);
      throw new PepDeniedError(reasonCode);
    }
  }
  async #audit(request: PepRequest, outcome: AuditEvent['outcome'], reasonCode: string, tier: DerivedRiskTier | null): Promise<void> {
    if (stryMutAct_9fa48("3250")) {
      {}
    } else {
      stryCov_9fa48("3250");
      const event = deepFreeze((stryMutAct_9fa48("3251") ? {} : (stryCov_9fa48("3251"), {
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
        derived_risk_tier: tier
      })) satisfies AuditEvent);
      try {
        if (stryMutAct_9fa48("3252")) {
          {}
        } else {
          stryCov_9fa48("3252");
          await this.#writeAudit(event);
        }
      } catch {
        if (stryMutAct_9fa48("3253")) {
          {}
        } else {
          stryCov_9fa48("3253");
          throw new PepDeniedError(stryMutAct_9fa48("3254") ? "" : (stryCov_9fa48("3254"), 'audit_failed'));
        }
      }
    }
  }
}