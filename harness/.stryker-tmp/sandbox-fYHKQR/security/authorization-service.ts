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
import { randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import type { CapabilityToken } from '../../spec/types/capability-token.js';
import type { ChildCapabilityRequest } from '../../spec/types/child-capability-request.js';
import { isStrictDateTime } from './policy-engine.js';
import { CapabilityDelegationError, CapabilityExpiredError, CapabilityInvalidError, CapabilityNotYetValidError, CapabilityRevokedError, type CapabilityStateRecord, type CapabilityStateStore, CapabilityUsedError, CredentialDispatchError, FileCapabilityStateStore, InMemoryCapabilityStateStore, type SignedCapabilityToken, canonicalizeCapabilityValue, hashCapabilityValue, isUuid, signCapabilityClaims, verifyCapabilityClaims } from './capability.js';
export { FileCapabilityStateStore, InMemoryCapabilityStateStore };
const HASH_PATTERN = stryMutAct_9fa48("2012") ? /^[^0-9a-f]{64}$/u : stryMutAct_9fa48("2011") ? /^[0-9a-f]$/u : stryMutAct_9fa48("2010") ? /^[0-9a-f]{64}/u : stryMutAct_9fa48("2009") ? /[0-9a-f]{64}$/u : (stryCov_9fa48("2009", "2010", "2011", "2012"), /^[0-9a-f]{64}$/u);
const ISSUE_FIELDS = new Set(stryMutAct_9fa48("2013") ? [] : (stryCov_9fa48("2013"), [stryMutAct_9fa48("2014") ? "" : (stryCov_9fa48("2014"), 'operation_id'), stryMutAct_9fa48("2015") ? "" : (stryCov_9fa48("2015"), 'attempt_id'), stryMutAct_9fa48("2016") ? "" : (stryCov_9fa48("2016"), 'manifest_hash'), stryMutAct_9fa48("2017") ? "" : (stryCov_9fa48("2017"), 'policy_decision_hash'), stryMutAct_9fa48("2018") ? "" : (stryCov_9fa48("2018"), 'tool_effect_contract_hash'), stryMutAct_9fa48("2019") ? "" : (stryCov_9fa48("2019"), 'subject_workload'), stryMutAct_9fa48("2020") ? "" : (stryCov_9fa48("2020"), 'tenant_id'), stryMutAct_9fa48("2021") ? "" : (stryCov_9fa48("2021"), 'audience'), stryMutAct_9fa48("2022") ? "" : (stryCov_9fa48("2022"), 'tool_grant_hash'), stryMutAct_9fa48("2023") ? "" : (stryCov_9fa48("2023"), 'resource_grant_hash'), stryMutAct_9fa48("2024") ? "" : (stryCov_9fa48("2024"), 'budget_ceiling_hash'), stryMutAct_9fa48("2025") ? "" : (stryCov_9fa48("2025"), 'execution_epoch'), stryMutAct_9fa48("2026") ? "" : (stryCov_9fa48("2026"), 'confirmation_key_thumbprint'), stryMutAct_9fa48("2027") ? "" : (stryCov_9fa48("2027"), 'not_before'), stryMutAct_9fa48("2028") ? "" : (stryCov_9fa48("2028"), 'expires_at')]));
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
  if (stryMutAct_9fa48("2029")) {
    {}
  } else {
    stryCov_9fa48("2029");
    return stryMutAct_9fa48("2032") ? typeof value === 'object' && value !== null || !Array.isArray(value) : stryMutAct_9fa48("2031") ? false : stryMutAct_9fa48("2030") ? true : (stryCov_9fa48("2030", "2031", "2032"), (stryMutAct_9fa48("2034") ? typeof value === 'object' || value !== null : stryMutAct_9fa48("2033") ? true : (stryCov_9fa48("2033", "2034"), (stryMutAct_9fa48("2036") ? typeof value !== 'object' : stryMutAct_9fa48("2035") ? true : (stryCov_9fa48("2035", "2036"), typeof value === (stryMutAct_9fa48("2037") ? "" : (stryCov_9fa48("2037"), 'object')))) && (stryMutAct_9fa48("2039") ? value === null : stryMutAct_9fa48("2038") ? true : (stryCov_9fa48("2038", "2039"), value !== null)))) && (stryMutAct_9fa48("2040") ? Array.isArray(value) : (stryCov_9fa48("2040"), !Array.isArray(value))));
  }
}
function requireNonEmpty(value: unknown, label: string): asserts value is string {
  if (stryMutAct_9fa48("2041")) {
    {}
  } else {
    stryCov_9fa48("2041");
    if (stryMutAct_9fa48("2044") ? typeof value !== 'string' && value.trim().length === 0 : stryMutAct_9fa48("2043") ? false : stryMutAct_9fa48("2042") ? true : (stryCov_9fa48("2042", "2043", "2044"), (stryMutAct_9fa48("2046") ? typeof value === 'string' : stryMutAct_9fa48("2045") ? false : (stryCov_9fa48("2045", "2046"), typeof value !== (stryMutAct_9fa48("2047") ? "" : (stryCov_9fa48("2047"), 'string')))) || (stryMutAct_9fa48("2049") ? value.trim().length !== 0 : stryMutAct_9fa48("2048") ? false : (stryCov_9fa48("2048", "2049"), (stryMutAct_9fa48("2050") ? value.length : (stryCov_9fa48("2050"), value.trim().length)) === 0)))) {
      if (stryMutAct_9fa48("2051")) {
        {}
      } else {
        stryCov_9fa48("2051");
        throw new CapabilityInvalidError(stryMutAct_9fa48("2052") ? `` : (stryCov_9fa48("2052"), `${label} must be a non-empty string`));
      }
    }
  }
}
function requireHash(value: unknown, label: string): asserts value is string {
  if (stryMutAct_9fa48("2053")) {
    {}
  } else {
    stryCov_9fa48("2053");
    if (stryMutAct_9fa48("2056") ? typeof value !== 'string' && !HASH_PATTERN.test(value) : stryMutAct_9fa48("2055") ? false : stryMutAct_9fa48("2054") ? true : (stryCov_9fa48("2054", "2055", "2056"), (stryMutAct_9fa48("2058") ? typeof value === 'string' : stryMutAct_9fa48("2057") ? false : (stryCov_9fa48("2057", "2058"), typeof value !== (stryMutAct_9fa48("2059") ? "" : (stryCov_9fa48("2059"), 'string')))) || (stryMutAct_9fa48("2060") ? HASH_PATTERN.test(value) : (stryCov_9fa48("2060"), !HASH_PATTERN.test(value))))) {
      if (stryMutAct_9fa48("2061")) {
        {}
      } else {
        stryCov_9fa48("2061");
        throw new CapabilityInvalidError(stryMutAct_9fa48("2062") ? `` : (stryCov_9fa48("2062"), `${label} must be a lowercase SHA-256 hash`));
      }
    }
  }
}
function strictTimestamp(value: unknown, label: string): number {
  if (stryMutAct_9fa48("2063")) {
    {}
  } else {
    stryCov_9fa48("2063");
    if (stryMutAct_9fa48("2066") ? false : stryMutAct_9fa48("2065") ? true : stryMutAct_9fa48("2064") ? isStrictDateTime(value) : (stryCov_9fa48("2064", "2065", "2066"), !isStrictDateTime(value))) throw new CapabilityInvalidError(stryMutAct_9fa48("2067") ? `` : (stryCov_9fa48("2067"), `${label} must be an ISO date-time`));
    return Date.parse(value);
  }
}
function validateIssueRequest(request: CapabilityIssueRequest): void {
  if (stryMutAct_9fa48("2068")) {
    {}
  } else {
    stryCov_9fa48("2068");
    if (stryMutAct_9fa48("2071") ? false : stryMutAct_9fa48("2070") ? true : stryMutAct_9fa48("2069") ? isRecord(request) : (stryCov_9fa48("2069", "2070", "2071"), !isRecord(request))) throw new CapabilityInvalidError(stryMutAct_9fa48("2072") ? "" : (stryCov_9fa48("2072"), 'capability request must be an object'));
    const unknown = stryMutAct_9fa48("2073") ? Object.keys(request) : (stryCov_9fa48("2073"), Object.keys(request).filter(stryMutAct_9fa48("2074") ? () => undefined : (stryCov_9fa48("2074"), key => stryMutAct_9fa48("2075") ? ISSUE_FIELDS.has(key) : (stryCov_9fa48("2075"), !ISSUE_FIELDS.has(key)))));
    if (stryMutAct_9fa48("2078") ? unknown.length > 0 && Object.keys(request).length !== ISSUE_FIELDS.size : stryMutAct_9fa48("2077") ? false : stryMutAct_9fa48("2076") ? true : (stryCov_9fa48("2076", "2077", "2078"), (stryMutAct_9fa48("2081") ? unknown.length <= 0 : stryMutAct_9fa48("2080") ? unknown.length >= 0 : stryMutAct_9fa48("2079") ? false : (stryCov_9fa48("2079", "2080", "2081"), unknown.length > 0)) || (stryMutAct_9fa48("2083") ? Object.keys(request).length === ISSUE_FIELDS.size : stryMutAct_9fa48("2082") ? false : (stryCov_9fa48("2082", "2083"), Object.keys(request).length !== ISSUE_FIELDS.size)))) {
      if (stryMutAct_9fa48("2084")) {
        {}
      } else {
        stryCov_9fa48("2084");
        throw new CapabilityInvalidError(stryMutAct_9fa48("2085") ? "" : (stryCov_9fa48("2085"), 'capability request contains unknown or missing fields'));
      }
    }
    for (const field of ['operation_id', 'attempt_id', 'subject_workload', 'tenant_id', 'audience', 'execution_epoch', 'confirmation_key_thumbprint'] as const) {
      if (stryMutAct_9fa48("2086")) {
        {}
      } else {
        stryCov_9fa48("2086");
        requireNonEmpty(request[field], field);
      }
    }
    for (const field of ['manifest_hash', 'policy_decision_hash', 'tool_effect_contract_hash', 'tool_grant_hash', 'resource_grant_hash', 'budget_ceiling_hash'] as const) {
      if (stryMutAct_9fa48("2087")) {
        {}
      } else {
        stryCov_9fa48("2087");
        requireHash(request[field], field);
      }
    }
    const notBefore = strictTimestamp(request.not_before, stryMutAct_9fa48("2088") ? "" : (stryCov_9fa48("2088"), 'not_before'));
    const expiresAt = strictTimestamp(request.expires_at, stryMutAct_9fa48("2089") ? "" : (stryCov_9fa48("2089"), 'expires_at'));
    if (stryMutAct_9fa48("2093") ? notBefore < expiresAt : stryMutAct_9fa48("2092") ? notBefore > expiresAt : stryMutAct_9fa48("2091") ? false : stryMutAct_9fa48("2090") ? true : (stryCov_9fa48("2090", "2091", "2092", "2093"), notBefore >= expiresAt)) throw new CapabilityInvalidError(stryMutAct_9fa48("2094") ? "" : (stryCov_9fa48("2094"), 'capability validity window is empty'));
  }
}
function validateClaimsShape(claims: CapabilityToken): void {
  if (stryMutAct_9fa48("2095")) {
    {}
  } else {
    stryCov_9fa48("2095");
    if (stryMutAct_9fa48("2098") ? false : stryMutAct_9fa48("2097") ? true : stryMutAct_9fa48("2096") ? isRecord(claims) : (stryCov_9fa48("2096", "2097", "2098"), !isRecord(claims))) throw new CapabilityInvalidError(stryMutAct_9fa48("2099") ? "" : (stryCov_9fa48("2099"), 'capability claims must be an object'));
    const required = stryMutAct_9fa48("2100") ? [] : (stryCov_9fa48("2100"), [stryMutAct_9fa48("2101") ? "" : (stryCov_9fa48("2101"), 'token_id'), stryMutAct_9fa48("2102") ? "" : (stryCov_9fa48("2102"), 'operation_id'), stryMutAct_9fa48("2103") ? "" : (stryCov_9fa48("2103"), 'attempt_id'), stryMutAct_9fa48("2104") ? "" : (stryCov_9fa48("2104"), 'manifest_hash'), stryMutAct_9fa48("2105") ? "" : (stryCov_9fa48("2105"), 'policy_decision_hash'), stryMutAct_9fa48("2106") ? "" : (stryCov_9fa48("2106"), 'tool_effect_contract_hash'), stryMutAct_9fa48("2107") ? "" : (stryCov_9fa48("2107"), 'subject_workload'), stryMutAct_9fa48("2108") ? "" : (stryCov_9fa48("2108"), 'tenant_id'), stryMutAct_9fa48("2109") ? "" : (stryCov_9fa48("2109"), 'audience'), stryMutAct_9fa48("2110") ? "" : (stryCov_9fa48("2110"), 'tool_grant_hash'), stryMutAct_9fa48("2111") ? "" : (stryCov_9fa48("2111"), 'resource_grant_hash'), stryMutAct_9fa48("2112") ? "" : (stryCov_9fa48("2112"), 'budget_ceiling_hash'), stryMutAct_9fa48("2113") ? "" : (stryCov_9fa48("2113"), 'issued_at'), stryMutAct_9fa48("2114") ? "" : (stryCov_9fa48("2114"), 'not_before'), stryMutAct_9fa48("2115") ? "" : (stryCov_9fa48("2115"), 'expires_at'), stryMutAct_9fa48("2116") ? "" : (stryCov_9fa48("2116"), 'execution_epoch'), stryMutAct_9fa48("2117") ? "" : (stryCov_9fa48("2117"), 'use_limit'), stryMutAct_9fa48("2118") ? "" : (stryCov_9fa48("2118"), 'confirmation_key_thumbprint')]);
    const allowed = new Set(stryMutAct_9fa48("2119") ? [] : (stryCov_9fa48("2119"), [...required, stryMutAct_9fa48("2120") ? "" : (stryCov_9fa48("2120"), 'parent_delegation_proof')]));
    if (stryMutAct_9fa48("2123") ? required.some(field => !(field in claims)) && Object.keys(claims).some(field => !allowed.has(field)) : stryMutAct_9fa48("2122") ? false : stryMutAct_9fa48("2121") ? true : (stryCov_9fa48("2121", "2122", "2123"), (stryMutAct_9fa48("2124") ? required.every(field => !(field in claims)) : (stryCov_9fa48("2124"), required.some(stryMutAct_9fa48("2125") ? () => undefined : (stryCov_9fa48("2125"), field => stryMutAct_9fa48("2126") ? field in claims : (stryCov_9fa48("2126"), !(field in claims)))))) || (stryMutAct_9fa48("2127") ? Object.keys(claims).every(field => !allowed.has(field)) : (stryCov_9fa48("2127"), Object.keys(claims).some(stryMutAct_9fa48("2128") ? () => undefined : (stryCov_9fa48("2128"), field => stryMutAct_9fa48("2129") ? allowed.has(field) : (stryCov_9fa48("2129"), !allowed.has(field)))))))) {
      if (stryMutAct_9fa48("2130")) {
        {}
      } else {
        stryCov_9fa48("2130");
        throw new CapabilityInvalidError(stryMutAct_9fa48("2131") ? "" : (stryCov_9fa48("2131"), 'capability claims contain unknown or missing fields'));
      }
    }
    if (stryMutAct_9fa48("2134") ? false : stryMutAct_9fa48("2133") ? true : stryMutAct_9fa48("2132") ? isUuid(claims.token_id) : (stryCov_9fa48("2132", "2133", "2134"), !isUuid(claims.token_id))) throw new CapabilityInvalidError(stryMutAct_9fa48("2135") ? "" : (stryCov_9fa48("2135"), 'token_id must be a UUID'));
    validateIssueRequest(stryMutAct_9fa48("2136") ? {} : (stryCov_9fa48("2136"), {
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
      expires_at: claims.expires_at
    }));
    const issuedAt = strictTimestamp(claims.issued_at, stryMutAct_9fa48("2137") ? "" : (stryCov_9fa48("2137"), 'issued_at'));
    if (stryMutAct_9fa48("2141") ? issuedAt <= Date.parse(claims.not_before) : stryMutAct_9fa48("2140") ? issuedAt >= Date.parse(claims.not_before) : stryMutAct_9fa48("2139") ? false : stryMutAct_9fa48("2138") ? true : (stryCov_9fa48("2138", "2139", "2140", "2141"), issuedAt > Date.parse(claims.not_before))) {
      if (stryMutAct_9fa48("2142")) {
        {}
      } else {
        stryCov_9fa48("2142");
        throw new CapabilityInvalidError(stryMutAct_9fa48("2143") ? "" : (stryCov_9fa48("2143"), 'issued_at must not be after not_before'));
      }
    }
    if (stryMutAct_9fa48("2146") ? claims.use_limit === 1 : stryMutAct_9fa48("2145") ? false : stryMutAct_9fa48("2144") ? true : (stryCov_9fa48("2144", "2145", "2146"), claims.use_limit !== 1)) throw new CapabilityInvalidError(stryMutAct_9fa48("2147") ? "" : (stryCov_9fa48("2147"), 'use_limit must be 1'));
    if (stryMutAct_9fa48("2150") ? claims.parent_delegation_proof !== undefined && claims.parent_delegation_proof !== null || typeof claims.parent_delegation_proof !== 'string' || claims.parent_delegation_proof.length === 0 : stryMutAct_9fa48("2149") ? false : stryMutAct_9fa48("2148") ? true : (stryCov_9fa48("2148", "2149", "2150"), (stryMutAct_9fa48("2152") ? claims.parent_delegation_proof !== undefined || claims.parent_delegation_proof !== null : stryMutAct_9fa48("2151") ? true : (stryCov_9fa48("2151", "2152"), (stryMutAct_9fa48("2154") ? claims.parent_delegation_proof === undefined : stryMutAct_9fa48("2153") ? true : (stryCov_9fa48("2153", "2154"), claims.parent_delegation_proof !== undefined)) && (stryMutAct_9fa48("2156") ? claims.parent_delegation_proof === null : stryMutAct_9fa48("2155") ? true : (stryCov_9fa48("2155", "2156"), claims.parent_delegation_proof !== null)))) && (stryMutAct_9fa48("2158") ? typeof claims.parent_delegation_proof !== 'string' && claims.parent_delegation_proof.length === 0 : stryMutAct_9fa48("2157") ? true : (stryCov_9fa48("2157", "2158"), (stryMutAct_9fa48("2160") ? typeof claims.parent_delegation_proof === 'string' : stryMutAct_9fa48("2159") ? false : (stryCov_9fa48("2159", "2160"), typeof claims.parent_delegation_proof !== (stryMutAct_9fa48("2161") ? "" : (stryCov_9fa48("2161"), 'string')))) || (stryMutAct_9fa48("2163") ? claims.parent_delegation_proof.length !== 0 : stryMutAct_9fa48("2162") ? false : (stryCov_9fa48("2162", "2163"), claims.parent_delegation_proof.length === 0)))))) {
      if (stryMutAct_9fa48("2164")) {
        {}
      } else {
        stryCov_9fa48("2164");
        throw new CapabilityInvalidError(stryMutAct_9fa48("2165") ? "" : (stryCov_9fa48("2165"), 'parent_delegation_proof must be a non-empty string or null'));
      }
    }
  }
}
function deepFreeze<T>(value: T): T {
  if (stryMutAct_9fa48("2166")) {
    {}
  } else {
    stryCov_9fa48("2166");
    if (stryMutAct_9fa48("2169") ? typeof value !== 'object' && typeof value !== 'function' && value === null : stryMutAct_9fa48("2168") ? false : stryMutAct_9fa48("2167") ? true : (stryCov_9fa48("2167", "2168", "2169"), (stryMutAct_9fa48("2171") ? typeof value !== 'object' || typeof value !== 'function' : stryMutAct_9fa48("2170") ? false : (stryCov_9fa48("2170", "2171"), (stryMutAct_9fa48("2173") ? typeof value === 'object' : stryMutAct_9fa48("2172") ? true : (stryCov_9fa48("2172", "2173"), typeof value !== (stryMutAct_9fa48("2174") ? "" : (stryCov_9fa48("2174"), 'object')))) && (stryMutAct_9fa48("2176") ? typeof value === 'function' : stryMutAct_9fa48("2175") ? true : (stryCov_9fa48("2175", "2176"), typeof value !== (stryMutAct_9fa48("2177") ? "" : (stryCov_9fa48("2177"), 'function')))))) || (stryMutAct_9fa48("2179") ? value !== null : stryMutAct_9fa48("2178") ? false : (stryCov_9fa48("2178", "2179"), value === null)))) return value;
    if (stryMutAct_9fa48("2181") ? false : stryMutAct_9fa48("2180") ? true : (stryCov_9fa48("2180", "2181"), Object.isFrozen(value))) return value;
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value);
  }
}
function cloneFreeze<T>(value: T): T {
  if (stryMutAct_9fa48("2182")) {
    {}
  } else {
    stryCov_9fa48("2182");
    return deepFreeze(structuredClone(value));
  }
}
function statusError(status: CapabilityStateRecord['status']): CapabilityUsedError | CapabilityRevokedError {
  if (stryMutAct_9fa48("2183")) {
    {}
  } else {
    stryCov_9fa48("2183");
    return (stryMutAct_9fa48("2186") ? status !== 'revoked' : stryMutAct_9fa48("2185") ? false : stryMutAct_9fa48("2184") ? true : (stryCov_9fa48("2184", "2185", "2186"), status === (stryMutAct_9fa48("2187") ? "" : (stryCov_9fa48("2187"), 'revoked')))) ? new CapabilityRevokedError(stryMutAct_9fa48("2188") ? "" : (stryCov_9fa48("2188"), 'capability has been revoked')) : new CapabilityUsedError(stryMutAct_9fa48("2189") ? "" : (stryCov_9fa48("2189"), 'capability has already been used'));
  }
}
function validateGrantSet(grants: CapabilityGrantSet): void {
  if (stryMutAct_9fa48("2190")) {
    {}
  } else {
    stryCov_9fa48("2190");
    if (stryMutAct_9fa48("2193") ? false : stryMutAct_9fa48("2192") ? true : stryMutAct_9fa48("2191") ? isRecord(grants) : (stryCov_9fa48("2191", "2192", "2193"), !isRecord(grants))) throw new CapabilityDelegationError(stryMutAct_9fa48("2194") ? "" : (stryCov_9fa48("2194"), 'grant set must be an object'));
    if (stryMutAct_9fa48("2197") ? (!Array.isArray(grants.tools) || !Array.isArray(grants.resources)) && !isRecord(grants.budget) : stryMutAct_9fa48("2196") ? false : stryMutAct_9fa48("2195") ? true : (stryCov_9fa48("2195", "2196", "2197"), (stryMutAct_9fa48("2199") ? !Array.isArray(grants.tools) && !Array.isArray(grants.resources) : stryMutAct_9fa48("2198") ? false : (stryCov_9fa48("2198", "2199"), (stryMutAct_9fa48("2200") ? Array.isArray(grants.tools) : (stryCov_9fa48("2200"), !Array.isArray(grants.tools))) || (stryMutAct_9fa48("2201") ? Array.isArray(grants.resources) : (stryCov_9fa48("2201"), !Array.isArray(grants.resources))))) || (stryMutAct_9fa48("2202") ? isRecord(grants.budget) : (stryCov_9fa48("2202"), !isRecord(grants.budget))))) {
      if (stryMutAct_9fa48("2203")) {
        {}
      } else {
        stryCov_9fa48("2203");
        throw new CapabilityDelegationError(stryMutAct_9fa48("2204") ? "" : (stryCov_9fa48("2204"), 'grant set is malformed'));
      }
    }
    for (const entry of stryMutAct_9fa48("2205") ? [] : (stryCov_9fa48("2205"), [...grants.tools, ...grants.resources])) requireNonEmpty(entry, stryMutAct_9fa48("2206") ? "" : (stryCov_9fa48("2206"), 'grant'));
    if (stryMutAct_9fa48("2209") ? new Set(grants.tools).size !== grants.tools.length && new Set(grants.resources).size !== grants.resources.length : stryMutAct_9fa48("2208") ? false : stryMutAct_9fa48("2207") ? true : (stryCov_9fa48("2207", "2208", "2209"), (stryMutAct_9fa48("2211") ? new Set(grants.tools).size === grants.tools.length : stryMutAct_9fa48("2210") ? false : (stryCov_9fa48("2210", "2211"), new Set(grants.tools).size !== grants.tools.length)) || (stryMutAct_9fa48("2213") ? new Set(grants.resources).size === grants.resources.length : stryMutAct_9fa48("2212") ? false : (stryCov_9fa48("2212", "2213"), new Set(grants.resources).size !== grants.resources.length)))) {
      if (stryMutAct_9fa48("2214")) {
        {}
      } else {
        stryCov_9fa48("2214");
        throw new CapabilityDelegationError(stryMutAct_9fa48("2215") ? "" : (stryCov_9fa48("2215"), 'grant set contains duplicates'));
      }
    }
  }
}
function budgetAttenuates(child: Record<string, unknown>, parent: Record<string, unknown>): boolean {
  if (stryMutAct_9fa48("2216")) {
    {}
  } else {
    stryCov_9fa48("2216");
    for (const [key, childValue] of Object.entries(child)) {
      if (stryMutAct_9fa48("2217")) {
        {}
      } else {
        stryCov_9fa48("2217");
        if (stryMutAct_9fa48("2220") ? false : stryMutAct_9fa48("2219") ? true : stryMutAct_9fa48("2218") ? key in parent : (stryCov_9fa48("2218", "2219", "2220"), !(key in parent))) return stryMutAct_9fa48("2221") ? true : (stryCov_9fa48("2221"), false);
        const parentValue = parent[key];
        if (stryMutAct_9fa48("2224") ? typeof childValue === 'number' || typeof parentValue === 'number' : stryMutAct_9fa48("2223") ? false : stryMutAct_9fa48("2222") ? true : (stryCov_9fa48("2222", "2223", "2224"), (stryMutAct_9fa48("2226") ? typeof childValue !== 'number' : stryMutAct_9fa48("2225") ? true : (stryCov_9fa48("2225", "2226"), typeof childValue === (stryMutAct_9fa48("2227") ? "" : (stryCov_9fa48("2227"), 'number')))) && (stryMutAct_9fa48("2229") ? typeof parentValue !== 'number' : stryMutAct_9fa48("2228") ? true : (stryCov_9fa48("2228", "2229"), typeof parentValue === (stryMutAct_9fa48("2230") ? "" : (stryCov_9fa48("2230"), 'number')))))) {
          if (stryMutAct_9fa48("2231")) {
            {}
          } else {
            stryCov_9fa48("2231");
            if (stryMutAct_9fa48("2234") ? (!Number.isFinite(childValue) || childValue < 0) && childValue > parentValue : stryMutAct_9fa48("2233") ? false : stryMutAct_9fa48("2232") ? true : (stryCov_9fa48("2232", "2233", "2234"), (stryMutAct_9fa48("2236") ? !Number.isFinite(childValue) && childValue < 0 : stryMutAct_9fa48("2235") ? false : (stryCov_9fa48("2235", "2236"), (stryMutAct_9fa48("2237") ? Number.isFinite(childValue) : (stryCov_9fa48("2237"), !Number.isFinite(childValue))) || (stryMutAct_9fa48("2240") ? childValue >= 0 : stryMutAct_9fa48("2239") ? childValue <= 0 : stryMutAct_9fa48("2238") ? false : (stryCov_9fa48("2238", "2239", "2240"), childValue < 0)))) || (stryMutAct_9fa48("2243") ? childValue <= parentValue : stryMutAct_9fa48("2242") ? childValue >= parentValue : stryMutAct_9fa48("2241") ? false : (stryCov_9fa48("2241", "2242", "2243"), childValue > parentValue)))) return stryMutAct_9fa48("2244") ? true : (stryCov_9fa48("2244"), false);
          }
        } else if (stryMutAct_9fa48("2247") ? typeof childValue === 'string' || typeof parentValue === 'string' : stryMutAct_9fa48("2246") ? false : stryMutAct_9fa48("2245") ? true : (stryCov_9fa48("2245", "2246", "2247"), (stryMutAct_9fa48("2249") ? typeof childValue !== 'string' : stryMutAct_9fa48("2248") ? true : (stryCov_9fa48("2248", "2249"), typeof childValue === (stryMutAct_9fa48("2250") ? "" : (stryCov_9fa48("2250"), 'string')))) && (stryMutAct_9fa48("2252") ? typeof parentValue !== 'string' : stryMutAct_9fa48("2251") ? true : (stryCov_9fa48("2251", "2252"), typeof parentValue === (stryMutAct_9fa48("2253") ? "" : (stryCov_9fa48("2253"), 'string')))))) {
          if (stryMutAct_9fa48("2254")) {
            {}
          } else {
            stryCov_9fa48("2254");
            if (stryMutAct_9fa48("2257") ? /^(?:0|[1-9]\d*)$/u.test(childValue) || /^(?:0|[1-9]\d*)$/u.test(parentValue) : stryMutAct_9fa48("2256") ? false : stryMutAct_9fa48("2255") ? true : (stryCov_9fa48("2255", "2256", "2257"), (stryMutAct_9fa48("2262") ? /^(?:0|[1-9]\D*)$/u : stryMutAct_9fa48("2261") ? /^(?:0|[1-9]\d)$/u : stryMutAct_9fa48("2260") ? /^(?:0|[^1-9]\d*)$/u : stryMutAct_9fa48("2259") ? /^(?:0|[1-9]\d*)/u : stryMutAct_9fa48("2258") ? /(?:0|[1-9]\d*)$/u : (stryCov_9fa48("2258", "2259", "2260", "2261", "2262"), /^(?:0|[1-9]\d*)$/u)).test(childValue) && (stryMutAct_9fa48("2267") ? /^(?:0|[1-9]\D*)$/u : stryMutAct_9fa48("2266") ? /^(?:0|[1-9]\d)$/u : stryMutAct_9fa48("2265") ? /^(?:0|[^1-9]\d*)$/u : stryMutAct_9fa48("2264") ? /^(?:0|[1-9]\d*)/u : stryMutAct_9fa48("2263") ? /(?:0|[1-9]\d*)$/u : (stryCov_9fa48("2263", "2264", "2265", "2266", "2267"), /^(?:0|[1-9]\d*)$/u)).test(parentValue))) {
              if (stryMutAct_9fa48("2268")) {
                {}
              } else {
                stryCov_9fa48("2268");
                if (stryMutAct_9fa48("2272") ? BigInt(childValue) <= BigInt(parentValue) : stryMutAct_9fa48("2271") ? BigInt(childValue) >= BigInt(parentValue) : stryMutAct_9fa48("2270") ? false : stryMutAct_9fa48("2269") ? true : (stryCov_9fa48("2269", "2270", "2271", "2272"), BigInt(childValue) > BigInt(parentValue))) return stryMutAct_9fa48("2273") ? true : (stryCov_9fa48("2273"), false);
              }
            } else if (stryMutAct_9fa48("2276") ? childValue === parentValue : stryMutAct_9fa48("2275") ? false : stryMutAct_9fa48("2274") ? true : (stryCov_9fa48("2274", "2275", "2276"), childValue !== parentValue)) {
              if (stryMutAct_9fa48("2277")) {
                {}
              } else {
                stryCov_9fa48("2277");
                return stryMutAct_9fa48("2278") ? true : (stryCov_9fa48("2278"), false);
              }
            }
          }
        } else if (stryMutAct_9fa48("2281") ? isRecord(childValue) || isRecord(parentValue) : stryMutAct_9fa48("2280") ? false : stryMutAct_9fa48("2279") ? true : (stryCov_9fa48("2279", "2280", "2281"), isRecord(childValue) && isRecord(parentValue))) {
          if (stryMutAct_9fa48("2282")) {
            {}
          } else {
            stryCov_9fa48("2282");
            if (stryMutAct_9fa48("2285") ? false : stryMutAct_9fa48("2284") ? true : stryMutAct_9fa48("2283") ? budgetAttenuates(childValue, parentValue) : (stryCov_9fa48("2283", "2284", "2285"), !budgetAttenuates(childValue, parentValue))) return stryMutAct_9fa48("2286") ? true : (stryCov_9fa48("2286"), false);
          }
        } else if (stryMutAct_9fa48("2289") ? childValue === parentValue : stryMutAct_9fa48("2288") ? false : stryMutAct_9fa48("2287") ? true : (stryCov_9fa48("2287", "2288", "2289"), childValue !== parentValue)) {
          if (stryMutAct_9fa48("2290")) {
            {}
          } else {
            stryCov_9fa48("2290");
            return stryMutAct_9fa48("2291") ? true : (stryCov_9fa48("2291"), false);
          }
        }
      }
    }
    return stryMutAct_9fa48("2292") ? false : (stryCov_9fa48("2292"), true);
  }
}
function resourceAttenuates(child: string, parents: readonly string[]): boolean {
  if (stryMutAct_9fa48("2293")) {
    {}
  } else {
    stryCov_9fa48("2293");
    return stryMutAct_9fa48("2294") ? parents.every(parent => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)) : (stryCov_9fa48("2294"), parents.some(stryMutAct_9fa48("2295") ? () => undefined : (stryCov_9fa48("2295"), parent => stryMutAct_9fa48("2298") ? child === parent && child.startsWith(parent.endsWith('/') ? parent : `${parent}/`) : stryMutAct_9fa48("2297") ? false : stryMutAct_9fa48("2296") ? true : (stryCov_9fa48("2296", "2297", "2298"), (stryMutAct_9fa48("2300") ? child !== parent : stryMutAct_9fa48("2299") ? false : (stryCov_9fa48("2299", "2300"), child === parent)) || (stryMutAct_9fa48("2301") ? child.endsWith(parent.endsWith('/') ? parent : `${parent}/`) : (stryCov_9fa48("2301"), child.startsWith((stryMutAct_9fa48("2302") ? parent.startsWith('/') : (stryCov_9fa48("2302"), parent.endsWith(stryMutAct_9fa48("2303") ? "" : (stryCov_9fa48("2303"), '/')))) ? parent : stryMutAct_9fa48("2304") ? `` : (stryCov_9fa48("2304"), `${parent}/`))))))));
  }
}
export function hashCapabilityGrant(value: unknown): string {
  if (stryMutAct_9fa48("2305")) {
    {}
  } else {
    stryCov_9fa48("2305");
    return hashCapabilityValue(value);
  }
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
    if (stryMutAct_9fa48("2306")) {
      {}
    } else {
      stryCov_9fa48("2306");
      if (stryMutAct_9fa48("2309") ? options.private_key?.type !== 'private' && options.public_key?.type !== 'public' : stryMutAct_9fa48("2308") ? false : stryMutAct_9fa48("2307") ? true : (stryCov_9fa48("2307", "2308", "2309"), (stryMutAct_9fa48("2311") ? options.private_key?.type === 'private' : stryMutAct_9fa48("2310") ? false : (stryCov_9fa48("2310", "2311"), (stryMutAct_9fa48("2312") ? options.private_key.type : (stryCov_9fa48("2312"), options.private_key?.type)) !== (stryMutAct_9fa48("2313") ? "" : (stryCov_9fa48("2313"), 'private')))) || (stryMutAct_9fa48("2315") ? options.public_key?.type === 'public' : stryMutAct_9fa48("2314") ? false : (stryCov_9fa48("2314", "2315"), (stryMutAct_9fa48("2316") ? options.public_key.type : (stryCov_9fa48("2316"), options.public_key?.type)) !== (stryMutAct_9fa48("2317") ? "" : (stryCov_9fa48("2317"), 'public')))))) {
        if (stryMutAct_9fa48("2318")) {
          {}
        } else {
          stryCov_9fa48("2318");
          throw new CapabilityInvalidError(stryMutAct_9fa48("2319") ? "" : (stryCov_9fa48("2319"), 'Authorization Service requires an asymmetric key pair'));
        }
      }
      if (stryMutAct_9fa48("2322") ? options.private_key.asymmetricKeyType !== 'ed25519' && options.public_key.asymmetricKeyType !== 'ed25519' : stryMutAct_9fa48("2321") ? false : stryMutAct_9fa48("2320") ? true : (stryCov_9fa48("2320", "2321", "2322"), (stryMutAct_9fa48("2324") ? options.private_key.asymmetricKeyType === 'ed25519' : stryMutAct_9fa48("2323") ? false : (stryCov_9fa48("2323", "2324"), options.private_key.asymmetricKeyType !== (stryMutAct_9fa48("2325") ? "" : (stryCov_9fa48("2325"), 'ed25519')))) || (stryMutAct_9fa48("2327") ? options.public_key.asymmetricKeyType === 'ed25519' : stryMutAct_9fa48("2326") ? false : (stryCov_9fa48("2326", "2327"), options.public_key.asymmetricKeyType !== (stryMutAct_9fa48("2328") ? "" : (stryCov_9fa48("2328"), 'ed25519')))))) {
        if (stryMutAct_9fa48("2329")) {
          {}
        } else {
          stryCov_9fa48("2329");
          throw new CapabilityInvalidError(stryMutAct_9fa48("2330") ? "" : (stryCov_9fa48("2330"), 'Authorization Service requires Ed25519 keys'));
        }
      }
      if (stryMutAct_9fa48("2333") ? (!options.state_store || typeof options.state_store.register !== 'function' || typeof options.state_store.read !== 'function' || typeof options.state_store.consume !== 'function') && typeof options.state_store.revoke !== 'function' : stryMutAct_9fa48("2332") ? false : stryMutAct_9fa48("2331") ? true : (stryCov_9fa48("2331", "2332", "2333"), (stryMutAct_9fa48("2335") ? (!options.state_store || typeof options.state_store.register !== 'function' || typeof options.state_store.read !== 'function') && typeof options.state_store.consume !== 'function' : stryMutAct_9fa48("2334") ? false : (stryCov_9fa48("2334", "2335"), (stryMutAct_9fa48("2337") ? (!options.state_store || typeof options.state_store.register !== 'function') && typeof options.state_store.read !== 'function' : stryMutAct_9fa48("2336") ? false : (stryCov_9fa48("2336", "2337"), (stryMutAct_9fa48("2339") ? !options.state_store && typeof options.state_store.register !== 'function' : stryMutAct_9fa48("2338") ? false : (stryCov_9fa48("2338", "2339"), (stryMutAct_9fa48("2340") ? options.state_store : (stryCov_9fa48("2340"), !options.state_store)) || (stryMutAct_9fa48("2342") ? typeof options.state_store.register === 'function' : stryMutAct_9fa48("2341") ? false : (stryCov_9fa48("2341", "2342"), typeof options.state_store.register !== (stryMutAct_9fa48("2343") ? "" : (stryCov_9fa48("2343"), 'function')))))) || (stryMutAct_9fa48("2345") ? typeof options.state_store.read === 'function' : stryMutAct_9fa48("2344") ? false : (stryCov_9fa48("2344", "2345"), typeof options.state_store.read !== (stryMutAct_9fa48("2346") ? "" : (stryCov_9fa48("2346"), 'function')))))) || (stryMutAct_9fa48("2348") ? typeof options.state_store.consume === 'function' : stryMutAct_9fa48("2347") ? false : (stryCov_9fa48("2347", "2348"), typeof options.state_store.consume !== (stryMutAct_9fa48("2349") ? "" : (stryCov_9fa48("2349"), 'function')))))) || (stryMutAct_9fa48("2351") ? typeof options.state_store.revoke === 'function' : stryMutAct_9fa48("2350") ? false : (stryCov_9fa48("2350", "2351"), typeof options.state_store.revoke !== (stryMutAct_9fa48("2352") ? "" : (stryCov_9fa48("2352"), 'function')))))) {
        if (stryMutAct_9fa48("2353")) {
          {}
        } else {
          stryCov_9fa48("2353");
          throw new CapabilityInvalidError(stryMutAct_9fa48("2354") ? "" : (stryCov_9fa48("2354"), 'state_store is required'));
        }
      }
      this.#privateKey = options.private_key;
      this.#publicKey = options.public_key;
      this.#state = options.state_store;
      this.#now = stryMutAct_9fa48("2355") ? options.now && (() => new Date().toISOString()) : (stryCov_9fa48("2355"), options.now ?? (stryMutAct_9fa48("2356") ? () => undefined : (stryCov_9fa48("2356"), () => new Date().toISOString())));
      this.#randomUuid = stryMutAct_9fa48("2357") ? options.random_uuid && randomUUID : (stryCov_9fa48("2357"), options.random_uuid ?? randomUUID);
      this.#maxTtlMs = stryMutAct_9fa48("2358") ? options.max_ttl_ms && 300_000 : (stryCov_9fa48("2358"), options.max_ttl_ms ?? 300_000);
      if (stryMutAct_9fa48("2361") ? !Number.isSafeInteger(this.#maxTtlMs) && this.#maxTtlMs <= 0 : stryMutAct_9fa48("2360") ? false : stryMutAct_9fa48("2359") ? true : (stryCov_9fa48("2359", "2360", "2361"), (stryMutAct_9fa48("2362") ? Number.isSafeInteger(this.#maxTtlMs) : (stryCov_9fa48("2362"), !Number.isSafeInteger(this.#maxTtlMs))) || (stryMutAct_9fa48("2365") ? this.#maxTtlMs > 0 : stryMutAct_9fa48("2364") ? this.#maxTtlMs < 0 : stryMutAct_9fa48("2363") ? false : (stryCov_9fa48("2363", "2364", "2365"), this.#maxTtlMs <= 0)))) {
        if (stryMutAct_9fa48("2366")) {
          {}
        } else {
          stryCov_9fa48("2366");
          throw new CapabilityInvalidError(stryMutAct_9fa48("2367") ? "" : (stryCov_9fa48("2367"), 'max_ttl_ms must be a positive safe integer'));
        }
      }
    }
  }
  async issue(request: CapabilityIssueRequest): Promise<SignedCapabilityToken> {
    if (stryMutAct_9fa48("2368")) {
      {}
    } else {
      stryCov_9fa48("2368");
      return this.#issue(request);
    }
  }
  async #issue(request: CapabilityIssueRequest, parentDelegationProof?: string): Promise<SignedCapabilityToken> {
    if (stryMutAct_9fa48("2369")) {
      {}
    } else {
      stryCov_9fa48("2369");
      validateIssueRequest(request);
      const issuedAt = this.#now();
      const issuedAtValue = strictTimestamp(issuedAt, stryMutAct_9fa48("2370") ? "" : (stryCov_9fa48("2370"), 'current time'));
      const notBefore = Date.parse(request.not_before);
      const expiresAt = Date.parse(request.expires_at);
      if (stryMutAct_9fa48("2373") ? issuedAtValue > notBefore && issuedAtValue >= expiresAt : stryMutAct_9fa48("2372") ? false : stryMutAct_9fa48("2371") ? true : (stryCov_9fa48("2371", "2372", "2373"), (stryMutAct_9fa48("2376") ? issuedAtValue <= notBefore : stryMutAct_9fa48("2375") ? issuedAtValue >= notBefore : stryMutAct_9fa48("2374") ? false : (stryCov_9fa48("2374", "2375", "2376"), issuedAtValue > notBefore)) || (stryMutAct_9fa48("2379") ? issuedAtValue < expiresAt : stryMutAct_9fa48("2378") ? issuedAtValue > expiresAt : stryMutAct_9fa48("2377") ? false : (stryCov_9fa48("2377", "2378", "2379"), issuedAtValue >= expiresAt)))) {
        if (stryMutAct_9fa48("2380")) {
          {}
        } else {
          stryCov_9fa48("2380");
          throw new CapabilityInvalidError(stryMutAct_9fa48("2381") ? "" : (stryCov_9fa48("2381"), 'capability is not valid at issuance time'));
        }
      }
      if (stryMutAct_9fa48("2385") ? expiresAt - issuedAtValue <= this.#maxTtlMs : stryMutAct_9fa48("2384") ? expiresAt - issuedAtValue >= this.#maxTtlMs : stryMutAct_9fa48("2383") ? false : stryMutAct_9fa48("2382") ? true : (stryCov_9fa48("2382", "2383", "2384", "2385"), (stryMutAct_9fa48("2386") ? expiresAt + issuedAtValue : (stryCov_9fa48("2386"), expiresAt - issuedAtValue)) > this.#maxTtlMs)) {
        if (stryMutAct_9fa48("2387")) {
          {}
        } else {
          stryCov_9fa48("2387");
          throw new CapabilityInvalidError(stryMutAct_9fa48("2388") ? "" : (stryCov_9fa48("2388"), 'capability lifetime exceeds Authorization Service policy'));
        }
      }
      const tokenId = this.#randomUuid();
      if (stryMutAct_9fa48("2391") ? false : stryMutAct_9fa48("2390") ? true : stryMutAct_9fa48("2389") ? isUuid(tokenId) : (stryCov_9fa48("2389", "2390", "2391"), !isUuid(tokenId))) throw new CapabilityInvalidError(stryMutAct_9fa48("2392") ? "" : (stryCov_9fa48("2392"), 'random_uuid returned an invalid UUID'));
      const claims = cloneFreeze((stryMutAct_9fa48("2393") ? {} : (stryCov_9fa48("2393"), {
        token_id: tokenId,
        ...structuredClone(request),
        ...((stryMutAct_9fa48("2396") ? parentDelegationProof !== undefined : stryMutAct_9fa48("2395") ? false : stryMutAct_9fa48("2394") ? true : (stryCov_9fa48("2394", "2395", "2396"), parentDelegationProof === undefined)) ? {} : stryMutAct_9fa48("2397") ? {} : (stryCov_9fa48("2397"), {
          parent_delegation_proof: parentDelegationProof
        })),
        issued_at: issuedAt,
        use_limit: 1
      })) satisfies CapabilityToken);
      validateClaimsShape(claims);
      const signature = signCapabilityClaims(claims, this.#privateKey);
      const signed = cloneFreeze((stryMutAct_9fa48("2398") ? {} : (stryCov_9fa48("2398"), {
        algorithm: stryMutAct_9fa48("2399") ? "" : (stryCov_9fa48("2399"), 'Ed25519'),
        claims,
        signature
      })) satisfies SignedCapabilityToken);
      await this.#state.register(tokenId, stryMutAct_9fa48("2400") ? {} : (stryCov_9fa48("2400"), {
        token_hash: hashCapabilityValue(claims),
        signature,
        status: stryMutAct_9fa48("2401") ? "" : (stryCov_9fa48("2401"), 'issued')
      }));
      return signed;
    }
  }
  async verify(capability: SignedCapabilityToken, options: {
    confirmation_key_thumbprint?: string;
  } = {}): Promise<CapabilityToken> {
    if (stryMutAct_9fa48("2402")) {
      {}
    } else {
      stryCov_9fa48("2402");
      this.#validateEnvelope(capability);
      const record = await this.#state.read(capability.claims.token_id);
      if (stryMutAct_9fa48("2405") ? (record === undefined || record.token_hash !== hashCapabilityValue(capability.claims)) && record.signature !== capability.signature : stryMutAct_9fa48("2404") ? false : stryMutAct_9fa48("2403") ? true : (stryCov_9fa48("2403", "2404", "2405"), (stryMutAct_9fa48("2407") ? record === undefined && record.token_hash !== hashCapabilityValue(capability.claims) : stryMutAct_9fa48("2406") ? false : (stryCov_9fa48("2406", "2407"), (stryMutAct_9fa48("2409") ? record !== undefined : stryMutAct_9fa48("2408") ? false : (stryCov_9fa48("2408", "2409"), record === undefined)) || (stryMutAct_9fa48("2411") ? record.token_hash === hashCapabilityValue(capability.claims) : stryMutAct_9fa48("2410") ? false : (stryCov_9fa48("2410", "2411"), record.token_hash !== hashCapabilityValue(capability.claims))))) || (stryMutAct_9fa48("2413") ? record.signature === capability.signature : stryMutAct_9fa48("2412") ? false : (stryCov_9fa48("2412", "2413"), record.signature !== capability.signature)))) {
        if (stryMutAct_9fa48("2414")) {
          {}
        } else {
          stryCov_9fa48("2414");
          throw new CapabilityInvalidError(stryMutAct_9fa48("2415") ? "" : (stryCov_9fa48("2415"), 'capability is unknown or state binding failed'));
        }
      }
      if (stryMutAct_9fa48("2418") ? record.status === 'issued' : stryMutAct_9fa48("2417") ? false : stryMutAct_9fa48("2416") ? true : (stryCov_9fa48("2416", "2417", "2418"), record.status !== (stryMutAct_9fa48("2419") ? "" : (stryCov_9fa48("2419"), 'issued')))) throw statusError(record.status);
      const now = strictTimestamp(this.#now(), stryMutAct_9fa48("2420") ? "" : (stryCov_9fa48("2420"), 'current time'));
      const notBefore = Date.parse(capability.claims.not_before);
      const expiresAt = Date.parse(capability.claims.expires_at);
      if (stryMutAct_9fa48("2424") ? now >= notBefore : stryMutAct_9fa48("2423") ? now <= notBefore : stryMutAct_9fa48("2422") ? false : stryMutAct_9fa48("2421") ? true : (stryCov_9fa48("2421", "2422", "2423", "2424"), now < notBefore)) throw new CapabilityNotYetValidError(stryMutAct_9fa48("2425") ? "" : (stryCov_9fa48("2425"), 'capability is not yet valid'));
      if (stryMutAct_9fa48("2429") ? now < expiresAt : stryMutAct_9fa48("2428") ? now > expiresAt : stryMutAct_9fa48("2427") ? false : stryMutAct_9fa48("2426") ? true : (stryCov_9fa48("2426", "2427", "2428", "2429"), now >= expiresAt)) throw new CapabilityExpiredError(stryMutAct_9fa48("2430") ? "" : (stryCov_9fa48("2430"), 'capability has expired'));
      if (stryMutAct_9fa48("2433") ? options.confirmation_key_thumbprint !== undefined || options.confirmation_key_thumbprint !== capability.claims.confirmation_key_thumbprint : stryMutAct_9fa48("2432") ? false : stryMutAct_9fa48("2431") ? true : (stryCov_9fa48("2431", "2432", "2433"), (stryMutAct_9fa48("2435") ? options.confirmation_key_thumbprint === undefined : stryMutAct_9fa48("2434") ? true : (stryCov_9fa48("2434", "2435"), options.confirmation_key_thumbprint !== undefined)) && (stryMutAct_9fa48("2437") ? options.confirmation_key_thumbprint === capability.claims.confirmation_key_thumbprint : stryMutAct_9fa48("2436") ? true : (stryCov_9fa48("2436", "2437"), options.confirmation_key_thumbprint !== capability.claims.confirmation_key_thumbprint)))) {
        if (stryMutAct_9fa48("2438")) {
          {}
        } else {
          stryCov_9fa48("2438");
          throw new CapabilityInvalidError(stryMutAct_9fa48("2439") ? "" : (stryCov_9fa48("2439"), 'confirmation key mismatch'));
        }
      }
      return cloneFreeze(capability.claims);
    }
  }
  async verify_signature(token: CapabilityToken): Promise<boolean> {
    if (stryMutAct_9fa48("2440")) {
      {}
    } else {
      stryCov_9fa48("2440");
      try {
        if (stryMutAct_9fa48("2441")) {
          {}
        } else {
          stryCov_9fa48("2441");
          validateClaimsShape(token);
          const record = await this.#state.read(token.token_id);
          return stryMutAct_9fa48("2444") ? record?.status === 'issued' && record.token_hash === hashCapabilityValue(token) || verifyCapabilityClaims(token, record.signature, this.#publicKey) : stryMutAct_9fa48("2443") ? false : stryMutAct_9fa48("2442") ? true : (stryCov_9fa48("2442", "2443", "2444"), (stryMutAct_9fa48("2446") ? record?.status === 'issued' || record.token_hash === hashCapabilityValue(token) : stryMutAct_9fa48("2445") ? true : (stryCov_9fa48("2445", "2446"), (stryMutAct_9fa48("2448") ? record?.status !== 'issued' : stryMutAct_9fa48("2447") ? true : (stryCov_9fa48("2447", "2448"), (stryMutAct_9fa48("2449") ? record.status : (stryCov_9fa48("2449"), record?.status)) === (stryMutAct_9fa48("2450") ? "" : (stryCov_9fa48("2450"), 'issued')))) && (stryMutAct_9fa48("2452") ? record.token_hash !== hashCapabilityValue(token) : stryMutAct_9fa48("2451") ? true : (stryCov_9fa48("2451", "2452"), record.token_hash === hashCapabilityValue(token))))) && verifyCapabilityClaims(token, record.signature, this.#publicKey));
        }
      } catch {
        if (stryMutAct_9fa48("2453")) {
          {}
        } else {
          stryCov_9fa48("2453");
          return stryMutAct_9fa48("2454") ? true : (stryCov_9fa48("2454"), false);
        }
      }
    }
  }
  async consume(capability: SignedCapabilityToken, options?: {
    confirmation_key_thumbprint?: string;
  }): Promise<CapabilityToken>;
  async consume(tokenId: string): Promise<boolean>;
  async consume(capabilityOrTokenId: SignedCapabilityToken | string, options: {
    confirmation_key_thumbprint?: string;
  } = {}): Promise<CapabilityToken | boolean> {
    if (stryMutAct_9fa48("2455")) {
      {}
    } else {
      stryCov_9fa48("2455");
      if (stryMutAct_9fa48("2458") ? typeof capabilityOrTokenId !== 'string' : stryMutAct_9fa48("2457") ? false : stryMutAct_9fa48("2456") ? true : (stryCov_9fa48("2456", "2457", "2458"), typeof capabilityOrTokenId === (stryMutAct_9fa48("2459") ? "" : (stryCov_9fa48("2459"), 'string')))) {
        if (stryMutAct_9fa48("2460")) {
          {}
        } else {
          stryCov_9fa48("2460");
          return stryMutAct_9fa48("2463") ? (await this.#state.consume(capabilityOrTokenId, (await this.#state.read(capabilityOrTokenId))?.token_hash ?? '')) !== 'consumed' : stryMutAct_9fa48("2462") ? false : stryMutAct_9fa48("2461") ? true : (stryCov_9fa48("2461", "2462", "2463"), (await this.#state.consume(capabilityOrTokenId, stryMutAct_9fa48("2464") ? (await this.#state.read(capabilityOrTokenId))?.token_hash && '' : (stryCov_9fa48("2464"), (stryMutAct_9fa48("2465") ? (await this.#state.read(capabilityOrTokenId)).token_hash : (stryCov_9fa48("2465"), (await this.#state.read(capabilityOrTokenId))?.token_hash)) ?? (stryMutAct_9fa48("2466") ? "Stryker was here!" : (stryCov_9fa48("2466"), ''))))) === (stryMutAct_9fa48("2467") ? "" : (stryCov_9fa48("2467"), 'consumed')));
        }
      }
      const claims = await this.verify(capabilityOrTokenId, options);
      const outcome = await this.#state.consume(claims.token_id, hashCapabilityValue(claims));
      if (stryMutAct_9fa48("2470") ? outcome !== 'consumed' : stryMutAct_9fa48("2469") ? false : stryMutAct_9fa48("2468") ? true : (stryCov_9fa48("2468", "2469", "2470"), outcome === (stryMutAct_9fa48("2471") ? "" : (stryCov_9fa48("2471"), 'consumed')))) return claims;
      if (stryMutAct_9fa48("2474") ? outcome !== 'revoked' : stryMutAct_9fa48("2473") ? false : stryMutAct_9fa48("2472") ? true : (stryCov_9fa48("2472", "2473", "2474"), outcome === (stryMutAct_9fa48("2475") ? "" : (stryCov_9fa48("2475"), 'revoked')))) throw new CapabilityRevokedError(stryMutAct_9fa48("2476") ? "" : (stryCov_9fa48("2476"), 'capability has been revoked'));
      if (stryMutAct_9fa48("2479") ? outcome !== 'used' : stryMutAct_9fa48("2478") ? false : stryMutAct_9fa48("2477") ? true : (stryCov_9fa48("2477", "2478", "2479"), outcome === (stryMutAct_9fa48("2480") ? "" : (stryCov_9fa48("2480"), 'used')))) throw new CapabilityUsedError(stryMutAct_9fa48("2481") ? "" : (stryCov_9fa48("2481"), 'capability has already been used'));
      throw new CapabilityInvalidError(stryMutAct_9fa48("2482") ? "" : (stryCov_9fa48("2482"), 'capability state binding failed'));
    }
  }
  async revoke(tokenId: string): Promise<boolean> {
    if (stryMutAct_9fa48("2483")) {
      {}
    } else {
      stryCov_9fa48("2483");
      if (stryMutAct_9fa48("2486") ? false : stryMutAct_9fa48("2485") ? true : stryMutAct_9fa48("2484") ? isUuid(tokenId) : (stryCov_9fa48("2484", "2485", "2486"), !isUuid(tokenId))) throw new CapabilityInvalidError(stryMutAct_9fa48("2487") ? "" : (stryCov_9fa48("2487"), 'token id must be a UUID'));
      return this.#state.revoke(tokenId);
    }
  }
  async authorizeDelegation(options: {
    parent: SignedCapabilityToken;
    parent_grants: CapabilityGrantSet;
    child_manifest_hash: string;
    delegation_depth: number;
  }): Promise<string> {
    if (stryMutAct_9fa48("2488")) {
      {}
    } else {
      stryCov_9fa48("2488");
      const parent = await this.verify(options.parent);
      validateGrantSet(options.parent_grants);
      this.#verifyGrantHashes(parent, options.parent_grants);
      requireHash(options.child_manifest_hash, stryMutAct_9fa48("2489") ? "" : (stryCov_9fa48("2489"), 'child_manifest_hash'));
      if (stryMutAct_9fa48("2492") ? !Number.isSafeInteger(options.delegation_depth) && options.delegation_depth < 1 : stryMutAct_9fa48("2491") ? false : stryMutAct_9fa48("2490") ? true : (stryCov_9fa48("2490", "2491", "2492"), (stryMutAct_9fa48("2493") ? Number.isSafeInteger(options.delegation_depth) : (stryCov_9fa48("2493"), !Number.isSafeInteger(options.delegation_depth))) || (stryMutAct_9fa48("2496") ? options.delegation_depth >= 1 : stryMutAct_9fa48("2495") ? options.delegation_depth <= 1 : stryMutAct_9fa48("2494") ? false : (stryCov_9fa48("2494", "2495", "2496"), options.delegation_depth < 1)))) {
        if (stryMutAct_9fa48("2497")) {
          {}
        } else {
          stryCov_9fa48("2497");
          throw new CapabilityDelegationError(stryMutAct_9fa48("2498") ? "" : (stryCov_9fa48("2498"), 'delegation_depth must be a positive safe integer'));
        }
      }
      const proof: DelegationProof = stryMutAct_9fa48("2499") ? {} : (stryCov_9fa48("2499"), {
        parent_token_id: parent.token_id,
        parent_token_hash: hashCapabilityValue(parent),
        child_manifest_hash: options.child_manifest_hash,
        delegation_depth: options.delegation_depth,
        expires_at: parent.expires_at
      });
      const payload = Buffer.from(JSON.stringify(canonicalizeCapabilityValue(proof))).toString(stryMutAct_9fa48("2500") ? "" : (stryCov_9fa48("2500"), 'base64url'));
      const signature = sign(null, Buffer.from(payload), this.#privateKey).toString(stryMutAct_9fa48("2501") ? "" : (stryCov_9fa48("2501"), 'base64url'));
      return stryMutAct_9fa48("2502") ? `` : (stryCov_9fa48("2502"), `${payload}.${signature}`);
    }
  }
  async issueChild(options: {
    parent: SignedCapabilityToken;
    parent_grants: CapabilityGrantSet;
    request: ChildCapabilityRequest;
    claims: CapabilityIssueRequest;
  }): Promise<SignedCapabilityToken> {
    if (stryMutAct_9fa48("2503")) {
      {}
    } else {
      stryCov_9fa48("2503");
      const parent = await this.verify(options.parent);
      validateGrantSet(options.parent_grants);
      this.#verifyGrantHashes(parent, options.parent_grants);
      const childGrants = this.#validateChildRequest(options.request);
      this.#verifyDelegationProof(options.request, parent);
      if (stryMutAct_9fa48("2506") ? false : stryMutAct_9fa48("2505") ? true : stryMutAct_9fa48("2504") ? childGrants.tools.every(tool => options.parent_grants.tools.includes(tool)) : (stryCov_9fa48("2504", "2505", "2506"), !(stryMutAct_9fa48("2507") ? childGrants.tools.some(tool => options.parent_grants.tools.includes(tool)) : (stryCov_9fa48("2507"), childGrants.tools.every(stryMutAct_9fa48("2508") ? () => undefined : (stryCov_9fa48("2508"), tool => options.parent_grants.tools.includes(tool))))))) {
        if (stryMutAct_9fa48("2509")) {
          {}
        } else {
          stryCov_9fa48("2509");
          throw new CapabilityDelegationError(stryMutAct_9fa48("2510") ? "" : (stryCov_9fa48("2510"), 'child tool grants exceed parent'));
        }
      }
      if (stryMutAct_9fa48("2513") ? false : stryMutAct_9fa48("2512") ? true : stryMutAct_9fa48("2511") ? childGrants.resources.every(resource => resourceAttenuates(resource, options.parent_grants.resources)) : (stryCov_9fa48("2511", "2512", "2513"), !(stryMutAct_9fa48("2514") ? childGrants.resources.some(resource => resourceAttenuates(resource, options.parent_grants.resources)) : (stryCov_9fa48("2514"), childGrants.resources.every(stryMutAct_9fa48("2515") ? () => undefined : (stryCov_9fa48("2515"), resource => resourceAttenuates(resource, options.parent_grants.resources))))))) {
        if (stryMutAct_9fa48("2516")) {
          {}
        } else {
          stryCov_9fa48("2516");
          throw new CapabilityDelegationError(stryMutAct_9fa48("2517") ? "" : (stryCov_9fa48("2517"), 'child resource grants exceed parent'));
        }
      }
      if (stryMutAct_9fa48("2520") ? false : stryMutAct_9fa48("2519") ? true : stryMutAct_9fa48("2518") ? budgetAttenuates(childGrants.budget, options.parent_grants.budget) : (stryCov_9fa48("2518", "2519", "2520"), !budgetAttenuates(childGrants.budget, options.parent_grants.budget))) {
        if (stryMutAct_9fa48("2521")) {
          {}
        } else {
          stryCov_9fa48("2521");
          throw new CapabilityDelegationError(stryMutAct_9fa48("2522") ? "" : (stryCov_9fa48("2522"), 'child budget exceeds parent'));
        }
      }
      validateIssueRequest(options.claims);
      if (stryMutAct_9fa48("2525") ? (options.claims.manifest_hash !== options.request.child_manifest_hash || options.claims.tool_grant_hash !== hashCapabilityGrant(childGrants.tools) || options.claims.resource_grant_hash !== hashCapabilityGrant(childGrants.resources)) && options.claims.budget_ceiling_hash !== hashCapabilityGrant(childGrants.budget) : stryMutAct_9fa48("2524") ? false : stryMutAct_9fa48("2523") ? true : (stryCov_9fa48("2523", "2524", "2525"), (stryMutAct_9fa48("2527") ? (options.claims.manifest_hash !== options.request.child_manifest_hash || options.claims.tool_grant_hash !== hashCapabilityGrant(childGrants.tools)) && options.claims.resource_grant_hash !== hashCapabilityGrant(childGrants.resources) : stryMutAct_9fa48("2526") ? false : (stryCov_9fa48("2526", "2527"), (stryMutAct_9fa48("2529") ? options.claims.manifest_hash !== options.request.child_manifest_hash && options.claims.tool_grant_hash !== hashCapabilityGrant(childGrants.tools) : stryMutAct_9fa48("2528") ? false : (stryCov_9fa48("2528", "2529"), (stryMutAct_9fa48("2531") ? options.claims.manifest_hash === options.request.child_manifest_hash : stryMutAct_9fa48("2530") ? false : (stryCov_9fa48("2530", "2531"), options.claims.manifest_hash !== options.request.child_manifest_hash)) || (stryMutAct_9fa48("2533") ? options.claims.tool_grant_hash === hashCapabilityGrant(childGrants.tools) : stryMutAct_9fa48("2532") ? false : (stryCov_9fa48("2532", "2533"), options.claims.tool_grant_hash !== hashCapabilityGrant(childGrants.tools))))) || (stryMutAct_9fa48("2535") ? options.claims.resource_grant_hash === hashCapabilityGrant(childGrants.resources) : stryMutAct_9fa48("2534") ? false : (stryCov_9fa48("2534", "2535"), options.claims.resource_grant_hash !== hashCapabilityGrant(childGrants.resources))))) || (stryMutAct_9fa48("2537") ? options.claims.budget_ceiling_hash === hashCapabilityGrant(childGrants.budget) : stryMutAct_9fa48("2536") ? false : (stryCov_9fa48("2536", "2537"), options.claims.budget_ceiling_hash !== hashCapabilityGrant(childGrants.budget))))) {
        if (stryMutAct_9fa48("2538")) {
          {}
        } else {
          stryCov_9fa48("2538");
          throw new CapabilityInvalidError(stryMutAct_9fa48("2539") ? "" : (stryCov_9fa48("2539"), 'child claim hashes do not match delegation request'));
        }
      }
      for (const field of ['tenant_id', 'audience', 'subject_workload', 'execution_epoch', 'confirmation_key_thumbprint'] as const) {
        if (stryMutAct_9fa48("2540")) {
          {}
        } else {
          stryCov_9fa48("2540");
          if (stryMutAct_9fa48("2543") ? options.claims[field] === parent[field] : stryMutAct_9fa48("2542") ? false : stryMutAct_9fa48("2541") ? true : (stryCov_9fa48("2541", "2542", "2543"), options.claims[field] !== parent[field])) {
            if (stryMutAct_9fa48("2544")) {
              {}
            } else {
              stryCov_9fa48("2544");
              throw new CapabilityDelegationError(stryMutAct_9fa48("2545") ? `` : (stryCov_9fa48("2545"), `child ${field} must match parent`));
            }
          }
        }
      }
      if (stryMutAct_9fa48("2548") ? Date.parse(options.claims.not_before) < Date.parse(parent.not_before) && Date.parse(options.claims.expires_at) > Date.parse(parent.expires_at) : stryMutAct_9fa48("2547") ? false : stryMutAct_9fa48("2546") ? true : (stryCov_9fa48("2546", "2547", "2548"), (stryMutAct_9fa48("2551") ? Date.parse(options.claims.not_before) >= Date.parse(parent.not_before) : stryMutAct_9fa48("2550") ? Date.parse(options.claims.not_before) <= Date.parse(parent.not_before) : stryMutAct_9fa48("2549") ? false : (stryCov_9fa48("2549", "2550", "2551"), Date.parse(options.claims.not_before) < Date.parse(parent.not_before))) || (stryMutAct_9fa48("2554") ? Date.parse(options.claims.expires_at) <= Date.parse(parent.expires_at) : stryMutAct_9fa48("2553") ? Date.parse(options.claims.expires_at) >= Date.parse(parent.expires_at) : stryMutAct_9fa48("2552") ? false : (stryCov_9fa48("2552", "2553", "2554"), Date.parse(options.claims.expires_at) > Date.parse(parent.expires_at))))) {
        if (stryMutAct_9fa48("2555")) {
          {}
        } else {
          stryCov_9fa48("2555");
          throw new CapabilityDelegationError(stryMutAct_9fa48("2556") ? "" : (stryCov_9fa48("2556"), 'child validity must be bounded by parent'));
        }
      }
      await this.consume(options.parent);
      return this.#issue(options.claims, options.request.parent_delegation_proof);
    }
  }
  async dispatchWithExchangedCredential<T>(request: CredentialDispatchRequest<T>): Promise<T> {
    if (stryMutAct_9fa48("2557")) {
      {}
    } else {
      stryCov_9fa48("2557");
      let claims: CapabilityToken;
      try {
        if (stryMutAct_9fa48("2558")) {
          {}
        } else {
          stryCov_9fa48("2558");
          claims = await this.consume(request.capability, stryMutAct_9fa48("2559") ? {} : (stryCov_9fa48("2559"), {
            confirmation_key_thumbprint: request.confirmation_key_thumbprint
          }));
        }
      } catch (error) {
        if (stryMutAct_9fa48("2560")) {
          {}
        } else {
          stryCov_9fa48("2560");
          throw new CredentialDispatchError(stryMutAct_9fa48("2561") ? "" : (stryCov_9fa48("2561"), 'capability rejected before credential exchange'), error);
        }
      }
      let credential: DisposableCredential | undefined;
      try {
        if (stryMutAct_9fa48("2562")) {
          {}
        } else {
          stryCov_9fa48("2562");
          credential = await request.exchange(stryMutAct_9fa48("2563") ? {} : (stryCov_9fa48("2563"), {
            token_id: claims.token_id,
            operation_id: claims.operation_id,
            attempt_id: claims.attempt_id,
            run_phase: stryMutAct_9fa48("2564") ? "" : (stryCov_9fa48("2564"), 'agent'),
            single_use: stryMutAct_9fa48("2565") ? false : (stryCov_9fa48("2565"), true)
          }));
          if (stryMutAct_9fa48("2568") ? !(credential.value instanceof Uint8Array) && typeof credential.dispose !== 'function' : stryMutAct_9fa48("2567") ? false : stryMutAct_9fa48("2566") ? true : (stryCov_9fa48("2566", "2567", "2568"), (stryMutAct_9fa48("2569") ? credential.value instanceof Uint8Array : (stryCov_9fa48("2569"), !(credential.value instanceof Uint8Array))) || (stryMutAct_9fa48("2571") ? typeof credential.dispose === 'function' : stryMutAct_9fa48("2570") ? false : (stryCov_9fa48("2570", "2571"), typeof credential.dispose !== (stryMutAct_9fa48("2572") ? "" : (stryCov_9fa48("2572"), 'function')))))) {
            if (stryMutAct_9fa48("2573")) {
              {}
            } else {
              stryCov_9fa48("2573");
              throw new CredentialDispatchError(stryMutAct_9fa48("2574") ? "" : (stryCov_9fa48("2574"), 'credential exchange returned an invalid disposable credential'));
            }
          }
          return await request.dispatch(credential.value);
        }
      } finally {
        if (stryMutAct_9fa48("2575")) {
          {}
        } else {
          stryCov_9fa48("2575");
          if (stryMutAct_9fa48("2578") ? credential === undefined : stryMutAct_9fa48("2577") ? false : stryMutAct_9fa48("2576") ? true : (stryCov_9fa48("2576", "2577", "2578"), credential !== undefined)) {
            if (stryMutAct_9fa48("2579")) {
              {}
            } else {
              stryCov_9fa48("2579");
              if (stryMutAct_9fa48("2581") ? false : stryMutAct_9fa48("2580") ? true : (stryCov_9fa48("2580", "2581"), credential.value instanceof Uint8Array)) credential.value.fill(0);
              await credential.dispose();
            }
          }
        }
      }
    }
  }
  #validateEnvelope(capability: SignedCapabilityToken): void {
    if (stryMutAct_9fa48("2582")) {
      {}
    } else {
      stryCov_9fa48("2582");
      if (stryMutAct_9fa48("2585") ? !isRecord(capability) && capability.algorithm !== 'Ed25519' : stryMutAct_9fa48("2584") ? false : stryMutAct_9fa48("2583") ? true : (stryCov_9fa48("2583", "2584", "2585"), (stryMutAct_9fa48("2586") ? isRecord(capability) : (stryCov_9fa48("2586"), !isRecord(capability))) || (stryMutAct_9fa48("2588") ? capability.algorithm === 'Ed25519' : stryMutAct_9fa48("2587") ? false : (stryCov_9fa48("2587", "2588"), capability.algorithm !== (stryMutAct_9fa48("2589") ? "" : (stryCov_9fa48("2589"), 'Ed25519')))))) {
        if (stryMutAct_9fa48("2590")) {
          {}
        } else {
          stryCov_9fa48("2590");
          throw new CapabilityInvalidError(stryMutAct_9fa48("2591") ? "" : (stryCov_9fa48("2591"), 'invalid signed capability envelope'));
        }
      }
      if (stryMutAct_9fa48("2594") ? Object.keys(capability).sort().join(',') === 'algorithm,claims,signature' : stryMutAct_9fa48("2593") ? false : stryMutAct_9fa48("2592") ? true : (stryCov_9fa48("2592", "2593", "2594"), (stryMutAct_9fa48("2595") ? Object.keys(capability).join(',') : (stryCov_9fa48("2595"), Object.keys(capability).sort().join(stryMutAct_9fa48("2596") ? "" : (stryCov_9fa48("2596"), ',')))) !== (stryMutAct_9fa48("2597") ? "" : (stryCov_9fa48("2597"), 'algorithm,claims,signature')))) {
        if (stryMutAct_9fa48("2598")) {
          {}
        } else {
          stryCov_9fa48("2598");
          throw new CapabilityInvalidError(stryMutAct_9fa48("2599") ? "" : (stryCov_9fa48("2599"), 'signed capability contains unknown or missing fields'));
        }
      }
      validateClaimsShape(capability.claims);
      if (stryMutAct_9fa48("2602") ? false : stryMutAct_9fa48("2601") ? true : stryMutAct_9fa48("2600") ? verifyCapabilityClaims(capability.claims, capability.signature, this.#publicKey) : (stryCov_9fa48("2600", "2601", "2602"), !verifyCapabilityClaims(capability.claims, capability.signature, this.#publicKey))) {
        if (stryMutAct_9fa48("2603")) {
          {}
        } else {
          stryCov_9fa48("2603");
          throw new CapabilityInvalidError(stryMutAct_9fa48("2604") ? "" : (stryCov_9fa48("2604"), 'capability signature is invalid'));
        }
      }
    }
  }
  #verifyGrantHashes(parent: CapabilityToken, grants: CapabilityGrantSet): void {
    if (stryMutAct_9fa48("2605")) {
      {}
    } else {
      stryCov_9fa48("2605");
      if (stryMutAct_9fa48("2608") ? (parent.tool_grant_hash !== hashCapabilityGrant(grants.tools) || parent.resource_grant_hash !== hashCapabilityGrant(grants.resources)) && parent.budget_ceiling_hash !== hashCapabilityGrant(grants.budget) : stryMutAct_9fa48("2607") ? false : stryMutAct_9fa48("2606") ? true : (stryCov_9fa48("2606", "2607", "2608"), (stryMutAct_9fa48("2610") ? parent.tool_grant_hash !== hashCapabilityGrant(grants.tools) && parent.resource_grant_hash !== hashCapabilityGrant(grants.resources) : stryMutAct_9fa48("2609") ? false : (stryCov_9fa48("2609", "2610"), (stryMutAct_9fa48("2612") ? parent.tool_grant_hash === hashCapabilityGrant(grants.tools) : stryMutAct_9fa48("2611") ? false : (stryCov_9fa48("2611", "2612"), parent.tool_grant_hash !== hashCapabilityGrant(grants.tools))) || (stryMutAct_9fa48("2614") ? parent.resource_grant_hash === hashCapabilityGrant(grants.resources) : stryMutAct_9fa48("2613") ? false : (stryCov_9fa48("2613", "2614"), parent.resource_grant_hash !== hashCapabilityGrant(grants.resources))))) || (stryMutAct_9fa48("2616") ? parent.budget_ceiling_hash === hashCapabilityGrant(grants.budget) : stryMutAct_9fa48("2615") ? false : (stryCov_9fa48("2615", "2616"), parent.budget_ceiling_hash !== hashCapabilityGrant(grants.budget))))) {
        if (stryMutAct_9fa48("2617")) {
          {}
        } else {
          stryCov_9fa48("2617");
          throw new CapabilityDelegationError(stryMutAct_9fa48("2618") ? "" : (stryCov_9fa48("2618"), 'parent grant material does not match signed hashes'));
        }
      }
    }
  }
  #validateChildRequest(request: ChildCapabilityRequest): CapabilityGrantSet {
    if (stryMutAct_9fa48("2619")) {
      {}
    } else {
      stryCov_9fa48("2619");
      if (stryMutAct_9fa48("2622") ? false : stryMutAct_9fa48("2621") ? true : stryMutAct_9fa48("2620") ? isRecord(request) : (stryCov_9fa48("2620", "2621", "2622"), !isRecord(request))) throw new CapabilityDelegationError(stryMutAct_9fa48("2623") ? "" : (stryCov_9fa48("2623"), 'child request must be an object'));
      const keys = stryMutAct_9fa48("2624") ? [] : (stryCov_9fa48("2624"), [stryMutAct_9fa48("2625") ? "" : (stryCov_9fa48("2625"), 'budget_ceiling'), stryMutAct_9fa48("2626") ? "" : (stryCov_9fa48("2626"), 'child_manifest_hash'), stryMutAct_9fa48("2627") ? "" : (stryCov_9fa48("2627"), 'delegation_depth'), stryMutAct_9fa48("2628") ? "" : (stryCov_9fa48("2628"), 'parent_delegation_proof'), stryMutAct_9fa48("2629") ? "" : (stryCov_9fa48("2629"), 'resource_grants'), stryMutAct_9fa48("2630") ? "" : (stryCov_9fa48("2630"), 'tool_grants')]);
      if (stryMutAct_9fa48("2633") ? Object.keys(request).sort().join(',') === keys.join(',') : stryMutAct_9fa48("2632") ? false : stryMutAct_9fa48("2631") ? true : (stryCov_9fa48("2631", "2632", "2633"), (stryMutAct_9fa48("2634") ? Object.keys(request).join(',') : (stryCov_9fa48("2634"), Object.keys(request).sort().join(stryMutAct_9fa48("2635") ? "" : (stryCov_9fa48("2635"), ',')))) !== keys.join(stryMutAct_9fa48("2636") ? "" : (stryCov_9fa48("2636"), ',')))) {
        if (stryMutAct_9fa48("2637")) {
          {}
        } else {
          stryCov_9fa48("2637");
          throw new CapabilityDelegationError(stryMutAct_9fa48("2638") ? "" : (stryCov_9fa48("2638"), 'child request contains unknown or missing fields'));
        }
      }
      requireHash(request.child_manifest_hash, stryMutAct_9fa48("2639") ? "" : (stryCov_9fa48("2639"), 'child_manifest_hash'));
      requireNonEmpty(request.parent_delegation_proof, stryMutAct_9fa48("2640") ? "" : (stryCov_9fa48("2640"), 'parent_delegation_proof'));
      if (stryMutAct_9fa48("2643") ? !Number.isSafeInteger(request.delegation_depth) && request.delegation_depth < 1 : stryMutAct_9fa48("2642") ? false : stryMutAct_9fa48("2641") ? true : (stryCov_9fa48("2641", "2642", "2643"), (stryMutAct_9fa48("2644") ? Number.isSafeInteger(request.delegation_depth) : (stryCov_9fa48("2644"), !Number.isSafeInteger(request.delegation_depth))) || (stryMutAct_9fa48("2647") ? request.delegation_depth >= 1 : stryMutAct_9fa48("2646") ? request.delegation_depth <= 1 : stryMutAct_9fa48("2645") ? false : (stryCov_9fa48("2645", "2646", "2647"), request.delegation_depth < 1)))) {
        if (stryMutAct_9fa48("2648")) {
          {}
        } else {
          stryCov_9fa48("2648");
          throw new CapabilityDelegationError(stryMutAct_9fa48("2649") ? "" : (stryCov_9fa48("2649"), 'delegation_depth must be a positive safe integer'));
        }
      }
      const grants: CapabilityGrantSet = stryMutAct_9fa48("2650") ? {} : (stryCov_9fa48("2650"), {
        tools: request.tool_grants as string[],
        resources: request.resource_grants as string[],
        budget: request.budget_ceiling
      });
      validateGrantSet(grants);
      return grants;
    }
  }
  #verifyDelegationProof(request: ChildCapabilityRequest, parent: CapabilityToken): void {
    if (stryMutAct_9fa48("2651")) {
      {}
    } else {
      stryCov_9fa48("2651");
      const [payload, signature, extra] = request.parent_delegation_proof.split(stryMutAct_9fa48("2652") ? "" : (stryCov_9fa48("2652"), '.'));
      if (stryMutAct_9fa48("2655") ? (payload === undefined || signature === undefined) && extra !== undefined : stryMutAct_9fa48("2654") ? false : stryMutAct_9fa48("2653") ? true : (stryCov_9fa48("2653", "2654", "2655"), (stryMutAct_9fa48("2657") ? payload === undefined && signature === undefined : stryMutAct_9fa48("2656") ? false : (stryCov_9fa48("2656", "2657"), (stryMutAct_9fa48("2659") ? payload !== undefined : stryMutAct_9fa48("2658") ? false : (stryCov_9fa48("2658", "2659"), payload === undefined)) || (stryMutAct_9fa48("2661") ? signature !== undefined : stryMutAct_9fa48("2660") ? false : (stryCov_9fa48("2660", "2661"), signature === undefined)))) || (stryMutAct_9fa48("2663") ? extra === undefined : stryMutAct_9fa48("2662") ? false : (stryCov_9fa48("2662", "2663"), extra !== undefined)))) {
        if (stryMutAct_9fa48("2664")) {
          {}
        } else {
          stryCov_9fa48("2664");
          throw new CapabilityDelegationError(stryMutAct_9fa48("2665") ? "" : (stryCov_9fa48("2665"), 'invalid delegation proof envelope'));
        }
      }
      if (stryMutAct_9fa48("2668") ? false : stryMutAct_9fa48("2667") ? true : stryMutAct_9fa48("2666") ? verify(null, Buffer.from(payload), this.#publicKey, Buffer.from(signature, 'base64url')) : (stryCov_9fa48("2666", "2667", "2668"), !verify(null, Buffer.from(payload), this.#publicKey, Buffer.from(signature, stryMutAct_9fa48("2669") ? "" : (stryCov_9fa48("2669"), 'base64url'))))) {
        if (stryMutAct_9fa48("2670")) {
          {}
        } else {
          stryCov_9fa48("2670");
          throw new CapabilityDelegationError(stryMutAct_9fa48("2671") ? "" : (stryCov_9fa48("2671"), 'delegation proof signature is invalid'));
        }
      }
      let proof: unknown;
      try {
        if (stryMutAct_9fa48("2672")) {
          {}
        } else {
          stryCov_9fa48("2672");
          proof = JSON.parse(Buffer.from(payload, stryMutAct_9fa48("2673") ? "" : (stryCov_9fa48("2673"), 'base64url')).toString(stryMutAct_9fa48("2674") ? "" : (stryCov_9fa48("2674"), 'utf8')));
        }
      } catch {
        if (stryMutAct_9fa48("2675")) {
          {}
        } else {
          stryCov_9fa48("2675");
          throw new CapabilityDelegationError(stryMutAct_9fa48("2676") ? "" : (stryCov_9fa48("2676"), 'delegation proof payload is invalid'));
        }
      }
      if (stryMutAct_9fa48("2679") ? (!isRecord(proof) || proof.parent_token_id !== parent.token_id || proof.parent_token_hash !== hashCapabilityValue(parent) || proof.child_manifest_hash !== request.child_manifest_hash || proof.delegation_depth !== request.delegation_depth || proof.expires_at !== parent.expires_at) && Object.keys(proof).sort().join(',') !== 'child_manifest_hash,delegation_depth,expires_at,parent_token_hash,parent_token_id' : stryMutAct_9fa48("2678") ? false : stryMutAct_9fa48("2677") ? true : (stryCov_9fa48("2677", "2678", "2679"), (stryMutAct_9fa48("2681") ? (!isRecord(proof) || proof.parent_token_id !== parent.token_id || proof.parent_token_hash !== hashCapabilityValue(parent) || proof.child_manifest_hash !== request.child_manifest_hash || proof.delegation_depth !== request.delegation_depth) && proof.expires_at !== parent.expires_at : stryMutAct_9fa48("2680") ? false : (stryCov_9fa48("2680", "2681"), (stryMutAct_9fa48("2683") ? (!isRecord(proof) || proof.parent_token_id !== parent.token_id || proof.parent_token_hash !== hashCapabilityValue(parent) || proof.child_manifest_hash !== request.child_manifest_hash) && proof.delegation_depth !== request.delegation_depth : stryMutAct_9fa48("2682") ? false : (stryCov_9fa48("2682", "2683"), (stryMutAct_9fa48("2685") ? (!isRecord(proof) || proof.parent_token_id !== parent.token_id || proof.parent_token_hash !== hashCapabilityValue(parent)) && proof.child_manifest_hash !== request.child_manifest_hash : stryMutAct_9fa48("2684") ? false : (stryCov_9fa48("2684", "2685"), (stryMutAct_9fa48("2687") ? (!isRecord(proof) || proof.parent_token_id !== parent.token_id) && proof.parent_token_hash !== hashCapabilityValue(parent) : stryMutAct_9fa48("2686") ? false : (stryCov_9fa48("2686", "2687"), (stryMutAct_9fa48("2689") ? !isRecord(proof) && proof.parent_token_id !== parent.token_id : stryMutAct_9fa48("2688") ? false : (stryCov_9fa48("2688", "2689"), (stryMutAct_9fa48("2690") ? isRecord(proof) : (stryCov_9fa48("2690"), !isRecord(proof))) || (stryMutAct_9fa48("2692") ? proof.parent_token_id === parent.token_id : stryMutAct_9fa48("2691") ? false : (stryCov_9fa48("2691", "2692"), proof.parent_token_id !== parent.token_id)))) || (stryMutAct_9fa48("2694") ? proof.parent_token_hash === hashCapabilityValue(parent) : stryMutAct_9fa48("2693") ? false : (stryCov_9fa48("2693", "2694"), proof.parent_token_hash !== hashCapabilityValue(parent))))) || (stryMutAct_9fa48("2696") ? proof.child_manifest_hash === request.child_manifest_hash : stryMutAct_9fa48("2695") ? false : (stryCov_9fa48("2695", "2696"), proof.child_manifest_hash !== request.child_manifest_hash)))) || (stryMutAct_9fa48("2698") ? proof.delegation_depth === request.delegation_depth : stryMutAct_9fa48("2697") ? false : (stryCov_9fa48("2697", "2698"), proof.delegation_depth !== request.delegation_depth)))) || (stryMutAct_9fa48("2700") ? proof.expires_at === parent.expires_at : stryMutAct_9fa48("2699") ? false : (stryCov_9fa48("2699", "2700"), proof.expires_at !== parent.expires_at)))) || (stryMutAct_9fa48("2702") ? Object.keys(proof).sort().join(',') === 'child_manifest_hash,delegation_depth,expires_at,parent_token_hash,parent_token_id' : stryMutAct_9fa48("2701") ? false : (stryCov_9fa48("2701", "2702"), (stryMutAct_9fa48("2703") ? Object.keys(proof).join(',') : (stryCov_9fa48("2703"), Object.keys(proof).sort().join(stryMutAct_9fa48("2704") ? "" : (stryCov_9fa48("2704"), ',')))) !== (stryMutAct_9fa48("2705") ? "" : (stryCov_9fa48("2705"), 'child_manifest_hash,delegation_depth,expires_at,parent_token_hash,parent_token_id')))))) {
        if (stryMutAct_9fa48("2706")) {
          {}
        } else {
          stryCov_9fa48("2706");
          throw new CapabilityDelegationError(stryMutAct_9fa48("2707") ? "" : (stryCov_9fa48("2707"), 'delegation proof does not bind this request'));
        }
      }
    }
  }
}