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
import { AuthorizationService } from './security/authorization-service.js';
import { SkillLoader, type SkillActivationResult } from './skills/skill-loader.js';
import { InMemoryCapabilityStateStore } from './security/capability.js';
import { PolicyEnforcementPoint } from './security/pep.js';
import { generateKeyPairSync } from 'node:crypto';
import { execSync } from 'node:child_process';

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

/** Configuration for the Harness — only typed components, no callbacks. */
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
   clock: (() => { const t = new Date().toISOString(); return () => t; })(),
 };
}

export interface HarnessConfig {
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  policyEngine: PolicyEngine;
  vfs: VirtualFilesystem;
  sandbox: SandboxProfile;
  provider: HarnessProvider;
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
  private currentTarget: unknown = null;

 constructor(config: HarnessConfig) {
   this.config = config;
   this.execCtx = config.executionContext ?? null;
   this.toolSnapshot = config.toolRegistry.freezeSnapshot();
   this.skillSnapshot = config.skillRegistry.freezeSnapshot();
   this.policySnapshotRef = `policy-${config.policyEngine.policy_hash}`;
   // Composition root: inject deps into ToolExecutor (not self-generated)
   const { privateKey, publicKey } = generateKeyPairSync('ed25519');
   this.injectedStateStore = new InMemoryCapabilityStateStore();
   this.injectedAuthz = new AuthorizationService({ private_key: privateKey, public_key: publicKey, state_store: this.injectedStateStore, now: () => this.now() });
   this.injectedPep = new PolicyEnforcementPoint({
     policy_engine: config.policyEngine,
     capability_authority: {
       verify_signature: async (token) => { try { const r = await this.injectedStateStore.read(token.token_id); return !!r; } catch { return false; } },
       consume: async (tokenId) => { if (this.consumedTokens.has(tokenId)) return false; this.consumedTokens.add(tokenId); return true; },
     },
     audit_sink: { write: async (entry) => { this.auditLog.push(entry); } },
     now: () => this.now(),
   });
 }
 private readonly injectedAuthz: AuthorizationService;
 private readonly injectedPep: PolicyEnforcementPoint;
 private readonly injectedStateStore: InMemoryCapabilityStateStore;
 private readonly consumedTokens = new Set<string>();
 private readonly auditLog: unknown[] = [];
 private execCtx: ExecutionContext | null = null;

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
   // Create a per-Run overlay for write isolation (stages writes, not committed until verification)
    const overlayPrefix = '/workspace';
    this.currentOverlay = new OverlayBackend(overlayPrefix);
    // Use VFS public API instead of accessing private backends array
    this.currentOverlay.setBaseBackend(this.config.vfs.route(overlayPrefix));
    this.currentTarget = null;

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
   let skillActivation: SkillActivationResult | null = null;
   // If the RunPlan has skill_bindings, try to activate the first one
   const skillBindings = (runPlan.skill_bindings ?? []) as Array<{ skill_name?: string }>;
   if (skillBindings.length > 0 && skillBindings[0]!.skill_name) {
     try {
       skillActivation = await skillLoader.activate(skillBindings[0]!.skill_name);
       session.append('system', { event: 'skill_activated', skill: skillBindings[0]!.skill_name, version: skillActivation.frozen_version });
     } catch {
       // Skill activation failure is non-fatal: continue without skill context
       session.append('error', { reason: 'skill_activation_failed', skill: skillBindings[0]!.skill_name });
     }
   }

   // 3. Runtime: execute the frozen RunPlan.reasoning_strategy
    const loop = new LoopEngine(
      {
        strategy: runPlan.reasoning_strategy,
        max_iterations: (runPlan.budget_allocation as { max_iterations: number }).max_iterations,
        run_id: runPlan.run_id,
        goal: task.goal,
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
   const executor = new ToolExecutor(
     { toolRegistry: this.config.toolRegistry, snapshot: this.toolSnapshot, vfs: this.config.vfs, sandbox: this.config.sandbox, policyEngine: this.config.policyEngine, session },
     { authz: this.injectedAuthz, pep: this.injectedPep, stateStore: this.injectedStateStore, now: () => this.now() },
   );
   const { result } = await executor.execute(name, args, async (deps) => {
     return this.dispatchToolViaDeps(name, args, deps.vfs);
   });
   return result;
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
      // Commit overlay to real VFS
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
    // Check each success criterion: criterion text must appear in the output
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
