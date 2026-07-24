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
import type { TaskContract } from '../spec/types/task-contract.js';
import type { RunPlan } from './router/static-router.js';
import { StaticRouter, type RoutingResult } from './router/static-router.js';
import type { ToolRegistry, RegistrySnapshot } from './tools/tool-registry.js';
import type { SkillRegistry, SkillRegistrySnapshot } from './tools/skill-registry.js';
import type { PolicyEngine } from './security/policy-engine.js';
import { createHash } from 'node:crypto';
import { DurableSession, persistSession } from './session/durable-session.js';
import { OverlayBackend } from './vfs/virtual-filesystem.js';
import { LoopEngine, type LoopResult, type ModelTurn } from './runtime/loop.js';
import type { VirtualFilesystem } from './vfs/virtual-filesystem.js';
import type { SandboxProfile } from './runtime/sandbox.js';
import { ToolExecutor } from './tools/tool-executor.js';
import { ToolDispatcher } from './tools/tool-dispatcher.js';
import type { AuthorizationService } from './security/authorization-service.js';
import type { InMemoryCapabilityStateStore } from './security/capability.js';
import type { PolicyEnforcementPoint } from './security/pep.js';
import { SkillLoader } from './skills/skill-loader.js';
import { SqliteSessionStore } from './session/sqlite-session-store.js';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

/** A provider port that can be called by the Runtime — typed, not a raw callback. */
export interface HarnessProvider {
  resolve(messages: Array<{ role: string; content: string }>): Promise<ModelTurn>;
}

/** Outcome returned to the caller (Vertical or user). */
export interface HarnessOutcome {
  run_plan: RunPlan | null;
  routing: RoutingResult;
  loop_result: LoopResult;
  session: DurableSession;
  evidence: {
    run_id: string;
    commit_sha: string;
    termination_reason: string;
    iterations: number;
    turns: number;
    decision_summaries: string[];
    session_events: number;
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
export function createDefaultExecutionContext(runId: string): ExecutionContext {
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
    clock: () => new Date().toISOString(),
 };
}

/** Injected security components — must be provided by the caller. */
export interface HarnessSecurityDeps {
  authz: AuthorizationService;
  pep: PolicyEnforcementPoint;
  stateStore: InMemoryCapabilityStateStore;
}

/** Configuration for the Harness — only typed components, no callbacks. */
export interface HarnessConfig {
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  policyEngine: PolicyEngine;
  vfs: VirtualFilesystem;
  sandbox: SandboxProfile;
  provider: HarnessProvider;
  security: HarnessSecurityDeps;
  executionContext?: ExecutionContext;
  dataDir?: string;
  sessionLogPath?: string;
}

function deterministicRunId(task: TaskContract): string {
  return 'run-' + createHash('sha256').update(task.goal).digest('hex').slice(0, 12);
}

export class Harness {
  private readonly config: HarnessConfig;
  private readonly toolSnapshot: RegistrySnapshot;
  private readonly skillSnapshot: SkillRegistrySnapshot;
  private readonly policySnapshotRef: string;
  private currentOverlay: OverlayBackend | null = null;
  private readonly auditLog: unknown[] = [];
  private execCtx: ExecutionContext | null = null;

  constructor(config: HarnessConfig) {
    this.config = config;
    this.execCtx = config.executionContext ?? null;
    this.toolSnapshot = config.toolRegistry.freezeSnapshot();
    this.skillSnapshot = config.skillRegistry.freezeSnapshot();
    this.policySnapshotRef = `policy-${config.policyEngine.policy_hash}`;
  }

  private now(): string {
    return this.execCtx?.clock() ?? new Date().toISOString();
  }

  /** Execute a TaskContract through the full Request-to-Outcome pipeline. */
  async run(task: TaskContract, runId?: string): Promise<HarnessOutcome> {
    const actualRunId = runId ?? `run-${deterministicRunId(task)}`;
  this.execCtx = this.config.executionContext ?? createDefaultExecutionContext(actualRunId);

  // 1. Create session (event log = source of truth)
  const session = new DurableSession(actualRunId);
  session.acquireWriter();

   // 1a. If dataDir provided, create SQLite store for immediate per-event persistence
   let sqliteStore: SqliteSessionStore | null = null;
   if (this.config.dataDir) {
     sqliteStore = new SqliteSessionStore(join(this.config.dataDir, 'session.db'));
     sqliteStore.createRun(actualRunId, task.goal, undefined);
     // Wrap session.append to persist each event to SQLite immediately
     const origAppend = session.append.bind(session);
     session.append = (type, data) => {
       const ev = origAppend(type, data);
       sqliteStore!.appendEvent(actualRunId, ev);
       return ev;
     };
   }

  // Create a per-Run overlay for write isolation
    const overlayPrefix = '/workspace';
    this.currentOverlay = new OverlayBackend(overlayPrefix);
    this.currentOverlay.setBaseBackend(this.config.vfs.route(overlayPrefix));

    // 2. StaticRouter: TaskContract → RunPlan (policy prefilter + strategy selection)
    const router = new StaticRouter({
      toolRegistry: this.config.toolRegistry,
      skillRegistry: this.config.skillRegistry,
      toolSnapshot: this.toolSnapshot,
      skillSnapshot: this.skillSnapshot,
      policyEngine: this.config.policyEngine,
      policySnapshotRef: this.policySnapshotRef,
    });
    const routing = router.route(task);

    if (routing.outcome !== 'route' || !routing.run_plan) {
      // Router deny is terminal: model_calls=0, tool_calls=0, no fake RunPlan
      session.append('error', { reason: 'routing_denied', outcome: routing.outcome, abstain_reason: routing.abstain_reason });
      session.releaseWriter();
      return {
        run_plan: routing.run_plan ?? null,
        routing,
        loop_result: {
          strategy: 'direct', iterations: 0, termination_reason: 'denied',
          turns: [], decision_summaries: [], progress_path: undefined, context_reset_emitted: false,
        },
        session,
        evidence: this.buildEvidence(session, routing.run_plan, 'denied', 0),
        success: false,
      };
    }

    const runPlan = routing.run_plan;

    // 2a. Skill activation: check if any required skills can activate
    const allowedTools = (this.config.policyEngine.snapshot as { allowed_tools: string[] }).allowed_tools;
    const skillLoader = new SkillLoader(
      this.config.skillRegistry,
      this.skillSnapshot,
      allowedTools,
    );
    const skillBindings = (runPlan.skill_bindings ?? []) as Array<{ skill_name?: string }>;
    let skillInstructions = '';
    if (skillBindings.length > 0 && skillBindings[0]!.skill_name) {
      try {
        const activation = await skillLoader.activate(skillBindings[0]!.skill_name);
        // Return instructions for context injection (not discarded)
        skillInstructions = `Skill: ${activation.skill.name} v${activation.frozen_version}`;
        session.append('system', { event: 'skill_activated', skill: skillBindings[0]!.skill_name, version: activation.frozen_version });
      } catch (e) {
        // Skill activation failure: log but continue (skill context is optional)
        session.append('error', { reason: 'skill_activation_failed', skill: skillBindings[0]!.skill_name, error: (e as Error).message });
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
        run_plan: runPlan,
      },
      {
        session,
        modelCall: async (messages: unknown[]) => {
          const typedMessages = messages as Array<{ role: string; content: string }>;
          const turn = await this.config.provider.resolve(typedMessages);
          return turn;
        },
        toolExecute: async (name: string, args: Record<string, unknown>) => {
          return this.executeTool(name, args, session);
        },
        goalSatisfied: (turns) => this.checkGoal(task, turns),
      },
    );

    const loopResult = await loop.run();

    // 3a. Finalize overlay: commit on success, discard on failure
    this.finalizeOverlay(loopResult.termination_reason === 'goal_satisfied' || loopResult.termination_reason === 'completed');

    // 4. Persist session if path provided
    if (this.config.sessionLogPath) {
      persistSession(session, this.config.sessionLogPath);
    }

    // 5. Build evidence
    const evidence = this.buildEvidence(session, runPlan, loopResult.termination_reason, loopResult.iterations);

    return {
      run_plan: runPlan,
      routing,
      loop_result: loopResult,
      session,
      evidence,
      success: loopResult.termination_reason === 'goal_satisfied' || loopResult.termination_reason === 'completed',
    };
  }

  /** Execute a tool through the ToolExecutor pipeline (Policy → Capability → PEP → VFS/Sandbox). */
private async executeTool(name: string, args: Record<string, unknown>, session: DurableSession): Promise<unknown> {
  const execCtxForTool = this.execCtx ? {
    tenant_id: this.execCtx.tenant_id,
    user_id: this.execCtx.user_id,
    run_id: this.execCtx.run_id,
    plan_id: this.execCtx.plan_id,
    step_id: this.execCtx.step_id,
    attempt_id: this.execCtx.attempt_id,
    operation_id: this.execCtx.operation_id,
    idempotency_key: this.execCtx.idempotency_key,
    confirmation_key_thumbprint: this.execCtx.confirmation_key_thumbprint,
  } : undefined;
  const executor = new ToolExecutor(
    { toolRegistry: this.config.toolRegistry, snapshot: this.toolSnapshot, vfs: this.config.vfs, sandbox: this.config.sandbox, policyEngine: this.config.policyEngine, session },
    {
      authz: this.config.security.authz,
      pep: this.config.security.pep,
      stateStore: this.config.security.stateStore,
      now: () => this.now(),
      ...(execCtxForTool ? { execCtx: execCtxForTool } : {}),
    },
   );
   // Route through ToolDispatcher: frozen snapshot → schema validation → ToolExecutor → receipt
   const dispatcher = new ToolDispatcher(this.config.toolRegistry, this.toolSnapshot, executor);
   const dispatchResult = await dispatcher.dispatch(
     { tool_name: name, input: args },
     async (deps) => this.dispatchToolViaDeps(name, args, (deps as { vfs: VirtualFilesystem }).vfs),
   );
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
      case 'execute_command_sandboxed': return executeCommand(this.config.sandbox, args as never);
      case 'create_artifact': return createArtifact(vfs, args as never);
      case 'parse_document': return parseDocument(vfs, args as never);
      case 'ask_user': throw new Error('ask_user must be handled by the caller, not dispatched');
      default: throw new Error(`unknown tool: ${name}`);
    }
  }

  /** Finalize the overlay: commit on success, discard on failure. */
  finalizeOverlay(success: boolean): void {
    if (!this.currentOverlay) return;
    if (success) {
      this.config.vfs.commitOverlay(this.currentOverlay);
    } else {
      this.config.vfs.discardOverlay(this.currentOverlay);
    }
    this.currentOverlay = null;
  }

  /** Goal verification — checks success criteria against the loop turns. */
  private checkGoal(task: TaskContract, turns: { model: { content: string; decision_summary: string } }[]): boolean {
    if (turns.length === 0) return false;
    const lastTurn = turns[turns.length - 1]!;
    const output = lastTurn.model.content + ' ' + lastTurn.model.decision_summary;
    for (const criterion of task.success_criteria ?? []) {
      if (!output.toLowerCase().includes(criterion.criterion.toLowerCase())) return false;
    }
    return true;
  }

  private buildEvidence(session: DurableSession, _runPlan: RunPlan | undefined, termination: string, iterations: number): HarnessOutcome['evidence'] {
    let commitSha = 'unknown';
    try { commitSha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(); } catch { /* not in git */ }
    return {
      run_id: session.session_id,
      commit_sha: commitSha,
      termination_reason: termination,
      iterations,
      turns: session.eventCount(),
      decision_summaries: session.getEvents().filter(e => e.type === 'assistant').map(e => (e.data as { decision_summary?: string }).decision_summary ?? ''),
      session_events: session.eventCount(),
    };
  }
}
