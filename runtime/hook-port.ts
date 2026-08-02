export const RUNTIME_HOOK_EVENTS = Object.freeze([
  'user_prompt_submit',
  'session_start',
  'before_provider_request',
  'pre_turn',
  'pre_tool_use',
  'post_tool_use',
  'after_response',
  'post_turn',
  'session_before_compact',
  'stop',
  'session_end',
] as const);

export type RuntimeHookEvent = (typeof RUNTIME_HOOK_EVENTS)[number];

export interface RuntimeHookScope {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly session_id: string;
  readonly operation_id?: string;
  readonly attempt_id?: string;
}

export interface RuntimeHookRequest {
  readonly event: RuntimeHookEvent;
  readonly invocation_id: string;
  readonly idempotency_key: string;
  readonly scope: RuntimeHookScope;
  readonly payload: unknown;
  readonly signal?: AbortSignal;
}

export interface RuntimeHookOutcome {
  readonly event: RuntimeHookEvent;
  readonly action: 'continue' | 'deny' | 'skip' | 'force_prompt';
  readonly payload: unknown;
  readonly reason_code?: string;
  readonly follow_ups: readonly unknown[];
  readonly replayed: boolean;
}

export interface HookRuntimePort {
  dispatch(request: RuntimeHookRequest): Promise<RuntimeHookOutcome>;
}

export type RuntimeHookTrust = 'hash_reviewed' | 'managed' | 'user';

export interface RuntimeHookHandlerInput {
  readonly hook_id: string;
  readonly event: RuntimeHookEvent;
  readonly trust: RuntimeHookTrust;
  readonly invocation_id: string;
  readonly scope: RuntimeHookScope;
  readonly payload: unknown;
}

export type RuntimeHookHandlerResult =
  | { readonly action: 'continue' }
  | {
      readonly action: 'deny' | 'skip' | 'force_prompt';
      readonly reason_code: string;
    }
  | { readonly action: 'attenuate'; readonly payload: unknown }
  | { readonly action: 'observe'; readonly follow_up?: unknown };

export interface RuntimeExternalHookRegistration {
  readonly id: string;
  readonly event: RuntimeHookEvent;
  readonly trust: 'hash_reviewed' | 'user';
  readonly priority: number;
  readonly timeout_ms: number;
  readonly content_hash?: string;
  readonly execution: {
    readonly executable_path: string;
    readonly argv: readonly string[];
    readonly source_path: string;
  };
}

export interface RuntimeHookExecutionPort {
  execute(
    registration: RuntimeExternalHookRegistration,
    input: RuntimeHookHandlerInput,
    signal: AbortSignal,
  ): Promise<RuntimeHookHandlerResult>;
}

export interface HookBoundaryOptions {
  readonly mode: 'decision' | 'observational';
  readonly timeout_ms?: number;
}

export class HookRestrictionError extends Error {
  constructor(
    readonly event: RuntimeHookEvent,
    readonly action: 'deny' | 'skip' | 'force_prompt',
    readonly reason_code: string,
  ) {
    super(`hook ${event} ${action}: ${reason_code}`);
    this.name = 'HookRestrictionError';
    Object.setPrototypeOf(this, HookRestrictionError.prototype);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new TypeError('hook boundary value must be JSON-serializable');
  return JSON.parse(encoded) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) as string;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameKeys(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return sameJson(Object.keys(left).sort(), Object.keys(right).sort());
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

function subset(
  candidate: readonly string[],
  original: readonly string[],
): boolean {
  const authority = new Set(original);
  return candidate.every((value) => authority.has(value));
}

function superset(
  candidate: readonly string[],
  original: readonly string[],
): boolean {
  return subset(original, candidate);
}

function allowedSetNarrows(original: unknown, candidate: unknown): boolean {
  if (original === undefined) {
    return candidate === undefined || stringArray(candidate) !== undefined;
  }
  const originalValues = stringArray(original);
  const candidateValues = stringArray(candidate);
  return (
    originalValues !== undefined &&
    candidateValues !== undefined &&
    subset(candidateValues, originalValues)
  );
}

function constraintsNarrow(original: unknown, candidate: unknown): boolean {
  const constraintTypes = new Set([
    'budget',
    'time',
    'risk_ceiling',
    'privacy',
    'tool_restriction',
    'model_restriction',
  ]);
  if (!Array.isArray(original) || !Array.isArray(candidate)) return false;
  if (
    ![...original, ...candidate].every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.type === 'string' &&
        constraintTypes.has(entry.type) &&
        typeof entry.value === 'string',
    )
  ) {
    return false;
  }
  return original.every((originalEntry) => {
    const originalConstraint = originalEntry as {
      type: string;
      value: string;
    };
    return candidate.some((candidateEntry) => {
      const candidateConstraint = candidateEntry as {
        type: string;
        value: string;
      };
      if (candidateConstraint.type !== originalConstraint.type) return false;
      if (candidateConstraint.value === originalConstraint.value) return true;
      if (
        !['budget', 'time', 'risk_ceiling'].includes(originalConstraint.type)
      ) {
        return false;
      }
      const originalNumber = Number(originalConstraint.value);
      const candidateNumber = Number(candidateConstraint.value);
      return (
        Number.isFinite(originalNumber) &&
        Number.isFinite(candidateNumber) &&
        candidateNumber >= 0 &&
        candidateNumber <= originalNumber
      );
    });
  });
}

function taskContractNarrows(original: unknown, candidate: unknown): boolean {
  if (!isRecord(original) || !isRecord(candidate)) return false;
  if (!sameKeys(original, candidate)) return false;
  const { constraints: originalConstraints, ...originalFixedFields } = original;
  const { constraints: candidateConstraints, ...candidateFixedFields } =
    candidate;
  if (!sameJson(originalFixedFields, candidateFixedFields)) return false;
  return constraintsNarrow(originalConstraints, candidateConstraints);
}

function providerRequestNarrows(
  original: unknown,
  candidate: unknown,
): boolean {
  if (!isRecord(original) || !isRecord(candidate)) return false;
  if (!sameKeys(original, candidate)) return false;
  if (
    !sameJson(
      original.registry_snapshot_hash,
      candidate.registry_snapshot_hash,
    ) ||
    !sameJson(original.estimated_input_tokens, candidate.estimated_input_tokens)
  ) {
    return false;
  }
  const originalCapabilities = stringArray(original.required_capabilities);
  const candidateCapabilities = stringArray(candidate.required_capabilities);
  if (
    !originalCapabilities ||
    !candidateCapabilities ||
    !superset(candidateCapabilities, originalCapabilities)
  ) {
    return false;
  }
  if (
    typeof original.requires_structured_output !== 'boolean' ||
    typeof candidate.requires_structured_output !== 'boolean' ||
    (original.requires_structured_output &&
      !candidate.requires_structured_output)
  ) {
    return false;
  }

  const originalRequest = original.request;
  const candidateRequest = candidate.request;
  if (!isRecord(originalRequest) || !isRecord(candidateRequest)) return false;
  if (!sameKeys(originalRequest, candidateRequest)) return false;
  const {
    tools: originalTools,
    max_tokens: originalMaxTokens,
    ...originalRequestRest
  } = originalRequest;
  const {
    tools: candidateTools,
    max_tokens: candidateMaxTokens,
    ...candidateRequestRest
  } = candidateRequest;
  if (!sameJson(originalRequestRest, candidateRequestRest)) return false;
  if (
    originalMaxTokens === undefined
      ? candidateMaxTokens !== undefined
      : typeof originalMaxTokens !== 'number' ||
        typeof candidateMaxTokens !== 'number' ||
        !Number.isSafeInteger(originalMaxTokens) ||
        !Number.isSafeInteger(candidateMaxTokens) ||
        candidateMaxTokens < 0 ||
        candidateMaxTokens > originalMaxTokens
  ) {
    return false;
  }
  if (!Array.isArray(originalTools) || !Array.isArray(candidateTools))
    return false;
  const originalToolSet = new Set(originalTools.map(canonicalJson));
  if (
    !candidateTools.every((tool) => originalToolSet.has(canonicalJson(tool)))
  ) {
    return false;
  }

  const originalData = original.data_policy;
  const candidateData = candidate.data_policy;
  if (!isRecord(originalData) || !isRecord(candidateData)) return false;
  if (!sameKeys(originalData, candidateData)) return false;
  const originalRegions = stringArray(originalData.allowed_regions);
  const candidateRegions = stringArray(candidateData.allowed_regions);
  const {
    local_only: _originalLocalOnly,
    allowed_regions: _originalAllowedRegions,
    max_retention_days: _originalMaxRetention,
    training_allowed: _originalTraining,
    ...originalDataRest
  } = originalData;
  const {
    local_only: _candidateLocalOnly,
    allowed_regions: _candidateAllowedRegions,
    max_retention_days: _candidateMaxRetention,
    training_allowed: _candidateTraining,
    ...candidateDataRest
  } = candidateData;
  if (
    typeof originalData.local_only !== 'boolean' ||
    typeof candidateData.local_only !== 'boolean' ||
    (originalData.local_only && !candidateData.local_only) ||
    !originalRegions ||
    !candidateRegions ||
    !subset(candidateRegions, originalRegions) ||
    typeof originalData.max_retention_days !== 'number' ||
    typeof candidateData.max_retention_days !== 'number' ||
    candidateData.max_retention_days < 0 ||
    candidateData.max_retention_days > originalData.max_retention_days ||
    typeof originalData.training_allowed !== 'boolean' ||
    typeof candidateData.training_allowed !== 'boolean' ||
    (!originalData.training_allowed && candidateData.training_allowed) ||
    !sameJson(originalDataRest, candidateDataRest)
  ) {
    return false;
  }

  const originalPolicy = original.policy;
  const candidatePolicy = candidate.policy;
  const originalPlan = original.run_plan;
  const candidatePlan = candidate.run_plan;
  if (
    !isRecord(originalPolicy) ||
    !isRecord(candidatePolicy) ||
    !isRecord(originalPlan) ||
    !isRecord(candidatePlan)
  ) {
    return false;
  }
  if (
    !sameKeys(originalPolicy, candidatePolicy) ||
    !sameKeys(originalPlan, candidatePlan)
  ) {
    return false;
  }
  const originalDenied = stringArray(originalPolicy.denied_provider_ids);
  const candidateDenied = stringArray(candidatePolicy.denied_provider_ids);
  const originalPlanCapabilities = stringArray(
    originalPlan.required_capabilities,
  );
  const candidatePlanCapabilities = stringArray(
    candidatePlan.required_capabilities,
  );
  const {
    allowed_provider_ids: _originalPolicyAllowed,
    denied_provider_ids: _originalPolicyDenied,
    ...originalPolicyRest
  } = originalPolicy;
  const {
    allowed_provider_ids: _candidatePolicyAllowed,
    denied_provider_ids: _candidatePolicyDenied,
    ...candidatePolicyRest
  } = candidatePolicy;
  const {
    allowed_provider_ids: _originalPlanAllowed,
    required_capabilities: _originalPlanCapabilities,
    ...originalPlanRest
  } = originalPlan;
  const {
    allowed_provider_ids: _candidatePlanAllowed,
    required_capabilities: _candidatePlanCapabilities,
    ...candidatePlanRest
  } = candidatePlan;
  return (
    allowedSetNarrows(
      originalPolicy.allowed_provider_ids,
      candidatePolicy.allowed_provider_ids,
    ) &&
    originalDenied !== undefined &&
    candidateDenied !== undefined &&
    superset(candidateDenied, originalDenied) &&
    sameJson(originalPolicyRest, candidatePolicyRest) &&
    allowedSetNarrows(
      originalPlan.allowed_provider_ids,
      candidatePlan.allowed_provider_ids,
    ) &&
    originalPlanCapabilities !== undefined &&
    candidatePlanCapabilities !== undefined &&
    superset(candidatePlanCapabilities, originalPlanCapabilities) &&
    sameJson(originalPlanRest, candidatePlanRest)
  );
}

/**
 * Trusted monotonic authority used by the Harness composition root.
 * Tool arguments remain candidates only; Harness re-runs Schema, Policy,
 * Capability and PEP after this policy permits the candidate.
 */
export function createHarnessHookAttenuationPolicy() {
  return Object.freeze({
    validate(input: {
      readonly event: RuntimeHookEvent;
      readonly scope: RuntimeHookScope;
      readonly original_payload: unknown;
      readonly candidate_payload: unknown;
    }) {
      const allowed =
        input.event === 'pre_tool_use'
          ? true
          : input.event === 'user_prompt_submit'
            ? taskContractNarrows(
                input.original_payload,
                input.candidate_payload,
              )
            : input.event === 'before_provider_request'
              ? providerRequestNarrows(
                  input.original_payload,
                  input.candidate_payload,
                )
              : input.event === 'pre_turn' ||
                  input.event === 'session_before_compact'
                ? sameJson(input.original_payload, input.candidate_payload)
                : false;
      return allowed
        ? ({ allowed: true } as const)
        : ({
            allowed: false,
            reason_code: 'hook_attenuation_would_expand_authority',
          } as const);
    },
  });
}

function outcome(
  request: RuntimeHookRequest,
  action: RuntimeHookOutcome['action'],
  payload: unknown,
  reasonCode?: string,
): RuntimeHookOutcome {
  return deepFreeze({
    event: request.event,
    action,
    payload: cloneJson(payload),
    ...(reasonCode === undefined ? {} : { reason_code: reasonCode }),
    follow_ups: [],
    replayed: false,
  });
}

function exactResult(
  value: Record<string, unknown>,
): value is Record<string, unknown> & RuntimeHookOutcome {
  const allowed = new Set([
    'event',
    'action',
    'payload',
    'reason_code',
    'follow_ups',
    'replayed',
  ]);
  return Reflect.ownKeys(value).every(
    (key) => typeof key === 'string' && allowed.has(key),
  );
}

function validPortResult(
  value: unknown,
  request: RuntimeHookRequest,
): value is RuntimeHookOutcome {
  if (!isRecord(value) || !exactResult(value)) return false;
  if (
    value.event !== request.event ||
    !['continue', 'deny', 'skip', 'force_prompt'].includes(
      String(value.action),
    ) ||
    !Object.hasOwn(value, 'payload') ||
    !Array.isArray(value.follow_ups) ||
    typeof value.replayed !== 'boolean'
  ) {
    return false;
  }
  if (
    value.action === 'continue'
      ? value.reason_code !== undefined
      : typeof value.reason_code !== 'string' ||
        value.reason_code.trim().length === 0
  ) {
    return false;
  }
  try {
    cloneJson(value.payload);
    cloneJson(value.follow_ups);
    return true;
  } catch {
    return false;
  }
}

type BoundaryRace =
  | { readonly kind: 'result'; readonly value: unknown }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error' };

export async function dispatchHookBoundary(
  port: HookRuntimePort | undefined,
  request: RuntimeHookRequest,
  options: HookBoundaryOptions,
): Promise<RuntimeHookOutcome> {
  const originalPayload = deepFreeze(cloneJson(request.payload));
  if (!port) return outcome(request, 'continue', originalPayload);
  const timeoutMs = options.timeout_ms ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(
      'hook boundary timeout_ms must be a positive safe integer',
    );
  }
  if (request.signal?.aborted) {
    return outcome(
      request,
      options.mode === 'decision' ? 'deny' : 'continue',
      originalPayload,
      options.mode === 'decision'
        ? 'hook_cancelled'
        : 'hook_observer_cancelled',
    );
  }

  const controller = new AbortController();
  let settle!: (value: BoundaryRace) => void;
  const boundary = new Promise<BoundaryRace>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  const fail = (value: BoundaryRace): void => {
    if (settled) return;
    settled = true;
    settle(value);
    controller.abort(value.kind);
  };
  const timer = setTimeout(() => fail({ kind: 'timeout' }), timeoutMs);
  const cancel = () => fail({ kind: 'cancelled' });
  request.signal?.addEventListener('abort', cancel, { once: true });
  const portRequest = Object.freeze({
    ...request,
    payload: originalPayload,
    signal: controller.signal,
  });
  try {
    const called: Promise<BoundaryRace> = Promise.resolve().then(async () => {
      try {
        const value = await port.dispatch(portRequest);
        return { kind: 'result', value };
      } catch {
        return { kind: 'error' };
      }
    });
    const result = await Promise.race([called, boundary]);
    if (result.kind !== 'result') {
      const suffix =
        result.kind === 'timeout'
          ? 'timeout'
          : result.kind === 'cancelled'
            ? 'cancelled'
            : 'failed';
      return outcome(
        request,
        options.mode === 'decision' ? 'deny' : 'continue',
        originalPayload,
        options.mode === 'decision'
          ? `hook_${suffix}`
          : `hook_observer_${suffix}`,
      );
    }
    if (!validPortResult(result.value, request)) {
      return outcome(
        request,
        options.mode === 'decision' ? 'deny' : 'continue',
        originalPayload,
        options.mode === 'decision'
          ? 'invalid_hook_boundary_result'
          : 'invalid_hook_observation',
      );
    }
    if (options.mode === 'observational') {
      return outcome(request, 'continue', originalPayload);
    }
    if (!sameJson(result.value.payload, originalPayload)) {
      const attenuation = createHarnessHookAttenuationPolicy().validate({
        event: request.event,
        scope: request.scope,
        original_payload: originalPayload,
        candidate_payload: result.value.payload,
      });
      if (!attenuation.allowed) {
        return outcome(
          request,
          'deny',
          originalPayload,
          attenuation.reason_code,
        );
      }
    }
    return deepFreeze(cloneJson(result.value));
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', cancel);
  }
}
