import { createHash } from 'node:crypto';

import type { ProviderAdapter as ProviderAdapterContract,
  ProviderType, } from '../contracts/index.js';
import type {
  DataPolicyResult,
  HealthStatus,
  ParsedResponse,
  ProviderError,
  ProviderRequest,
  ScriptedTestProvider,
  StreamEvent,
  Usage,
} from './scripted-provider.js';

type MaybePromise<T> = Promise<T> | T;
type ScriptedRuntimeMethods = Pick<
  ScriptedTestProvider,
  | 'mapError'
  | 'meterUsage'
  | 'normalizeRequest'
  | 'normalizeToolCall'
  | 'parseResponse'
  | 'validateDataPolicy'
>;

export interface EphemeralCredentialLease {
  readonly lease_id: string;
  readonly audience: string;
  readonly expires_at: string;
  readonly secret?: string;
}

export interface ProviderDispatchContext {
  readonly operation_id: string;
  readonly attempt_id?: string;
  readonly credential?: EphemeralCredentialLease;
  readonly signal?: AbortSignal;
  readonly deadline_at?: string;
}

/** The operational method set derives from the verified ScriptedTestProvider. */
export type GatewayProviderRuntime = ScriptedRuntimeMethods & {
  provider_type: ProviderType;
  checkHealth: () => MaybePromise<HealthStatus>;
  resolve: (
    request: Parameters<ScriptedTestProvider['resolve']>[0],
    context?: ProviderDispatchContext,
  ) => MaybePromise<ReturnType<ScriptedTestProvider['resolve']>>;
  streamEvents: (
    request: ProviderRequest,
    context?: ProviderDispatchContext,
  ) => AsyncIterable<StreamEvent>;
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

export interface ResolvedProviderDescription {
  readonly provider_id: string;
  readonly provider_type: ProviderType;
  readonly execution: 'local' | 'remote';
  readonly metadata_hash: string;
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
  }): Promise<{ readonly allowed: boolean; readonly reason?: string }>;
}

export interface UsageMeterPort {
  record(input: {
    readonly provider_id: string;
    readonly operation_id: string;
    readonly attempt_id?: string;
    readonly usage: Usage;
  }): Promise<void>;
}

export interface GatewayClockPort {
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface GatewayDispatchResult {
  readonly provider_id: string;
  readonly response: ParsedResponse;
  readonly usage: Usage;
}

export class ProviderConfigurationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigurationError';
  }
}

export type ProviderResolutionErrorCode =
  | 'no_compatible_provider'
  | 'stale_registry_snapshot';

export class ProviderResolutionError extends Error {
  readonly code: ProviderResolutionErrorCode;

  constructor(code: ProviderResolutionErrorCode, message: string) {
    super(message);
    this.name = 'ProviderResolutionError';
    this.code = code;
  }
}

export type ProviderDispatchErrorCode =
  | 'cancelled'
  | 'credential_exchange_failed'
  | 'egress_denied'
  | 'egress_policy_failure'
  | 'metering_failed'
  | 'provider_failure'
  | 'provider_no_longer_compatible'
  | 'provider_unhealthy'
  | 'timeout';

export class ProviderDispatchError extends Error {
  readonly code: ProviderDispatchErrorCode;
  readonly provider_error?: ProviderError;

  constructor(code: ProviderDispatchErrorCode, providerError?: ProviderError) {
    super(`ModelGateway dispatch failed: ${code}`);
    this.name = 'ProviderDispatchError';
    this.code = code;
    if (providerError !== undefined) this.provider_error = deepFreeze({ ...providerError });
  }
}

interface NormalizedBinding {
  readonly entry: ProviderSnapshotEntry;
  readonly adapter: GatewayProviderRuntime;
}

const REQUIRED_CONTRACT_METHODS = [
  'normalize_request',
  'parse_response',
  'normalize_tool_call',
  'stream_events',
  'map_error',
  'meter_usage',
  'check_health',
  'validate_data_policy',
] as const;

const RUNTIME_METHODS = [
  'normalizeRequest',
  'parseResponse',
  'normalizeToolCall',
  'streamEvents',
  'mapError',
  'meterUsage',
  'checkHealth',
  'validateDataPolicy',
  'resolve',
] as const;

const PROVIDER_TYPES = [
  'openai',
  'anthropic',
  'google',
  'local',
  'scripted_test',
  'deepseek',
  'qwen',
  'doubao',
  'ollama',
  'vllm',
] as const satisfies readonly ProviderType[];
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const registryBindings = new WeakMap<
  FrozenProviderRegistry,
  ReadonlyMap<string, NormalizedBinding>
>();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function assertPlainRecord(value: unknown, location: string): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new ProviderConfigurationError(`${location} must be an object`);
}

function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[], location: string) {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    throw new ProviderConfigurationError(`${location} contains unknown field: ${unknown[0]}`);
  }
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProviderConfigurationError(`${location} must be a non-empty string`);
  }
  return value;
}

function finiteNonNegative(value: unknown, location: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ProviderConfigurationError(`${location} must be a finite non-negative number`);
  }
  return value;
}

function safeInteger(value: unknown, minimum: number, location: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ProviderConfigurationError(`${location} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function booleanValue(value: unknown, location: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ProviderConfigurationError(`${location} must be a boolean`);
  }
  return value;
}

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueStrings(value: unknown, location: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value)) throw new ProviderConfigurationError(`${location} must be an array`);
  const normalized = value.map((entry, index) => nonEmptyString(entry, `${location}[${index}]`));
  if (!allowEmpty && normalized.length === 0) {
    throw new ProviderConfigurationError(`${location} must not be empty`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new ProviderConfigurationError(`${location} must not contain duplicates`);
  }
  return normalized.sort(binaryCompare);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ProviderConfigurationError('hash input must be JSON');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => binaryCompare(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  throw new ProviderConfigurationError('hash input must be plain JSON data');
}

function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function normalizeContract(raw: unknown, location: string): Readonly<ProviderAdapterContract> {
  assertPlainRecord(raw, location);
  assertKnownKeys(
    raw,
    [
      'provider_type',
      ...REQUIRED_CONTRACT_METHODS,
      'fallback_compatibility_checker',
      'rate_limiter',
      'circuit_breaker',
    ],
    location,
  );
  const providerType = nonEmptyString(raw.provider_type, `${location}.provider_type`);
  if (!PROVIDER_TYPES.includes(providerType as ProviderType)) {
    throw new ProviderConfigurationError(`${location}.provider_type is unsupported`);
  }
  for (const method of REQUIRED_CONTRACT_METHODS) {
    if (raw[method] !== true) {
      throw new ProviderConfigurationError(`${location}.${method} must be true`);
    }
  }
  for (const optional of [
    'fallback_compatibility_checker',
    'rate_limiter',
    'circuit_breaker',
  ] as const) {
    if (raw[optional] !== undefined && typeof raw[optional] !== 'boolean') {
      throw new ProviderConfigurationError(`${location}.${optional} must be a boolean`);
    }
  }
  return deepFreeze({ ...raw, provider_type: providerType } as ProviderAdapterContract);
}

function normalizeDataPolicy(raw: unknown, location: string): Readonly<ProviderDataPolicyMetadata> {
  assertPlainRecord(raw, location);
  assertKnownKeys(raw, ['execution', 'regions', 'retention_days', 'training_allowed'], location);
  if (raw.execution !== 'local' && raw.execution !== 'remote') {
    throw new ProviderConfigurationError(`${location}.execution is unsupported`);
  }
  return deepFreeze({
    execution: raw.execution,
    regions: uniqueStrings(raw.regions, `${location}.regions`, false),
    retention_days: safeInteger(raw.retention_days, 0, `${location}.retention_days`),
    training_allowed: booleanValue(raw.training_allowed, `${location}.training_allowed`),
  });
}

function normalizePricing(raw: unknown, location: string): Readonly<ProviderPricingMetadata> {
  assertPlainRecord(raw, location);
  assertKnownKeys(raw, ['currency', 'input_per_million', 'output_per_million'], location);
  if (raw.currency !== 'USD') {
    throw new ProviderConfigurationError(`${location}.currency must be USD in Phase 1`);
  }
  return deepFreeze({
    currency: raw.currency,
    input_per_million: finiteNonNegative(raw.input_per_million, `${location}.input_per_million`),
    output_per_million: finiteNonNegative(
      raw.output_per_million,
      `${location}.output_per_million`,
    ),
  });
}

function normalizeNetwork(raw: unknown, location: string): Readonly<ProviderNetworkMetadata> {
  assertPlainRecord(raw, location);
  assertKnownKeys(raw, ['required', 'destination'], location);
  const required = booleanValue(raw.required, `${location}.required`);
  if (!required && raw.destination !== undefined) {
    throw new ProviderConfigurationError(`${location}.destination requires network.required=true`);
  }
  if (!required) return deepFreeze({ required: false });
  const destination = nonEmptyString(raw.destination, `${location}.destination`);
  let parsed: URL;
  try {
    parsed = new URL(destination);
  } catch {
    throw new ProviderConfigurationError(`${location}.destination must be a valid HTTPS origin`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.origin !== destination
  ) {
    throw new ProviderConfigurationError(`${location}.destination must be a valid HTTPS origin`);
  }
  return deepFreeze({ required: true, destination });
}

function normalizeCredentials(
  raw: unknown,
  location: string,
): Readonly<ProviderCredentialMetadata> {
  assertPlainRecord(raw, location);
  assertKnownKeys(raw, ['required', 'audience'], location);
  return deepFreeze({
    required: booleanValue(raw.required, `${location}.required`),
    audience: nonEmptyString(raw.audience, `${location}.audience`),
  });
}

function normalizeRegistration(raw: unknown, index: number): NormalizedBinding {
  const location = `providers[${index}]`;
  assertPlainRecord(raw, location);
  assertKnownKeys(raw, ['provider_id', 'contract', 'adapter', 'metadata'], location);
  const providerId = nonEmptyString(raw.provider_id, `${location}.provider_id`);
  const contract = normalizeContract(raw.contract, `${location}.contract`);
  if (typeof raw.adapter !== 'object' || raw.adapter === null || Array.isArray(raw.adapter)) {
    throw new ProviderConfigurationError(`${location}.adapter must be an object`);
  }
  const adapterSource = raw.adapter as GatewayProviderRuntime;
  for (const method of RUNTIME_METHODS) {
    if (typeof adapterSource[method] !== 'function') {
      throw new ProviderConfigurationError(`${location}.adapter.${method} must be a function`);
    }
  }
  if (adapterSource.provider_type !== contract.provider_type) {
    throw new ProviderConfigurationError(`${location}.adapter.provider_type must match Contract`);
  }
  const adapter: GatewayProviderRuntime = deepFreeze({
    provider_type: adapterSource.provider_type,
    normalizeRequest: adapterSource.normalizeRequest.bind(adapterSource),
    parseResponse: adapterSource.parseResponse.bind(adapterSource),
    normalizeToolCall: adapterSource.normalizeToolCall.bind(adapterSource),
    streamEvents: adapterSource.streamEvents.bind(adapterSource),
    mapError: adapterSource.mapError.bind(adapterSource),
    meterUsage: adapterSource.meterUsage.bind(adapterSource),
    checkHealth: adapterSource.checkHealth.bind(adapterSource),
    validateDataPolicy: adapterSource.validateDataPolicy.bind(adapterSource),
    resolve: adapterSource.resolve.bind(adapterSource),
  });

  assertPlainRecord(raw.metadata, `${location}.metadata`);
  assertKnownKeys(
    raw.metadata,
    [
      'capabilities',
      'max_context_tokens',
      'structured_output',
      'tool_calling',
      'data_policy',
      'pricing',
      'health',
      'network',
      'credentials',
    ],
    `${location}.metadata`,
  );
  if (!['healthy', 'degraded', 'down'].includes(raw.metadata.health as string)) {
    throw new ProviderConfigurationError(`${location}.metadata.health is unsupported`);
  }
  const metadata = {
    capabilities: uniqueStrings(
      raw.metadata.capabilities,
      `${location}.metadata.capabilities`,
      false,
    ),
    max_context_tokens: safeInteger(
      raw.metadata.max_context_tokens,
      1,
      `${location}.metadata.max_context_tokens`,
    ),
    structured_output: booleanValue(
      raw.metadata.structured_output,
      `${location}.metadata.structured_output`,
    ),
    tool_calling: booleanValue(raw.metadata.tool_calling, `${location}.metadata.tool_calling`),
    data_policy: normalizeDataPolicy(
      raw.metadata.data_policy,
      `${location}.metadata.data_policy`,
    ),
    pricing: normalizePricing(raw.metadata.pricing, `${location}.metadata.pricing`),
    health: raw.metadata.health as HealthStatus,
    network: normalizeNetwork(raw.metadata.network, `${location}.metadata.network`),
    credentials: normalizeCredentials(
      raw.metadata.credentials,
      `${location}.metadata.credentials`,
    ),
  };
  const descriptor = {
    provider_id: providerId,
    provider_type: contract.provider_type,
    contract,
    ...metadata,
  };
  return {
    entry: deepFreeze({ ...descriptor, metadata_hash: contentHash(descriptor) }),
    adapter,
  };
}

export class FrozenProviderRegistry {
  readonly snapshot: ProviderRegistrySnapshot;

  constructor(registrations: readonly GatewayProviderRegistration[]) {
    if (!Array.isArray(registrations)) {
      throw new ProviderConfigurationError('provider registrations must be an array');
    }
    const normalized = registrations.map((registration, index) =>
      normalizeRegistration(registration, index),
    );
    const ids = normalized.map(({ entry }) => entry.provider_id);
    if (new Set(ids).size !== ids.length) {
      throw new ProviderConfigurationError('duplicate provider identity is forbidden');
    }
    normalized.sort((left, right) => binaryCompare(left.entry.provider_id, right.entry.provider_id));
    const providers = normalized.map(({ entry }) => entry);
    this.snapshot = deepFreeze({ hash: contentHash(providers), providers });
    registryBindings.set(
      this,
      new Map(normalized.map((binding) => [binding.entry.provider_id, binding])),
    );
    Object.freeze(this);
  }
}

function bindingFor(registry: FrozenProviderRegistry, providerId: string): NormalizedBinding {
  const binding = registryBindings.get(registry)?.get(providerId);
  if (!binding) throw new ProviderDispatchError('provider_no_longer_compatible');
  return binding;
}

function normalizeRequiredDataPolicy(raw: unknown): Readonly<RequiredDataPolicy> {
  assertPlainRecord(raw, 'selection.data_policy');
  assertKnownKeys(
    raw,
    ['local_only', 'allowed_regions', 'max_retention_days', 'training_allowed'],
    'selection.data_policy',
  );
  return deepFreeze({
    local_only: booleanValue(raw.local_only, 'selection.data_policy.local_only'),
    allowed_regions: uniqueStrings(
      raw.allowed_regions,
      'selection.data_policy.allowed_regions',
      false,
    ),
    max_retention_days: safeInteger(
      raw.max_retention_days,
      0,
      'selection.data_policy.max_retention_days',
    ),
    training_allowed: booleanValue(
      raw.training_allowed,
      'selection.data_policy.training_allowed',
    ),
  });
}

function normalizeAuthority(
  raw: unknown,
  location: string,
): Readonly<ProviderAuthorityConstraints> {
  assertPlainRecord(raw, location);
  assertKnownKeys(raw, ['allowed_provider_ids', 'denied_provider_ids'], location);
  return deepFreeze({
    allowed_provider_ids:
      raw.allowed_provider_ids === undefined
        ? undefined
        : uniqueStrings(raw.allowed_provider_ids, `${location}.allowed_provider_ids`, true),
    denied_provider_ids: uniqueStrings(
      raw.denied_provider_ids,
      `${location}.denied_provider_ids`,
      true,
    ),
  });
}

function normalizeRunPlan(raw: unknown): Readonly<ProviderRunPlanConstraints> {
  assertPlainRecord(raw, 'selection.run_plan');
  assertKnownKeys(raw, ['allowed_provider_ids', 'required_capabilities'], 'selection.run_plan');
  return deepFreeze({
    allowed_provider_ids:
      raw.allowed_provider_ids === undefined
        ? undefined
        : uniqueStrings(
            raw.allowed_provider_ids,
            'selection.run_plan.allowed_provider_ids',
            true,
          ),
    required_capabilities: uniqueStrings(
      raw.required_capabilities,
      'selection.run_plan.required_capabilities',
      true,
    ),
  });
}

function validateSelection(request: ProviderSelectionRequest) {
  assertPlainRecord(request, 'selection');
  assertKnownKeys(
    request,
    [
      'registry_snapshot_hash',
      'request',
      'estimated_input_tokens',
      'required_capabilities',
      'requires_structured_output',
      'data_policy',
      'policy',
      'run_plan',
    ],
    'selection',
  );
  if (!/^[0-9a-f]{64}$/u.test(request.registry_snapshot_hash)) {
    throw new ProviderConfigurationError('selection.registry_snapshot_hash must be SHA-256');
  }
  safeInteger(request.estimated_input_tokens, 0, 'selection.estimated_input_tokens');
  uniqueStrings(request.required_capabilities, 'selection.required_capabilities', true);
  booleanValue(request.requires_structured_output, 'selection.requires_structured_output');
  normalizeRequiredDataPolicy(request.data_policy);
  normalizeAuthority(request.policy, 'selection.policy');
  normalizeRunPlan(request.run_plan);
}

function selectionHash(request: ProviderSelectionRequest): string {
  return contentHash(request);
}

function isAllowedByAuthority(
  providerId: string,
  authority: ProviderAuthorityConstraints,
): boolean {
  return (
    (authority.allowed_provider_ids === undefined ||
      authority.allowed_provider_ids.includes(providerId)) &&
    !authority.denied_provider_ids.includes(providerId)
  );
}

function incompatibilityReason(
  binding: NormalizedBinding,
  request: ProviderSelectionRequest,
): string | undefined {
  const { adapter, entry } = binding;
  if (entry.health !== 'healthy') return 'snapshot health is not healthy';
  if (!isAllowedByAuthority(entry.provider_id, request.policy)) return 'Policy denied provider';
  if (
    request.run_plan.allowed_provider_ids !== undefined &&
    !request.run_plan.allowed_provider_ids.includes(entry.provider_id)
  ) {
    return 'RunPlan denied provider';
  }
  const requiredCapabilities = new Set([
    ...request.required_capabilities,
    ...request.run_plan.required_capabilities,
  ]);
  if ([...requiredCapabilities].some((capability) => !entry.capabilities.includes(capability))) {
    return 'required capability is unavailable';
  }
  if (
    request.estimated_input_tokens + (request.request.max_tokens ?? 0) >
    entry.max_context_tokens
  ) {
    return 'context length is incompatible';
  }
  if (request.requires_structured_output && !entry.structured_output) {
    return 'structured output is unavailable';
  }
  if ((request.request.tools?.length ?? 0) > 0 && !entry.tool_calling) {
    return 'tool calling is unavailable';
  }
  if (request.data_policy.local_only && entry.data_policy.execution !== 'local') {
    return 'local-only data policy is incompatible';
  }
  if (
    !entry.data_policy.regions.some((region) => request.data_policy.allowed_regions.includes(region))
  ) {
    return 'data region is incompatible';
  }
  if (entry.data_policy.retention_days > request.data_policy.max_retention_days) {
    return 'data retention is incompatible';
  }
  if (!request.data_policy.training_allowed && entry.data_policy.training_allowed) {
    return 'provider training policy is incompatible';
  }
  try {
    adapter.normalizeRequest(request.request);
    const decision: DataPolicyResult = adapter.validateDataPolicy(request.request);
    if (!decision.allowed) return 'adapter data policy denied request';
  } catch {
    return 'adapter validation rejected request';
  }
  return undefined;
}

function estimatedPrice(entry: ProviderSnapshotEntry, request: ProviderSelectionRequest): number {
  return (
    request.estimated_input_tokens * entry.pricing.input_per_million +
    (request.request.max_tokens ?? 0) * entry.pricing.output_per_million
  );
}

export class ModelGateway {
  private readonly registry: FrozenProviderRegistry;
  private readonly ports: {
    readonly secretsBroker: SecretsBrokerPort;
    readonly egressPolicy: EgressPolicyPort;
    readonly usageMeter: UsageMeterPort;
    readonly clock: GatewayClockPort;
  };

  constructor(
    registry: FrozenProviderRegistry,
    ports: {
      readonly secretsBroker: SecretsBrokerPort;
      readonly egressPolicy: EgressPolicyPort;
      readonly usageMeter: UsageMeterPort;
      readonly clock: GatewayClockPort;
    },
  ) {
    if (!(registry instanceof FrozenProviderRegistry)) {
      throw new ProviderConfigurationError('ModelGateway requires a FrozenProviderRegistry');
    }
    if (!ports || typeof ports !== 'object') {
      throw new ProviderConfigurationError('ModelGateway control ports are required');
    }
    for (const [name, method] of [
      ['secretsBroker.exchangeCredential', ports.secretsBroker?.exchangeCredential],
      ['egressPolicy.authorize', ports.egressPolicy?.authorize],
      ['usageMeter.record', ports.usageMeter?.record],
      ['clock.now', ports.clock?.now],
      ['clock.sleep', ports.clock?.sleep],
    ] as const) {
      if (typeof method !== 'function') {
        throw new ProviderConfigurationError(`${name} must be a function`);
      }
    }
    this.registry = registry;
    this.ports = deepFreeze({
      secretsBroker: {
        exchangeCredential: ports.secretsBroker.exchangeCredential.bind(ports.secretsBroker),
      },
      egressPolicy: { authorize: ports.egressPolicy.authorize.bind(ports.egressPolicy) },
      usageMeter: { record: ports.usageMeter.record.bind(ports.usageMeter) },
      clock: {
        now: ports.clock.now.bind(ports.clock),
        sleep: ports.clock.sleep.bind(ports.clock),
      },
    });
    Object.freeze(this);
  }

  /** The frozen registry snapshot hash owned by this gateway. */
  get registrySnapshotHash(): string {
    return this.registry.snapshot.hash;
  }

  /** The frozen registry snapshot (providers list) owned by this gateway. */
  get registrySnapshot(): { readonly providers: readonly ProviderSnapshotEntry[]; readonly hash: string } {
    return this.registry.snapshot;
  }

  resolve(request: ProviderSelectionRequest): ResolvedProvider {
    return this.resolveExcluding(request, new Set());
  }

  describeResolved(resolved: ResolvedProvider): ResolvedProviderDescription {
    if (resolved.registry_snapshot_hash !== this.registry.snapshot.hash) {
      throw new ProviderResolutionError(
        'stale_registry_snapshot',
        'Resolved provider does not belong to this frozen registry',
      );
    }
    const binding = bindingFor(this.registry, resolved.provider_id);
    if (binding.entry.metadata_hash !== resolved.provider_metadata_hash) {
      throw new ProviderResolutionError(
        'stale_registry_snapshot',
        'Resolved provider metadata does not match the frozen registry',
      );
    }
    return deepFreeze({
      provider_id: binding.entry.provider_id,
      provider_type: binding.entry.provider_type,
      execution: binding.entry.data_policy.execution,
      metadata_hash: binding.entry.metadata_hash,
    });
  }

  switchProvider(
    previous: ResolvedProvider,
    request: ProviderSelectionRequest,
    attemptedProviderIds: readonly string[] = [],
  ): ResolvedProvider {
    if (
      previous.registry_snapshot_hash !== this.registry.snapshot.hash ||
      previous.selection_request_hash !== selectionHash(request)
    ) {
      throw new ProviderResolutionError(
        'stale_registry_snapshot',
        'Provider switch must use the same frozen registry and selection request',
      );
    }
    return this.resolveExcluding(request, new Set([previous.provider_id, ...attemptedProviderIds]));
  }

  async dispatch(
    resolved: ResolvedProvider,
    request: ProviderSelectionRequest,
    context: {
      readonly operation_id: string;
      readonly attempt_id?: string;
      readonly signal?: AbortSignal | undefined;
      readonly deadline_at?: string;
    },
  ): Promise<GatewayDispatchResult> {
    if (
      resolved.registry_snapshot_hash !== this.registry.snapshot.hash ||
      resolved.selection_request_hash !== selectionHash(request)
    ) {
      throw new ProviderDispatchError('provider_no_longer_compatible');
    }
    const operationId = nonEmptyString(context.operation_id, 'dispatch.operation_id');
    const deadline =
      context.deadline_at === undefined ? undefined : Date.parse(context.deadline_at);
    if (deadline !== undefined && !Number.isFinite(deadline)) {
      throw new ProviderConfigurationError('dispatch.deadline_at must be an ISO timestamp');
    }
    const abort = this.createDispatchAbort(context.signal, deadline);
    const attemptedProviderIds: string[] = [];
    let selected = resolved;
    try {
      for (;;) {
        try {
          return await this.dispatchToProvider(
            selected,
            request,
            context,
            operationId,
            abort.signal,
            abort.code,
          );
        } catch (error) {
          if (
            !(error instanceof ProviderDispatchError) ||
            error.code !== 'provider_failure' ||
            error.provider_error?.retryable !== true ||
            error.provider_error.kind === 'auth' ||
            error.provider_error.kind === 'invalid_request'
          ) {
            throw error;
          }
          attemptedProviderIds.push(selected.provider_id);
          try {
            selected = this.switchProvider(selected, request, attemptedProviderIds);
          } catch (switchError) {
            if (switchError instanceof ProviderResolutionError) throw error;
            throw switchError;
          }
        }
      }
    } finally {
      abort.cleanup();
    }
  }

  /**
   * Dispatches only the resolved provider. Runtime fallback orchestration uses
   * this entrypoint so cache invalidation and context recompilation occur
   * between provider hops instead of being bypassed by an internal switch.
   */
  async dispatchExact(
    resolved: ResolvedProvider,
    request: ProviderSelectionRequest,
    context: {
      readonly operation_id: string;
      readonly attempt_id?: string;
      readonly signal?: AbortSignal | undefined;
      readonly deadline_at?: string;
    },
  ): Promise<GatewayDispatchResult> {
    if (
      resolved.registry_snapshot_hash !== this.registry.snapshot.hash ||
      resolved.selection_request_hash !== selectionHash(request)
    ) {
      throw new ProviderDispatchError('provider_no_longer_compatible');
    }
    const operationId = nonEmptyString(context.operation_id, 'dispatchExact.operation_id');
    const deadline =
      context.deadline_at === undefined ? undefined : Date.parse(context.deadline_at);
    if (deadline !== undefined && !Number.isFinite(deadline)) {
      throw new ProviderConfigurationError('dispatchExact.deadline_at must be an ISO timestamp');
    }
    const abort = this.createDispatchAbort(context.signal, deadline);
    try {
      return await this.dispatchToProvider(
        resolved,
        request,
        context,
        operationId,
        abort.signal,
        abort.code,
      );
    } finally {
     abort.cleanup();
   }
 }

  async *dispatchStream(
    resolved: ResolvedProvider,
    request: ProviderSelectionRequest,
    context: {
      readonly operation_id: string;
      readonly attempt_id?: string;
      readonly signal?: AbortSignal | undefined;
      readonly deadline_at?: string | undefined;
    },
  ): AsyncGenerator<StreamEvent, void, void> {
    if (
      resolved.registry_snapshot_hash !== this.registry.snapshot.hash ||
      resolved.selection_request_hash !== selectionHash(request)
    ) {
      throw new ProviderDispatchError('provider_no_longer_compatible');
    }
    const operationId = nonEmptyString(context.operation_id, 'dispatchStream.operation_id');
    const deadline =
      context.deadline_at === undefined ? undefined : Date.parse(context.deadline_at);
    if (deadline !== undefined && !Number.isFinite(deadline)) {
      throw new ProviderConfigurationError('dispatchStream.deadline_at must be an ISO timestamp');
    }
    const abort = this.createDispatchAbort(context.signal, deadline);
    const attemptedProviderIds: string[] = [];
    let selected = resolved;
    try {
      for (;;) {
        try {
          yield* this.dispatchToProviderStream(
            selected,
            request,
            {
              ...(context.attempt_id === undefined ? {} : { attempt_id: context.attempt_id }),
              ...(context.deadline_at === undefined ? {} : { deadline_at: context.deadline_at }),
            },
            operationId,
            abort.signal,
            abort.code,
          );
          return;
        } catch (error) {
          if (
            !(error instanceof ProviderDispatchError) ||
            error.code !== 'provider_failure' ||
            error.provider_error?.retryable !== true ||
            error.provider_error.kind === 'auth' ||
            error.provider_error.kind === 'invalid_request'
          ) {
            throw error;
          }
          attemptedProviderIds.push(selected.provider_id);
          try {
            selected = this.switchProvider(selected, request, attemptedProviderIds);
          } catch (switchError) {
            if (switchError instanceof ProviderResolutionError) throw error;
            throw switchError;
          }
        }
      }
    } finally {
      abort.cleanup();
    }
  }

  private async *dispatchToProviderStream(
    resolved: ResolvedProvider,
    request: ProviderSelectionRequest,
    context: {
      readonly attempt_id?: string;
      readonly deadline_at?: string;
    },
    operationId: string,
    signal: AbortSignal,
    abortCode: () => 'cancelled' | 'timeout',
  ): AsyncGenerator<StreamEvent, void, void> {
    if (signal.aborted) throw new ProviderDispatchError(abortCode());
    const { binding, credential } = await this.prepareProvider(resolved, request, operationId);
    let collectedUsage: Usage | undefined;
    const maxAttempts = 3;
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new ProviderDispatchError(abortCode());
      const attemptId =
        context.attempt_id ?? `${operationId}.${binding.entry.provider_id}.${attempt + 1}`;
      let eventsYielded = 0;
      try {
        for await (const event of binding.adapter.streamEvents(request.request, {
          operation_id: operationId,
          attempt_id: attemptId,
          ...(credential === undefined ? {} : { credential }),
          signal,
          ...(context.deadline_at === undefined ? {} : { deadline_at: context.deadline_at }),
        })) {
          eventsYielded++;
          if (event.type === 'message_stop' && event.usage !== undefined) {
            collectedUsage = event.usage;
          }
          yield event;
        }
        break;
      } catch (error) {
        if (signal.aborted) throw new ProviderDispatchError(abortCode());
        let mapped: ProviderError;
        try { mapped = binding.adapter.mapError(error); }
        catch { mapped = { kind: 'unknown', retryable: false, detail: 'Provider error normalization failed' }; }
        if (eventsYielded > 0) throw new ProviderDispatchError('provider_failure', mapped);
        if (
          !mapped.retryable ||
          mapped.kind === 'auth' ||
          mapped.kind === 'invalid_request' ||
          attempt >= maxAttempts - 1
        ) {
          throw new ProviderDispatchError('provider_failure', mapped);
        }
        const backoffMs = Math.min(100 * 2 ** attempt, 1_000);
        await this.raceWithAbort(this.ports.clock.sleep(backoffMs, signal), signal, abortCode);
      }
    }
    if (collectedUsage !== undefined) {
      try {
        await this.ports.usageMeter.record({
          provider_id: binding.entry.provider_id,
          operation_id: operationId,
          ...(context.attempt_id === undefined ? {} : { attempt_id: context.attempt_id }),
          usage: collectedUsage,
        });
      } catch { throw new ProviderDispatchError('metering_failed'); }
    }
  }

 private async dispatchToProvider(
   resolved: ResolvedProvider,
    request: ProviderSelectionRequest,
    context: {
      readonly attempt_id?: string;
      readonly deadline_at?: string;
    },
    operationId: string,
    signal: AbortSignal,
    abortCode: () => 'cancelled' | 'timeout',
  ): Promise<GatewayDispatchResult> {
    if (signal.aborted) throw new ProviderDispatchError(abortCode());
    const { binding, credential } = await this.prepareProvider(
      resolved,
      request,
      operationId,
    );

    let response: ParsedResponse;
    let usage: Usage;
    const maxAttempts = 3;
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new ProviderDispatchError(abortCode());
      const attemptId =
        context.attempt_id ?? `${operationId}.${binding.entry.provider_id}.${attempt + 1}`;
      try {
        const raw = await this.raceWithAbort(
          Promise.resolve(binding.adapter.resolve(request.request, {
            operation_id: operationId,
            attempt_id: attemptId,
            ...(credential === undefined ? {} : { credential }),
            signal,
            ...(context.deadline_at === undefined
              ? {}
              : { deadline_at: context.deadline_at }),
          })),
          signal,
          abortCode,
        );
        response = binding.adapter.parseResponse(raw);
        usage = binding.adapter.meterUsage(response);
        break;
      } catch (error) {
        if (signal.aborted) throw new ProviderDispatchError(abortCode());
        let mapped: ProviderError;
        try {
          mapped = binding.adapter.mapError(error);
        } catch {
          mapped = {
            kind: 'unknown',
            retryable: false,
            detail: 'Provider error normalization failed',
          };
        }
        if (
          !mapped.retryable ||
          mapped.kind === 'auth' ||
          mapped.kind === 'invalid_request' ||
          attempt >= maxAttempts - 1
        ) {
          throw new ProviderDispatchError('provider_failure', mapped);
        }
        const backoffMs = Math.min(100 * 2 ** attempt, 1_000);
        await this.raceWithAbort(
          this.ports.clock.sleep(backoffMs, signal),
          signal,
          abortCode,
        );
      }
    }

    try {
      await this.ports.usageMeter.record({
        provider_id: binding.entry.provider_id,
        operation_id: operationId,
        ...(context.attempt_id === undefined ? {} : { attempt_id: context.attempt_id }),
        usage,
      });
    } catch {
      throw new ProviderDispatchError('metering_failed');
    }
    return deepFreeze({ provider_id: binding.entry.provider_id, response, usage });
  }

  async *stream(
    resolved: ResolvedProvider,
    request: ProviderSelectionRequest,
    context: {
      readonly operation_id: string;
      readonly attempt_id?: string;
      readonly signal?: AbortSignal;
      readonly deadline_at?: string;
    },
  ): AsyncIterable<StreamEvent> {
    if (
      resolved.registry_snapshot_hash !== this.registry.snapshot.hash ||
      resolved.selection_request_hash !== selectionHash(request)
    ) {
      throw new ProviderDispatchError('provider_no_longer_compatible');
    }
    const operationId = nonEmptyString(context.operation_id, 'stream.operation_id');
    const deadline =
      context.deadline_at === undefined ? undefined : Date.parse(context.deadline_at);
    if (deadline !== undefined && !Number.isFinite(deadline)) {
      throw new ProviderConfigurationError('stream.deadline_at must be an ISO timestamp');
    }
    const abort = this.createDispatchAbort(context.signal, deadline);
    try {
      const { binding, credential } = await this.prepareProvider(
        resolved,
        request,
        operationId,
      );
      const attemptId =
        context.attempt_id ?? `${operationId}.${binding.entry.provider_id}.1`;
      let terminalSeen = false;
      let usage: Usage = { input_tokens: 0, output_tokens: 0 };
      try {
        const events = binding.adapter.streamEvents(request.request, {
          operation_id: operationId,
          attempt_id: attemptId,
          ...(credential === undefined ? {} : { credential }),
          signal: abort.signal,
          ...(context.deadline_at === undefined
            ? {}
            : { deadline_at: context.deadline_at }),
        });
        for await (const event of events) {
          if (abort.signal.aborted) throw new ProviderDispatchError(abort.code());
          if (terminalSeen) {
            throw new ProviderDispatchError('provider_failure', {
              kind: 'invalid_request',
              retryable: false,
              detail: 'Provider emitted data after terminal stream event',
            });
          }
          let normalized = event;
          if (event.type === 'tool_call') {
            normalized = {
              type: 'tool_call',
              tool_call: binding.adapter.normalizeToolCall(event.tool_call),
            };
          } else if (event.type === 'message_stop') {
            terminalSeen = true;
            usage = event.usage ?? usage;
          }
          yield deepFreeze(structuredClone(normalized));
        }
      } catch (error) {
        if (error instanceof ProviderDispatchError) throw error;
        if (abort.signal.aborted) throw new ProviderDispatchError(abort.code());
        let mapped: ProviderError;
        try {
          mapped = binding.adapter.mapError(error);
        } catch {
          mapped = {
            kind: 'unknown',
            retryable: false,
            detail: 'Provider error normalization failed',
          };
        }
        throw new ProviderDispatchError('provider_failure', mapped);
      }
      if (!terminalSeen) {
        throw new ProviderDispatchError('provider_failure', {
          kind: 'invalid_request',
          retryable: false,
          detail: 'Provider stream ended without terminal event',
        });
      }
      try {
        await this.ports.usageMeter.record({
          provider_id: binding.entry.provider_id,
          operation_id: operationId,
          ...(context.attempt_id === undefined ? {} : { attempt_id: context.attempt_id }),
          usage,
        });
      } catch {
        throw new ProviderDispatchError('metering_failed');
      }
    } finally {
      abort.cleanup();
    }
  }

  private async prepareProvider(
    resolved: ResolvedProvider,
    request: ProviderSelectionRequest,
    operationId: string,
  ): Promise<{
    binding: NormalizedBinding;
    credential: EphemeralCredentialLease | undefined;
  }> {
    const binding = bindingFor(this.registry, resolved.provider_id);
    if (
      binding.entry.metadata_hash !== resolved.provider_metadata_hash ||
      incompatibilityReason(binding, request) !== undefined
    ) {
      throw new ProviderDispatchError('provider_no_longer_compatible');
    }
    const health = await binding.adapter.checkHealth();
    if (health !== 'healthy') throw new ProviderDispatchError('provider_unhealthy');

    let egressDecision: { readonly allowed: boolean; readonly reason?: string };
    try {
      egressDecision = await this.ports.egressPolicy.authorize({
        provider_id: binding.entry.provider_id,
        ...(binding.entry.network.destination === undefined
          ? {}
          : { destination: binding.entry.network.destination }),
        network_required: binding.entry.network.required,
        data_policy: normalizeRequiredDataPolicy(request.data_policy),
        operation_id: operationId,
      });
    } catch {
      throw new ProviderDispatchError('egress_policy_failure');
    }
    if (!egressDecision.allowed) throw new ProviderDispatchError('egress_denied');

    let credential: EphemeralCredentialLease | undefined;
    if (binding.entry.credentials.required) {
      try {
        credential = await this.ports.secretsBroker.exchangeCredential({
          provider_id: binding.entry.provider_id,
          audience: binding.entry.credentials.audience,
          operation_id: operationId,
        });
        if (
          typeof credential.lease_id !== 'string' ||
          credential.lease_id.length === 0 ||
          credential.audience !== binding.entry.credentials.audience ||
          !Number.isFinite(Date.parse(credential.expires_at)) ||
          Date.parse(credential.expires_at) <= this.ports.clock.now()
        ) {
          throw new Error('invalid credential lease');
        }
      } catch {
        throw new ProviderDispatchError('credential_exchange_failed');
      }
    }
    return { binding, credential };
  }

  private createDispatchAbort(
    source: AbortSignal | undefined,
    deadline: number | undefined,
  ): {
    signal: AbortSignal;
    code: () => 'cancelled' | 'timeout';
    cleanup: () => void;
  } {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (source?.aborted) controller.abort();
    else source?.addEventListener('abort', onAbort, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (deadline !== undefined) {
      const scheduleDeadline = () => {
        const remaining = deadline - this.ports.clock.now();
        if (remaining <= 0) {
          timedOut = true;
          controller.abort();
          return;
        }
        timer = setTimeout(
          scheduleDeadline,
          Math.min(remaining, MAX_TIMER_DELAY_MS),
        );
      };
      scheduleDeadline();
    }
    return {
      signal: controller.signal,
      code: () => (timedOut ? 'timeout' : 'cancelled'),
      cleanup: () => {
        if (timer !== undefined) clearTimeout(timer);
        source?.removeEventListener('abort', onAbort);
      },
    };
  }

  private async raceWithAbort<T>(
    operation: Promise<T>,
    signal: AbortSignal,
    abortCode: () => 'cancelled' | 'timeout',
  ): Promise<T> {
    if (signal.aborted) throw new ProviderDispatchError(abortCode());
    let listener: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      listener = () => reject(new ProviderDispatchError(abortCode()));
      signal.addEventListener('abort', listener, { once: true });
    });
    try {
      return await Promise.race([operation, cancelled]);
    } finally {
      if (listener) signal.removeEventListener('abort', listener);
    }
  }

  private resolveExcluding(
    request: ProviderSelectionRequest,
    excludedProviderIds: ReadonlySet<string>,
  ): ResolvedProvider {
    validateSelection(request);
    if (request.registry_snapshot_hash !== this.registry.snapshot.hash) {
      throw new ProviderResolutionError(
        'stale_registry_snapshot',
        'RunPlan provider registry snapshot is stale',
      );
    }
    const candidates = this.registry.snapshot.providers
      .filter((entry) => !excludedProviderIds.has(entry.provider_id))
      .map((entry) => bindingFor(this.registry, entry.provider_id))
      .filter((binding) => incompatibilityReason(binding, request) === undefined)
      .sort((left, right) => {
        const costDelta = estimatedPrice(left.entry, request) - estimatedPrice(right.entry, request);
        return costDelta === 0
          ? binaryCompare(left.entry.provider_id, right.entry.provider_id)
          : costDelta;
      });
    const selected = candidates[0];
    if (!selected) {
      throw new ProviderResolutionError(
        'no_compatible_provider',
        'No provider satisfies Policy, RunPlan, context, tool and data-policy constraints',
      );
    }
    return deepFreeze({
      provider_id: selected.entry.provider_id,
      registry_snapshot_hash: this.registry.snapshot.hash,
      provider_metadata_hash: selected.entry.metadata_hash,
      selection_request_hash: selectionHash(request),
    });
  }
}
