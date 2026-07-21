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
import type { ProviderAdapter as ProviderAdapterContract, ProviderType } from '../../spec/types/provider-adapter.js';
import type { DataPolicyResult, HealthStatus, ParsedResponse, ProviderError, ProviderRequest, ScriptedTestProvider, Usage } from './scripted-provider.js';
type MaybePromise<T> = Promise<T> | T;
type ScriptedRuntimeMethods = Pick<ScriptedTestProvider, 'mapError' | 'meterUsage' | 'normalizeRequest' | 'normalizeToolCall' | 'parseResponse' | 'streamEvents' | 'validateDataPolicy'>;
export interface EphemeralCredentialLease {
  readonly lease_id: string;
  readonly audience: string;
  readonly expires_at: string;
}
export interface ProviderDispatchContext {
  readonly operation_id: string;
  readonly credential?: EphemeralCredentialLease;
}

/** The operational method set derives from the verified ScriptedTestProvider. */
export type GatewayProviderRuntime = ScriptedRuntimeMethods & {
  provider_type: ProviderType;
  checkHealth: () => MaybePromise<HealthStatus>;
  resolve: (request: Parameters<ScriptedTestProvider['resolve']>[0], context?: ProviderDispatchContext) => MaybePromise<ReturnType<ScriptedTestProvider['resolve']>>;
};
export interface ProviderDataPolicyMetadata {
  execution: 'local' | 'remote';
  regions: string[];
  retention_days: number;
  training_allowed: boolean;
}
export interface ProviderPricingMetadata {
  currency: 'USD';
  input_per_million: number;
  output_per_million: number;
}
export interface ProviderNetworkMetadata {
  required: boolean;
  destination?: string;
}
export interface ProviderCredentialMetadata {
  required: boolean;
  audience: string;
}
export interface GatewayProviderMetadata {
  capabilities: string[];
  max_context_tokens: number;
  structured_output: boolean;
  tool_calling: boolean;
  data_policy: ProviderDataPolicyMetadata;
  pricing: ProviderPricingMetadata;
  health: HealthStatus;
  network: ProviderNetworkMetadata;
  credentials: ProviderCredentialMetadata;
}
export interface GatewayProviderRegistration {
  provider_id: string;
  contract: ProviderAdapterContract;
  adapter: GatewayProviderRuntime;
  metadata: GatewayProviderMetadata;
}
export interface ProviderSnapshotEntry extends Readonly<GatewayProviderMetadata> {
  readonly provider_id: string;
  readonly provider_type: ProviderType;
  readonly contract: Readonly<ProviderAdapterContract>;
  readonly metadata_hash: string;
}
export interface ProviderRegistrySnapshot {
  readonly hash: string;
  readonly providers: readonly ProviderSnapshotEntry[];
}
export interface RequiredDataPolicy {
  local_only: boolean;
  allowed_regions: readonly string[];
  max_retention_days: number;
  training_allowed: boolean;
}
export interface ProviderAuthorityConstraints {
  allowed_provider_ids: readonly string[] | undefined;
  denied_provider_ids: readonly string[];
}
export interface ProviderRunPlanConstraints {
  allowed_provider_ids: readonly string[] | undefined;
  required_capabilities: readonly string[];
}
export interface ProviderSelectionRequest {
  registry_snapshot_hash: string;
  request: ProviderRequest;
  estimated_input_tokens: number;
  required_capabilities: readonly string[];
  requires_structured_output: boolean;
  data_policy: RequiredDataPolicy;
  policy: ProviderAuthorityConstraints;
  run_plan: ProviderRunPlanConstraints;
}
export interface ResolvedProvider {
  readonly provider_id: string;
  readonly registry_snapshot_hash: string;
  readonly provider_metadata_hash: string;
  readonly selection_request_hash: string;
}
export interface SecretsBrokerPort {
  exchangeCredential(input: {
    readonly provider_id: string;
    readonly audience: string;
    readonly operation_id: string;
  }): Promise<EphemeralCredentialLease>;
}
export interface EgressPolicyPort {
  authorize(input: {
    readonly provider_id: string;
    readonly destination?: string;
    readonly network_required: boolean;
    readonly data_policy: Readonly<RequiredDataPolicy>;
    readonly operation_id: string;
  }): Promise<{
    readonly allowed: boolean;
    readonly reason?: string;
  }>;
}
export interface UsageMeterPort {
  record(input: {
    readonly provider_id: string;
    readonly operation_id: string;
    readonly usage: Usage;
  }): Promise<void>;
}
export interface GatewayDispatchResult {
  readonly provider_id: string;
  readonly response: ParsedResponse;
  readonly usage: Usage;
}
export class ProviderConfigurationError extends TypeError {
  constructor(message: string) {
    if (stryMutAct_9fa48("0")) {
      {}
    } else {
      stryCov_9fa48("0");
      super(message);
      this.name = stryMutAct_9fa48("1") ? "" : (stryCov_9fa48("1"), 'ProviderConfigurationError');
    }
  }
}
export type ProviderResolutionErrorCode = 'no_compatible_provider' | 'stale_registry_snapshot';
export class ProviderResolutionError extends Error {
  readonly code: ProviderResolutionErrorCode;
  constructor(code: ProviderResolutionErrorCode, message: string) {
    if (stryMutAct_9fa48("2")) {
      {}
    } else {
      stryCov_9fa48("2");
      super(message);
      this.name = stryMutAct_9fa48("3") ? "" : (stryCov_9fa48("3"), 'ProviderResolutionError');
      this.code = code;
    }
  }
}
export type ProviderDispatchErrorCode = 'credential_exchange_failed' | 'egress_denied' | 'egress_policy_failure' | 'metering_failed' | 'provider_failure' | 'provider_no_longer_compatible' | 'provider_unhealthy';
export class ProviderDispatchError extends Error {
  readonly code: ProviderDispatchErrorCode;
  readonly provider_error?: ProviderError;
  constructor(code: ProviderDispatchErrorCode, providerError?: ProviderError) {
    if (stryMutAct_9fa48("4")) {
      {}
    } else {
      stryCov_9fa48("4");
      super(stryMutAct_9fa48("5") ? `` : (stryCov_9fa48("5"), `ModelGateway dispatch failed: ${code}`));
      this.name = stryMutAct_9fa48("6") ? "" : (stryCov_9fa48("6"), 'ProviderDispatchError');
      this.code = code;
      if (stryMutAct_9fa48("9") ? providerError === undefined : stryMutAct_9fa48("8") ? false : stryMutAct_9fa48("7") ? true : (stryCov_9fa48("7", "8", "9"), providerError !== undefined)) this.provider_error = deepFreeze(stryMutAct_9fa48("10") ? {} : (stryCov_9fa48("10"), {
        ...providerError
      }));
    }
  }
}
interface NormalizedBinding {
  readonly entry: ProviderSnapshotEntry;
  readonly adapter: GatewayProviderRuntime;
}
const REQUIRED_CONTRACT_METHODS = ['normalize_request', 'parse_response', 'normalize_tool_call', 'stream_events', 'map_error', 'meter_usage', 'check_health', 'validate_data_policy'] as const;
const RUNTIME_METHODS = ['normalizeRequest', 'parseResponse', 'normalizeToolCall', 'streamEvents', 'mapError', 'meterUsage', 'checkHealth', 'validateDataPolicy', 'resolve'] as const;
const PROVIDER_TYPES = ['openai', 'anthropic', 'google', 'local', 'scripted_test'] as const satisfies readonly ProviderType[];
const registryBindings = new WeakMap<FrozenProviderRegistry, ReadonlyMap<string, NormalizedBinding>>();
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (stryMutAct_9fa48("11")) {
    {}
  } else {
    stryCov_9fa48("11");
    if (stryMutAct_9fa48("14") ? (typeof value !== 'object' || value === null) && Array.isArray(value) : stryMutAct_9fa48("13") ? false : stryMutAct_9fa48("12") ? true : (stryCov_9fa48("12", "13", "14"), (stryMutAct_9fa48("16") ? typeof value !== 'object' && value === null : stryMutAct_9fa48("15") ? false : (stryCov_9fa48("15", "16"), (stryMutAct_9fa48("18") ? typeof value === 'object' : stryMutAct_9fa48("17") ? false : (stryCov_9fa48("17", "18"), typeof value !== (stryMutAct_9fa48("19") ? "" : (stryCov_9fa48("19"), 'object')))) || (stryMutAct_9fa48("21") ? value !== null : stryMutAct_9fa48("20") ? false : (stryCov_9fa48("20", "21"), value === null)))) || Array.isArray(value))) return stryMutAct_9fa48("22") ? true : (stryCov_9fa48("22"), false);
    const prototype = Object.getPrototypeOf(value) as unknown;
    return stryMutAct_9fa48("25") ? prototype === Object.prototype && prototype === null : stryMutAct_9fa48("24") ? false : stryMutAct_9fa48("23") ? true : (stryCov_9fa48("23", "24", "25"), (stryMutAct_9fa48("27") ? prototype !== Object.prototype : stryMutAct_9fa48("26") ? false : (stryCov_9fa48("26", "27"), prototype === Object.prototype)) || (stryMutAct_9fa48("29") ? prototype !== null : stryMutAct_9fa48("28") ? false : (stryCov_9fa48("28", "29"), prototype === null)));
  }
}
function assertPlainRecord(value: unknown, location: string): asserts value is Record<string, unknown> {
  if (stryMutAct_9fa48("30")) {
    {}
  } else {
    stryCov_9fa48("30");
    if (stryMutAct_9fa48("33") ? false : stryMutAct_9fa48("32") ? true : stryMutAct_9fa48("31") ? isPlainRecord(value) : (stryCov_9fa48("31", "32", "33"), !isPlainRecord(value))) throw new ProviderConfigurationError(stryMutAct_9fa48("34") ? `` : (stryCov_9fa48("34"), `${location} must be an object`));
  }
}
function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[], location: string) {
  if (stryMutAct_9fa48("35")) {
    {}
  } else {
    stryCov_9fa48("35");
    const unknown = stryMutAct_9fa48("36") ? Object.keys(value) : (stryCov_9fa48("36"), Object.keys(value).filter(stryMutAct_9fa48("37") ? () => undefined : (stryCov_9fa48("37"), key => stryMutAct_9fa48("38") ? keys.includes(key) : (stryCov_9fa48("38"), !keys.includes(key)))));
    if (stryMutAct_9fa48("42") ? unknown.length <= 0 : stryMutAct_9fa48("41") ? unknown.length >= 0 : stryMutAct_9fa48("40") ? false : stryMutAct_9fa48("39") ? true : (stryCov_9fa48("39", "40", "41", "42"), unknown.length > 0)) {
      if (stryMutAct_9fa48("43")) {
        {}
      } else {
        stryCov_9fa48("43");
        throw new ProviderConfigurationError(stryMutAct_9fa48("44") ? `` : (stryCov_9fa48("44"), `${location} contains unknown field: ${unknown[0]}`));
      }
    }
  }
}
function nonEmptyString(value: unknown, location: string): string {
  if (stryMutAct_9fa48("45")) {
    {}
  } else {
    stryCov_9fa48("45");
    if (stryMutAct_9fa48("48") ? typeof value !== 'string' && value.trim().length === 0 : stryMutAct_9fa48("47") ? false : stryMutAct_9fa48("46") ? true : (stryCov_9fa48("46", "47", "48"), (stryMutAct_9fa48("50") ? typeof value === 'string' : stryMutAct_9fa48("49") ? false : (stryCov_9fa48("49", "50"), typeof value !== (stryMutAct_9fa48("51") ? "" : (stryCov_9fa48("51"), 'string')))) || (stryMutAct_9fa48("53") ? value.trim().length !== 0 : stryMutAct_9fa48("52") ? false : (stryCov_9fa48("52", "53"), (stryMutAct_9fa48("54") ? value.length : (stryCov_9fa48("54"), value.trim().length)) === 0)))) {
      if (stryMutAct_9fa48("55")) {
        {}
      } else {
        stryCov_9fa48("55");
        throw new ProviderConfigurationError(stryMutAct_9fa48("56") ? `` : (stryCov_9fa48("56"), `${location} must be a non-empty string`));
      }
    }
    return value;
  }
}
function finiteNonNegative(value: unknown, location: string): number {
  if (stryMutAct_9fa48("57")) {
    {}
  } else {
    stryCov_9fa48("57");
    if (stryMutAct_9fa48("60") ? (typeof value !== 'number' || !Number.isFinite(value)) && value < 0 : stryMutAct_9fa48("59") ? false : stryMutAct_9fa48("58") ? true : (stryCov_9fa48("58", "59", "60"), (stryMutAct_9fa48("62") ? typeof value !== 'number' && !Number.isFinite(value) : stryMutAct_9fa48("61") ? false : (stryCov_9fa48("61", "62"), (stryMutAct_9fa48("64") ? typeof value === 'number' : stryMutAct_9fa48("63") ? false : (stryCov_9fa48("63", "64"), typeof value !== (stryMutAct_9fa48("65") ? "" : (stryCov_9fa48("65"), 'number')))) || (stryMutAct_9fa48("66") ? Number.isFinite(value) : (stryCov_9fa48("66"), !Number.isFinite(value))))) || (stryMutAct_9fa48("69") ? value >= 0 : stryMutAct_9fa48("68") ? value <= 0 : stryMutAct_9fa48("67") ? false : (stryCov_9fa48("67", "68", "69"), value < 0)))) {
      if (stryMutAct_9fa48("70")) {
        {}
      } else {
        stryCov_9fa48("70");
        throw new ProviderConfigurationError(stryMutAct_9fa48("71") ? `` : (stryCov_9fa48("71"), `${location} must be a finite non-negative number`));
      }
    }
    return value;
  }
}
function safeInteger(value: unknown, minimum: number, location: string): number {
  if (stryMutAct_9fa48("72")) {
    {}
  } else {
    stryCov_9fa48("72");
    if (stryMutAct_9fa48("75") ? !Number.isSafeInteger(value) && value as number < minimum : stryMutAct_9fa48("74") ? false : stryMutAct_9fa48("73") ? true : (stryCov_9fa48("73", "74", "75"), (stryMutAct_9fa48("76") ? Number.isSafeInteger(value) : (stryCov_9fa48("76"), !Number.isSafeInteger(value))) || (stryMutAct_9fa48("79") ? value as number >= minimum : stryMutAct_9fa48("78") ? value as number <= minimum : stryMutAct_9fa48("77") ? false : (stryCov_9fa48("77", "78", "79"), value as number < minimum)))) {
      if (stryMutAct_9fa48("80")) {
        {}
      } else {
        stryCov_9fa48("80");
        throw new ProviderConfigurationError(stryMutAct_9fa48("81") ? `` : (stryCov_9fa48("81"), `${location} must be a safe integer >= ${minimum}`));
      }
    }
    return value as number;
  }
}
function booleanValue(value: unknown, location: string): boolean {
  if (stryMutAct_9fa48("82")) {
    {}
  } else {
    stryCov_9fa48("82");
    if (stryMutAct_9fa48("85") ? typeof value === 'boolean' : stryMutAct_9fa48("84") ? false : stryMutAct_9fa48("83") ? true : (stryCov_9fa48("83", "84", "85"), typeof value !== (stryMutAct_9fa48("86") ? "" : (stryCov_9fa48("86"), 'boolean')))) {
      if (stryMutAct_9fa48("87")) {
        {}
      } else {
        stryCov_9fa48("87");
        throw new ProviderConfigurationError(stryMutAct_9fa48("88") ? `` : (stryCov_9fa48("88"), `${location} must be a boolean`));
      }
    }
    return value;
  }
}
function binaryCompare(left: string, right: string): number {
  if (stryMutAct_9fa48("89")) {
    {}
  } else {
    stryCov_9fa48("89");
    return (stryMutAct_9fa48("93") ? left >= right : stryMutAct_9fa48("92") ? left <= right : stryMutAct_9fa48("91") ? false : stryMutAct_9fa48("90") ? true : (stryCov_9fa48("90", "91", "92", "93"), left < right)) ? stryMutAct_9fa48("94") ? +1 : (stryCov_9fa48("94"), -1) : (stryMutAct_9fa48("98") ? left <= right : stryMutAct_9fa48("97") ? left >= right : stryMutAct_9fa48("96") ? false : stryMutAct_9fa48("95") ? true : (stryCov_9fa48("95", "96", "97", "98"), left > right)) ? 1 : 0;
  }
}
function uniqueStrings(value: unknown, location: string, allowEmpty: boolean): string[] {
  if (stryMutAct_9fa48("99")) {
    {}
  } else {
    stryCov_9fa48("99");
    if (stryMutAct_9fa48("102") ? false : stryMutAct_9fa48("101") ? true : stryMutAct_9fa48("100") ? Array.isArray(value) : (stryCov_9fa48("100", "101", "102"), !Array.isArray(value))) throw new ProviderConfigurationError(stryMutAct_9fa48("103") ? `` : (stryCov_9fa48("103"), `${location} must be an array`));
    const normalized = value.map(stryMutAct_9fa48("104") ? () => undefined : (stryCov_9fa48("104"), (entry, index) => nonEmptyString(entry, stryMutAct_9fa48("105") ? `` : (stryCov_9fa48("105"), `${location}[${index}]`))));
    if (stryMutAct_9fa48("108") ? !allowEmpty || normalized.length === 0 : stryMutAct_9fa48("107") ? false : stryMutAct_9fa48("106") ? true : (stryCov_9fa48("106", "107", "108"), (stryMutAct_9fa48("109") ? allowEmpty : (stryCov_9fa48("109"), !allowEmpty)) && (stryMutAct_9fa48("111") ? normalized.length !== 0 : stryMutAct_9fa48("110") ? true : (stryCov_9fa48("110", "111"), normalized.length === 0)))) {
      if (stryMutAct_9fa48("112")) {
        {}
      } else {
        stryCov_9fa48("112");
        throw new ProviderConfigurationError(stryMutAct_9fa48("113") ? `` : (stryCov_9fa48("113"), `${location} must not be empty`));
      }
    }
    if (stryMutAct_9fa48("116") ? new Set(normalized).size === normalized.length : stryMutAct_9fa48("115") ? false : stryMutAct_9fa48("114") ? true : (stryCov_9fa48("114", "115", "116"), new Set(normalized).size !== normalized.length)) {
      if (stryMutAct_9fa48("117")) {
        {}
      } else {
        stryCov_9fa48("117");
        throw new ProviderConfigurationError(stryMutAct_9fa48("118") ? `` : (stryCov_9fa48("118"), `${location} must not contain duplicates`));
      }
    }
    return stryMutAct_9fa48("119") ? normalized : (stryCov_9fa48("119"), normalized.sort(binaryCompare));
  }
}
function deepFreeze<T>(value: T): T {
  if (stryMutAct_9fa48("120")) {
    {}
  } else {
    stryCov_9fa48("120");
    if (stryMutAct_9fa48("123") ? (typeof value !== 'object' || value === null) && Object.isFrozen(value) : stryMutAct_9fa48("122") ? false : stryMutAct_9fa48("121") ? true : (stryCov_9fa48("121", "122", "123"), (stryMutAct_9fa48("125") ? typeof value !== 'object' && value === null : stryMutAct_9fa48("124") ? false : (stryCov_9fa48("124", "125"), (stryMutAct_9fa48("127") ? typeof value === 'object' : stryMutAct_9fa48("126") ? false : (stryCov_9fa48("126", "127"), typeof value !== (stryMutAct_9fa48("128") ? "" : (stryCov_9fa48("128"), 'object')))) || (stryMutAct_9fa48("130") ? value !== null : stryMutAct_9fa48("129") ? false : (stryCov_9fa48("129", "130"), value === null)))) || Object.isFrozen(value))) return value;
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    return Object.freeze(value);
  }
}
function canonicalJson(value: unknown): string {
  if (stryMutAct_9fa48("131")) {
    {}
  } else {
    stryCov_9fa48("131");
    if (stryMutAct_9fa48("134") ? (value === null || typeof value === 'boolean') && typeof value === 'string' : stryMutAct_9fa48("133") ? false : stryMutAct_9fa48("132") ? true : (stryCov_9fa48("132", "133", "134"), (stryMutAct_9fa48("136") ? value === null && typeof value === 'boolean' : stryMutAct_9fa48("135") ? false : (stryCov_9fa48("135", "136"), (stryMutAct_9fa48("138") ? value !== null : stryMutAct_9fa48("137") ? false : (stryCov_9fa48("137", "138"), value === null)) || (stryMutAct_9fa48("140") ? typeof value !== 'boolean' : stryMutAct_9fa48("139") ? false : (stryCov_9fa48("139", "140"), typeof value === (stryMutAct_9fa48("141") ? "" : (stryCov_9fa48("141"), 'boolean')))))) || (stryMutAct_9fa48("143") ? typeof value !== 'string' : stryMutAct_9fa48("142") ? false : (stryCov_9fa48("142", "143"), typeof value === (stryMutAct_9fa48("144") ? "" : (stryCov_9fa48("144"), 'string')))))) {
      if (stryMutAct_9fa48("145")) {
        {}
      } else {
        stryCov_9fa48("145");
        return JSON.stringify(value);
      }
    }
    if (stryMutAct_9fa48("148") ? typeof value !== 'number' : stryMutAct_9fa48("147") ? false : stryMutAct_9fa48("146") ? true : (stryCov_9fa48("146", "147", "148"), typeof value === (stryMutAct_9fa48("149") ? "" : (stryCov_9fa48("149"), 'number')))) {
      if (stryMutAct_9fa48("150")) {
        {}
      } else {
        stryCov_9fa48("150");
        if (stryMutAct_9fa48("153") ? false : stryMutAct_9fa48("152") ? true : stryMutAct_9fa48("151") ? Number.isFinite(value) : (stryCov_9fa48("151", "152", "153"), !Number.isFinite(value))) throw new ProviderConfigurationError(stryMutAct_9fa48("154") ? "" : (stryCov_9fa48("154"), 'hash input must be JSON'));
        return JSON.stringify(value);
      }
    }
    if (stryMutAct_9fa48("156") ? false : stryMutAct_9fa48("155") ? true : (stryCov_9fa48("155", "156"), Array.isArray(value))) return stryMutAct_9fa48("157") ? `` : (stryCov_9fa48("157"), `[${value.map(stryMutAct_9fa48("158") ? () => undefined : (stryCov_9fa48("158"), entry => canonicalJson(entry))).join(stryMutAct_9fa48("159") ? "" : (stryCov_9fa48("159"), ','))}]`);
    if (stryMutAct_9fa48("161") ? false : stryMutAct_9fa48("160") ? true : (stryCov_9fa48("160", "161"), isPlainRecord(value))) {
      if (stryMutAct_9fa48("162")) {
        {}
      } else {
        stryCov_9fa48("162");
        return stryMutAct_9fa48("163") ? `` : (stryCov_9fa48("163"), `{${stryMutAct_9fa48("165") ? Object.entries(value).sort(([left], [right]) => binaryCompare(left, right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',') : stryMutAct_9fa48("164") ? Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',') : (stryCov_9fa48("164", "165"), Object.entries(value).filter(stryMutAct_9fa48("166") ? () => undefined : (stryCov_9fa48("166"), ([, entry]) => stryMutAct_9fa48("169") ? entry === undefined : stryMutAct_9fa48("168") ? false : stryMutAct_9fa48("167") ? true : (stryCov_9fa48("167", "168", "169"), entry !== undefined))).sort(stryMutAct_9fa48("170") ? () => undefined : (stryCov_9fa48("170"), ([left], [right]) => binaryCompare(left, right))).map(stryMutAct_9fa48("171") ? () => undefined : (stryCov_9fa48("171"), ([key, entry]) => stryMutAct_9fa48("172") ? `` : (stryCov_9fa48("172"), `${JSON.stringify(key)}:${canonicalJson(entry)}`))).join(stryMutAct_9fa48("173") ? "" : (stryCov_9fa48("173"), ',')))}}`);
      }
    }
    throw new ProviderConfigurationError(stryMutAct_9fa48("174") ? "" : (stryCov_9fa48("174"), 'hash input must be plain JSON data'));
  }
}
function contentHash(value: unknown): string {
  if (stryMutAct_9fa48("175")) {
    {}
  } else {
    stryCov_9fa48("175");
    return createHash(stryMutAct_9fa48("176") ? "" : (stryCov_9fa48("176"), 'sha256')).update(canonicalJson(value)).digest(stryMutAct_9fa48("177") ? "" : (stryCov_9fa48("177"), 'hex'));
  }
}
function normalizeContract(raw: unknown, location: string): Readonly<ProviderAdapterContract> {
  if (stryMutAct_9fa48("178")) {
    {}
  } else {
    stryCov_9fa48("178");
    assertPlainRecord(raw, location);
    assertKnownKeys(raw, stryMutAct_9fa48("179") ? [] : (stryCov_9fa48("179"), [stryMutAct_9fa48("180") ? "" : (stryCov_9fa48("180"), 'provider_type'), ...REQUIRED_CONTRACT_METHODS, stryMutAct_9fa48("181") ? "" : (stryCov_9fa48("181"), 'fallback_compatibility_checker'), stryMutAct_9fa48("182") ? "" : (stryCov_9fa48("182"), 'rate_limiter'), stryMutAct_9fa48("183") ? "" : (stryCov_9fa48("183"), 'circuit_breaker')]), location);
    const providerType = nonEmptyString(raw.provider_type, stryMutAct_9fa48("184") ? `` : (stryCov_9fa48("184"), `${location}.provider_type`));
    if (stryMutAct_9fa48("187") ? false : stryMutAct_9fa48("186") ? true : stryMutAct_9fa48("185") ? PROVIDER_TYPES.includes(providerType as ProviderType) : (stryCov_9fa48("185", "186", "187"), !PROVIDER_TYPES.includes(providerType as ProviderType))) {
      if (stryMutAct_9fa48("188")) {
        {}
      } else {
        stryCov_9fa48("188");
        throw new ProviderConfigurationError(stryMutAct_9fa48("189") ? `` : (stryCov_9fa48("189"), `${location}.provider_type is unsupported`));
      }
    }
    for (const method of REQUIRED_CONTRACT_METHODS) {
      if (stryMutAct_9fa48("190")) {
        {}
      } else {
        stryCov_9fa48("190");
        if (stryMutAct_9fa48("193") ? raw[method] === true : stryMutAct_9fa48("192") ? false : stryMutAct_9fa48("191") ? true : (stryCov_9fa48("191", "192", "193"), raw[method] !== (stryMutAct_9fa48("194") ? false : (stryCov_9fa48("194"), true)))) {
          if (stryMutAct_9fa48("195")) {
            {}
          } else {
            stryCov_9fa48("195");
            throw new ProviderConfigurationError(stryMutAct_9fa48("196") ? `` : (stryCov_9fa48("196"), `${location}.${method} must be true`));
          }
        }
      }
    }
    for (const optional of ['fallback_compatibility_checker', 'rate_limiter', 'circuit_breaker'] as const) {
      if (stryMutAct_9fa48("197")) {
        {}
      } else {
        stryCov_9fa48("197");
        if (stryMutAct_9fa48("200") ? raw[optional] !== undefined || typeof raw[optional] !== 'boolean' : stryMutAct_9fa48("199") ? false : stryMutAct_9fa48("198") ? true : (stryCov_9fa48("198", "199", "200"), (stryMutAct_9fa48("202") ? raw[optional] === undefined : stryMutAct_9fa48("201") ? true : (stryCov_9fa48("201", "202"), raw[optional] !== undefined)) && (stryMutAct_9fa48("204") ? typeof raw[optional] === 'boolean' : stryMutAct_9fa48("203") ? true : (stryCov_9fa48("203", "204"), typeof raw[optional] !== (stryMutAct_9fa48("205") ? "" : (stryCov_9fa48("205"), 'boolean')))))) {
          if (stryMutAct_9fa48("206")) {
            {}
          } else {
            stryCov_9fa48("206");
            throw new ProviderConfigurationError(stryMutAct_9fa48("207") ? `` : (stryCov_9fa48("207"), `${location}.${optional} must be a boolean`));
          }
        }
      }
    }
    return deepFreeze({
      ...raw,
      provider_type: providerType
    } as ProviderAdapterContract);
  }
}
function normalizeDataPolicy(raw: unknown, location: string): Readonly<ProviderDataPolicyMetadata> {
  if (stryMutAct_9fa48("208")) {
    {}
  } else {
    stryCov_9fa48("208");
    assertPlainRecord(raw, location);
    assertKnownKeys(raw, stryMutAct_9fa48("209") ? [] : (stryCov_9fa48("209"), [stryMutAct_9fa48("210") ? "" : (stryCov_9fa48("210"), 'execution'), stryMutAct_9fa48("211") ? "" : (stryCov_9fa48("211"), 'regions'), stryMutAct_9fa48("212") ? "" : (stryCov_9fa48("212"), 'retention_days'), stryMutAct_9fa48("213") ? "" : (stryCov_9fa48("213"), 'training_allowed')]), location);
    if (stryMutAct_9fa48("216") ? raw.execution !== 'local' || raw.execution !== 'remote' : stryMutAct_9fa48("215") ? false : stryMutAct_9fa48("214") ? true : (stryCov_9fa48("214", "215", "216"), (stryMutAct_9fa48("218") ? raw.execution === 'local' : stryMutAct_9fa48("217") ? true : (stryCov_9fa48("217", "218"), raw.execution !== (stryMutAct_9fa48("219") ? "" : (stryCov_9fa48("219"), 'local')))) && (stryMutAct_9fa48("221") ? raw.execution === 'remote' : stryMutAct_9fa48("220") ? true : (stryCov_9fa48("220", "221"), raw.execution !== (stryMutAct_9fa48("222") ? "" : (stryCov_9fa48("222"), 'remote')))))) {
      if (stryMutAct_9fa48("223")) {
        {}
      } else {
        stryCov_9fa48("223");
        throw new ProviderConfigurationError(stryMutAct_9fa48("224") ? `` : (stryCov_9fa48("224"), `${location}.execution is unsupported`));
      }
    }
    return deepFreeze(stryMutAct_9fa48("225") ? {} : (stryCov_9fa48("225"), {
      execution: raw.execution,
      regions: uniqueStrings(raw.regions, stryMutAct_9fa48("226") ? `` : (stryCov_9fa48("226"), `${location}.regions`), stryMutAct_9fa48("227") ? true : (stryCov_9fa48("227"), false)),
      retention_days: safeInteger(raw.retention_days, 0, stryMutAct_9fa48("228") ? `` : (stryCov_9fa48("228"), `${location}.retention_days`)),
      training_allowed: booleanValue(raw.training_allowed, stryMutAct_9fa48("229") ? `` : (stryCov_9fa48("229"), `${location}.training_allowed`))
    }));
  }
}
function normalizePricing(raw: unknown, location: string): Readonly<ProviderPricingMetadata> {
  if (stryMutAct_9fa48("230")) {
    {}
  } else {
    stryCov_9fa48("230");
    assertPlainRecord(raw, location);
    assertKnownKeys(raw, stryMutAct_9fa48("231") ? [] : (stryCov_9fa48("231"), [stryMutAct_9fa48("232") ? "" : (stryCov_9fa48("232"), 'currency'), stryMutAct_9fa48("233") ? "" : (stryCov_9fa48("233"), 'input_per_million'), stryMutAct_9fa48("234") ? "" : (stryCov_9fa48("234"), 'output_per_million')]), location);
    if (stryMutAct_9fa48("237") ? raw.currency === 'USD' : stryMutAct_9fa48("236") ? false : stryMutAct_9fa48("235") ? true : (stryCov_9fa48("235", "236", "237"), raw.currency !== (stryMutAct_9fa48("238") ? "" : (stryCov_9fa48("238"), 'USD')))) {
      if (stryMutAct_9fa48("239")) {
        {}
      } else {
        stryCov_9fa48("239");
        throw new ProviderConfigurationError(stryMutAct_9fa48("240") ? `` : (stryCov_9fa48("240"), `${location}.currency must be USD in Phase 1`));
      }
    }
    return deepFreeze(stryMutAct_9fa48("241") ? {} : (stryCov_9fa48("241"), {
      currency: raw.currency,
      input_per_million: finiteNonNegative(raw.input_per_million, stryMutAct_9fa48("242") ? `` : (stryCov_9fa48("242"), `${location}.input_per_million`)),
      output_per_million: finiteNonNegative(raw.output_per_million, stryMutAct_9fa48("243") ? `` : (stryCov_9fa48("243"), `${location}.output_per_million`))
    }));
  }
}
function normalizeNetwork(raw: unknown, location: string): Readonly<ProviderNetworkMetadata> {
  if (stryMutAct_9fa48("244")) {
    {}
  } else {
    stryCov_9fa48("244");
    assertPlainRecord(raw, location);
    assertKnownKeys(raw, stryMutAct_9fa48("245") ? [] : (stryCov_9fa48("245"), [stryMutAct_9fa48("246") ? "" : (stryCov_9fa48("246"), 'required'), stryMutAct_9fa48("247") ? "" : (stryCov_9fa48("247"), 'destination')]), location);
    const required = booleanValue(raw.required, stryMutAct_9fa48("248") ? `` : (stryCov_9fa48("248"), `${location}.required`));
    if (stryMutAct_9fa48("251") ? !required || raw.destination !== undefined : stryMutAct_9fa48("250") ? false : stryMutAct_9fa48("249") ? true : (stryCov_9fa48("249", "250", "251"), (stryMutAct_9fa48("252") ? required : (stryCov_9fa48("252"), !required)) && (stryMutAct_9fa48("254") ? raw.destination === undefined : stryMutAct_9fa48("253") ? true : (stryCov_9fa48("253", "254"), raw.destination !== undefined)))) {
      if (stryMutAct_9fa48("255")) {
        {}
      } else {
        stryCov_9fa48("255");
        throw new ProviderConfigurationError(stryMutAct_9fa48("256") ? `` : (stryCov_9fa48("256"), `${location}.destination requires network.required=true`));
      }
    }
    if (stryMutAct_9fa48("259") ? false : stryMutAct_9fa48("258") ? true : stryMutAct_9fa48("257") ? required : (stryCov_9fa48("257", "258", "259"), !required)) return deepFreeze(stryMutAct_9fa48("260") ? {} : (stryCov_9fa48("260"), {
      required: stryMutAct_9fa48("261") ? true : (stryCov_9fa48("261"), false)
    }));
    const destination = nonEmptyString(raw.destination, stryMutAct_9fa48("262") ? `` : (stryCov_9fa48("262"), `${location}.destination`));
    let parsed: URL;
    try {
      if (stryMutAct_9fa48("263")) {
        {}
      } else {
        stryCov_9fa48("263");
        parsed = new URL(destination);
      }
    } catch {
      if (stryMutAct_9fa48("264")) {
        {}
      } else {
        stryCov_9fa48("264");
        throw new ProviderConfigurationError(stryMutAct_9fa48("265") ? `` : (stryCov_9fa48("265"), `${location}.destination must be a valid HTTPS origin`));
      }
    }
    if (stryMutAct_9fa48("268") ? (parsed.protocol !== 'https:' || parsed.username.length > 0 || parsed.password.length > 0) && parsed.origin !== destination : stryMutAct_9fa48("267") ? false : stryMutAct_9fa48("266") ? true : (stryCov_9fa48("266", "267", "268"), (stryMutAct_9fa48("270") ? (parsed.protocol !== 'https:' || parsed.username.length > 0) && parsed.password.length > 0 : stryMutAct_9fa48("269") ? false : (stryCov_9fa48("269", "270"), (stryMutAct_9fa48("272") ? parsed.protocol !== 'https:' && parsed.username.length > 0 : stryMutAct_9fa48("271") ? false : (stryCov_9fa48("271", "272"), (stryMutAct_9fa48("274") ? parsed.protocol === 'https:' : stryMutAct_9fa48("273") ? false : (stryCov_9fa48("273", "274"), parsed.protocol !== (stryMutAct_9fa48("275") ? "" : (stryCov_9fa48("275"), 'https:')))) || (stryMutAct_9fa48("278") ? parsed.username.length <= 0 : stryMutAct_9fa48("277") ? parsed.username.length >= 0 : stryMutAct_9fa48("276") ? false : (stryCov_9fa48("276", "277", "278"), parsed.username.length > 0)))) || (stryMutAct_9fa48("281") ? parsed.password.length <= 0 : stryMutAct_9fa48("280") ? parsed.password.length >= 0 : stryMutAct_9fa48("279") ? false : (stryCov_9fa48("279", "280", "281"), parsed.password.length > 0)))) || (stryMutAct_9fa48("283") ? parsed.origin === destination : stryMutAct_9fa48("282") ? false : (stryCov_9fa48("282", "283"), parsed.origin !== destination)))) {
      if (stryMutAct_9fa48("284")) {
        {}
      } else {
        stryCov_9fa48("284");
        throw new ProviderConfigurationError(stryMutAct_9fa48("285") ? `` : (stryCov_9fa48("285"), `${location}.destination must be a valid HTTPS origin`));
      }
    }
    return deepFreeze(stryMutAct_9fa48("286") ? {} : (stryCov_9fa48("286"), {
      required: stryMutAct_9fa48("287") ? false : (stryCov_9fa48("287"), true),
      destination
    }));
  }
}
function normalizeCredentials(raw: unknown, location: string): Readonly<ProviderCredentialMetadata> {
  if (stryMutAct_9fa48("288")) {
    {}
  } else {
    stryCov_9fa48("288");
    assertPlainRecord(raw, location);
    assertKnownKeys(raw, stryMutAct_9fa48("289") ? [] : (stryCov_9fa48("289"), [stryMutAct_9fa48("290") ? "" : (stryCov_9fa48("290"), 'required'), stryMutAct_9fa48("291") ? "" : (stryCov_9fa48("291"), 'audience')]), location);
    return deepFreeze(stryMutAct_9fa48("292") ? {} : (stryCov_9fa48("292"), {
      required: booleanValue(raw.required, stryMutAct_9fa48("293") ? `` : (stryCov_9fa48("293"), `${location}.required`)),
      audience: nonEmptyString(raw.audience, stryMutAct_9fa48("294") ? `` : (stryCov_9fa48("294"), `${location}.audience`))
    }));
  }
}
function normalizeRegistration(raw: unknown, index: number): NormalizedBinding {
  if (stryMutAct_9fa48("295")) {
    {}
  } else {
    stryCov_9fa48("295");
    const location = stryMutAct_9fa48("296") ? `` : (stryCov_9fa48("296"), `providers[${index}]`);
    assertPlainRecord(raw, location);
    assertKnownKeys(raw, stryMutAct_9fa48("297") ? [] : (stryCov_9fa48("297"), [stryMutAct_9fa48("298") ? "" : (stryCov_9fa48("298"), 'provider_id'), stryMutAct_9fa48("299") ? "" : (stryCov_9fa48("299"), 'contract'), stryMutAct_9fa48("300") ? "" : (stryCov_9fa48("300"), 'adapter'), stryMutAct_9fa48("301") ? "" : (stryCov_9fa48("301"), 'metadata')]), location);
    const providerId = nonEmptyString(raw.provider_id, stryMutAct_9fa48("302") ? `` : (stryCov_9fa48("302"), `${location}.provider_id`));
    const contract = normalizeContract(raw.contract, stryMutAct_9fa48("303") ? `` : (stryCov_9fa48("303"), `${location}.contract`));
    if (stryMutAct_9fa48("306") ? (typeof raw.adapter !== 'object' || raw.adapter === null) && Array.isArray(raw.adapter) : stryMutAct_9fa48("305") ? false : stryMutAct_9fa48("304") ? true : (stryCov_9fa48("304", "305", "306"), (stryMutAct_9fa48("308") ? typeof raw.adapter !== 'object' && raw.adapter === null : stryMutAct_9fa48("307") ? false : (stryCov_9fa48("307", "308"), (stryMutAct_9fa48("310") ? typeof raw.adapter === 'object' : stryMutAct_9fa48("309") ? false : (stryCov_9fa48("309", "310"), typeof raw.adapter !== (stryMutAct_9fa48("311") ? "" : (stryCov_9fa48("311"), 'object')))) || (stryMutAct_9fa48("313") ? raw.adapter !== null : stryMutAct_9fa48("312") ? false : (stryCov_9fa48("312", "313"), raw.adapter === null)))) || Array.isArray(raw.adapter))) {
      if (stryMutAct_9fa48("314")) {
        {}
      } else {
        stryCov_9fa48("314");
        throw new ProviderConfigurationError(stryMutAct_9fa48("315") ? `` : (stryCov_9fa48("315"), `${location}.adapter must be an object`));
      }
    }
    const adapterSource = raw.adapter as GatewayProviderRuntime;
    for (const method of RUNTIME_METHODS) {
      if (stryMutAct_9fa48("316")) {
        {}
      } else {
        stryCov_9fa48("316");
        if (stryMutAct_9fa48("319") ? typeof adapterSource[method] === 'function' : stryMutAct_9fa48("318") ? false : stryMutAct_9fa48("317") ? true : (stryCov_9fa48("317", "318", "319"), typeof adapterSource[method] !== (stryMutAct_9fa48("320") ? "" : (stryCov_9fa48("320"), 'function')))) {
          if (stryMutAct_9fa48("321")) {
            {}
          } else {
            stryCov_9fa48("321");
            throw new ProviderConfigurationError(stryMutAct_9fa48("322") ? `` : (stryCov_9fa48("322"), `${location}.adapter.${method} must be a function`));
          }
        }
      }
    }
    if (stryMutAct_9fa48("325") ? adapterSource.provider_type === contract.provider_type : stryMutAct_9fa48("324") ? false : stryMutAct_9fa48("323") ? true : (stryCov_9fa48("323", "324", "325"), adapterSource.provider_type !== contract.provider_type)) {
      if (stryMutAct_9fa48("326")) {
        {}
      } else {
        stryCov_9fa48("326");
        throw new ProviderConfigurationError(stryMutAct_9fa48("327") ? `` : (stryCov_9fa48("327"), `${location}.adapter.provider_type must match Contract`));
      }
    }
    const adapter: GatewayProviderRuntime = deepFreeze(stryMutAct_9fa48("328") ? {} : (stryCov_9fa48("328"), {
      provider_type: adapterSource.provider_type,
      normalizeRequest: adapterSource.normalizeRequest.bind(adapterSource),
      parseResponse: adapterSource.parseResponse.bind(adapterSource),
      normalizeToolCall: adapterSource.normalizeToolCall.bind(adapterSource),
      streamEvents: adapterSource.streamEvents.bind(adapterSource),
      mapError: adapterSource.mapError.bind(adapterSource),
      meterUsage: adapterSource.meterUsage.bind(adapterSource),
      checkHealth: adapterSource.checkHealth.bind(adapterSource),
      validateDataPolicy: adapterSource.validateDataPolicy.bind(adapterSource),
      resolve: adapterSource.resolve.bind(adapterSource)
    }));
    assertPlainRecord(raw.metadata, stryMutAct_9fa48("329") ? `` : (stryCov_9fa48("329"), `${location}.metadata`));
    assertKnownKeys(raw.metadata, stryMutAct_9fa48("330") ? [] : (stryCov_9fa48("330"), [stryMutAct_9fa48("331") ? "" : (stryCov_9fa48("331"), 'capabilities'), stryMutAct_9fa48("332") ? "" : (stryCov_9fa48("332"), 'max_context_tokens'), stryMutAct_9fa48("333") ? "" : (stryCov_9fa48("333"), 'structured_output'), stryMutAct_9fa48("334") ? "" : (stryCov_9fa48("334"), 'tool_calling'), stryMutAct_9fa48("335") ? "" : (stryCov_9fa48("335"), 'data_policy'), stryMutAct_9fa48("336") ? "" : (stryCov_9fa48("336"), 'pricing'), stryMutAct_9fa48("337") ? "" : (stryCov_9fa48("337"), 'health'), stryMutAct_9fa48("338") ? "" : (stryCov_9fa48("338"), 'network'), stryMutAct_9fa48("339") ? "" : (stryCov_9fa48("339"), 'credentials')]), stryMutAct_9fa48("340") ? `` : (stryCov_9fa48("340"), `${location}.metadata`));
    if (stryMutAct_9fa48("343") ? false : stryMutAct_9fa48("342") ? true : stryMutAct_9fa48("341") ? ['healthy', 'degraded', 'down'].includes(raw.metadata.health as string) : (stryCov_9fa48("341", "342", "343"), !(stryMutAct_9fa48("344") ? [] : (stryCov_9fa48("344"), [stryMutAct_9fa48("345") ? "" : (stryCov_9fa48("345"), 'healthy'), stryMutAct_9fa48("346") ? "" : (stryCov_9fa48("346"), 'degraded'), stryMutAct_9fa48("347") ? "" : (stryCov_9fa48("347"), 'down')])).includes(raw.metadata.health as string))) {
      if (stryMutAct_9fa48("348")) {
        {}
      } else {
        stryCov_9fa48("348");
        throw new ProviderConfigurationError(stryMutAct_9fa48("349") ? `` : (stryCov_9fa48("349"), `${location}.metadata.health is unsupported`));
      }
    }
    const metadata = stryMutAct_9fa48("350") ? {} : (stryCov_9fa48("350"), {
      capabilities: uniqueStrings(raw.metadata.capabilities, stryMutAct_9fa48("351") ? `` : (stryCov_9fa48("351"), `${location}.metadata.capabilities`), stryMutAct_9fa48("352") ? true : (stryCov_9fa48("352"), false)),
      max_context_tokens: safeInteger(raw.metadata.max_context_tokens, 1, stryMutAct_9fa48("353") ? `` : (stryCov_9fa48("353"), `${location}.metadata.max_context_tokens`)),
      structured_output: booleanValue(raw.metadata.structured_output, stryMutAct_9fa48("354") ? `` : (stryCov_9fa48("354"), `${location}.metadata.structured_output`)),
      tool_calling: booleanValue(raw.metadata.tool_calling, stryMutAct_9fa48("355") ? `` : (stryCov_9fa48("355"), `${location}.metadata.tool_calling`)),
      data_policy: normalizeDataPolicy(raw.metadata.data_policy, stryMutAct_9fa48("356") ? `` : (stryCov_9fa48("356"), `${location}.metadata.data_policy`)),
      pricing: normalizePricing(raw.metadata.pricing, stryMutAct_9fa48("357") ? `` : (stryCov_9fa48("357"), `${location}.metadata.pricing`)),
      health: raw.metadata.health as HealthStatus,
      network: normalizeNetwork(raw.metadata.network, stryMutAct_9fa48("358") ? `` : (stryCov_9fa48("358"), `${location}.metadata.network`)),
      credentials: normalizeCredentials(raw.metadata.credentials, stryMutAct_9fa48("359") ? `` : (stryCov_9fa48("359"), `${location}.metadata.credentials`))
    });
    const descriptor = stryMutAct_9fa48("360") ? {} : (stryCov_9fa48("360"), {
      provider_id: providerId,
      provider_type: contract.provider_type,
      contract,
      ...metadata
    });
    return stryMutAct_9fa48("361") ? {} : (stryCov_9fa48("361"), {
      entry: deepFreeze(stryMutAct_9fa48("362") ? {} : (stryCov_9fa48("362"), {
        ...descriptor,
        metadata_hash: contentHash(descriptor)
      })),
      adapter
    });
  }
}
export class FrozenProviderRegistry {
  readonly snapshot: ProviderRegistrySnapshot;
  constructor(registrations: readonly GatewayProviderRegistration[]) {
    if (stryMutAct_9fa48("363")) {
      {}
    } else {
      stryCov_9fa48("363");
      if (stryMutAct_9fa48("366") ? false : stryMutAct_9fa48("365") ? true : stryMutAct_9fa48("364") ? Array.isArray(registrations) : (stryCov_9fa48("364", "365", "366"), !Array.isArray(registrations))) {
        if (stryMutAct_9fa48("367")) {
          {}
        } else {
          stryCov_9fa48("367");
          throw new ProviderConfigurationError(stryMutAct_9fa48("368") ? "" : (stryCov_9fa48("368"), 'provider registrations must be an array'));
        }
      }
      const normalized = registrations.map(stryMutAct_9fa48("369") ? () => undefined : (stryCov_9fa48("369"), (registration, index) => normalizeRegistration(registration, index)));
      const ids = normalized.map(stryMutAct_9fa48("370") ? () => undefined : (stryCov_9fa48("370"), ({
        entry
      }) => entry.provider_id));
      if (stryMutAct_9fa48("373") ? new Set(ids).size === ids.length : stryMutAct_9fa48("372") ? false : stryMutAct_9fa48("371") ? true : (stryCov_9fa48("371", "372", "373"), new Set(ids).size !== ids.length)) {
        if (stryMutAct_9fa48("374")) {
          {}
        } else {
          stryCov_9fa48("374");
          throw new ProviderConfigurationError(stryMutAct_9fa48("375") ? "" : (stryCov_9fa48("375"), 'duplicate provider identity is forbidden'));
        }
      }
      stryMutAct_9fa48("376") ? normalized : (stryCov_9fa48("376"), normalized.sort(stryMutAct_9fa48("377") ? () => undefined : (stryCov_9fa48("377"), (left, right) => binaryCompare(left.entry.provider_id, right.entry.provider_id))));
      const providers = normalized.map(stryMutAct_9fa48("378") ? () => undefined : (stryCov_9fa48("378"), ({
        entry
      }) => entry));
      this.snapshot = deepFreeze(stryMutAct_9fa48("379") ? {} : (stryCov_9fa48("379"), {
        hash: contentHash(providers),
        providers
      }));
      registryBindings.set(this, new Map(normalized.map(stryMutAct_9fa48("380") ? () => undefined : (stryCov_9fa48("380"), binding => stryMutAct_9fa48("381") ? [] : (stryCov_9fa48("381"), [binding.entry.provider_id, binding])))));
      Object.freeze(this);
    }
  }
}
function bindingFor(registry: FrozenProviderRegistry, providerId: string): NormalizedBinding {
  if (stryMutAct_9fa48("382")) {
    {}
  } else {
    stryCov_9fa48("382");
    const binding = stryMutAct_9fa48("383") ? registryBindings.get(registry).get(providerId) : (stryCov_9fa48("383"), registryBindings.get(registry)?.get(providerId));
    if (stryMutAct_9fa48("386") ? false : stryMutAct_9fa48("385") ? true : stryMutAct_9fa48("384") ? binding : (stryCov_9fa48("384", "385", "386"), !binding)) throw new ProviderDispatchError(stryMutAct_9fa48("387") ? "" : (stryCov_9fa48("387"), 'provider_no_longer_compatible'));
    return binding;
  }
}
function normalizeRequiredDataPolicy(raw: unknown): Readonly<RequiredDataPolicy> {
  if (stryMutAct_9fa48("388")) {
    {}
  } else {
    stryCov_9fa48("388");
    assertPlainRecord(raw, stryMutAct_9fa48("389") ? "" : (stryCov_9fa48("389"), 'selection.data_policy'));
    assertKnownKeys(raw, stryMutAct_9fa48("390") ? [] : (stryCov_9fa48("390"), [stryMutAct_9fa48("391") ? "" : (stryCov_9fa48("391"), 'local_only'), stryMutAct_9fa48("392") ? "" : (stryCov_9fa48("392"), 'allowed_regions'), stryMutAct_9fa48("393") ? "" : (stryCov_9fa48("393"), 'max_retention_days'), stryMutAct_9fa48("394") ? "" : (stryCov_9fa48("394"), 'training_allowed')]), stryMutAct_9fa48("395") ? "" : (stryCov_9fa48("395"), 'selection.data_policy'));
    return deepFreeze(stryMutAct_9fa48("396") ? {} : (stryCov_9fa48("396"), {
      local_only: booleanValue(raw.local_only, stryMutAct_9fa48("397") ? "" : (stryCov_9fa48("397"), 'selection.data_policy.local_only')),
      allowed_regions: uniqueStrings(raw.allowed_regions, stryMutAct_9fa48("398") ? "" : (stryCov_9fa48("398"), 'selection.data_policy.allowed_regions'), stryMutAct_9fa48("399") ? true : (stryCov_9fa48("399"), false)),
      max_retention_days: safeInteger(raw.max_retention_days, 0, stryMutAct_9fa48("400") ? "" : (stryCov_9fa48("400"), 'selection.data_policy.max_retention_days')),
      training_allowed: booleanValue(raw.training_allowed, stryMutAct_9fa48("401") ? "" : (stryCov_9fa48("401"), 'selection.data_policy.training_allowed'))
    }));
  }
}
function normalizeAuthority(raw: unknown, location: string): Readonly<ProviderAuthorityConstraints> {
  if (stryMutAct_9fa48("402")) {
    {}
  } else {
    stryCov_9fa48("402");
    assertPlainRecord(raw, location);
    assertKnownKeys(raw, stryMutAct_9fa48("403") ? [] : (stryCov_9fa48("403"), [stryMutAct_9fa48("404") ? "" : (stryCov_9fa48("404"), 'allowed_provider_ids'), stryMutAct_9fa48("405") ? "" : (stryCov_9fa48("405"), 'denied_provider_ids')]), location);
    return deepFreeze(stryMutAct_9fa48("406") ? {} : (stryCov_9fa48("406"), {
      allowed_provider_ids: (stryMutAct_9fa48("409") ? raw.allowed_provider_ids !== undefined : stryMutAct_9fa48("408") ? false : stryMutAct_9fa48("407") ? true : (stryCov_9fa48("407", "408", "409"), raw.allowed_provider_ids === undefined)) ? undefined : uniqueStrings(raw.allowed_provider_ids, stryMutAct_9fa48("410") ? `` : (stryCov_9fa48("410"), `${location}.allowed_provider_ids`), stryMutAct_9fa48("411") ? false : (stryCov_9fa48("411"), true)),
      denied_provider_ids: uniqueStrings(raw.denied_provider_ids, stryMutAct_9fa48("412") ? `` : (stryCov_9fa48("412"), `${location}.denied_provider_ids`), stryMutAct_9fa48("413") ? false : (stryCov_9fa48("413"), true))
    }));
  }
}
function normalizeRunPlan(raw: unknown): Readonly<ProviderRunPlanConstraints> {
  if (stryMutAct_9fa48("414")) {
    {}
  } else {
    stryCov_9fa48("414");
    assertPlainRecord(raw, stryMutAct_9fa48("415") ? "" : (stryCov_9fa48("415"), 'selection.run_plan'));
    assertKnownKeys(raw, stryMutAct_9fa48("416") ? [] : (stryCov_9fa48("416"), [stryMutAct_9fa48("417") ? "" : (stryCov_9fa48("417"), 'allowed_provider_ids'), stryMutAct_9fa48("418") ? "" : (stryCov_9fa48("418"), 'required_capabilities')]), stryMutAct_9fa48("419") ? "" : (stryCov_9fa48("419"), 'selection.run_plan'));
    return deepFreeze(stryMutAct_9fa48("420") ? {} : (stryCov_9fa48("420"), {
      allowed_provider_ids: (stryMutAct_9fa48("423") ? raw.allowed_provider_ids !== undefined : stryMutAct_9fa48("422") ? false : stryMutAct_9fa48("421") ? true : (stryCov_9fa48("421", "422", "423"), raw.allowed_provider_ids === undefined)) ? undefined : uniqueStrings(raw.allowed_provider_ids, stryMutAct_9fa48("424") ? "" : (stryCov_9fa48("424"), 'selection.run_plan.allowed_provider_ids'), stryMutAct_9fa48("425") ? false : (stryCov_9fa48("425"), true)),
      required_capabilities: uniqueStrings(raw.required_capabilities, stryMutAct_9fa48("426") ? "" : (stryCov_9fa48("426"), 'selection.run_plan.required_capabilities'), stryMutAct_9fa48("427") ? false : (stryCov_9fa48("427"), true))
    }));
  }
}
function validateSelection(request: ProviderSelectionRequest) {
  if (stryMutAct_9fa48("428")) {
    {}
  } else {
    stryCov_9fa48("428");
    assertPlainRecord(request, stryMutAct_9fa48("429") ? "" : (stryCov_9fa48("429"), 'selection'));
    assertKnownKeys(request, stryMutAct_9fa48("430") ? [] : (stryCov_9fa48("430"), [stryMutAct_9fa48("431") ? "" : (stryCov_9fa48("431"), 'registry_snapshot_hash'), stryMutAct_9fa48("432") ? "" : (stryCov_9fa48("432"), 'request'), stryMutAct_9fa48("433") ? "" : (stryCov_9fa48("433"), 'estimated_input_tokens'), stryMutAct_9fa48("434") ? "" : (stryCov_9fa48("434"), 'required_capabilities'), stryMutAct_9fa48("435") ? "" : (stryCov_9fa48("435"), 'requires_structured_output'), stryMutAct_9fa48("436") ? "" : (stryCov_9fa48("436"), 'data_policy'), stryMutAct_9fa48("437") ? "" : (stryCov_9fa48("437"), 'policy'), stryMutAct_9fa48("438") ? "" : (stryCov_9fa48("438"), 'run_plan')]), stryMutAct_9fa48("439") ? "" : (stryCov_9fa48("439"), 'selection'));
    if (stryMutAct_9fa48("442") ? false : stryMutAct_9fa48("441") ? true : stryMutAct_9fa48("440") ? /^[0-9a-f]{64}$/u.test(request.registry_snapshot_hash) : (stryCov_9fa48("440", "441", "442"), !(stryMutAct_9fa48("446") ? /^[^0-9a-f]{64}$/u : stryMutAct_9fa48("445") ? /^[0-9a-f]$/u : stryMutAct_9fa48("444") ? /^[0-9a-f]{64}/u : stryMutAct_9fa48("443") ? /[0-9a-f]{64}$/u : (stryCov_9fa48("443", "444", "445", "446"), /^[0-9a-f]{64}$/u)).test(request.registry_snapshot_hash))) {
      if (stryMutAct_9fa48("447")) {
        {}
      } else {
        stryCov_9fa48("447");
        throw new ProviderConfigurationError(stryMutAct_9fa48("448") ? "" : (stryCov_9fa48("448"), 'selection.registry_snapshot_hash must be SHA-256'));
      }
    }
    safeInteger(request.estimated_input_tokens, 0, stryMutAct_9fa48("449") ? "" : (stryCov_9fa48("449"), 'selection.estimated_input_tokens'));
    uniqueStrings(request.required_capabilities, stryMutAct_9fa48("450") ? "" : (stryCov_9fa48("450"), 'selection.required_capabilities'), stryMutAct_9fa48("451") ? false : (stryCov_9fa48("451"), true));
    booleanValue(request.requires_structured_output, stryMutAct_9fa48("452") ? "" : (stryCov_9fa48("452"), 'selection.requires_structured_output'));
    normalizeRequiredDataPolicy(request.data_policy);
    normalizeAuthority(request.policy, stryMutAct_9fa48("453") ? "" : (stryCov_9fa48("453"), 'selection.policy'));
    normalizeRunPlan(request.run_plan);
  }
}
function selectionHash(request: ProviderSelectionRequest): string {
  if (stryMutAct_9fa48("454")) {
    {}
  } else {
    stryCov_9fa48("454");
    return contentHash(request);
  }
}
function isAllowedByAuthority(providerId: string, authority: ProviderAuthorityConstraints): boolean {
  if (stryMutAct_9fa48("455")) {
    {}
  } else {
    stryCov_9fa48("455");
    return stryMutAct_9fa48("458") ? authority.allowed_provider_ids === undefined || authority.allowed_provider_ids.includes(providerId) || !authority.denied_provider_ids.includes(providerId) : stryMutAct_9fa48("457") ? false : stryMutAct_9fa48("456") ? true : (stryCov_9fa48("456", "457", "458"), (stryMutAct_9fa48("460") ? authority.allowed_provider_ids === undefined && authority.allowed_provider_ids.includes(providerId) : stryMutAct_9fa48("459") ? true : (stryCov_9fa48("459", "460"), (stryMutAct_9fa48("462") ? authority.allowed_provider_ids !== undefined : stryMutAct_9fa48("461") ? false : (stryCov_9fa48("461", "462"), authority.allowed_provider_ids === undefined)) || authority.allowed_provider_ids.includes(providerId))) && (stryMutAct_9fa48("463") ? authority.denied_provider_ids.includes(providerId) : (stryCov_9fa48("463"), !authority.denied_provider_ids.includes(providerId))));
  }
}
function incompatibilityReason(binding: NormalizedBinding, request: ProviderSelectionRequest): string | undefined {
  if (stryMutAct_9fa48("464")) {
    {}
  } else {
    stryCov_9fa48("464");
    const {
      adapter,
      entry
    } = binding;
    if (stryMutAct_9fa48("467") ? entry.health === 'healthy' : stryMutAct_9fa48("466") ? false : stryMutAct_9fa48("465") ? true : (stryCov_9fa48("465", "466", "467"), entry.health !== (stryMutAct_9fa48("468") ? "" : (stryCov_9fa48("468"), 'healthy')))) return stryMutAct_9fa48("469") ? "" : (stryCov_9fa48("469"), 'snapshot health is not healthy');
    if (stryMutAct_9fa48("472") ? false : stryMutAct_9fa48("471") ? true : stryMutAct_9fa48("470") ? isAllowedByAuthority(entry.provider_id, request.policy) : (stryCov_9fa48("470", "471", "472"), !isAllowedByAuthority(entry.provider_id, request.policy))) return stryMutAct_9fa48("473") ? "" : (stryCov_9fa48("473"), 'Policy denied provider');
    if (stryMutAct_9fa48("476") ? request.run_plan.allowed_provider_ids !== undefined || !request.run_plan.allowed_provider_ids.includes(entry.provider_id) : stryMutAct_9fa48("475") ? false : stryMutAct_9fa48("474") ? true : (stryCov_9fa48("474", "475", "476"), (stryMutAct_9fa48("478") ? request.run_plan.allowed_provider_ids === undefined : stryMutAct_9fa48("477") ? true : (stryCov_9fa48("477", "478"), request.run_plan.allowed_provider_ids !== undefined)) && (stryMutAct_9fa48("479") ? request.run_plan.allowed_provider_ids.includes(entry.provider_id) : (stryCov_9fa48("479"), !request.run_plan.allowed_provider_ids.includes(entry.provider_id))))) {
      if (stryMutAct_9fa48("480")) {
        {}
      } else {
        stryCov_9fa48("480");
        return stryMutAct_9fa48("481") ? "" : (stryCov_9fa48("481"), 'RunPlan denied provider');
      }
    }
    const requiredCapabilities = new Set(stryMutAct_9fa48("482") ? [] : (stryCov_9fa48("482"), [...request.required_capabilities, ...request.run_plan.required_capabilities]));
    if (stryMutAct_9fa48("485") ? [...requiredCapabilities].every(capability => !entry.capabilities.includes(capability)) : stryMutAct_9fa48("484") ? false : stryMutAct_9fa48("483") ? true : (stryCov_9fa48("483", "484", "485"), (stryMutAct_9fa48("486") ? [] : (stryCov_9fa48("486"), [...requiredCapabilities])).some(stryMutAct_9fa48("487") ? () => undefined : (stryCov_9fa48("487"), capability => stryMutAct_9fa48("488") ? entry.capabilities.includes(capability) : (stryCov_9fa48("488"), !entry.capabilities.includes(capability)))))) {
      if (stryMutAct_9fa48("489")) {
        {}
      } else {
        stryCov_9fa48("489");
        return stryMutAct_9fa48("490") ? "" : (stryCov_9fa48("490"), 'required capability is unavailable');
      }
    }
    if (stryMutAct_9fa48("494") ? request.estimated_input_tokens + (request.request.max_tokens ?? 0) <= entry.max_context_tokens : stryMutAct_9fa48("493") ? request.estimated_input_tokens + (request.request.max_tokens ?? 0) >= entry.max_context_tokens : stryMutAct_9fa48("492") ? false : stryMutAct_9fa48("491") ? true : (stryCov_9fa48("491", "492", "493", "494"), (stryMutAct_9fa48("495") ? request.estimated_input_tokens - (request.request.max_tokens ?? 0) : (stryCov_9fa48("495"), request.estimated_input_tokens + (stryMutAct_9fa48("496") ? request.request.max_tokens && 0 : (stryCov_9fa48("496"), request.request.max_tokens ?? 0)))) > entry.max_context_tokens)) {
      if (stryMutAct_9fa48("497")) {
        {}
      } else {
        stryCov_9fa48("497");
        return stryMutAct_9fa48("498") ? "" : (stryCov_9fa48("498"), 'context length is incompatible');
      }
    }
    if (stryMutAct_9fa48("501") ? request.requires_structured_output || !entry.structured_output : stryMutAct_9fa48("500") ? false : stryMutAct_9fa48("499") ? true : (stryCov_9fa48("499", "500", "501"), request.requires_structured_output && (stryMutAct_9fa48("502") ? entry.structured_output : (stryCov_9fa48("502"), !entry.structured_output)))) {
      if (stryMutAct_9fa48("503")) {
        {}
      } else {
        stryCov_9fa48("503");
        return stryMutAct_9fa48("504") ? "" : (stryCov_9fa48("504"), 'structured output is unavailable');
      }
    }
    if (stryMutAct_9fa48("507") ? (request.request.tools?.length ?? 0) > 0 || !entry.tool_calling : stryMutAct_9fa48("506") ? false : stryMutAct_9fa48("505") ? true : (stryCov_9fa48("505", "506", "507"), (stryMutAct_9fa48("510") ? (request.request.tools?.length ?? 0) <= 0 : stryMutAct_9fa48("509") ? (request.request.tools?.length ?? 0) >= 0 : stryMutAct_9fa48("508") ? true : (stryCov_9fa48("508", "509", "510"), (stryMutAct_9fa48("511") ? request.request.tools?.length && 0 : (stryCov_9fa48("511"), (stryMutAct_9fa48("512") ? request.request.tools.length : (stryCov_9fa48("512"), request.request.tools?.length)) ?? 0)) > 0)) && (stryMutAct_9fa48("513") ? entry.tool_calling : (stryCov_9fa48("513"), !entry.tool_calling)))) {
      if (stryMutAct_9fa48("514")) {
        {}
      } else {
        stryCov_9fa48("514");
        return stryMutAct_9fa48("515") ? "" : (stryCov_9fa48("515"), 'tool calling is unavailable');
      }
    }
    if (stryMutAct_9fa48("518") ? request.data_policy.local_only || entry.data_policy.execution !== 'local' : stryMutAct_9fa48("517") ? false : stryMutAct_9fa48("516") ? true : (stryCov_9fa48("516", "517", "518"), request.data_policy.local_only && (stryMutAct_9fa48("520") ? entry.data_policy.execution === 'local' : stryMutAct_9fa48("519") ? true : (stryCov_9fa48("519", "520"), entry.data_policy.execution !== (stryMutAct_9fa48("521") ? "" : (stryCov_9fa48("521"), 'local')))))) {
      if (stryMutAct_9fa48("522")) {
        {}
      } else {
        stryCov_9fa48("522");
        return stryMutAct_9fa48("523") ? "" : (stryCov_9fa48("523"), 'local-only data policy is incompatible');
      }
    }
    if (stryMutAct_9fa48("526") ? false : stryMutAct_9fa48("525") ? true : stryMutAct_9fa48("524") ? entry.data_policy.regions.some(region => request.data_policy.allowed_regions.includes(region)) : (stryCov_9fa48("524", "525", "526"), !(stryMutAct_9fa48("527") ? entry.data_policy.regions.every(region => request.data_policy.allowed_regions.includes(region)) : (stryCov_9fa48("527"), entry.data_policy.regions.some(stryMutAct_9fa48("528") ? () => undefined : (stryCov_9fa48("528"), region => request.data_policy.allowed_regions.includes(region))))))) {
      if (stryMutAct_9fa48("529")) {
        {}
      } else {
        stryCov_9fa48("529");
        return stryMutAct_9fa48("530") ? "" : (stryCov_9fa48("530"), 'data region is incompatible');
      }
    }
    if (stryMutAct_9fa48("534") ? entry.data_policy.retention_days <= request.data_policy.max_retention_days : stryMutAct_9fa48("533") ? entry.data_policy.retention_days >= request.data_policy.max_retention_days : stryMutAct_9fa48("532") ? false : stryMutAct_9fa48("531") ? true : (stryCov_9fa48("531", "532", "533", "534"), entry.data_policy.retention_days > request.data_policy.max_retention_days)) {
      if (stryMutAct_9fa48("535")) {
        {}
      } else {
        stryCov_9fa48("535");
        return stryMutAct_9fa48("536") ? "" : (stryCov_9fa48("536"), 'data retention is incompatible');
      }
    }
    if (stryMutAct_9fa48("539") ? !request.data_policy.training_allowed || entry.data_policy.training_allowed : stryMutAct_9fa48("538") ? false : stryMutAct_9fa48("537") ? true : (stryCov_9fa48("537", "538", "539"), (stryMutAct_9fa48("540") ? request.data_policy.training_allowed : (stryCov_9fa48("540"), !request.data_policy.training_allowed)) && entry.data_policy.training_allowed)) {
      if (stryMutAct_9fa48("541")) {
        {}
      } else {
        stryCov_9fa48("541");
        return stryMutAct_9fa48("542") ? "" : (stryCov_9fa48("542"), 'provider training policy is incompatible');
      }
    }
    try {
      if (stryMutAct_9fa48("543")) {
        {}
      } else {
        stryCov_9fa48("543");
        adapter.normalizeRequest(request.request);
        const decision: DataPolicyResult = adapter.validateDataPolicy(request.request);
        if (stryMutAct_9fa48("546") ? false : stryMutAct_9fa48("545") ? true : stryMutAct_9fa48("544") ? decision.allowed : (stryCov_9fa48("544", "545", "546"), !decision.allowed)) return stryMutAct_9fa48("547") ? "" : (stryCov_9fa48("547"), 'adapter data policy denied request');
      }
    } catch {
      if (stryMutAct_9fa48("548")) {
        {}
      } else {
        stryCov_9fa48("548");
        return stryMutAct_9fa48("549") ? "" : (stryCov_9fa48("549"), 'adapter validation rejected request');
      }
    }
    return undefined;
  }
}
function estimatedPrice(entry: ProviderSnapshotEntry, request: ProviderSelectionRequest): number {
  if (stryMutAct_9fa48("550")) {
    {}
  } else {
    stryCov_9fa48("550");
    return stryMutAct_9fa48("551") ? request.estimated_input_tokens * entry.pricing.input_per_million - (request.request.max_tokens ?? 0) * entry.pricing.output_per_million : (stryCov_9fa48("551"), (stryMutAct_9fa48("552") ? request.estimated_input_tokens / entry.pricing.input_per_million : (stryCov_9fa48("552"), request.estimated_input_tokens * entry.pricing.input_per_million)) + (stryMutAct_9fa48("553") ? (request.request.max_tokens ?? 0) / entry.pricing.output_per_million : (stryCov_9fa48("553"), (stryMutAct_9fa48("554") ? request.request.max_tokens && 0 : (stryCov_9fa48("554"), request.request.max_tokens ?? 0)) * entry.pricing.output_per_million)));
  }
}
export class ModelGateway {
  private readonly registry: FrozenProviderRegistry;
  private readonly ports: {
    readonly secretsBroker: SecretsBrokerPort;
    readonly egressPolicy: EgressPolicyPort;
    readonly usageMeter: UsageMeterPort;
  };
  constructor(registry: FrozenProviderRegistry, ports: {
    readonly secretsBroker: SecretsBrokerPort;
    readonly egressPolicy: EgressPolicyPort;
    readonly usageMeter: UsageMeterPort;
  }) {
    if (stryMutAct_9fa48("555")) {
      {}
    } else {
      stryCov_9fa48("555");
      if (stryMutAct_9fa48("558") ? false : stryMutAct_9fa48("557") ? true : stryMutAct_9fa48("556") ? registry instanceof FrozenProviderRegistry : (stryCov_9fa48("556", "557", "558"), !(registry instanceof FrozenProviderRegistry))) {
        if (stryMutAct_9fa48("559")) {
          {}
        } else {
          stryCov_9fa48("559");
          throw new ProviderConfigurationError(stryMutAct_9fa48("560") ? "" : (stryCov_9fa48("560"), 'ModelGateway requires a FrozenProviderRegistry'));
        }
      }
      if (stryMutAct_9fa48("563") ? !ports && typeof ports !== 'object' : stryMutAct_9fa48("562") ? false : stryMutAct_9fa48("561") ? true : (stryCov_9fa48("561", "562", "563"), (stryMutAct_9fa48("564") ? ports : (stryCov_9fa48("564"), !ports)) || (stryMutAct_9fa48("566") ? typeof ports === 'object' : stryMutAct_9fa48("565") ? false : (stryCov_9fa48("565", "566"), typeof ports !== (stryMutAct_9fa48("567") ? "" : (stryCov_9fa48("567"), 'object')))))) {
        if (stryMutAct_9fa48("568")) {
          {}
        } else {
          stryCov_9fa48("568");
          throw new ProviderConfigurationError(stryMutAct_9fa48("569") ? "" : (stryCov_9fa48("569"), 'ModelGateway control ports are required'));
        }
      }
      for (const [name, method] of [['secretsBroker.exchangeCredential', ports.secretsBroker?.exchangeCredential], ['egressPolicy.authorize', ports.egressPolicy?.authorize], ['usageMeter.record', ports.usageMeter?.record]] as const) {
        if (stryMutAct_9fa48("570")) {
          {}
        } else {
          stryCov_9fa48("570");
          if (stryMutAct_9fa48("573") ? typeof method === 'function' : stryMutAct_9fa48("572") ? false : stryMutAct_9fa48("571") ? true : (stryCov_9fa48("571", "572", "573"), typeof method !== (stryMutAct_9fa48("574") ? "" : (stryCov_9fa48("574"), 'function')))) {
            if (stryMutAct_9fa48("575")) {
              {}
            } else {
              stryCov_9fa48("575");
              throw new ProviderConfigurationError(stryMutAct_9fa48("576") ? `` : (stryCov_9fa48("576"), `${name} must be a function`));
            }
          }
        }
      }
      this.registry = registry;
      this.ports = deepFreeze(stryMutAct_9fa48("577") ? {} : (stryCov_9fa48("577"), {
        secretsBroker: stryMutAct_9fa48("578") ? {} : (stryCov_9fa48("578"), {
          exchangeCredential: ports.secretsBroker.exchangeCredential.bind(ports.secretsBroker)
        }),
        egressPolicy: stryMutAct_9fa48("579") ? {} : (stryCov_9fa48("579"), {
          authorize: ports.egressPolicy.authorize.bind(ports.egressPolicy)
        }),
        usageMeter: stryMutAct_9fa48("580") ? {} : (stryCov_9fa48("580"), {
          record: ports.usageMeter.record.bind(ports.usageMeter)
        })
      }));
      Object.freeze(this);
    }
  }
  resolve(request: ProviderSelectionRequest): ResolvedProvider {
    if (stryMutAct_9fa48("581")) {
      {}
    } else {
      stryCov_9fa48("581");
      return this.resolveExcluding(request, new Set());
    }
  }
  switchProvider(previous: ResolvedProvider, request: ProviderSelectionRequest, attemptedProviderIds: readonly string[] = stryMutAct_9fa48("582") ? ["Stryker was here"] : (stryCov_9fa48("582"), [])): ResolvedProvider {
    if (stryMutAct_9fa48("583")) {
      {}
    } else {
      stryCov_9fa48("583");
      if (stryMutAct_9fa48("586") ? previous.registry_snapshot_hash !== this.registry.snapshot.hash && previous.selection_request_hash !== selectionHash(request) : stryMutAct_9fa48("585") ? false : stryMutAct_9fa48("584") ? true : (stryCov_9fa48("584", "585", "586"), (stryMutAct_9fa48("588") ? previous.registry_snapshot_hash === this.registry.snapshot.hash : stryMutAct_9fa48("587") ? false : (stryCov_9fa48("587", "588"), previous.registry_snapshot_hash !== this.registry.snapshot.hash)) || (stryMutAct_9fa48("590") ? previous.selection_request_hash === selectionHash(request) : stryMutAct_9fa48("589") ? false : (stryCov_9fa48("589", "590"), previous.selection_request_hash !== selectionHash(request))))) {
        if (stryMutAct_9fa48("591")) {
          {}
        } else {
          stryCov_9fa48("591");
          throw new ProviderResolutionError(stryMutAct_9fa48("592") ? "" : (stryCov_9fa48("592"), 'stale_registry_snapshot'), stryMutAct_9fa48("593") ? "" : (stryCov_9fa48("593"), 'Provider switch must use the same frozen registry and selection request'));
        }
      }
      return this.resolveExcluding(request, new Set(stryMutAct_9fa48("594") ? [] : (stryCov_9fa48("594"), [previous.provider_id, ...attemptedProviderIds])));
    }
  }
  async dispatch(resolved: ResolvedProvider, request: ProviderSelectionRequest, context: {
    readonly operation_id: string;
  }): Promise<GatewayDispatchResult> {
    if (stryMutAct_9fa48("595")) {
      {}
    } else {
      stryCov_9fa48("595");
      if (stryMutAct_9fa48("598") ? resolved.registry_snapshot_hash !== this.registry.snapshot.hash && resolved.selection_request_hash !== selectionHash(request) : stryMutAct_9fa48("597") ? false : stryMutAct_9fa48("596") ? true : (stryCov_9fa48("596", "597", "598"), (stryMutAct_9fa48("600") ? resolved.registry_snapshot_hash === this.registry.snapshot.hash : stryMutAct_9fa48("599") ? false : (stryCov_9fa48("599", "600"), resolved.registry_snapshot_hash !== this.registry.snapshot.hash)) || (stryMutAct_9fa48("602") ? resolved.selection_request_hash === selectionHash(request) : stryMutAct_9fa48("601") ? false : (stryCov_9fa48("601", "602"), resolved.selection_request_hash !== selectionHash(request))))) {
        if (stryMutAct_9fa48("603")) {
          {}
        } else {
          stryCov_9fa48("603");
          throw new ProviderDispatchError(stryMutAct_9fa48("604") ? "" : (stryCov_9fa48("604"), 'provider_no_longer_compatible'));
        }
      }
      const operationId = nonEmptyString(context.operation_id, stryMutAct_9fa48("605") ? "" : (stryCov_9fa48("605"), 'dispatch.operation_id'));
      const binding = bindingFor(this.registry, resolved.provider_id);
      if (stryMutAct_9fa48("608") ? binding.entry.metadata_hash !== resolved.provider_metadata_hash && incompatibilityReason(binding, request) !== undefined : stryMutAct_9fa48("607") ? false : stryMutAct_9fa48("606") ? true : (stryCov_9fa48("606", "607", "608"), (stryMutAct_9fa48("610") ? binding.entry.metadata_hash === resolved.provider_metadata_hash : stryMutAct_9fa48("609") ? false : (stryCov_9fa48("609", "610"), binding.entry.metadata_hash !== resolved.provider_metadata_hash)) || (stryMutAct_9fa48("612") ? incompatibilityReason(binding, request) === undefined : stryMutAct_9fa48("611") ? false : (stryCov_9fa48("611", "612"), incompatibilityReason(binding, request) !== undefined)))) {
        if (stryMutAct_9fa48("613")) {
          {}
        } else {
          stryCov_9fa48("613");
          throw new ProviderDispatchError(stryMutAct_9fa48("614") ? "" : (stryCov_9fa48("614"), 'provider_no_longer_compatible'));
        }
      }
      const health = await binding.adapter.checkHealth();
      if (stryMutAct_9fa48("617") ? health === 'healthy' : stryMutAct_9fa48("616") ? false : stryMutAct_9fa48("615") ? true : (stryCov_9fa48("615", "616", "617"), health !== (stryMutAct_9fa48("618") ? "" : (stryCov_9fa48("618"), 'healthy')))) throw new ProviderDispatchError(stryMutAct_9fa48("619") ? "" : (stryCov_9fa48("619"), 'provider_unhealthy'));
      let egressDecision: {
        readonly allowed: boolean;
        readonly reason?: string;
      };
      try {
        if (stryMutAct_9fa48("620")) {
          {}
        } else {
          stryCov_9fa48("620");
          egressDecision = await this.ports.egressPolicy.authorize(stryMutAct_9fa48("621") ? {} : (stryCov_9fa48("621"), {
            provider_id: binding.entry.provider_id,
            ...((stryMutAct_9fa48("624") ? binding.entry.network.destination !== undefined : stryMutAct_9fa48("623") ? false : stryMutAct_9fa48("622") ? true : (stryCov_9fa48("622", "623", "624"), binding.entry.network.destination === undefined)) ? {} : stryMutAct_9fa48("625") ? {} : (stryCov_9fa48("625"), {
              destination: binding.entry.network.destination
            })),
            network_required: binding.entry.network.required,
            data_policy: normalizeRequiredDataPolicy(request.data_policy),
            operation_id: operationId
          }));
        }
      } catch {
        if (stryMutAct_9fa48("626")) {
          {}
        } else {
          stryCov_9fa48("626");
          throw new ProviderDispatchError(stryMutAct_9fa48("627") ? "" : (stryCov_9fa48("627"), 'egress_policy_failure'));
        }
      }
      if (stryMutAct_9fa48("630") ? false : stryMutAct_9fa48("629") ? true : stryMutAct_9fa48("628") ? egressDecision.allowed : (stryCov_9fa48("628", "629", "630"), !egressDecision.allowed)) throw new ProviderDispatchError(stryMutAct_9fa48("631") ? "" : (stryCov_9fa48("631"), 'egress_denied'));
      let credential: EphemeralCredentialLease | undefined;
      if (stryMutAct_9fa48("633") ? false : stryMutAct_9fa48("632") ? true : (stryCov_9fa48("632", "633"), binding.entry.credentials.required)) {
        if (stryMutAct_9fa48("634")) {
          {}
        } else {
          stryCov_9fa48("634");
          try {
            if (stryMutAct_9fa48("635")) {
              {}
            } else {
              stryCov_9fa48("635");
              credential = await this.ports.secretsBroker.exchangeCredential(stryMutAct_9fa48("636") ? {} : (stryCov_9fa48("636"), {
                provider_id: binding.entry.provider_id,
                audience: binding.entry.credentials.audience,
                operation_id: operationId
              }));
            }
          } catch {
            if (stryMutAct_9fa48("637")) {
              {}
            } else {
              stryCov_9fa48("637");
              throw new ProviderDispatchError(stryMutAct_9fa48("638") ? "" : (stryCov_9fa48("638"), 'credential_exchange_failed'));
            }
          }
        }
      }
      let response: ParsedResponse;
      let usage: Usage;
      try {
        if (stryMutAct_9fa48("639")) {
          {}
        } else {
          stryCov_9fa48("639");
          const raw = await binding.adapter.resolve(request.request, stryMutAct_9fa48("640") ? {} : (stryCov_9fa48("640"), {
            operation_id: operationId,
            ...((stryMutAct_9fa48("643") ? credential !== undefined : stryMutAct_9fa48("642") ? false : stryMutAct_9fa48("641") ? true : (stryCov_9fa48("641", "642", "643"), credential === undefined)) ? {} : stryMutAct_9fa48("644") ? {} : (stryCov_9fa48("644"), {
              credential
            }))
          }));
          response = binding.adapter.parseResponse(raw);
          usage = binding.adapter.meterUsage(response);
        }
      } catch (error) {
        if (stryMutAct_9fa48("645")) {
          {}
        } else {
          stryCov_9fa48("645");
          let mapped: ProviderError;
          try {
            if (stryMutAct_9fa48("646")) {
              {}
            } else {
              stryCov_9fa48("646");
              mapped = binding.adapter.mapError(error);
            }
          } catch {
            if (stryMutAct_9fa48("647")) {
              {}
            } else {
              stryCov_9fa48("647");
              mapped = stryMutAct_9fa48("648") ? {} : (stryCov_9fa48("648"), {
                kind: stryMutAct_9fa48("649") ? "" : (stryCov_9fa48("649"), 'unknown'),
                retryable: stryMutAct_9fa48("650") ? true : (stryCov_9fa48("650"), false),
                detail: stryMutAct_9fa48("651") ? "" : (stryCov_9fa48("651"), 'Provider error normalization failed')
              });
            }
          }
          throw new ProviderDispatchError(stryMutAct_9fa48("652") ? "" : (stryCov_9fa48("652"), 'provider_failure'), mapped);
        }
      }
      try {
        if (stryMutAct_9fa48("653")) {
          {}
        } else {
          stryCov_9fa48("653");
          await this.ports.usageMeter.record(stryMutAct_9fa48("654") ? {} : (stryCov_9fa48("654"), {
            provider_id: binding.entry.provider_id,
            operation_id: operationId,
            usage
          }));
        }
      } catch {
        if (stryMutAct_9fa48("655")) {
          {}
        } else {
          stryCov_9fa48("655");
          throw new ProviderDispatchError(stryMutAct_9fa48("656") ? "" : (stryCov_9fa48("656"), 'metering_failed'));
        }
      }
      return deepFreeze(stryMutAct_9fa48("657") ? {} : (stryCov_9fa48("657"), {
        provider_id: binding.entry.provider_id,
        response,
        usage
      }));
    }
  }
  private resolveExcluding(request: ProviderSelectionRequest, excludedProviderIds: ReadonlySet<string>): ResolvedProvider {
    if (stryMutAct_9fa48("658")) {
      {}
    } else {
      stryCov_9fa48("658");
      validateSelection(request);
      if (stryMutAct_9fa48("661") ? request.registry_snapshot_hash === this.registry.snapshot.hash : stryMutAct_9fa48("660") ? false : stryMutAct_9fa48("659") ? true : (stryCov_9fa48("659", "660", "661"), request.registry_snapshot_hash !== this.registry.snapshot.hash)) {
        if (stryMutAct_9fa48("662")) {
          {}
        } else {
          stryCov_9fa48("662");
          throw new ProviderResolutionError(stryMutAct_9fa48("663") ? "" : (stryCov_9fa48("663"), 'stale_registry_snapshot'), stryMutAct_9fa48("664") ? "" : (stryCov_9fa48("664"), 'RunPlan provider registry snapshot is stale'));
        }
      }
      const candidates = stryMutAct_9fa48("667") ? this.registry.snapshot.providers.map(entry => bindingFor(this.registry, entry.provider_id)).filter(binding => incompatibilityReason(binding, request) === undefined).sort((left, right) => {
        const costDelta = estimatedPrice(left.entry, request) - estimatedPrice(right.entry, request);
        return costDelta === 0 ? binaryCompare(left.entry.provider_id, right.entry.provider_id) : costDelta;
      }) : stryMutAct_9fa48("666") ? this.registry.snapshot.providers.filter(entry => !excludedProviderIds.has(entry.provider_id)).map(entry => bindingFor(this.registry, entry.provider_id)).sort((left, right) => {
        const costDelta = estimatedPrice(left.entry, request) - estimatedPrice(right.entry, request);
        return costDelta === 0 ? binaryCompare(left.entry.provider_id, right.entry.provider_id) : costDelta;
      }) : stryMutAct_9fa48("665") ? this.registry.snapshot.providers.filter(entry => !excludedProviderIds.has(entry.provider_id)).map(entry => bindingFor(this.registry, entry.provider_id)).filter(binding => incompatibilityReason(binding, request) === undefined) : (stryCov_9fa48("665", "666", "667"), this.registry.snapshot.providers.filter(stryMutAct_9fa48("668") ? () => undefined : (stryCov_9fa48("668"), entry => stryMutAct_9fa48("669") ? excludedProviderIds.has(entry.provider_id) : (stryCov_9fa48("669"), !excludedProviderIds.has(entry.provider_id)))).map(stryMutAct_9fa48("670") ? () => undefined : (stryCov_9fa48("670"), entry => bindingFor(this.registry, entry.provider_id))).filter(stryMutAct_9fa48("671") ? () => undefined : (stryCov_9fa48("671"), binding => stryMutAct_9fa48("674") ? incompatibilityReason(binding, request) !== undefined : stryMutAct_9fa48("673") ? false : stryMutAct_9fa48("672") ? true : (stryCov_9fa48("672", "673", "674"), incompatibilityReason(binding, request) === undefined))).sort((left, right) => {
        if (stryMutAct_9fa48("675")) {
          {}
        } else {
          stryCov_9fa48("675");
          const costDelta = stryMutAct_9fa48("676") ? estimatedPrice(left.entry, request) + estimatedPrice(right.entry, request) : (stryCov_9fa48("676"), estimatedPrice(left.entry, request) - estimatedPrice(right.entry, request));
          return (stryMutAct_9fa48("679") ? costDelta !== 0 : stryMutAct_9fa48("678") ? false : stryMutAct_9fa48("677") ? true : (stryCov_9fa48("677", "678", "679"), costDelta === 0)) ? binaryCompare(left.entry.provider_id, right.entry.provider_id) : costDelta;
        }
      }));
      const selected = candidates[0];
      if (stryMutAct_9fa48("682") ? false : stryMutAct_9fa48("681") ? true : stryMutAct_9fa48("680") ? selected : (stryCov_9fa48("680", "681", "682"), !selected)) {
        if (stryMutAct_9fa48("683")) {
          {}
        } else {
          stryCov_9fa48("683");
          throw new ProviderResolutionError(stryMutAct_9fa48("684") ? "" : (stryCov_9fa48("684"), 'no_compatible_provider'), stryMutAct_9fa48("685") ? "" : (stryCov_9fa48("685"), 'No provider satisfies Policy, RunPlan, context, tool and data-policy constraints'));
        }
      }
      return deepFreeze(stryMutAct_9fa48("686") ? {} : (stryCov_9fa48("686"), {
        provider_id: selected.entry.provider_id,
        registry_snapshot_hash: this.registry.snapshot.hash,
        provider_metadata_hash: selected.entry.metadata_hash,
        selection_request_hash: selectionHash(request)
      }));
    }
  }
}