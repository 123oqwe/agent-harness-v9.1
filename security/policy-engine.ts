import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

import type { EffectRisk } from '../contracts/index.js';

export type DerivedRiskTier = 0 | 1 | 2 | 3 | 4 | 5;
export type EgressPolicy = NonNullable<EffectRisk['egress_policy']>;
export type NormalizedEgressPolicy = Readonly<{
  mode: 'disabled' | 'allowlist' | 'denylist' | 'open';
  domain_rules: readonly Readonly<{ action: 'allow' | 'deny'; host: string }>[];
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
  readonly reason_code:
    | 'allowed'
    | 'default_deny'
    | 'explicit_deny'
    | 'tool_not_allowed'
    | 'resource_not_allowed'
    | 'risk_tier_exceeded'
    | 'missing_egress_policy'
    | 'egress_disabled';
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
  readonly reason_code:
    | 'egress_allowed'
    | 'invalid_destination'
    | 'host_not_allowed'
    | 'private_or_local_address'
    | 'dns_resolution_failed'
    | 'dns_rebinding'
    | 'unix_socket_denied'
    | 'socks5_denied';
  readonly canonical_host?: string;
  readonly resolved_addresses?: readonly string[];
}

export class PolicyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyConfigurationError';
  }
}

export class PolicyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyInputError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value;
  if (Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requireNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PolicyConfigurationError(`${label} must be a non-empty string`);
  }
}

function validateUniqueStrings(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PolicyConfigurationError(`${label} must be a non-empty array`);
  }
  for (const entry of value) requireNonEmpty(entry, `${label} entry`);
  if (new Set(value).size !== value.length) {
    throw new PolicyConfigurationError(`${label} must not contain duplicates`);
  }
}

function isTier(value: unknown): value is DerivedRiskTier {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 5;
}

function validatePolicy(policy: Policy): void {
  if (!isRecord(policy)) throw new PolicyConfigurationError('policy must be an object');
  requireNonEmpty(policy.version, 'policy.version');
  if (policy.default_decision !== 'deny') {
    throw new PolicyConfigurationError('policy must enforce deny-by-default');
  }
  validateUniqueStrings(policy.allowed_tools, 'policy.allowed_tools');
  validateUniqueStrings(policy.allowed_resource_prefixes, 'policy.allowed_resource_prefixes');
  if (!Array.isArray(policy.rules)) throw new PolicyConfigurationError('policy.rules must be an array');
  if (policy.minimum_risk_tier !== undefined && !isTier(policy.minimum_risk_tier)) {
    throw new PolicyConfigurationError('policy.minimum_risk_tier must be between 0 and 5');
  }
  const identifiers = new Set<string>();
  for (const rule of policy.rules) {
    if (!isRecord(rule)) throw new PolicyConfigurationError('policy rule must be an object');
    requireNonEmpty(rule.id, 'policy rule id');
    if (identifiers.has(rule.id)) throw new PolicyConfigurationError('policy rule ids must be unique');
    identifiers.add(rule.id);
    if (!Number.isSafeInteger(rule.priority)) {
      throw new PolicyConfigurationError('policy rule priority must be a safe integer');
    }
    if (rule.effect !== 'allow' && rule.effect !== 'deny') {
      throw new PolicyConfigurationError('policy rule effect must be allow or deny');
    }
    validateUniqueStrings(rule.tools, 'policy rule tools');
    validateUniqueStrings(rule.resource_prefixes, 'policy rule resource_prefixes');
    if (rule.maximum_risk_tier !== undefined && !isTier(rule.maximum_risk_tier)) {
      throw new PolicyConfigurationError('policy rule maximum_risk_tier must be between 0 and 5');
    }
    if (rule.egress_policy !== undefined) normalizeEgress(rule.egress_policy);
  }
  if (policy.egress_policy !== undefined) normalizeEgress(policy.egress_policy);
}

function validateContext(context: PolicyContext): void {
  if (!isRecord(context)) throw new PolicyInputError('context must be an object');
  if (!['setup', 'agent'].includes(context.run_phase)) throw new PolicyInputError('invalid run phase');
  if (!['trusted', 'untrusted', 'quarantined'].includes(context.trust_level)) {
    throw new PolicyInputError('invalid trust level');
  }
  if (!isStrictDateTime(context.now)) throw new PolicyInputError('context.now must be an ISO date-time');
  if (context.tenant_id.length === 0 || context.user_id.length === 0) {
    throw new PolicyInputError('context identity is required');
  }
}

export function isStrictDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/u.test(value);
  if (!match) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const canonicalInput = value.includes('.') ? value : value.replace(/Z$/u, '.000Z');
  return new Date(timestamp).toISOString() === canonicalInput;
}

function parseFinancialImpact(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new PolicyInputError('financial impact must be a non-negative decimal integer string');
  }
  return BigInt(value);
}

function validateEffectRisk(risk: EffectRisk): void {
  if (!isRecord(risk)) throw new PolicyInputError('EffectRisk must be an object');
  const knownKeys = new Set([
    'locality',
    'operation',
    'reversibility',
    'data_egress',
    'network_access',
    'egress_policy',
    'screen_access',
    'credential_access',
    'blast_radius',
    'financial_impact_usd_micros',
    'human_impact',
    'external_visibility',
    'regulatory_sensitivity',
  ]);
  if (Object.keys(risk).some((key) => !knownKeys.has(key))) {
    throw new PolicyInputError('EffectRisk contains an unknown field');
  }
  const enumChecks: Array<[unknown, readonly string[], string]> = [
    [risk.locality, ['local', 'remote', 'external'], 'locality'],
    [risk.operation, ['read', 'create', 'write', 'delete', 'execute', 'publish', 'communicate', 'purchase'], 'operation'],
    [risk.reversibility, ['guaranteed', 'best_effort', 'none'], 'reversibility'],
    [risk.data_egress, ['none', 'metadata', 'content', 'sensitive'], 'data_egress'],
    [risk.blast_radius, ['single_resource', 'bounded_set', 'workspace', 'organization', 'public', 'unbounded'], 'blast_radius'],
    [risk.human_impact, ['none', 'self', 'internal_people', 'external_people', 'public'], 'human_impact'],
    [risk.external_visibility, ['private', 'shared', 'public'], 'external_visibility'],
  ];
  for (const [value, allowed, label] of enumChecks) {
    if (typeof value !== 'string' || !allowed.includes(value)) {
      throw new PolicyInputError(`EffectRisk.${label} is invalid`);
    }
  }
  if (typeof risk.network_access !== 'boolean' || typeof risk.credential_access !== 'boolean') {
    throw new PolicyInputError('EffectRisk access flags must be boolean');
  }
  if (
    !Array.isArray(risk.regulatory_sensitivity) ||
    risk.regulatory_sensitivity.some((entry) => typeof entry !== 'string')
  ) {
    throw new PolicyInputError('EffectRisk.regulatory_sensitivity must be a string array');
  }
  if (risk.egress_policy !== undefined) normalizeEgress(risk.egress_policy);
  if (risk.screen_access !== undefined) {
    if (!isRecord(risk.screen_access)) {
      throw new PolicyInputError('EffectRisk.screen_access must be an object');
    }
    const screenKeys = new Set(['surface', 'input_modes', 'app_scope']);
    if (Object.keys(risk.screen_access).some((key) => !screenKeys.has(key))) {
      throw new PolicyInputError('EffectRisk.screen_access contains an unknown field');
    }
    if (
      risk.screen_access.surface !== undefined &&
      !['none', 'browser', 'native_app', 'desktop', 'fullscreen'].includes(risk.screen_access.surface)
    ) {
      throw new PolicyInputError('EffectRisk.screen_access.surface is invalid');
    }
    if (
      risk.screen_access.input_modes !== undefined &&
      (!Array.isArray(risk.screen_access.input_modes) ||
        risk.screen_access.input_modes.some(
          (mode) => !['screenshot', 'click', 'type', 'key', 'clipboard'].includes(mode),
        ))
    ) {
      throw new PolicyInputError('EffectRisk.screen_access.input_modes is invalid');
    }
    if (
      risk.screen_access.app_scope !== undefined &&
      !['per_app_approved', 'workspace', 'system'].includes(risk.screen_access.app_scope)
    ) {
      throw new PolicyInputError('EffectRisk.screen_access.app_scope is invalid');
    }
  }
}

export function deriveRiskTier(
  risk: EffectRisk,
  policy: Policy,
  context: PolicyContext,
): DerivedRiskTier {
  validateContext(context);
  validateEffectRisk(risk);
  const financialImpact = parseFinancialImpact(risk.financial_impact_usd_micros);
  let score = 0;

  if (risk.locality === 'remote') score += 1;
  if (risk.locality === 'external') score += 2;

  if (risk.operation === 'create') score += 1;
  if (risk.operation === 'write' || risk.operation === 'execute') score += 2;
  if (risk.operation === 'delete' || risk.operation === 'purchase') score += 3;
  if (risk.operation === 'publish' || risk.operation === 'communicate') score += 2;

  if (risk.reversibility === 'best_effort') score += 1;
  if (risk.reversibility === 'none') score += 2;

  if (risk.data_egress === 'metadata') score += 1;
  if (risk.data_egress === 'content') score += 2;
  if (risk.data_egress === 'sensitive') score += 3;
  if (risk.network_access) score += 1;
  if (risk.credential_access) score += 2;

  if (risk.blast_radius === 'bounded_set') score += 1;
  if (risk.blast_radius === 'workspace') score += 2;
  if (risk.blast_radius === 'organization' || risk.blast_radius === 'public') score += 3;
  if (risk.blast_radius === 'unbounded') score += 4;

  if (financialImpact >= 1_000_000n) score += 3;
  else if (financialImpact >= 10_000n) score += 1;

  if (risk.human_impact === 'self') score += 1;
  if (risk.human_impact === 'internal_people') score += 2;
  if (risk.human_impact === 'external_people' || risk.human_impact === 'public') score += 3;
  if (risk.external_visibility === 'shared') score += 1;
  if (risk.external_visibility === 'public') score += 2;

  if (risk.regulatory_sensitivity.length > 0) score += 1;
  if (risk.regulatory_sensitivity.some((entry) => /health|children/iu.test(entry))) score += 2;

  if (risk.screen_access?.surface === 'browser') score += 1;
  if (risk.screen_access?.surface === 'native_app') score += 2;
  if (risk.screen_access?.surface === 'desktop' || risk.screen_access?.surface === 'fullscreen') score += 3;
  if (risk.screen_access?.input_modes?.some((mode) => ['click', 'type', 'key'].includes(mode))) score += 1;
  if (risk.screen_access?.input_modes?.includes('clipboard')) score += 1;
  if (risk.screen_access?.app_scope === 'workspace') score += 1;
  if (risk.screen_access?.app_scope === 'system') score += 2;

  if (context.trust_level === 'untrusted') score += 1;
  if (context.trust_level === 'quarantined') score += 3;
  score = Math.max(score, policy.minimum_risk_tier ?? 0);
  return Math.min(5, score) as DerivedRiskTier;
}

function normalizeHost(host: string, allowWildcard: boolean): string {
  if (typeof host !== 'string') throw new PolicyInputError('host must be a string');
  let candidate = host.trim().replace(/\.+$/u, '').toLowerCase();
  if (candidate.length === 0) throw new PolicyInputError('host must not be empty');
  if (candidate === '*') {
    if (!allowWildcard) throw new PolicyInputError('wildcard is not a destination');
    return candidate;
  }
  let wildcard = false;
  if (candidate.startsWith('*.')) {
    if (!allowWildcard) throw new PolicyInputError('wildcard is not a destination');
    wildcard = true;
    candidate = candidate.slice(2);
  } else if (candidate.includes('*')) {
    throw new PolicyInputError('invalid wildcard host pattern');
  }
  const bracketless = candidate.startsWith('[') && candidate.endsWith(']') ? candidate.slice(1, -1) : candidate;
  const ipVersion = isIP(bracketless);
  const ascii = ipVersion === 6
    ? new URL(`http://[${bracketless}]/`).hostname.slice(1, -1)
    : ipVersion === 4
      ? bracketless
      : domainToASCII(bracketless);
  if (ascii.length === 0 || /[\s/@]/u.test(ascii)) throw new PolicyInputError('invalid host');
  return wildcard ? `*.${ascii}` : ascii;
}

export function hostMatches(host: string, pattern: string): boolean {
  const normalizedHost = normalizeHost(host, false);
  const normalizedPattern = normalizeHost(pattern, true);
  if (normalizedPattern === '*') return true;
  if (normalizedPattern.startsWith('*.')) {
    return normalizedHost.endsWith(`.${normalizedPattern.slice(2)}`);
  }
  return normalizedHost === normalizedPattern;
}

function normalizeEgress(policy: EgressPolicy | NormalizedEgressPolicy): NormalizedEgressPolicy {
  if (!isRecord(policy)) throw new PolicyConfigurationError('egress policy must be an object');
  const knownKeys = new Set(['mode', 'domain_rules', 'unix_sockets', 'allow_local_binding', 'socks5']);
  if (Object.keys(policy).some((key) => !knownKeys.has(key))) {
    throw new PolicyConfigurationError('egress policy contains an unknown field');
  }
  const mode = policy.mode ?? 'disabled';
  if (!['disabled', 'allowlist', 'denylist', 'open'].includes(mode)) {
    throw new PolicyConfigurationError('invalid egress mode');
  }
  const domainRules = policy.domain_rules ?? [];
  if (!Array.isArray(domainRules)) throw new PolicyConfigurationError('egress domain_rules must be an array');
  if (policy.unix_sockets !== undefined && !['denied', 'allowlist'].includes(policy.unix_sockets)) {
    throw new PolicyConfigurationError('invalid egress unix_sockets setting');
  }
  if (policy.allow_local_binding !== undefined && typeof policy.allow_local_binding !== 'boolean') {
    throw new PolicyConfigurationError('invalid egress allow_local_binding setting');
  }
  if (policy.socks5 !== undefined && typeof policy.socks5 !== 'boolean') {
    throw new PolicyConfigurationError('invalid egress socks5 setting');
  }
  const normalizedRules = domainRules.map((rule) => {
    if (
      !isRecord(rule) ||
      Object.keys(rule).some((key) => key !== 'action' && key !== 'host') ||
      (rule.action !== 'allow' && rule.action !== 'deny') ||
      typeof rule.host !== 'string'
    ) {
      throw new PolicyConfigurationError('invalid egress domain rule');
    }
    try {
      return {
        action: rule.action as 'allow' | 'deny',
        host: normalizeHost(rule.host, true),
      };
    } catch (error) {
      throw new PolicyConfigurationError(
        error instanceof Error ? `invalid egress host: ${error.message}` : 'invalid egress host',
      );
    }
  });
  normalizedRules.sort((left, right) =>
    `${left.action}:${left.host}`.localeCompare(`${right.action}:${right.host}`, 'en'),
  );
  const uniqueRules = normalizedRules.filter(
    (rule, index) => index === 0 || `${rule.action}:${rule.host}` !== `${normalizedRules[index - 1]!.action}:${normalizedRules[index - 1]!.host}`,
  );
  return deepFreeze({
    mode,
    domain_rules: uniqueRules,
    unix_sockets: policy.unix_sockets ?? 'denied',
    allow_local_binding: policy.allow_local_binding ?? false,
    socks5: policy.socks5 ?? false,
  });
}

function patternIntersection(left: string, right: string): string | undefined {
  if (left === '*') return right;
  if (right === '*') return left;
  if (left === right) return left;
  if (left.startsWith('*.') && right.startsWith('*.')) {
    const leftSuffix = left.slice(2);
    const rightSuffix = right.slice(2);
    if (leftSuffix.endsWith(`.${rightSuffix}`)) return left;
    if (rightSuffix.endsWith(`.${leftSuffix}`)) return right;
    return undefined;
  }
  if (left.startsWith('*.') && hostMatches(right, left)) return right;
  if (right.startsWith('*.') && hostMatches(left, right)) return left;
  return undefined;
}

export function resolveEgress(
  first?: EgressPolicy | NormalizedEgressPolicy,
  second?: EgressPolicy | NormalizedEgressPolicy,
): NormalizedEgressPolicy | undefined {
  if (first === undefined && second === undefined) return undefined;
  if (first === undefined) return normalizeEgress(second!);
  if (second === undefined) return normalizeEgress(first);
  const left = normalizeEgress(first);
  const right = normalizeEgress(second);
  if (left.mode === 'disabled' || right.mode === 'disabled') return normalizeEgress({ mode: 'disabled' });

  const denyRules = [...left.domain_rules, ...right.domain_rules].filter((rule) => rule.action === 'deny');
  const leftAllows = left.domain_rules.filter((rule) => rule.action === 'allow').map((rule) => rule.host);
  const rightAllows = right.domain_rules.filter((rule) => rule.action === 'allow').map((rule) => rule.host);
  let allowHosts: string[] = [];
  if (left.mode === 'allowlist' && right.mode === 'allowlist') {
    allowHosts = leftAllows.flatMap((leftHost) =>
      rightAllows.map((rightHost) => patternIntersection(leftHost, rightHost)).filter((entry): entry is string => entry !== undefined),
    );
  } else if (left.mode === 'allowlist') {
    allowHosts = leftAllows;
  } else if (right.mode === 'allowlist') {
    allowHosts = rightAllows;
  }
  const mode = left.mode === 'allowlist' || right.mode === 'allowlist'
    ? 'allowlist'
    : left.mode === 'denylist' || right.mode === 'denylist'
      ? 'denylist'
      : 'open';
  return normalizeEgress({
    mode,
    domain_rules: [
      ...denyRules,
      ...allowHosts.map((host) => ({ action: 'allow' as const, host })),
    ],
    unix_sockets: left.unix_sockets === 'allowlist' && right.unix_sockets === 'allowlist' ? 'allowlist' : 'denied',
    allow_local_binding: left.allow_local_binding && right.allow_local_binding,
    socks5: left.socks5 && right.socks5,
  });
}

export function isHostAllowed(host: string, policy: EgressPolicy | NormalizedEgressPolicy): boolean {
  const normalized = normalizeEgress(policy);
  if (normalized.mode === 'disabled') return false;
  if (normalized.domain_rules.some((rule) => rule.action === 'deny' && hostMatches(host, rule.host))) return false;
  if (normalized.mode === 'open' || normalized.mode === 'denylist') return true;
  return normalized.domain_rules.some((rule) => rule.action === 'allow' && hostMatches(host, rule.host));
}

function isPrivateOrLocalAddress(address: string): boolean {
  const normalized = normalizeHost(address, false).toLowerCase();
  const version = isIP(normalized);
  if (version === 4) {
    const octets = normalized.split('.').map(Number);
    const [a, b] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b !== undefined && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (version === 6) {
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(normalized);
    if (mapped) {
      const high = Number.parseInt(mapped[1]!, 16);
      const low = Number.parseInt(mapped[2]!, 16);
      return isPrivateOrLocalAddress(
        `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`,
      );
    }
    return normalized === '::' || normalized === '::1' || /^f[cd]/u.test(normalized) || /^fe[89ab]/u.test(normalized);
  }
  throw new PolicyInputError('DNS resolver returned a non-IP address');
}

export async function validateEgressTarget(input: {
  destination: string;
  policy: EgressPolicy | NormalizedEgressPolicy;
  resolve_host: (host: string) => Promise<string[]>;
  pinned_addresses?: string[];
  redirect_from?: string;
}): Promise<EgressDecision> {
  const normalizedPolicy = normalizeEgress(input.policy);
  const lowerDestination = input.destination.trim().toLowerCase();
  if (lowerDestination.startsWith('unix:') || lowerDestination.startsWith('http+unix:')) {
    return deepFreeze({ allowed: false, reason_code: 'unix_socket_denied' });
  }
  if (lowerDestination.startsWith('socks5:') && !normalizedPolicy.socks5) {
    return deepFreeze({ allowed: false, reason_code: 'socks5_denied' });
  }
  let parsed: URL;
  try {
    parsed = new URL(input.destination);
  } catch {
    return deepFreeze({ allowed: false, reason_code: 'invalid_destination' });
  }
  if (!['https:', 'http:', 'socks5:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    return deepFreeze({ allowed: false, reason_code: 'invalid_destination' });
  }
  let canonicalHost: string;
  try {
    canonicalHost = normalizeHost(parsed.hostname, false);
  } catch {
    return deepFreeze({ allowed: false, reason_code: 'invalid_destination' });
  }
  if (!isHostAllowed(canonicalHost, normalizedPolicy)) {
    return deepFreeze({ allowed: false, reason_code: 'host_not_allowed' });
  }

  let resolved: string[];
  if (isIP(canonicalHost)) {
    resolved = [canonicalHost];
  } else {
    try {
      resolved = await input.resolve_host(canonicalHost);
    } catch {
      return deepFreeze({ allowed: false, reason_code: 'dns_resolution_failed' });
    }
  }
  if (!Array.isArray(resolved) || resolved.length === 0) {
    return deepFreeze({ allowed: false, reason_code: 'dns_resolution_failed' });
  }
  let normalizedAddresses: string[];
  try {
    normalizedAddresses = [...new Set(resolved.map((address) => normalizeHost(address, false)))].sort();
    if (!normalizedPolicy.allow_local_binding && normalizedAddresses.some(isPrivateOrLocalAddress)) {
      return deepFreeze({ allowed: false, reason_code: 'private_or_local_address' });
    }
  } catch {
    return deepFreeze({ allowed: false, reason_code: 'dns_resolution_failed' });
  }
  if (input.pinned_addresses !== undefined) {
    let pinned: string[];
    try {
      pinned = [...new Set(input.pinned_addresses.map((address) => normalizeHost(address, false)))].sort();
    } catch {
      return deepFreeze({ allowed: false, reason_code: 'dns_rebinding' });
    }
    if (JSON.stringify(pinned) !== JSON.stringify(normalizedAddresses)) {
      return deepFreeze({ allowed: false, reason_code: 'dns_rebinding' });
    }
  }
  return deepFreeze({
    allowed: true,
    reason_code: 'egress_allowed',
    canonical_host: canonicalHost,
    resolved_addresses: normalizedAddresses,
  });
}

function resourceAllowed(resourceIds: string[], prefixes: readonly string[]): boolean {
  return resourceIds.length > 0 && resourceIds.every((resource) =>
    prefixes.some((prefix) =>
      resource === prefix ||
      (prefix.endsWith('/') && resource.startsWith(prefix)) ||
      resource.startsWith(`${prefix}/`),
    ),
  );
}

function ruleMatches(rule: Readonly<PolicyRule>, request: PolicyEvaluationRequest): boolean {
  const toolMatches = rule.tools.includes('*') || rule.tools.includes(request.tool_name);
  return toolMatches && resourceAllowed(request.resource_ids, rule.resource_prefixes);
}

export interface AuditLogEntry {
  readonly timestamp: string;
  readonly tool_name: string;
  readonly resource_ids: readonly string[];
  readonly verdict: 'allow' | 'deny';
  readonly reason_code: string;
  readonly derived_risk_tier: number;
  readonly tenant_id: string;
  readonly user_id: string;
  readonly decided_at: string;
  readonly decision_hash: string;
}

export class PolicyEngine {
  readonly snapshot: Readonly<Policy>;
  readonly version: string;
  readonly policy_hash: string;
  private readonly auditLog: AuditLogEntry[] = [];

  constructor(policy: Policy) {
    validatePolicy(policy);
    const snapshot = clone(policy);
    snapshot.allowed_tools.sort();
    snapshot.allowed_resource_prefixes.sort();
    snapshot.rules.sort((left, right) =>
      right.priority - left.priority || left.id.localeCompare(right.id, 'en'),
    );
    this.snapshot = deepFreeze(snapshot);
    this.version = snapshot.version;
    this.policy_hash = hashValue(snapshot);
  }

  evaluate(request: PolicyEvaluationRequest): PolicyDecision {
    if (!isRecord(request) || typeof request.tool_name !== 'string' || request.tool_name.length === 0) {
      throw new PolicyInputError('invalid policy evaluation request');
    }
    if (!Array.isArray(request.resource_ids) || request.resource_ids.some((entry) => typeof entry !== 'string')) {
      throw new PolicyInputError('invalid resource ids');
    }
    const tier = deriveRiskTier(request.risk, this.snapshot as Policy, request.context);
    if (!this.snapshot.allowed_tools.includes(request.tool_name)) {
      return this.decision(false, 'tool_not_allowed', tier, request, null);
    }
    if (!resourceAllowed(request.resource_ids, this.snapshot.allowed_resource_prefixes)) {
      return this.decision(false, 'resource_not_allowed', tier, request, null);
    }
    const matching = this.snapshot.rules.filter((rule) => ruleMatches(rule, request));
    const denied = matching.find((rule) => rule.effect === 'deny');
    if (denied) return this.decision(false, 'explicit_deny', tier, request, denied);
    const allowed = matching.find((rule) => rule.effect === 'allow');
    if (!allowed) return this.decision(false, 'default_deny', tier, request, null);
    if (allowed.maximum_risk_tier !== undefined && tier > allowed.maximum_risk_tier) {
      return this.decision(false, 'risk_tier_exceeded', tier, request, allowed);
    }

    const authorityEgress = resolveEgress(this.snapshot.egress_policy, allowed.egress_policy);
    const effectiveEgress = resolveEgress(request.risk.egress_policy, authorityEgress);
    if (request.risk.network_access && request.risk.egress_policy === undefined) {
      return this.decision(false, 'missing_egress_policy', tier, request, allowed);
    }
    if (request.risk.network_access && effectiveEgress?.mode === 'disabled') {
      return this.decision(false, 'egress_disabled', tier, request, allowed, effectiveEgress);
    }
    return this.decision(true, 'allowed', tier, request, allowed, effectiveEgress);
  }

  private decision(
    allowed: boolean,
    reasonCode: PolicyDecision['reason_code'],
    tier: DerivedRiskTier,
    request: PolicyEvaluationRequest,
    rule: Readonly<PolicyRule> | null,
    egressPolicy?: NormalizedEgressPolicy,
  ): PolicyDecision {
    const semanticDecision = {
      allowed,
      reason_code: reasonCode,
      derived_risk_tier: tier,
      policy_version: this.version,
      policy_hash: this.policy_hash,
      matched_rule_id: rule?.id ?? null,
      ...(egressPolicy === undefined ? {} : { egress_policy: egressPolicy }),
    };
    const result = deepFreeze({
      ...semanticDecision,
      decided_at: request.context.now,
      decision_hash: hashValue(semanticDecision),
    });
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      tool_name: request.tool_name,
      resource_ids: [...request.resource_ids],
      verdict: allowed ? 'allow' : 'deny',
      reason_code: reasonCode,
      derived_risk_tier: tier,
      tenant_id: request.context.tenant_id,
      user_id: request.context.user_id,
      decided_at: request.context.now,
      decision_hash: result.decision_hash,
    });
    return result;
  }

  getAuditLog(): readonly AuditLogEntry[] {
    return [...this.auditLog];
  }
}
