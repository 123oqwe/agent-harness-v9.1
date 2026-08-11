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
import {
  deriveRunId,
  StaticRouter,
  type RoutingResult,
} from './router/static-router.js';
import type { ToolRegistry, RegistrySnapshot } from './tools/tool-registry.js';
import type { SkillRegistry, SkillRegistrySnapshot } from './skills/skill-registry.js';
import type { PolicyEngine } from './security/policy-engine.js';
import {
  persistSession,
  type DurableSession,
} from './session/durable-session.js';
import {
  LoopEngine,
  type LoopResult,
  type ModelCallDirective,
  type ToolCallExecutionContext,
} from './runtime/loop.js';
import type { EventBus } from './runtime/event-bus.js';
import type { VirtualFilesystem } from './vfs/virtual-filesystem.js';
import type { SandboxProfile } from './sandbox/process-sandbox.js';
import { ActionExecutor, OutputFormatValidator } from './security/action-executor.js';
import type { RagIndexStore } from '@agent-harness/rag';
import type { DefaultDocumentIngestor } from '@agent-harness/documents';
import { ToolDispatcher } from './tools/tool-dispatcher.js';
import { LocalToolHost } from './tools/local-tool-host.js';
import type { AuthorizationService } from './security/authorization-service.js';
import type { CapabilityStateStore } from './security/capability.js';
import type { PolicyEnforcementPoint } from './security/pep.js';
import type { ConsentService } from './security/consent.js';
import type { AuditSink } from './security/audit-sink.js';
import type { PostconditionVerifierPort, ToolCredentialBrokerPort } from './tools/tool-executor.js';
import { CacheManager } from './gateway/cache-manager.js';

// Lazy-loaded Phase 2 package modules — dynamic imports prevent the packed
// root tarball from needing packages/ at module-load time.
// Lazy-loaded Phase 2 package modules — dynamic imports for RAG and documents.
// In dev: imports resolve via workspace symlinks in node_modules.
// In packed root: imports resolve via @agent-harness/* package resolution.
function combineAbortSignals(configSignal: AbortSignal | undefined, modelSignal: AbortSignal | undefined): AbortSignal | undefined {
  if (configSignal && modelSignal && configSignal !== modelSignal) {
    return AbortSignal.any([configSignal, modelSignal]);
  }
  return modelSignal ?? configSignal;
}

function spreadIfDefined<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

function hookActionToState(action: string): 'approval_required' | 'skipped' | 'blocked' {
  switch (action) {
    case 'force_prompt': return 'approval_required';
    case 'skip': return 'skipped';
    default: return 'blocked';
  }
}



// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type RagModule = typeof import('@agent-harness/rag');
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type DocModule = typeof import('@agent-harness/documents');
let _ragModulePromise: Promise<RagModule> | undefined;
const _lazyDoc = (): Promise<DocModule> => {
  return import('@agent-harness/documents');
};
const lazyRag = (): Promise<RagModule> => {
  if (!_ragModulePromise) _ragModulePromise = import('@agent-harness/rag');
  return _ragModulePromise;
};
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
  extractToolReceipts,
  gatewayResultToModelTurn,
  processStreamEvents,
  normalizeWorkspaceToolInput,
  recordTerminalFailure,
  restoreLoopResult,
  restoreVerificationReport,
  restoreWorkspaceChanges,
  validateExecutionContext,
  assertValidHookPayload,
  assertValidPreTurnMessages,
  assertNoToolSetExpansion,
  type ExecutionContext,
  type RunEvidence,
} from './runtime/harness-support.js';
import { TransactionalWorkspace } from './vfs/transactional-workspace.js';
import {
  dispatchHookBoundary,
  HookRestrictionError,
  type HookRuntimePort,
  type RuntimeHookEvent,
  type RuntimeHookOutcome,
  type RuntimeHookScope,
} from './runtime/hook-port.js';
import {
  isTerminalRun,
  openRunSession,
} from './session/run-session.js';
import type { RuntimeSteeringFactoryPort } from './runtime/steering-port.js';
import {
  BudgetLedgerRuntimeAdapter,
  type RuntimeBudgetFactoryPort,
  type RuntimeBudgetPricing,
} from './runtime/budget-port.js';
import { recordSessionBranch } from './runtime/session-tree-port.js';

// Phase 2 runtime-core package integration
import type { SessionTreeAuthorityPort } from '@agent-harness/runtime-core';
import type { HookSystem } from '@agent-harness/runtime-core';
import type { BudgetLedger as RuntimeCoreBudgetLedger } from '@agent-harness/runtime-core';
import type { SteeringController } from '@agent-harness/runtime-core';
import type { ContextCompactor } from '@agent-harness/runtime-core';
import type { ContextCompiler } from '@agent-harness/runtime-core';
import type { ModelFallbackController } from '@agent-harness/runtime-core';
import type { PauseResumeController } from '@agent-harness/runtime-core';

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
  hook_disposition?: {
    readonly action: 'deny' | 'skip' | 'force_prompt';
    readonly state: 'blocked' | 'skipped' | 'approval_required';
    readonly reason_code: string;
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
  /** Build-time source revision. Never inferred from the consumer's cwd. */
  buildCommitSha?: string;
  /** Maximum declarative skill risk tier accepted for this composition. */
  maxSkillRiskTier?: 1 | 2 | 3 | 4;
  /** Per-provider-call output ceiling; overall run budget remains separate. */
  maxOutputTokensPerCall?: number;
  /** Phase 2 Hook authority. It can restrict a request but never authorize one. */
  hooks?: HookRuntimePort;
  /** Aggregate boundary ceiling; individual Hook registrations may be lower. */
  hookTimeoutMs?: number;
  /** Binds the single Runtime steering authority to the active session log. */
  steering?: RuntimeSteeringFactoryPort;
  /** Binds the single runtime-core BudgetLedger authority to the routed run. */
  budget?: RuntimeBudgetFactoryPort;
  /** Phase 2: SessionTree authority for branch/fork/rewind validation. */
  sessionTreeAuthority?: SessionTreeAuthorityPort;
  /** Phase 2: HookSystem as hook dispatch implementation. */
  hookSystem?: HookSystem;
  /** Phase 2: BudgetLedger for sophisticated budget tracking. */
  budgetLedger?: RuntimeCoreBudgetLedger;
  /** Phase 2: Pricing required when budgetLedger is provided. */
  budgetLedgerPricing?: RuntimeBudgetPricing;
  /** Phase 2: SteeringController for runtime steering. */
  steeringController?: SteeringController;
  /** Phase 2: ContextCompactor for context compaction. */
  contextCompactor?: ContextCompactor;
  /** Phase 2: ContextCompiler for context building. */
  contextCompiler?: ContextCompiler;
  /** Phase 2: ModelFallbackController for provider fallback. */
  modelFallback?: ModelFallbackController;
  /** Phase 2: PauseResumeController for session pause/resume. */
  pauseResume?: PauseResumeController;
  /** #6: RAG index store for evidence retrieval. Defaults to empty store. */
  ragStore?: RagIndexStore;
  /** #6: Document ingestor for parse_document → RAG indexing. */
  documentIngestor?: DefaultDocumentIngestor;
  /** Streaming: callback for each model output token delta. Enables SSE/WebSocket streaming. */
  onModelDelta?: (delta: string) => void;
  /** Streaming: callback for each tool output chunk. Enables live tool output streaming. */
  onToolOutput?: (toolCallId: string, stepId: string, stream: 'stdout' | 'stderr', chunk: string) => void;
  /** EventBus for pub/sub of agent activity events (tool calls, model calls, turns). */
  eventBus?: EventBus;
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
  private readonly hookPort: HookRuntimePort | undefined;
  private readonly sessionTreeAuthority: SessionTreeAuthorityPort | undefined;
  private readonly steeringController: SteeringController | undefined;
  private readonly contextCompactor: ContextCompactor | undefined;
  private readonly contextCompiler: ContextCompiler | undefined;
  private readonly modelFallback: ModelFallbackController | undefined;
  private readonly pauseResume: PauseResumeController | undefined;
  private readonly budgetLedger: RuntimeCoreBudgetLedger | undefined;
  private readonly budgetLedgerPricing: RuntimeBudgetPricing | undefined;
  /** P2-12: LLM cache manager for prompt cache tracking. */
  private readonly cacheManager = new CacheManager();
  /** #6: RAG store and document ingestor (lazy-initialized for packed-root compatibility). */
  private ragStore: RagIndexStore | undefined;
  private documentIngestor: DefaultDocumentIngestor | undefined;
  /** #1: context window capacity from provider metadata. N34 fix: read from gateway. */
  private readonly contextCapacity: number | undefined;

  /** Mutable streaming callbacks — set after construction by ws-server or SSE handler. */
  private _onModelDelta: ((delta: string) => void) | undefined;
  private _onToolOutput: ((toolCallId: string, stepId: string, stream: 'stdout' | 'stderr', chunk: string) => void) | undefined;
  private _eventBus: EventBus | undefined;

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
    // N34 fix: read context capacity from the first provider in the gateway snapshot
    const providers = config.gateway.registrySnapshot.providers;
    this.contextCapacity = providers.length > 0 ? providers[0]!.max_context_tokens : undefined;
    this.toolSnapshot = config.toolRegistry.freezeSnapshot();
    this.skillSnapshot = config.skillRegistry.freezeSnapshot();
    this.policySnapshotRef = `policy-${config.policyEngine.policy_hash}`;
    this.localToolHost = new LocalToolHost(() => ({
      transaction: this.currentWorkspace!.transaction,
      sandbox: this.currentWorkspace!.sandbox,
    }));
    // Phase 2: wire runtime-core packages into the composition root.
    this.sessionTreeAuthority = config.sessionTreeAuthority;
    this.steeringController = config.steeringController;
    this.contextCompactor = config.contextCompactor;
    this.contextCompiler = config.contextCompiler;
    this.modelFallback = config.modelFallback;
    this.pauseResume = config.pauseResume;
    this.budgetLedger = config.budgetLedger;
    this.budgetLedgerPricing = config.budgetLedgerPricing;
    // When HookSystem is provided, wrap it as a HookRuntimePort so that
    // dispatchHookBoundary dispatches through the Phase 2 authority.
    this.hookPort = config.hookSystem === undefined
      ? undefined
      : {
         dispatch: (request) => config.hookSystem!.dispatch(request),
       };
    // #6: initialize RAG store and document ingestor
    // When provided in config, use directly. Otherwise lazy-load from packages.
    this.ragStore = config.ragStore;
    this.documentIngestor = config.documentIngestor;
  }

  private now(): string {
    return assertTimestamp(this.execCtx!.clock(), 'execution clock');
  }

  /**
   * Attach streaming callbacks after construction. Returns `this` for chaining.
   * Used by ws-server / SSE handler to route model deltas and tool output
   * through the WebSocket without bypassing the Harness security pipeline.
   */
  withStreaming(callbacks: {
    onModelDelta?: (delta: string) => void;
    onToolOutput?: (toolCallId: string, stepId: string, stream: 'stdout' | 'stderr', chunk: string) => void;
  }): this {
    this._onModelDelta = callbacks.onModelDelta;
    this._onToolOutput = callbacks.onToolOutput;
    return this;
  }

  /** Attach an EventBus for pub/sub of agent activity events. */
  withEventBus(bus: EventBus): this {
    this._eventBus = bus;
    return this;
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
      const requestedRunId =
        runId ??
        deriveRunId(
          task,
          this.toolSnapshot.snapshot_id,
          this.skillSnapshot.snapshot_id,
          this.config.gateway.registrySnapshotHash,
        );
      const prompt = await this.dispatchHook(
        'user_prompt_submit',
        task,
        `prompt:${requestedRunId}`,
        'decision',
        {
          run_id: requestedRunId,
          session_id: requestedRunId,
        },
      );
      if (prompt.action !== 'continue') {
        return await this.runOnce(task, requestedRunId, prompt);
      }
      if (!this.isTaskContract(prompt.payload)) {
        throw new Error('UserPromptSubmit hook returned an invalid TaskContract');
      }
      return await this.runOnce(prompt.payload, requestedRunId);
    } finally {
      this.activeRun = false;
    }
  }

  private async runOnce(
    task: TaskContract,
    runId: string,
    promptRestriction?: RuntimeHookOutcome,
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
    const actualRunId = routing.run_plan?.run_id ?? runId;
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
    const steering = this.config.steering?.bind({
      session,
      scope: {
        tenant_id: this.execCtx.tenant_id,
        run_id: actualRunId,
        session_id: actualRunId,
      },
    });
    try {
      await this.observationalHook(
        'session_start',
        { restored: existingEvents.length > 0 },
        `session-start:${actualRunId}`,
      );
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
      if (promptRestriction && promptRestriction.action !== 'continue') {
        const action = promptRestriction.action;
        const reasonCode = promptRestriction.reason_code ?? 'hook_restricted';
        const state = hookActionToState(action);
        const failure = recordTerminalFailure(
          session,
          routing.run_plan?.reasoning_strategy ?? 'direct',
          {
            reason: 'user_prompt_hook_restricted',
            hook_action: action,
            hook_state: state,
            reason_code: reasonCode,
            approval_required: action === 'force_prompt',
          },
        );
        session.releaseWriter();
        sqliteStore?.updateRunStatus(actualRunId, 'denied');
        await this.observationalHook(
          'stop',
          { termination_reason: 'denied', hook_action: action, hook_state: state },
          `stop:${actualRunId}:prompt-${action}`,
        );
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
          hook_disposition: {
            action,
            state,
            reason_code: reasonCode,
          },
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
      await this.observationalHook(
        'stop',
        { termination_reason: 'denied', routing_outcome: routing.outcome },
        `stop:${actualRunId}:denied`,
      );
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
    const budgetGuard = this.config.budget?.bind({
      scope: {
        tenant_id: this.execCtx.tenant_id,
        run_id: actualRunId,
        session_id: actualRunId,
      },
    });
    // Phase 2: when a BudgetLedger is provided, wrap it in the runtime
    // adapter so the loop's budget guard goes through the ledger authority.
    const ledgerAdapter =
      this.budgetLedger !== undefined && this.budgetLedgerPricing !== undefined
        ? new BudgetLedgerRuntimeAdapter({
            ledger: this.budgetLedger,
            pricing: this.budgetLedgerPricing,
          })
        : undefined;
    const effectiveBudgetGuard = ledgerAdapter ?? budgetGuard;
    // Phase 2: when a SteeringController is provided, expose it as the
    // RuntimeSteeringPort for the loop.
    const effectiveSteering = this.steeringController ?? steering;
    this.currentWorkspace = TransactionalWorkspace.open({
      runId: actualRunId,
      baseVfs: this.config.vfs,
      sandbox: this.config.sandbox,
      stateRoot: this.config.dataDir,
    });
    // N31: Record a branch event in the SessionTree when a new run starts
    if (this.sessionTreeAuthority) {
      await recordSessionBranch({
        authority: this.sessionTreeAuthority,
        scope: {
          tenant_id: this.execCtx.tenant_id,
          root_session_id: actualRunId,
        },
        rootSessionId: actualRunId,
        childSessionId: `${actualRunId}-branch`,
      });
    }

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
        await this.observationalHook(
          'stop',
          { termination_reason: 'denied', reason: 'skill_activation_failed' },
          `stop:${actualRunId}:skill-activation`,
        );
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
        ...spreadIfDefined('max_output_tokens_per_call', this.config.maxOutputTokensPerCall),
       run_plan: runPlan,
       clock: () => this.now(),
       // P1-10: read auto_execute from cancellation_policy (default true)
      auto_execute:
        (runPlan.cancellation_policy as { auto_execute?: boolean }).auto_execute !== false,
      // #1: pass context capacity from the first model binding's max_context
      // #1: context capacity from gateway — use undefined if not available
      ...spreadIfDefined('context_capacity_tokens', this.contextCapacity),
    },
      {
        session,
        ...spreadIfDefined('steering', effectiveSteering),
        ...spreadIfDefined('budgetGuard', effectiveBudgetGuard),
       modelCall: async (
         messages: unknown[],
         _attempt: number,
         modelBudget,
         directive?: ModelCallDirective,
         modelSignal?: AbortSignal,
         onDelta?: (delta: string) => void,
       ) => {
          const modelCallCount = (this._modelCallCount++) + 1;
          const plannedToolNames = new Set(
            runPlan.tool_grants.map((grant) => grant.tool),
          );
          const directiveTools =
            directive?.allowed_tools === undefined
              ? plannedToolNames
              : new Set(directive.allowed_tools);
          const selectedTools = this.toolSnapshot.tool_names
            .filter((name) => plannedToolNames.has(name))
            .filter((name) => directiveTools.has(name))
            .filter((n) => this.config.policyEngine.snapshot.allowed_tools.includes(n))
            .map((n) => this.config.toolRegistry.loadProviderTool(n, this.toolSnapshot));
          const req = buildProviderSelectionRequest({
            task,
            runPlan,
            messages,
            modelBudget,
            registrySnapshotHash: this.config.gateway.registrySnapshotHash,
            selectedTools,
            ...spreadIfDefined('directive', directive),
          });
          const beforeProvider = await this.decisionHook(
            'before_provider_request',
            req,
            `provider-before:${runPlan.run_id}:${modelCallCount}`,
          );
          assertValidHookPayload(beforeProvider.payload, 'before_provider_request');
          const effectiveRequest = beforeProvider.payload as typeof req;
          // Validate that hooks did not expand the tool set beyond policy
          // filtering. Hooks can restrict a request but never authorize one.
          assertNoToolSetExpansion(
            (req.request.tools ?? []) as readonly { name: string }[],
            (
              (effectiveRequest.request as unknown as { tools?: readonly { name: string }[] })
                .tools ?? []
            ),
          );
          const resolved = this.config.gateway.resolve(effectiveRequest);
          const opId = `${this.execCtx!.operation_id}-att-${modelCallCount}`;
          const attId = `${this.execCtx!.attempt_id}-${modelCallCount}`;
         // P2-12: track LLM cache key for prompt cache management
         this.cacheManager.trackCall(
           this.cacheManager.computeKey(resolved.provider_id, 'default', false),
         );
         // #4: streaming token output via dispatchStream when onDelta is provided
         if (onDelta) {
           const streamResult = await processStreamEvents(
             this.config.gateway.dispatchStream(resolved, effectiveRequest, {
               operation_id: opId,
               attempt_id: attId,
               signal: combineAbortSignals(this.config.signal, modelSignal),
             }),
             resolved.provider_id,
             onDelta,
           );
           await this.observationalHook('after_response', streamResult, `provider-after:${runPlan.run_id}:${modelCallCount}`);
           return gatewayResultToModelTurn(streamResult);
         }
       // N28 fix: ModelFallback — if dispatch fails, try switching providers
       let result: GatewayDispatchResult | undefined;
       const dispatchSignal = combineAbortSignals(this.config.signal, modelSignal);
       try {
         result = await this.config.gateway.dispatch(resolved, effectiveRequest, {
           operation_id: opId,
           attempt_id: attId,
           signal: dispatchSignal,
         });
       } catch (dispatchError) {
         // Try fallback to another provider if modelFallback is configured
         if (this.modelFallback) {
           try {
             const fallbackResult = await this.modelFallback.execute({
               current_provider: {
                 provider_id: resolved.provider_id,
                 registry_snapshot_hash: this.config.gateway.registrySnapshotHash,
                 provider_metadata_hash: this.config.gateway.registrySnapshotHash,
                 selection_request_hash: this.config.gateway.registrySnapshotHash,
               },
               selection_request: effectiveRequest,
               dispatch_context: { operation_id: opId, attempt_id: attId, ...(dispatchSignal ? { signal: dispatchSignal } : {}) },
               context_generation: 0,
               visited_provider_ids: [resolved.provider_id],
               initial_failure: dispatchError,
             });
             result = fallbackResult.dispatch_result as GatewayDispatchResult;
              } catch {
             // Fallback also failed — throw original error
             throw dispatchError;
           }
         } else {
           // Simple fallback: try switching providers directly via gateway
           {
             let fallbackResolved = resolved;
             const attempted = new Set<string>([resolved.provider_id]);
             let found = false;
            for (let i = 0; i < 5 && !found; i++) {
              try {
                fallbackResolved = this.config.gateway.switchProvider(fallbackResolved, effectiveRequest, [...attempted]);
                attempted.add(fallbackResolved.provider_id);
                result = await this.config.gateway.dispatch(fallbackResolved, effectiveRequest, {
                   operation_id: `${opId}-fb${i}`,
                   attempt_id: attId,
                   ...(dispatchSignal ? { signal: dispatchSignal } : {}),
                 });
                 found = true;
               } catch {
                 // Continue to next provider
               }
             }
             if (!found) throw dispatchError;
           }
         }
       }
       if (!result) throw new Error('model dispatch returned no result after fallback');
       await this.observationalHook(
         'after_response',
         result,
         `provider-after:${runPlan.run_id}:${modelCallCount}`,
       );
       return gatewayResultToModelTurn(result);
        },
        toolExecute: async (
          name: string,
          args: Record<string, unknown>,
          context: ToolCallExecutionContext,
       ) => {
         return this.executeTool(name, args, context, session, sqliteStore);
       },
       // #6: RAG query for evidence injection
       ragQuery: async (query, topK) => {
         if (!this.ragStore) { const m = await lazyRag(); this.ragStore = m.createIndexStore(); }
         const results = (await lazyRag()).queryStore(this.ragStore, {
           text: query,
           tenant_id: this.execCtx!.tenant_id,
           principal_id: this.execCtx!.user_id,
           top_k: topK,
         });
         return results;
       },
       signal: this.config.signal,
       ...spreadIfDefined('onModelDelta', this._onModelDelta ?? this.config.onModelDelta),
       ...spreadIfDefined('onToolOutput', this._onToolOutput ?? this.config.onToolOutput),
       ...spreadIfDefined('eventBus', this._eventBus ?? this.config.eventBus),
       ...spreadIfDefined('contextCompiler', this.contextCompiler),
        turnHooks: {
          beforeTurn: async ({ iteration, messages }) => {
            const before = await this.decisionHook(
              'pre_turn',
              { messages },
              `turn-before:${runPlan.run_id}:${iteration}`,
            );
            assertValidPreTurnMessages(before.payload);
           messages.splice(0, messages.length, ...(before.payload as { messages: unknown[] }).messages);
          },
          afterTurn: async ({ iteration, turn, observations }) => {
            await this.observationalHook(
              'post_turn',
              { iteration, turn, observations },
              `turn-after:${runPlan.run_id}:${iteration}`,
            );
          },
        },
      },
    );

    const executionResult = await loop.run();
    let verificationReport: VerificationReport | null = null;
    let success = false;
    let loopResult = executionResult;
    // N30: When the loop terminates with approval_required and a
    // PauseResumeController is configured, invoke resume() to determine
    // the correct next action (continue, retry, or await human).
    if (
      executionResult.termination_reason === 'approval_required' &&
      this.pauseResume
    ) {
      const pauseAction = await this.pauseResume.resume({
        run_id: actualRunId,
        operation_id: `${this.execCtx!.operation_id}-pause`,
      });
      session.acquireWriter();
      session.append('system', {
        event: 'pause_resume_evaluated',
        action: pauseAction.action,
        operation_id: pauseAction.operation_id,
      });
      session.releaseWriter();
      if (pauseAction.action === 'continue_next_step') {
        // Resume execution by re-running the loop
        const resumedResult = await loop.run();
        loopResult = resumedResult;
      }
      // For retry_new_attempt and await_human, the caller (ws-server or
      // API handler) is responsible for re-invoking Harness.run() after
      // the human approval or new capability is obtained.
    }
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
    await this.observationalHook(
      'stop',
      { termination_reason: loopResult.termination_reason },
      `stop:${actualRunId}:${loopResult.termination_reason}`,
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
    } catch (error) {
      await this.observationalHook(
        'stop',
        { termination_reason: 'internal_error' },
        `stop:${actualRunId}:internal-error`,
      );
      throw error;
    } finally {
      try {
        await this.observationalHook(
          'session_end',
          { run_id: actualRunId },
          `session-end:${actualRunId}`,
        );
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
  const initialArgs = normalizeWorkspaceToolInput(name, args);
  let preTool: RuntimeHookOutcome;
  try {
    preTool = await this.decisionHook(
      'pre_tool_use',
      initialArgs,
      `tool-before:${this.execCtx!.run_id}:${call.step_id}:${call.tool_call_id}:${call.attempt_index}`,
      {
        operation_id: `${this.execCtx!.operation_id}:${call.tool_call_id}`,
        attempt_id: `${this.execCtx!.attempt_id}:${call.attempt_index}`,
      },
    );
  } catch (error) {
    if (error instanceof HookRestrictionError) {
      session.append('tool_result', {
        step: call.step_id,
        tool_call_id: call.tool_call_id,
        tool: name,
        status: 'rejected',
        receipt: Object.freeze({
          tool_name: name,
          timestamp: this.now(),
          success: false,
          error: `hook_${error.action}:${error.reason_code}`,
          duration_ms: 0,
          input_hash: canonicalHash(initialArgs, 16),
        }),
      });
    }
    throw error;
  }
  assertValidHookPayload(preTool.payload, 'PreToolUse hook');
  const normalizedArgs = normalizeWorkspaceToolInput(
    name,
    preTool.payload as Record<string, unknown>,
  );
  for (const key of Object.keys(args)) delete args[key];
  Object.assign(args, normalizedArgs);
  const identity = canonicalHash(
    {
      run_id: this.execCtx!.run_id,
      step_id: call.step_id,
      tool_call_id: call.tool_call_id,
      tool_name: name,
    },
    24,
  );
  const inputIdentity = canonicalHash(normalizedArgs, 24);
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
      outputFormatValidator: new OutputFormatValidator(this.config.toolRegistry, this.toolSnapshot),
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
     undefined,
     {
       observe: async ({ input, result }) => {
         await this.observationalHook(
           'post_tool_use',
           { tool_name: name, input, result },
           `tool-after:${this.execCtx!.run_id}:${call.step_id}:${call.tool_call_id}:${call.attempt_index}`,
           {
             operation_id: execCtxForTool.operation_id,
             attempt_id: execCtxForTool.attempt_id,
           },
         );
       },
     },
   );
   const dispatchResult = await dispatcher.dispatch({
     tool_name: name,
     input: normalizedArgs,
   });
   if (!dispatchResult.success) {
     throw new Error(dispatchResult.error ?? 'tool dispatch failed');
   }
   return dispatchResult.result;
 }

 private async decisionHook(
   event: RuntimeHookEvent,
   payload: unknown,
   identity: string,
   scopeOverrides: Partial<{
     run_id: string;
     session_id: string;
     operation_id: string;
     attempt_id: string;
   }> = {},
 ): Promise<RuntimeHookOutcome> {
   const result = await this.dispatchHook(
     event,
     payload,
     identity,
     'decision',
     scopeOverrides,
   );
   if (result.action !== 'continue') {
     throw new HookRestrictionError(
       event,
       result.action,
       result.reason_code ?? 'restricted',
     );
   }
   return result;
 }

 private async observationalHook(
   event: RuntimeHookEvent,
   payload: unknown,
   identity: string,
   scopeOverrides: Partial<{
     run_id: string;
     session_id: string;
     operation_id: string;
     attempt_id: string;
   }> = {},
 ): Promise<RuntimeHookOutcome> {
   return this.dispatchHook(
     event,
     payload,
     identity,
     'observational',
     scopeOverrides,
   );
 }

 private async dispatchHook(
   event: RuntimeHookEvent,
   payload: unknown,
   identity: string,
   mode: 'decision' | 'observational',
   scopeOverrides: Partial<{
     run_id: string;
     session_id: string;
     operation_id: string;
     attempt_id: string;
   }>,
 ): Promise<RuntimeHookOutcome> {
   const context = this.execCtx ?? this.config.executionContext;
   const scope: RuntimeHookScope = {
     tenant_id: context.tenant_id,
     run_id: scopeOverrides.run_id ?? context.run_id,
     session_id: scopeOverrides.session_id ?? context.session_id,
     operation_id: scopeOverrides.operation_id ?? context.operation_id,
     attempt_id: scopeOverrides.attempt_id ?? context.attempt_id,
   };
   const key = canonicalHash({ event, identity, scope }, 32);
   return dispatchHookBoundary(
     this.hookPort ?? this.config.hooks,
     {
       event,
       invocation_id: `hook-${key}`,
       idempotency_key: `hook-idempotency-${key}`,
       scope,
       payload,
       ...spreadIfDefined('signal', this.config.signal),
     },
     {
       mode,
       ...spreadIfDefined('timeout_ms', this.config.hookTimeoutMs),
     },
   );
 }

 private isTaskContract(value: unknown): value is TaskContract {
   if (value === null) return false;
   if (typeof value !== 'object') return false;
   if (Array.isArray(value)) return false;
   const candidate = value as Partial<TaskContract>;
   if (typeof candidate.goal !== 'string') return false;
   if (candidate.goal.trim().length === 0) return false;
   if (!Array.isArray(candidate.success_criteria)) return false;
   if (!Array.isArray(candidate.constraints)) return false;
   return true;
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

  /** P2-12: Expose LLM cache metrics. */
  getCacheMetrics(): Record<string, unknown> {
    return this.cacheManager.getMetrics() as unknown as Record<string, unknown>;
  }

}
