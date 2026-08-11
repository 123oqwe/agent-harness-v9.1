import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { TaskContract } from '../contracts/index.js';
import type {
  ProviderSelectionRequest,
  GatewayDispatchResult,
} from '../gateway/model-gateway.js';
import type {
  Message,
  ProviderTool,
  StreamEvent,
} from '../gateway/scripted-provider.js';
import type { RunPlan, RoutingResult } from '../router/static-router.js';
import type { AuditEntry } from '../security/audit-sink.js';
import type { DurableSession } from '../session/durable-session.js';
import type { SessionEvent } from '../session/durable-session.js';
import type { WorkspaceChange } from '../vfs/workspace-transaction.js';
import type {
  LoopResult,
  ModelCallBudget,
  ModelCallDirective,
  ModelTurn,
} from './loop.js';
import type {
  VerificationReport,
} from '../verification/verification-engine.js';

export interface ExecutionContext {
  tenant_id: string;
  user_id: string;
  session_id: string;
  run_id: string;
  plan_id: string;
  step_id: string;
  attempt_id: string;
  operation_id: string;
  idempotency_key: string;
  policy_snapshot: string;
  tool_snapshot: string;
  budget: { token_limit: number; usd_micros: number };
  risk_level: number;
  confirmation_key_thumbprint: string;
  clock: () => string;
}

export interface RunEvidence {
  run_id: string;
  commit_sha: string;
  plan_hash: string | null;
  plan_revision: number | null;
  reasoning_strategy: string | null;
  registry_snapshot_refs: Readonly<Record<string, string>>;
  termination_reason: string;
  iterations: number;
  turns: number;
  decision_summaries: string[];
  session_events: number;
  usage: LoopResult['usage'];
  step_states: LoopResult['step_states'];
  tool_calls: ReadonlyArray<{
    tool_call_id: string;
    step: string;
    tool: string;
    arguments_hash: string;
  }>;
  tool_receipts: readonly unknown[];
  audit_entries: readonly AuditEntry[];
  verification_records: VerificationReport['records'];
  workspace_changes: readonly WorkspaceChange[];
  session_head_hash: string | null;
}

export function createDefaultExecutionContext(
  runId: string,
  clock?: () => string,
): ExecutionContext {
  const fixedTime = new Date().toISOString();
  return {
    tenant_id: 'default-tenant',
    user_id: 'default-user',
    session_id: runId,
    run_id: runId,
    plan_id: `plan-${runId}`,
    step_id: 'step-001',
    attempt_id: 'attempt-001',
    operation_id: `op-${runId}`,
    idempotency_key: `idem-${runId}`,
    policy_snapshot: 'policy-v1',
    tool_snapshot: 'tool-v1',
    budget: { token_limit: 100_000, usd_micros: 5_000_000 },
    risk_level: 2,
    confirmation_key_thumbprint: 'test-thumbprint',
    clock: clock ?? (() => fixedTime),
  };
}

export function validateExecutionContext(context: ExecutionContext): void {
  for (const [name, value] of [
    ['tenant_id', context.tenant_id],
    ['user_id', context.user_id],
    ['session_id', context.session_id],
    ['run_id', context.run_id],
    ['plan_id', context.plan_id],
    ['step_id', context.step_id],
    ['attempt_id', context.attempt_id],
    ['operation_id', context.operation_id],
    ['idempotency_key', context.idempotency_key],
    ['policy_snapshot', context.policy_snapshot],
    ['tool_snapshot', context.tool_snapshot],
    ['confirmation_key_thumbprint', context.confirmation_key_thumbprint],
  ] as const) {
    if (value.trim().length === 0) {
      throw new Error(`executionContext.${name} is required`);
    }
  }
  for (const [name, value] of [
    ['token_limit', context.budget.token_limit],
    ['usd_micros', context.budget.usd_micros],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `executionContext.budget.${name} must be a non-negative safe integer`,
      );
    }
  }
  if (!Number.isSafeInteger(context.risk_level) || context.risk_level < 0) {
    throw new Error(
      'executionContext.risk_level must be a non-negative safe integer',
    );
  }
  assertTimestamp(context.clock(), 'executionContext.clock');
}

export function assertTimestamp(value: string, source: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${source} returned an invalid timestamp`);
  }
  return value;
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

export function canonicalHash(value: unknown, length?: number): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
  return length === undefined ? digest : digest.slice(0, length);
}

const WORKSPACE_PATH_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  create_artifact: 'path',
  edit_file: 'path',
  execute_command: 'cwd',
  list_directory: 'path',
  parse_document: 'path',
  read_file: 'path',
  search_files: 'root',
  write_file: 'path',
});

/**
 * Model-facing tools accept either `/workspace/...` or a safe workspace-
 * relative path. Canonicalization happens before schema validation, Policy,
 * capability issuance, idempotency hashing, and execution.
 */
export function normalizeWorkspaceToolInput(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const field = WORKSPACE_PATH_FIELDS[toolName];
  if (field === undefined || typeof input[field] !== 'string') {
    return { ...input };
  }
  const value = input[field];
  if (value.startsWith('/') || /^[a-z]:[\\/]/iu.test(value)) {
    return { ...input };
  }
  const segments = value
    .split(/[\\/]+/u)
    .filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    throw new Error('workspace-relative path must not contain ..');
  }
  return {
    ...input,
    [field]:
      segments.length === 0 ? '/workspace' : `/workspace/${segments.join('/')}`,
  };
}

export function terminalFailure(
  strategy: LoopResult['strategy'],
  terminationReason: LoopResult['termination_reason'],
): LoopResult {
  return {
    strategy,
    iterations: 0,
    termination_reason: terminationReason,
    turns: [],
    decision_summaries: [],
    context_reset_emitted: false,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    step_states: Object.freeze({}),
  };
}

export function recordTerminalFailure(
  session: DurableSession,
  strategy: LoopResult['strategy'],
  errorData: Readonly<Record<string, unknown>>,
): LoopResult {
  const failure = terminalFailure(strategy, 'denied');
  session.append('error', errorData);
  session.append('system', {
    event: 'run_terminated',
    termination_reason: 'denied',
    iterations: 0,
    usage: failure.usage,
  });
  session.append('system', {
    event: 'run_finalized',
    termination_reason: 'denied',
    verification_report: null,
    workspace_changes: [],
  });
  session.snapshot_({
    termination_reason: 'denied',
    iterations: 0,
    last_event_seq: session.eventCount(),
  });
  return failure;
}

export function sanitizeMessages(messages: readonly unknown[]): Message[] {
  return messages.map((candidate) => {
    const message = candidate as {
      role: Message['role'];
      content: string;
      reasoning_content?: string;
      tool_call_id?: string;
      tool_calls?: Message['tool_calls'];
    };
    return {
      role: message.role,
      content: message.content,
      ...(message.reasoning_content === undefined
        ? {}
        : { reasoning_content: message.reasoning_content }),
      ...(message.tool_call_id === undefined
        ? {}
        : { tool_call_id: message.tool_call_id }),
      ...(message.tool_calls === undefined
        ? {}
        : { tool_calls: message.tool_calls }),
    };
  });
}

interface ProviderRequestInput {
  task: TaskContract;
  runPlan: RunPlan;
  messages: readonly unknown[];
  modelBudget: ModelCallBudget;
  registrySnapshotHash: string;
  selectedTools: readonly ProviderTool[];
  directive?: ModelCallDirective;
}

export function buildProviderSelectionRequest(
  input: ProviderRequestInput,
): ProviderSelectionRequest {
  const messages = [
    ...(input.directive === undefined
      ? []
      : [
          {
            role: 'system' as const,
            content: input.directive.system_instruction,
          },
        ]),
    ...sanitizeMessages(input.messages),
  ];
  if (
    input.directive?.required_tool !== undefined &&
    !input.selectedTools.some(
      (tool) => tool.name === input.directive!.required_tool,
    )
  ) {
    throw new Error(
      `required model tool is not selected: ${input.directive.required_tool}`,
    );
  }
  const localOnly = input.task.constraints.some(
    (constraint) =>
      constraint.type === 'privacy' && constraint.value === 'local_only',
  );
  const requiredCapabilities =
    input.runPlan.reasoning_strategy === 'direct'
      ? ['text_reasoning']
      : ['text_reasoning', 'tool_calling'];
  const providerId = input.runPlan.model_bindings[0]?.provider;
  if (providerId === undefined) {
    throw new Error('RunPlan must bind a model provider');
  }
  // Check for model_restriction constraints that explicitly limit provider choice
  const modelRestrictions = input.task.constraints
    .filter((c) => c.type === 'model_restriction')
    .map((c) => c.value);
  const allowedProviderIds = modelRestrictions.length > 0 ? modelRestrictions : undefined;
  return {
    registry_snapshot_hash: input.registrySnapshotHash,
    request: {
      messages,
      ...(input.selectedTools.length === 0
        ? {}
        : { tools: input.selectedTools }),
      ...(input.directive?.required_tool !== undefined
        ? {
            tool_choice: {
              type: 'function' as const,
              function: { name: input.directive.required_tool },
            },
          }
        : input.directive?.allowed_tools?.length === 0
          ? { tool_choice: 'none' as const }
          : input.directive === undefined
            ? {}
            : { tool_choice: 'auto' as const }),
      max_tokens: input.modelBudget.max_output_tokens,
    },
    estimated_input_tokens: Math.min(
      messages.reduce((sum, message) => sum + message.content.length, 0),
      100_000,
    ),
    required_capabilities: requiredCapabilities,
    requires_structured_output: false,
    data_policy: {
      local_only: localOnly,
      allowed_regions: localOnly
        ? ['local']
        : ['local', 'cn', 'us', 'eu'],
      max_retention_days: localOnly ? 0 : 365,
      training_allowed: false,
    },
    policy: {
      allowed_provider_ids: allowedProviderIds,
      denied_provider_ids: [],
    },
    run_plan: {
      allowed_provider_ids: allowedProviderIds,
      required_capabilities: requiredCapabilities,
    },
  };
}

export function gatewayResultToModelTurn(result: {
  response: {
    content: string;
    reasoning_content?: string;
    tool_calls?: readonly {
      id: string;
      name: string;
      arguments: Readonly<Record<string, unknown>>;
    }[];
    stop_reason?: ModelTurn['stop_reason'];
  };
  usage: ModelTurn['usage'];
}): ModelTurn {
  return {
    content: result.response.content,
    ...(result.response.reasoning_content === undefined
      ? {}
      : { reasoning_content: result.response.reasoning_content }),
    decision_summary: result.response.content.slice(0, 200),
    ...(result.response.tool_calls === undefined
      ? {}
      : {
          tool_calls: result.response.tool_calls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: { ...call.arguments },
          })),
        }),
    ...(result.response.stop_reason === undefined
      ? {}
      : { stop_reason: result.response.stop_reason }),
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  };
}

export function restoreVerificationReport(
  session: DurableSession,
): VerificationReport | null {
  for (const event of [...session.getEvents()].reverse()) {
    if (
      event.type === 'system' &&
      (event.data as { event?: string }).event === 'run_finalized'
    ) {
      return (
        (event.data as { verification_report?: VerificationReport | null })
          .verification_report ?? null
      );
    }
  }
  return null;
}

export function restoreWorkspaceChanges(
  session: DurableSession,
): readonly WorkspaceChange[] {
  for (const event of [...session.getEvents()].reverse()) {
    if (
      event.type === 'system' &&
      (event.data as { event?: string }).event === 'run_finalized'
    ) {
      const changes = (event.data as {
        workspace_changes?: WorkspaceChange[];
      }).workspace_changes;
      return Object.freeze([...(changes ?? [])]);
    }
  }
  return Object.freeze([]);
}

export function restoreLoopResult(
  session: DurableSession,
  runPlan: RunPlan | undefined,
  termination: LoopResult['termination_reason'],
  iterations: number,
): LoopResult {
  let usage: LoopResult['usage'] = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };
  const stepStates: Record<string, LoopResult['step_states'][string]> = {};
  for (const event of session.getEvents()) {
    if (event.type !== 'system') continue;
    const data = event.data as {
      event?: string;
      step?: string;
      status?: LoopResult['step_states'][string];
      usage?: LoopResult['usage'];
    };
    if (data.event === 'step_state' && data.step && data.status) {
      stepStates[data.step] = data.status;
    }
    if (data.event === 'run_terminated' && data.usage) {
      usage = data.usage;
    }
  }
  return {
    strategy: runPlan?.reasoning_strategy ?? 'direct',
    iterations,
    termination_reason: termination,
    turns: [],
    decision_summaries: session
      .getEvents()
      .filter((event) => event.type === 'assistant')
      .map(
        (event) =>
          (event.data as { decision_summary?: string }).decision_summary ?? '',
      ),
    context_reset_emitted: termination === 'context_reset',
    usage,
    step_states: Object.freeze(stepStates),
  };
}

export function extractToolReceipts(
  events: readonly SessionEvent[],
): readonly unknown[] {
  return Object.freeze(
    events
      .filter((event) => event.type === 'tool_result')
      .flatMap((event) => {
        const receipt = (event.data as { receipt?: unknown }).receipt;
        return receipt === undefined ? [] : [receipt];
      }),
  );
}

interface EvidenceInput {
  session: DurableSession;
  runPlan: RunPlan | undefined;
  loopResult: LoopResult;
  verificationReport: VerificationReport | null;
  workspaceChanges: readonly WorkspaceChange[];
  auditEntries: readonly AuditEntry[];
  buildCommitSha: string | undefined;
}

export function buildEvidence(input: EvidenceInput): RunEvidence {
  const events = input.session.getEvents();
  const toolCalls = events
    .filter((event) => event.type === 'tool_call')
    .flatMap((event) => {
      const data = event.data as {
        tool_call_id?: string;
        step?: string;
        tool?: string;
        arguments?: Record<string, unknown>;
      };
      if (!data.tool_call_id || !data.step || !data.tool || !data.arguments) {
        return [];
      }
      return [
        {
          tool_call_id: data.tool_call_id,
          step: data.step,
          tool: data.tool,
          arguments_hash: canonicalHash(data.arguments),
        },
      ];
    });
  const toolReceipts = extractToolReceipts(events);
  return {
    run_id: input.session.session_id,
    commit_sha: input.buildCommitSha ?? 'unknown',
    plan_hash: input.runPlan?.run_plan_hash ?? null,
    plan_revision: input.runPlan?.revision ?? null,
    reasoning_strategy: input.runPlan?.reasoning_strategy ?? null,
    registry_snapshot_refs: Object.freeze(
      Object.fromEntries(
        Object.entries(input.runPlan?.registry_snapshot_refs ?? {}).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === 'string',
        ),
      ),
    ),
    termination_reason: input.loopResult.termination_reason,
    iterations: input.loopResult.iterations,
    turns: input.loopResult.turns.length,
    decision_summaries: [...input.loopResult.decision_summaries],
    session_events: input.session.eventCount(),
    usage: { ...input.loopResult.usage },
    step_states: Object.freeze({ ...input.loopResult.step_states }),
    tool_calls: Object.freeze(toolCalls),
    tool_receipts: Object.freeze(toolReceipts),
    audit_entries: Object.freeze([...input.auditEntries]),
    verification_records: Object.freeze([
      ...(input.verificationReport?.records ?? []),
    ]),
    workspace_changes: Object.freeze([...input.workspaceChanges]),
    session_head_hash: events.at(-1)?.hash ?? null,
  };
}


export function assertValidHookPayload(payload: unknown, context: string): asserts payload is object {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${context} returned an invalid request`);
  }
}

export function assertValidPreTurnMessages(payload: unknown): asserts payload is { messages: unknown[] } {
  const candidate = payload as { messages?: unknown };
  if (!candidate || !Array.isArray(candidate.messages)) {
    throw new Error('pre_turn returned invalid messages');
  }
  for (const msg of candidate.messages) {
    if (
      !msg ||
      typeof msg !== 'object' ||
      typeof (msg as Record<string, unknown>).role !== 'string'
    ) {
      throw new Error('pre_turn returned a message with invalid role');
    }
  }
}

export function assertNoToolSetExpansion(
  originalTools: readonly { name: string }[],
  effectiveTools: readonly { name: string }[],
): void {
  const originalNames = new Set(originalTools.map((t) => t.name));
  for (const tool of effectiveTools) {
    if (!originalNames.has(tool.name)) {
      throw new Error(
        `before_provider_request expanded tool set beyond policy: ${tool.name}`,
      );
    }
  }
}

export async function processStreamEvents(
  stream: AsyncIterable<StreamEvent>,
  providerId: string,
  onDelta: (delta: string) => void,
): Promise<GatewayDispatchResult> {
  let contentBuffer = '';
  let usage: { input_tokens: number; output_tokens: number } | undefined;
  const toolCalls: Array<{ id: string; name: string; arguments: Readonly<Record<string, unknown>> }> = [];
  for await (const ev of stream) {
    if (ev.type === 'text_delta' && ev.text) {
      onDelta(ev.text);
      contentBuffer += ev.text;
    } else if (ev.type === 'tool_call' && ev.tool_call) {
      toolCalls.push(ev.tool_call);
    } else if (ev.type === 'message_stop' && ev.usage) {
      usage = ev.usage;
    }
  }
  return {
    provider_id: providerId,
    response: {
      content: contentBuffer,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(usage !== undefined ? { usage } : {}),
    },
    usage: usage ?? { input_tokens: 0, output_tokens: 0 },
  };
}

/** Emit a system event to the session with proper writer lifecycle. */
export function emitSessionEvent(
  session: DurableSession,
  data: Record<string, unknown>,
): void {
  session.acquireWriter();
  session.append('system', data);
  session.releaseWriter();
}

/** Emit an error event to the session with proper writer lifecycle. */
export function emitErrorEvent(
  session: DurableSession,
  eventName: string,
  message: string,
): void {
  session.acquireWriter();
  session.append('error', { event: eventName, message });
  session.releaseWriter();
}

/** Build the harness outcome object from its components. */
export function buildHarnessOutcome(
  runPlan: RunPlan | null,
  routing: RoutingResult,
  loopResult: LoopResult,
  verificationReport: VerificationReport | null,
  session: DurableSession,
  evidence: RunEvidence,
  success: boolean,
): {
  run_plan: RunPlan | null;
  routing: RoutingResult;
  loop_result: LoopResult;
  verification_report: VerificationReport | null;
  session: DurableSession;
  evidence: RunEvidence;
  success: boolean;
} {
  return {
    run_plan: runPlan,
    routing,
    loop_result: loopResult,
    verification_report: verificationReport,
    session,
    evidence,
    success,
  };
}

/** Build a LoopResult object from its components. */
export function buildLoopResult(
  strategy: string,
  iterations: number,
  terminationReason: string,
  turns: readonly unknown[],
  decisionSummaries: readonly unknown[],
  dataDir: string | undefined,
  contextResetEmitted: boolean,
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
  stepStates: ReadonlyMap<string, string>,
): LoopResult {
  return {
    strategy,
    iterations,
    termination_reason: terminationReason as LoopResult['termination_reason'],
    turns: turns as LoopResult['turns'],
    decision_summaries: decisionSummaries as LoopResult['decision_summaries'],
    ...(dataDir === undefined
      ? {}
      : { progress_path: join(dataDir, 'progress.json') }),
    context_reset_emitted: contextResetEmitted,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
    },
    step_states: Object.freeze(Object.fromEntries(stepStates)),
  } as LoopResult;
}

/** Build hook identity strings used for invocation_id and idempotency_key. */
export const HookIdentity = {
  prompt: (runId: string): string => `prompt:${runId}`,
  sessionStart: (runId: string): string => `session-start:${runId}`,
  sessionEnd: (runId: string): string => `session-end:${runId}`,
  stopPrompt: (runId: string, action: string): string => `stop:${runId}:prompt-${action}`,
  stopDenied: (runId: string): string => `stop:${runId}:denied`,
  stopSkill: (runId: string): string => `stop:${runId}:skill-activation`,
  stopTermination: (runId: string, reason: string): string => `stop:${runId}:${reason}`,
  stopInternalError: (runId: string): string => `stop:${runId}:internal-error`,
  providerBefore: (runId: string, count: number): string => `provider-before:${runId}:${count}`,
  providerAfter: (runId: string, count: number): string => `provider-after:${runId}:${count}`,
  turnBefore: (runId: string, iteration: number): string => `turn-before:${runId}:${iteration}`,
  turnAfter: (runId: string, iteration: number): string => `turn-after:${runId}:${iteration}`,
  toolBefore: (runId: string, stepId: string, toolCallId: string, attemptIndex: number): string =>
    `tool-before:${runId}:${stepId}:${toolCallId}:${attemptIndex}`,
  toolAfter: (runId: string, stepId: string, toolCallId: string, attemptIndex: number): string =>
    `tool-after:${runId}:${stepId}:${toolCallId}:${attemptIndex}`,
} as const;

/** Build a frozen tool rejection receipt for HookRestrictionError cases. */
export function buildToolRejectionReceipt(
  name: string,
  error: { action: string; reason_code: string },
  timestamp: string,
  inputHash: string,
): Readonly<{
  tool_name: string;
  timestamp: string;
  success: boolean;
  error: string;
  duration_ms: number;
  input_hash: string;
}> {
  return Object.freeze({
    tool_name: name,
    timestamp,
    success: false,
    error: `hook_${error.action}:${error.reason_code}`,
    duration_ms: 0,
    input_hash: inputHash,
  });
}

/** Build a canonical identity hash for a tool call. */
export function buildToolCallIdentity(
  runId: string,
  stepId: string,
  toolCallId: string,
  toolName: string,
): string {
  return canonicalHash(
    {
      run_id: runId,
      step_id: stepId,
      tool_call_id: toolCallId,
      tool_name: toolName,
    },
    24,
  );
}

/** Build the execution context for a tool call. */
export function buildToolCallExecutionContext(
  execCtx: {
    tenant_id: string;
    user_id: string;
    run_id: string;
    plan_id: string;
    confirmation_key_thumbprint: string;
    budget: { token_limit: number; usd_micros: number };
  },
  stepId: string,
  identity: string,
  inputIdentity: string,
  attemptIndex: number,
): {
  tenant_id: string;
  user_id: string;
  run_id: string;
  plan_id: string;
  step_id: string;
  attempt_id: string;
  operation_id: string;
  idempotency_key: string;
  confirmation_key_thumbprint: string;
  run_phase: 'agent';
  budget: { token_limit: number; usd_micros: number };
} {
  return {
    tenant_id: execCtx.tenant_id,
    user_id: execCtx.user_id,
    run_id: execCtx.run_id,
    plan_id: execCtx.plan_id,
    step_id: stepId,
    attempt_id: `attempt-${identity}-${attemptIndex}`,
    operation_id: `operation-${identity}`,
    idempotency_key: `idempotency-${identity}-${inputIdentity}`,
    confirmation_key_thumbprint: execCtx.confirmation_key_thumbprint,
    run_phase: 'agent' as const,
    budget: {
      token_limit: execCtx.budget.token_limit,
      usd_micros: execCtx.budget.usd_micros,
    },
  };
}

/** Build the fallback operation ID for a provider fallback attempt. */
export function buildFallbackOperationId(
  opId: string,
  attemptIndex: number,
): string {
  return `${opId}-fb${attemptIndex}`;
}

/** Build a skill activation event payload. */
export function buildSkillActivationEvent(
  skillName: string,
  version: string,
): { event: string; skill: string; version: string } {
  return {
    event: 'skill_activated',
    skill: skillName,
    version,
  };
}

/** Build a skill activation failure record. */
export function buildSkillActivationFailure(
  strategy: string,
  skillName: string,
  errorMessage: string,
): {
  reason: string;
  skill: string;
  error: string;
} {
  return {
    reason: 'skill_activation_failed',
    skill: skillName,
    error: errorMessage,
  };
}

/** Check if budget ledger components are both defined. */
export function shouldUseBudgetLedger(
  ledger: unknown,
  pricing: unknown,
): boolean {
  return ledger !== undefined && pricing !== undefined;
}
