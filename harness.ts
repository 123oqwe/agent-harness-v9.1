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
import {
  persistSession,
  type DurableSession,
} from './session/durable-session.js';
import {
  LoopEngine,
  type LoopResult,
  type ToolCallExecutionContext,
} from './runtime/loop.js';
import type { VirtualFilesystem } from './vfs/virtual-filesystem.js';
import type { SandboxProfile } from './runtime/sandbox.js';
import { ActionExecutor } from './security/action-executor.js';
import { ToolDispatcher } from './tools/tool-dispatcher.js';
import { LocalToolHost } from './tools/local-tool-host.js';
import type { AuthorizationService } from './security/authorization-service.js';
import type { CapabilityStateStore } from './security/capability.js';
import type { PolicyEnforcementPoint } from './security/pep.js';
import type { ConsentService } from './security/consent.js';
import type { AuditSink } from './security/audit-sink.js';
import type { PostconditionVerifierPort, ToolCredentialBrokerPort } from './tools/tool-executor.js';
import { SkillLoader } from './skills/skill-loader.js';
import type { SqliteSessionStore } from './session/sqlite-session-store.js';
import type {
  ModelGateway,
  GatewayDispatchResult,
} from './gateway/model-gateway.js';
import {
  type VerificationEngine,
  type VerificationReport,
} from './verification/verification-engine.js';
import {
  assertTimestamp,
  buildEvidence,
  buildProviderSelectionRequest,
  canonicalHash,
  deterministicRunId,
  extractToolReceipts,
  gatewayResultToModelTurn,
  recordTerminalFailure,
  restoreLoopResult,
  restoreVerificationReport,
  restoreWorkspaceChanges,
  validateExecutionContext,
  type ExecutionContext,
  type RunEvidence,
} from './runtime/harness-support.js';
import { TransactionalWorkspace } from './vfs/transactional-workspace.js';
import {
  isTerminalRun,
  openRunSession,
} from './session/run-session.js';

export {
  createDefaultExecutionContext,
  type ExecutionContext,
} from './runtime/harness-support.js';

/** Outcome returned to the caller (Vertical or user). */
export interface HarnessOutcome {
  run_plan: RunPlan | null;
  routing: RoutingResult;
  loop_result: LoopResult;
  verification_report: VerificationReport | null;
  session: DurableSession;
  evidence: RunEvidence;
  success: boolean;
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
  /** Build-time source revision. Never inferred from the consumer's cwd. */
  buildCommitSha?: string;
  /** Maximum declarative skill risk tier accepted for this composition. */
  maxSkillRiskTier?: 1 | 2 | 3 | 4;
}

export class Harness {
  private readonly config: HarnessConfig;
  private readonly toolSnapshot: RegistrySnapshot;
  private readonly skillSnapshot: SkillRegistrySnapshot;
  private readonly policySnapshotRef: string;
  private readonly localToolHost: LocalToolHost;
  private currentWorkspace: TransactionalWorkspace | null = null;
  private execCtx: ExecutionContext | null = null;
  private _modelCallCount = 0;
  private activeRun = false;

  constructor(config: HarnessConfig) {
    if (
      (config.dataDir !== undefined || config.sessionLogPath !== undefined) &&
      config.sessionMasterKey?.byteLength !== 32
    ) {
      throw new Error(
        '32-byte sessionMasterKey is required when session persistence is configured',
      );
    }
    if (
      config.buildCommitSha !== undefined &&
      !/^[0-9a-f]{40}$/u.test(config.buildCommitSha)
    ) {
      throw new Error('buildCommitSha must be a lowercase 40-character SHA');
    }
    if (
      config.maxSkillRiskTier !== undefined &&
      ![1, 2, 3, 4].includes(config.maxSkillRiskTier)
    ) {
      throw new Error('maxSkillRiskTier must be an integer from 1 through 4');
    }
    validateExecutionContext(config.executionContext);
    this.config = config;
    this.execCtx = config.executionContext;
    this.toolSnapshot = config.toolRegistry.freezeSnapshot();
    this.skillSnapshot = config.skillRegistry.freezeSnapshot();
    this.policySnapshotRef = `policy-${config.policyEngine.policy_hash}`;
    this.localToolHost = new LocalToolHost(() => ({
      transaction: this.currentWorkspace!.transaction,
      sandbox: this.currentWorkspace!.sandbox,
    }));
  }

  private now(): string {
    return assertTimestamp(this.execCtx!.clock(), 'execution clock');
  }

  /** Execute a TaskContract through the full Request-to-Outcome pipeline. */
  async run(task: TaskContract, runId?: string): Promise<HarnessOutcome> {
    if (runId !== undefined && runId.trim().length === 0) {
      throw new Error('runId must be a non-empty string when provided');
    }
    if (this.activeRun) {
      throw new Error('Harness supports one active Phase 1 run at a time');
    }
    this.activeRun = true;
    try {
      return await this.runOnce(task, runId);
    } finally {
      this.activeRun = false;
    }
  }

  private async runOnce(
    task: TaskContract,
    runId?: string,
  ): Promise<HarnessOutcome> {
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

    const openedSession = openRunSession({
      runId: actualRunId,
      goal: task.goal,
      strategy: routing.run_plan?.reasoning_strategy,
      clock: () => this.now(),
      dataDir: this.config.dataDir,
      masterKey: this.config.sessionMasterKey,
    });
    const {
      store: sqliteStore,
      session,
      existingEvents,
    } = openedSession;

    try {
      if (isTerminalRun(openedSession)) {
        session.releaseWriter();
        const termination =
          openedSession.persistedRun.status as LoopResult['termination_reason'];
        const iterations = existingEvents.filter(
          (event) => event.type === 'assistant',
        ).length;
        const restoredLoopResult = restoreLoopResult(
          session,
          routing.run_plan,
          termination,
          iterations,
        );
        const restoredVerification = restoreVerificationReport(session);
        return {
          run_plan: routing.run_plan ?? null,
          routing,
          loop_result: restoredLoopResult,
          verification_report: restoredVerification,
          session,
          evidence: buildEvidence({
            session,
            runPlan: routing.run_plan,
            loopResult: restoredLoopResult,
            verificationReport: restoredVerification,
            workspaceChanges: restoreWorkspaceChanges(session),
            auditEntries: this.config.security.auditSink.all,
            buildCommitSha: this.config.buildCommitSha,
          }),
          success: termination === 'goal_satisfied',
        };
      }
    if (routing.outcome !== 'route') {
      const failure = recordTerminalFailure(session, 'direct', {
        reason:
          routing.outcome === 'ask_user'
            ? 'routing_requires_user_input'
            : 'routing_abstained',
        outcome: routing.outcome,
        ask_user_message: routing.ask_user_message,
        abstain_reason: routing.abstain_reason,
      });
      session.releaseWriter();
      sqliteStore?.updateRunStatus(actualRunId, 'denied');
      if (this.config.sessionLogPath) {
        persistSession(session, this.config.sessionLogPath, {
          encryptionKey: this.config.sessionMasterKey!,
        });
      }
      return {
        run_plan: routing.run_plan ?? null,
        routing,
        loop_result: failure,
        verification_report: null,
        session,
        evidence: buildEvidence({
          session,
          runPlan: routing.run_plan,
          loopResult: failure,
          verificationReport: null,
          workspaceChanges: [],
          auditEntries: this.config.security.auditSink.all,
          buildCommitSha: this.config.buildCommitSha,
        }),
        success: false,
      };
    }

    const runPlan = routing.run_plan;
    if (runPlan === undefined) {
      throw new Error('Router returned route without a RunPlan');
    }
    this.currentWorkspace = TransactionalWorkspace.open({
      runId: actualRunId,
      baseVfs: this.config.vfs,
      sandbox: this.config.sandbox,
      stateRoot: this.config.dataDir,
    });

    // 2a. Skill activation: check if any required skills can activate
    const allowedTools = (this.config.policyEngine.snapshot as { allowed_tools: string[] }).allowed_tools;
    const skillLoader = new SkillLoader(
      this.config.skillRegistry,
      this.skillSnapshot,
      allowedTools,
      this.config.maxSkillRiskTier ?? 2,
      undefined,
      Object.fromEntries(
        this.toolSnapshot.tool_names.map((toolName) => [
          toolName,
          String(
            (
              this.config.toolRegistry.loadFull(
                toolName,
                this.toolSnapshot,
              ).effect_model as
                | { operation?: unknown }
            ).operation,
          ),
        ]),
      ),
    );
    const skillBindings = (runPlan.skill_bindings ?? []) as Array<{ skill_name?: string }>;
    let skillInstructions = '';
    if (skillBindings.length > 0 && skillBindings[0]!.skill_name) {
      try {
        const activation = await skillLoader.activate(skillBindings[0]!.skill_name);
        skillInstructions = activation.instructions;
        session.append('system', { event: 'skill_activated', skill: skillBindings[0]!.skill_name, version: activation.frozen_version });
      } catch (e) {
        const failure = recordTerminalFailure(
          session,
          runPlan.reasoning_strategy,
          {
          reason: 'skill_activation_failed',
          skill: skillBindings[0]!.skill_name,
          error: e instanceof Error ? e.message : 'skill activation failed',
          },
        );
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
          evidence: buildEvidence({
            session,
            runPlan,
            loopResult: failure,
            verificationReport: null,
            workspaceChanges: [],
            auditEntries: this.config.security.auditSink.all,
            buildCommitSha: this.config.buildCommitSha,
          }),
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
        data_dir: this.config.dataDir,
        budget_tokens: this.execCtx.budget.token_limit,
        run_plan: runPlan,
        clock: () => this.now(),
      },
      {
        session,
        modelCall: async (messages: unknown[], _attempt: number, modelBudget) => {
          const modelCallCount = (this._modelCallCount++) + 1;
          const plannedToolNames = new Set(
            runPlan.tool_grants.map((grant) => grant.tool),
          );
          const selectedTools = this.toolSnapshot.tool_names
            .filter((name) => plannedToolNames.has(name))
            .filter((n) => this.config.policyEngine.snapshot.allowed_tools.includes(n))
            .map((n) => this.config.toolRegistry.loadProviderTool(n, this.toolSnapshot));
          const req = buildProviderSelectionRequest({
            task,
            runPlan,
            messages,
            modelBudget,
            registrySnapshotHash: this.config.gateway.registrySnapshotHash,
            selectedTools,
          });
          const resolved = this.config.gateway.resolve(req);
          const opId = `${this.execCtx!.operation_id}-att-${modelCallCount}`;
          const attId = `${this.execCtx!.attempt_id}-${modelCallCount}`;
        const result: GatewayDispatchResult = await this.config.gateway.dispatch(resolved, req, {
          operation_id: opId,
          attempt_id: attId,
          signal: this.config.signal,
        });
          return gatewayResultToModelTurn(result);
        },
        toolExecute: async (
          name: string,
          args: Record<string, unknown>,
          context: ToolCallExecutionContext,
        ) => {
          return this.executeTool(name, args, context, session, sqliteStore);
        },
        signal: this.config.signal,
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
          sandbox: this.currentWorkspace!.sandbox,
          sessionEvents: session.getEvents(),
          toolReceipts: extractToolReceipts(session.getEvents()),
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
    const workspaceChanges = this.currentWorkspace!.describeChanges();
    try {
      // VerificationGraph pass is the only commit authority.
      this.finalizeOverlay(success);
    } catch (error) {
      success = false;
      loopResult = {
        ...loopResult,
        termination_reason: 'internal_error',
      };
      session.acquireWriter();
      session.append('error', {
        event: 'workspace_finalize_failed',
        message: error instanceof Error ? error.message : 'unknown',
      });
      session.releaseWriter();
    }

    session.acquireWriter();
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

    // 4. Persist session if path provided
    if (this.config.sessionLogPath) {
      persistSession(session, this.config.sessionLogPath, {
        encryptionKey: this.config.sessionMasterKey!,
      });
    }

    // 5. Build evidence
    const evidence = buildEvidence({
      session,
      runPlan,
      loopResult,
      verificationReport,
      workspaceChanges,
      auditEntries: this.config.security.auditSink.all,
      buildCommitSha: this.config.buildCommitSha,
    });

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
      try {
        this.finalizeOverlay(false);
      } finally {
        sqliteStore?.close();
      }
    }
  }

/** Return the overlay as a VirtualFilesystem-compatible object for tool dispatch. */
private currentOverlayAsVfs(): VirtualFilesystem {
   return this.currentWorkspace!.vfs;
}

  /** Execute a tool through the ToolExecutor pipeline (Policy → Capability → PEP → VFS/Sandbox). */
private async executeTool(
  name: string,
  args: Record<string, unknown>,
  call: ToolCallExecutionContext,
  session: DurableSession,
  effectJournal: SqliteSessionStore | null,
): Promise<unknown> {
  const identity = canonicalHash(
    {
      run_id: this.execCtx!.run_id,
      step_id: call.step_id,
      tool_call_id: call.tool_call_id,
      tool_name: name,
    },
    24,
  );
  const inputIdentity = canonicalHash(args, 24);
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
  const activeVfs = this.currentWorkspace ? this.currentOverlayAsVfs() : this.config.vfs;
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
      credentialBroker: this.config.security.credentialBroker,
      effectJournal: effectJournal ?? undefined,
      execCtx: execCtxForTool,
    },
   );
   const implementations = this.localToolHost.implementations(
     this.toolSnapshot.tool_names,
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

  /** Finalize the overlay: commit on success, discard on failure. */
  finalizeOverlay(success: boolean): void {
    if (!this.currentWorkspace) return;
    const workspace = this.currentWorkspace;
    try {
      workspace.finalize(success);
    } finally {
      this.currentWorkspace = null;
    }
  }

}
