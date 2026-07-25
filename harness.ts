/**
 * General Harness Composition Root.
 *
 * The single entry point that executes the full Request-to-Outcome pipeline:
 *   TaskContract → Policy → StaticRouter → RunPlan → Runtime → ModelGateway
 *   → ToolExecutor (Policy/Capability/PEP) → VFS/Sandbox → Session → Evidence → Outcome
 *
 * Verticals call this entry point; they do NOT call Provider, Tool, VFS or
 * Sandbox directly. This root accepts only typed component instances — never
 * raw callbacks.
 *
 * Security components (AuthorizationService, PEP, CapabilityStateStore,
 * AuditSink, signing keys, clock) are injected by the caller. The Harness
 * does NOT generate keys or create default security instances.
 */
import type { TaskContract } from './contracts/index.js';
import type { RunPlan } from './router/static-router.js';
import { StaticRouter, type RoutingResult } from './router/static-router.js';
import type { ToolRegistry, RegistrySnapshot } from './tools/tool-registry.js';
import type { SkillRegistry, SkillRegistrySnapshot } from './tools/skill-registry.js';
import type { PolicyEngine } from './security/policy-engine.js';
import { createHash } from 'node:crypto';
import { DurableSession, persistSession } from './session/durable-session.js';
import { OverlayBackend } from './vfs/virtual-filesystem.js';
import {
  WorkspaceTransaction,
  type WorkspaceChange,
} from './vfs/workspace-transaction.js';
import {
  LoopEngine,
  type LoopResult,
  type ModelTurn,
  type ToolCallExecutionContext,
} from './runtime/loop.js';
import type { VirtualFilesystem } from './vfs/virtual-filesystem.js';
import type { SandboxProfile } from './runtime/sandbox.js';
import { ActionExecutor } from './security/action-executor.js';
import { ToolDispatcher, type ToolImplementation } from './tools/tool-dispatcher.js';
import type { AuthorizationService } from './security/authorization-service.js';
import type { CapabilityStateStore } from './security/capability.js';
import type { PolicyEnforcementPoint } from './security/pep.js';
import type { ConsentService } from './security/consent.js';
import type { AuditSink } from './security/audit-sink.js';
import type { PostconditionVerifierPort, ToolCredentialBrokerPort } from './tools/tool-executor.js';
import { SkillLoader } from './skills/skill-loader.js';
import { SqliteSessionStore } from './session/sqlite-session-store.js';
import { spawnSync } from 'node:child_process';
import type { ModelGateway, ProviderSelectionRequest, GatewayDispatchResult } from './gateway/model-gateway.js';
import type { Message } from './gateway/scripted-provider.js';
import { join } from 'node:path';
import {
  type VerificationEngine,
  type VerificationReport,
} from './verification/verification-engine.js';

/** Outcome returned to the caller (Vertical or user). */
export interface HarnessOutcome {
  run_plan: RunPlan | null;
  routing: RoutingResult;
  loop_result: LoopResult;
  verification_report: VerificationReport | null;
  session: DurableSession;
  evidence: {
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
    audit_entries: readonly unknown[];
    verification_records: VerificationReport['records'];
    workspace_changes: readonly WorkspaceChange[];
    session_head_hash: string | null;
  };
  success: boolean;
}

/** Execution context: replaces all hardcoded identity values. */
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

/** Default execution context for tests (deterministic but not hardcoded in production). */
export function createDefaultExecutionContext(runId: string, clock?: () => string): ExecutionContext {
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
    budget: { token_limit: 100000, usd_micros: 5000000 },
    risk_level: 2,
    confirmation_key_thumbprint: 'test-thumbprint',
    clock: clock ?? (() => fixedTime),
 };
}

/** Injected security components — must be provided by the caller. */
export interface HarnessSecurityDeps {
  authz: AuthorizationService;
  pep: PolicyEnforcementPoint;
  stateStore: CapabilityStateStore;
  consent: ConsentService;
  auditSink: AuditSink;
  postconditionVerifier: PostconditionVerifierPort;
  credentialBroker?: ToolCredentialBrokerPort;
}

/** Configuration for the Harness — only typed components, no callbacks. */
export interface HarnessConfig {
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  policyEngine: PolicyEngine;
  vfs: VirtualFilesystem;
  sandbox: SandboxProfile;
  /** ModelGateway: all model calls go through gateway.resolve() + dispatch() */
  gateway: ModelGateway;
  security: HarnessSecurityDeps;
  executionContext: ExecutionContext;
  /** Required independent success authority. Model text cannot replace it. */
  verification: VerificationEngine;
  signal?: AbortSignal;
  dataDir?: string | undefined;
  /** Caller-custodied 256-bit key required whenever dataDir enables persistence. */
  sessionMasterKey?: Uint8Array;
  sessionLogPath?: string;
}

function deterministicRunId(task: TaskContract): string {
  return 'run-' + createHash('sha256').update(task.goal).digest('hex').slice(0, 12);
}

function canonicalize(value: unknown): unknown {
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

export class Harness {
  private readonly config: HarnessConfig;
  private readonly toolSnapshot: RegistrySnapshot;
  private readonly skillSnapshot: SkillRegistrySnapshot;
  private readonly policySnapshotRef: string;
  private currentOverlay: OverlayBackend | null = null;
  private currentWorkspaceTransaction: WorkspaceTransaction | null = null;
  private currentTransactionVfs: VirtualFilesystem | null = null;
  private currentTransactionSandbox: SandboxProfile | null = null;
  private readonly auditLog: unknown[] = [];
  private execCtx: ExecutionContext | null = null;
  private _modelCallCount = 0;

  constructor(config: HarnessConfig) {
    if (
      (config.dataDir !== undefined || config.sessionLogPath !== undefined) &&
      config.sessionMasterKey?.byteLength !== 32
    ) {
      throw new Error(
        '32-byte sessionMasterKey is required when session persistence is configured',
      );
    }
    this.config = config;
    this.execCtx = config.executionContext;
    this.toolSnapshot = config.toolRegistry.freezeSnapshot();
    this.skillSnapshot = config.skillRegistry.freezeSnapshot();
    this.policySnapshotRef = `policy-${config.policyEngine.policy_hash}`;
  }

  private now(): string {
    return this.execCtx?.clock() ?? new Date().toISOString();
  }

  /** Execute a TaskContract through the full Request-to-Outcome pipeline. */
  async run(task: TaskContract, runId?: string): Promise<HarnessOutcome> {
    this._modelCallCount = 0;
    const router = new StaticRouter({
      toolRegistry: this.config.toolRegistry,
      skillRegistry: this.config.skillRegistry,
      toolSnapshot: this.toolSnapshot,
      skillSnapshot: this.skillSnapshot,
      policyEngine: this.config.policyEngine,
      policySnapshotRef: this.policySnapshotRef,
      gateway: this.config.gateway,
    });
    const routing = router.route(task, runId);
    const actualRunId =
      runId ?? routing.run_plan?.run_id ?? deterministicRunId(task);
    this.execCtx = {
      ...this.config.executionContext,
      session_id: actualRunId,
      run_id: actualRunId,
      plan_id: routing.run_plan?.run_plan_hash ?? `plan-${actualRunId}`,
    };

    let sqliteStore: SqliteSessionStore | null = null;
    if (this.config.dataDir) {
      sqliteStore = new SqliteSessionStore(
        join(this.config.dataDir, 'session.db'),
        { masterKey: this.config.sessionMasterKey! },
      );
      sqliteStore.createRun(
        actualRunId,
        task.goal,
        routing.run_plan?.reasoning_strategy,
      );
    }
    const existingEvents = sqliteStore?.loadEvents(actualRunId) ?? [];
    const latestSnapshot = sqliteStore?.getLatestSnapshot(actualRunId) ?? null;
    const usableSnapshot =
      latestSnapshot !== null &&
      latestSnapshot.last_seq === existingEvents.length &&
      latestSnapshot.last_hash === (existingEvents.at(-1)?.hash ?? '')
        ? latestSnapshot
        : null;
    const persistedRun = sqliteStore?.getRun(actualRunId) ?? null;
    const session =
      existingEvents.length === 0
        ? new DurableSession(actualRunId, {
            ...(sqliteStore === null ? {} : { persistence: sqliteStore }),
            clock: () => this.now(),
          })
        : DurableSession.restore(
            {
              session_id: actualRunId,
              events: existingEvents,
              snapshot: usableSnapshot,
            },
            {
              ...(sqliteStore === null ? {} : { persistence: sqliteStore }),
              clock: () => this.now(),
            },
          );
    session.acquireWriter();

    try {
      if (
        existingEvents.length > 0 &&
        persistedRun !== null &&
        persistedRun.status !== 'running'
      ) {
        session.releaseWriter();
        const termination = persistedRun.status as LoopResult['termination_reason'];
        const iterations = existingEvents.filter(
          (event) => event.type === 'assistant',
        ).length;
        const restoredLoopResult = this.restoreLoopResult(
          session,
          routing.run_plan,
          termination,
          iterations,
        );
        const restoredVerification = this.restoreVerificationReport(session);
        return {
          run_plan: routing.run_plan ?? null,
          routing,
          loop_result: restoredLoopResult,
          verification_report: restoredVerification,
          session,
          evidence: this.buildEvidence(
            session,
            routing.run_plan,
            restoredLoopResult,
            restoredVerification,
            this.restoreWorkspaceChanges(session),
          ),
          success: termination === 'goal_satisfied',
        };
      }
    if (routing.outcome !== 'route' || !routing.run_plan) {
      // Router deny is terminal: model_calls=0, tool_calls=0, no fake RunPlan
      session.append('error', { reason: 'routing_denied', outcome: routing.outcome, abstain_reason: routing.abstain_reason });
      session.snapshot_({
        termination_reason: 'denied',
        iterations: 0,
        last_event_seq: session.eventCount(),
      });
      session.releaseWriter();
      this.finalizeOverlay(false);
      sqliteStore?.updateRunStatus(actualRunId, 'denied');
      return {
        run_plan: routing.run_plan ?? null,
        routing,
        loop_result: {
          strategy: 'direct', iterations: 0, termination_reason: 'denied',
          turns: [], decision_summaries: [], context_reset_emitted: false,
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          step_states: Object.freeze({}),
        },
        verification_report: null,
        session,
        evidence: this.buildEvidence(
          session,
          routing.run_plan,
          {
            strategy: 'direct',
            iterations: 0,
            termination_reason: 'denied',
            turns: [],
            decision_summaries: [],
            context_reset_emitted: false,
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            step_states: Object.freeze({}),
          },
          null,
          [],
        ),
        success: false,
      };
    }

    const runPlan = routing.run_plan;
    const overlayPrefix = '/workspace';
    this.currentOverlay = new OverlayBackend(overlayPrefix);
    this.currentOverlay.setBaseBackend(this.config.vfs.route(overlayPrefix));
    this.currentWorkspaceTransaction = WorkspaceTransaction.open({
      runId: actualRunId,
      baseRoot: this.config.sandbox.workspaceRoot,
      ...(this.config.dataDir === undefined
        ? {}
        : { stateRoot: this.config.dataDir }),
    });
    this.currentTransactionVfs =
      this.currentWorkspaceTransaction.createVfs(this.config.vfs);
    this.currentTransactionSandbox =
      this.currentWorkspaceTransaction.sandboxProfile(this.config.sandbox);

    // 2a. Skill activation: check if any required skills can activate
    const allowedTools = (this.config.policyEngine.snapshot as { allowed_tools: string[] }).allowed_tools;
    const skillLoader = new SkillLoader(
      this.config.skillRegistry,
      this.skillSnapshot,
      allowedTools,
      2,
      undefined,
      Object.fromEntries(
        this.toolSnapshot.tool_names.map((toolName) => [
          toolName,
          String(
            (
              this.config.toolRegistry.get(toolName)?.effect_model as
                | { operation?: unknown }
                | undefined
            )?.operation,
          ),
        ]),
      ),
    );
    const skillBindings = (runPlan.skill_bindings ?? []) as Array<{ skill_name?: string }>;
    let skillInstructions = '';
    if (skillBindings.length > 0 && skillBindings[0]!.skill_name) {
      try {
        const activation = await skillLoader.activate(skillBindings[0]!.skill_name);
        skillInstructions = activation.instructions || `Skill: ${activation.skill.name} v${activation.frozen_version}`;
        session.append('system', { event: 'skill_activated', skill: skillBindings[0]!.skill_name, version: activation.frozen_version });
      } catch (e) {
        const failure: LoopResult = {
          strategy: runPlan.reasoning_strategy,
          iterations: 0,
          termination_reason: 'denied',
          turns: [],
          decision_summaries: [],
          context_reset_emitted: false,
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          step_states: Object.freeze({}),
        };
        session.append('error', {
          reason: 'skill_activation_failed',
          skill: skillBindings[0]!.skill_name,
          error: e instanceof Error ? e.message : 'skill activation failed',
        });
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
        session.releaseWriter();
        this.finalizeOverlay(false);
        if (this.config.sessionLogPath) {
          persistSession(session, this.config.sessionLogPath, {
            encryptionKey: this.config.sessionMasterKey!,
          });
        }
        sqliteStore?.updateRunStatus(actualRunId, 'denied');
        return {
          run_plan: runPlan,
          routing,
          loop_result: failure,
          verification_report: null,
          session,
          evidence: this.buildEvidence(
            session,
            runPlan,
            failure,
            null,
            [],
          ),
          success: false,
        };
      }
    }

    // 3. Runtime: execute the frozen RunPlan.reasoning_strategy
    const goalWithSkill = skillInstructions ? `${skillInstructions}\n\n${task.goal}` : task.goal;
    const loop = new LoopEngine(
      {
        strategy: runPlan.reasoning_strategy,
        max_iterations: (runPlan.budget_allocation as { max_iterations: number }).max_iterations,
        run_id: runPlan.run_id,
        goal: goalWithSkill,
        ...(this.config.dataDir === undefined
          ? {}
          : { data_dir: this.config.dataDir }),
        budget_tokens: this.execCtx.budget.token_limit,
        run_plan: runPlan,
        clock: () => this.now(),
      },
      {
        session,
        modelCall: async (messages: unknown[], _attempt: number, modelBudget) => {
          // Strategy-local metadata such as decision_summary is evidence, not
          // provider protocol. Rebuild the wire messages with only supported
          // fields so a later turn cannot invalidate an otherwise valid plan.
          const typedMessages: Message[] = messages.map((candidate) => {
            const message = candidate as {
              role: Message['role'];
              content: string;
              tool_call_id?: string;
              tool_calls?: Message['tool_calls'];
            };
            return {
              role: message.role,
              content: message.content,
              ...(message.tool_call_id === undefined
                ? {}
                : { tool_call_id: message.tool_call_id }),
              ...(message.tool_calls === undefined
                ? {}
                : { tool_calls: message.tool_calls }),
            };
          });
          const modelCallCount = (this._modelCallCount++) + 1;
          const localOnly = task.constraints.some(
            (constraint) =>
              constraint.type === 'privacy' && constraint.value === 'local_only',
          );
          // Required capabilities derive from strategy + contract
          const requiredCaps = runPlan.reasoning_strategy === 'direct'
            ? ['text_reasoning']
            : ['text_reasoning', 'tool_calling'];
          // Selected frozen tools — compact metadata, no permission granted
          const plannedToolNames = new Set(
            runPlan.tool_grants.map((grant) => grant.tool),
          );
          const selectedTools = this.toolSnapshot.tool_names
            .filter((name) => plannedToolNames.has(name))
            .filter((n) => this.config.policyEngine.snapshot.allowed_tools.includes(n))
            .map((n) => this.config.toolRegistry.loadProviderTool(n, this.toolSnapshot));
          const providerId = runPlan.model_bindings[0]!.provider;
         const req: ProviderSelectionRequest = {
            registry_snapshot_hash: this.config.gateway.registrySnapshotHash,
           request: {
              messages: typedMessages,
              ...(selectedTools.length > 0 ? { tools: selectedTools } : {}),
              max_tokens: modelBudget.max_output_tokens,
            },
            estimated_input_tokens: Math.min(typedMessages.reduce((s, m) => s + m.content.length, 0), 100000),
            required_capabilities: requiredCaps,
            requires_structured_output: false,
           data_policy: {
             local_only: localOnly,
             allowed_regions: localOnly ? ['local'] : ['local', 'cn', 'us', 'eu'],
             max_retention_days: localOnly ? 0 : 365,
              training_allowed: false,
            },
            policy: { allowed_provider_ids: [providerId], denied_provider_ids: [] },
            run_plan: { allowed_provider_ids: [providerId], required_capabilities: requiredCaps },
          };
          const resolved = this.config.gateway.resolve(req);
          const opId = `${this.execCtx!.operation_id}-att-${modelCallCount}`;
          const attId = `${this.execCtx!.attempt_id}-${modelCallCount}`;
        const result: GatewayDispatchResult = await this.config.gateway.dispatch(resolved, req, {
          operation_id: opId,
          attempt_id: attId,
          ...(this.config.signal === undefined
            ? {}
            : { signal: this.config.signal }),
        });
          return {
            content: result.response.content,
            tool_calls: result.response.tool_calls,
            stop_reason: result.response.stop_reason,
            decision_summary: result.response.content.slice(0, 200),
            usage: result.usage,
          } as ModelTurn;
        },
        toolExecute: async (
          name: string,
          args: Record<string, unknown>,
          context: ToolCallExecutionContext,
        ) => {
          return this.executeTool(name, args, context, session, sqliteStore);
        },
        ...(this.config.signal === undefined
          ? {}
          : { signal: this.config.signal }),
      },
    );

    const executionResult = await loop.run();
    let verificationReport: VerificationReport | null = null;
    let success = false;
    let loopResult = executionResult;
    if (executionResult.termination_reason === 'completed') {
      try {
        verificationReport = await this.config.verification.verify({
          task,
          runPlan,
          loopResult: executionResult,
          vfs: this.currentOverlayAsVfs(),
          sandbox: this.currentTransactionSandbox!,
          sessionEvents: session.getEvents(),
          toolReceipts: session
            .getEvents()
            .filter((event) => event.type === 'tool_result')
            .flatMap((event) => {
              const receipt = (event.data as { receipt?: unknown }).receipt;
              return receipt === undefined ? [] : [receipt];
            }),
        });
        success = verificationReport.all_passed;
      } catch (error) {
        verificationReport = null;
        success = false;
        session.acquireWriter();
        session.append('error', {
          event: 'verification_engine_failed',
          message: error instanceof Error ? error.message : 'unknown',
        });
        session.releaseWriter();
      }
      loopResult = {
        ...executionResult,
        termination_reason: success
          ? 'goal_satisfied'
          : 'verification_failed',
      };
    }
    session.acquireWriter();
    const workspaceChanges =
      this.currentWorkspaceTransaction?.describeChanges() ?? [];
    session.append('system', {
      event: 'run_finalized',
      termination_reason: loopResult.termination_reason,
      verification_report: verificationReport,
      workspace_changes: workspaceChanges,
    });
    session.snapshot_({
      termination_reason: loopResult.termination_reason,
      iterations: loopResult.iterations,
      last_event_seq: session.eventCount(),
    });
    session.releaseWriter();

    // VerificationGraph pass is the only commit authority.
    this.finalizeOverlay(success);

    // 4. Persist session if path provided
    if (this.config.sessionLogPath) {
      persistSession(session, this.config.sessionLogPath, {
        encryptionKey: this.config.sessionMasterKey!,
      });
    }

    // 5. Build evidence
    const evidence = this.buildEvidence(
      session,
      runPlan,
      loopResult,
      verificationReport,
      workspaceChanges,
    );

    sqliteStore?.updateRunStatus(
      actualRunId,
      loopResult.termination_reason,
    );
    return {
      run_plan: runPlan,
      routing,
      loop_result: loopResult,
      verification_report: verificationReport,
      session,
      evidence,
      success,
    };
    } finally {
      sqliteStore?.close();
    }
  }

/** Return the overlay as a VirtualFilesystem-compatible object for tool dispatch. */
private currentOverlayAsVfs(): VirtualFilesystem {
   if (!this.currentTransactionVfs) {
     throw new Error('workspace transaction is not active');
   }
   return this.currentTransactionVfs;
}

  /** Execute a tool through the ToolExecutor pipeline (Policy → Capability → PEP → VFS/Sandbox). */
private async executeTool(
  name: string,
  args: Record<string, unknown>,
  call: ToolCallExecutionContext,
  session: DurableSession,
  effectJournal: SqliteSessionStore | null,
): Promise<unknown> {
  const identity = createHash('sha256')
    .update(
      JSON.stringify(canonicalize({
        run_id: this.execCtx!.run_id,
        step_id: call.step_id,
        tool_call_id: call.tool_call_id,
        tool_name: name,
      })),
    )
    .digest('hex')
    .slice(0, 24);
  const inputIdentity = createHash('sha256')
    .update(JSON.stringify(canonicalize(args)))
    .digest('hex')
    .slice(0, 24);
  // ExecutionContext is always set (required in HarnessConfig, set in run())
  const execCtxForTool = {
    tenant_id: this.execCtx!.tenant_id,
    user_id: this.execCtx!.user_id,
    run_id: this.execCtx!.run_id,
    plan_id: this.execCtx!.plan_id,
    step_id: call.step_id,
    attempt_id: `attempt-${identity}-${call.attempt_index}`,
    operation_id: `operation-${identity}`,
    idempotency_key: `idempotency-${identity}-${inputIdentity}`,
    confirmation_key_thumbprint: this.execCtx!.confirmation_key_thumbprint,
    run_phase: 'agent' as const,
    budget: {
      token_limit: this.execCtx!.budget.token_limit,
      usd_micros: this.execCtx!.budget.usd_micros,
    },
  };
  // Pass overlay VFS (if active) so tool writes go through the overlay, not the real FS
  const activeVfs = this.currentOverlay ? this.currentOverlayAsVfs() : this.config.vfs;
  const executor = new ActionExecutor(
   { toolRegistry: this.config.toolRegistry, snapshot: this.toolSnapshot, vfs: activeVfs, sandbox: this.config.sandbox, policyEngine: this.config.policyEngine, session },
    {
      authz: this.config.security.authz,
      pep: this.config.security.pep,
      stateStore: this.config.security.stateStore,
      now: () => this.now(),
      consent: this.config.security.consent,
      auditSink: this.config.security.auditSink,
      postconditionVerifier: this.config.security.postconditionVerifier,
      ...(this.config.security.credentialBroker === undefined
        ? {}
        : { credentialBroker: this.config.security.credentialBroker }),
      ...(effectJournal === null ? {} : { effectJournal }),
      execCtx: execCtxForTool,
    },
   );
   const implementations = new Map<string, ToolImplementation>(
     this.toolSnapshot.tool_names.map((toolName) => [
       toolName,
       async (dependencies, input) =>
         this.dispatchToolViaDeps(
           toolName,
           input as Record<string, unknown>,
           dependencies.vfs,
         ),
     ]),
   );
   const dispatcher = new ToolDispatcher(
     this.config.toolRegistry,
     this.toolSnapshot,
     executor,
     implementations,
   );
   const dispatchResult = await dispatcher.dispatch({ tool_name: name, input: args });
   if (!dispatchResult.success) {
     throw new Error(dispatchResult.error ?? 'tool dispatch failed');
   }
   return dispatchResult.result;
 }

  private async dispatchToolViaDeps(name: string, args: Record<string, unknown>, vfs: VirtualFilesystem): Promise<unknown> {
    const { readFile } = await import('./tools/read-file.js');
    const { writeFile } = await import('./tools/write-file.js');
    const { editFile } = await import('./tools/edit-file.js');
    const { listDirectory } = await import('./tools/list-directory.js');
    const { searchFiles } = await import('./tools/search-files.js');
    const { executeCommand } = await import('./tools/execute-command.js');
    const { createArtifact } = await import('./tools/create-artifact.js');
    const { parseDocument } = await import('./ingestion/parse-document.js');

    switch (name) {
      case 'read_file': return readFile(vfs, args as never);
      case 'write_file': return writeFile(vfs, args as never);
      case 'edit_file': return editFile(vfs, args as never);
      case 'list_directory': return listDirectory(vfs, args as never);
      case 'search_files': return searchFiles(vfs, args as never);
      case 'execute_command': {
        if (!this.currentWorkspaceTransaction || !this.currentTransactionSandbox) {
          throw new Error('workspace transaction is not active');
        }
        const commandArgs = args as unknown as {
          argv: string[];
          cwd: string;
          stdin?: string;
          timeout_ms?: number;
        };
        return executeCommand(this.currentTransactionSandbox, {
          ...commandArgs,
          cwd: this.currentWorkspaceTransaction.mapCwd(commandArgs.cwd),
        });
      }
      case 'create_artifact': return createArtifact(vfs, args as never);
      case 'parse_document': return parseDocument(vfs, args as never);
      case 'ask_user': throw new Error('ask_user must be handled by the caller, not dispatched');
      default: throw new Error(`unknown tool: ${name}`);
    }
  }

  /** Finalize the overlay: commit on success, discard on failure. */
  finalizeOverlay(success: boolean): void {
    if (!this.currentOverlay) return;
    const overlay = this.currentOverlay;
    const transaction = this.currentWorkspaceTransaction;
    try {
      if (success) {
        if (!transaction) throw new Error('workspace transaction is not active');
        transaction.capture(overlay);
        this.config.vfs.commitOverlay(overlay);
        transaction.complete();
      } else {
        this.config.vfs.discardOverlay(overlay);
        transaction?.discard();
      }
    } catch (error) {
      if (!overlay.isCommitted() && !overlay.isDiscarded()) {
        this.config.vfs.discardOverlay(overlay);
      }
      try { transaction?.discard(); } catch { /* already finalized */ }
      throw error;
    } finally {
      this.currentOverlay = null;
      this.currentWorkspaceTransaction = null;
      this.currentTransactionVfs = null;
      this.currentTransactionSandbox = null;
    }
  }

  private restoreVerificationReport(
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

  private restoreWorkspaceChanges(
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

  private restoreLoopResult(
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
      if (data.event === 'run_terminated' && data.usage) usage = data.usage;
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

  private buildEvidence(
    session: DurableSession,
    runPlan: RunPlan | undefined,
    loopResult: LoopResult,
    verificationReport: VerificationReport | null,
    workspaceChanges: readonly WorkspaceChange[],
  ): HarnessOutcome['evidence'] {
    let commitSha = 'unknown';
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      shell: false,
    });
    if (revision.status === 0 && /^[0-9a-f]{40}\s*$/u.test(revision.stdout)) {
      commitSha = revision.stdout.trim();
    }
    const events = session.getEvents();
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
        return [{
          tool_call_id: data.tool_call_id,
          step: data.step,
          tool: data.tool,
          arguments_hash: createHash('sha256')
            .update(JSON.stringify(canonicalize(data.arguments)))
            .digest('hex'),
        }];
      });
    const toolReceipts = events
      .filter((event) => event.type === 'tool_result')
      .flatMap((event) => {
        const receipt = (event.data as { receipt?: unknown }).receipt;
        return receipt === undefined ? [] : [receipt];
      });
    return {
      run_id: session.session_id,
      commit_sha: commitSha,
      plan_hash: runPlan?.run_plan_hash ?? null,
      plan_revision: runPlan?.revision ?? null,
      reasoning_strategy: runPlan?.reasoning_strategy ?? null,
      registry_snapshot_refs: Object.freeze(
        Object.fromEntries(
          Object.entries(runPlan?.registry_snapshot_refs ?? {}).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === 'string',
          ),
        ),
      ),
      termination_reason: loopResult.termination_reason,
      iterations: loopResult.iterations,
      turns: loopResult.turns.length,
      decision_summaries: [...loopResult.decision_summaries],
      session_events: session.eventCount(),
      usage: { ...loopResult.usage },
      step_states: Object.freeze({ ...loopResult.step_states }),
      tool_calls: Object.freeze(toolCalls),
      tool_receipts: Object.freeze(toolReceipts),
      audit_entries: Object.freeze([...this.config.security.auditSink.all]),
      verification_records: Object.freeze([
        ...(verificationReport?.records ?? []),
      ]),
      workspace_changes: Object.freeze([...workspaceChanges]),
      session_head_hash: events.at(-1)?.hash ?? null,
    };
  }
}
