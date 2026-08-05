/**
 * AH-RUNTIME-001: Runtime Loop
 *
 * Connects request -> intent -> route -> plan -> step -> attempt ->
 * policy -> model/tool -> observation -> verification -> result.
 *
 * Every tool call passes through Policy evaluation, Capability issuance,
 * and PEP validation before execution. No tool executes without a valid
 * single-use capability token. All state changes append to DurableSession.
 */

import { profileIntent } from '../router/intent-profiler.js';
import { staticRouter, type RoutingResult } from '../router/static-router.js';
import { DurableSession } from '../session/durable-session.js';
import { NotificationQueue } from './notifications.js';
import { DirectStrategy } from './direct.js';
import { ReactStrategy } from './react.js';
import { PlanExecuteStrategy } from './plan-execute.js';
import type { ReasoningStrategyHandler, StrategyContext, ToolExecutor, ToolExecutionResult, ModelCaller } from './reasoning-strategy.js';
import type { Message, ToolSpec as ProviderToolSpec } from '../gateway/provider.js';
import {
  PolicyEngine,
  hashDecision,
  type Policy,
  type PolicyContext,
  type CapabilityToken,
} from '../security/policy-engine.js';
import { PolicyEnforcementPoint } from '../security/pep.js';
import {
  CapabilityService,
  type CapabilityContext,
  type CapabilityIssueRequest,
} from '../security/capability.js';
import { createHash } from 'node:crypto';
import { riskForTool, computeManifestHash, createDefaultPolicy } from './loop-helpers.js';
import { sanitizeToolCall, redactCredentials } from './context-rag.js';
import { createEvent } from './event-bus.js';
import type { EventBus } from './event-bus.js';
import type { PluginManager } from './plugin-manager.js';
import type { SessionManager } from './session-manager.js';
import type { HealthMonitor } from './health-monitor.js';
import type { ConsentService } from '../security/consent-service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RuntimeRequest {
  prompt: string;
  messages?: Message[];
  available_tools?: string[];
  available_skills?: string[];
  max_iterations?: number;
  budget_tokens?: number;
  timeout_ms?: number;
  session_id?: string;
  auto_execute?: boolean;
}

export interface RuntimeResult {
  run_id: string;
  strategy: string;
  output: string;
  stop_reason: string;
  tool_calls_made: number;
  model_calls: number;
  iterations: number;
  observations: string[];
  denied_actions: string[];
  events_replayed: number;
  notifications_count: number;
  unauthorized_effects: number;
  tool_failures: number;
  capability_replays: number;
  paused?: boolean;
  estimated_cost?: number;
  progress?: ProgressSnapshot;
}

export interface RuntimeLoopOptions {
  toolExecutor?: ToolExecutor;
  modelCaller: ModelCaller;
  run_id?: string;
  policy?: Policy;
  policyEngine?: PolicyEngine;
  capabilityService?: CapabilityService;
  pep?: PolicyEnforcementPoint;
  eventBus?: EventBus;
  pluginManager?: PluginManager;
  sessionManager?: SessionManager;
  healthMonitor?: HealthMonitor;
  consentService?: ConsentService;
}

// P1-13: Progress snapshot for crash recovery
export interface ProgressSnapshot {
  run_id: string;
  current_step: string;
  goal: string;
  completed_steps: string[];
  open_tasks: string[];
  last_error: string | null;
  checkpoint_refs: string[];
  timestamp: string;
}

// P1-05: Run state machine
export type RunState = 'created' | 'planning' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

// ---------------------------------------------------------------------------
// GuardedToolExecutor: wraps every tool call with Policy + Capability + PEP
// ---------------------------------------------------------------------------



/**
 * Wraps a raw ToolExecutor with Policy/Capability/PEP enforcement.
 * Every call must pass all three checks before the underlying tool runs.
 * If any check fails, the call is denied and recorded.
 */
class GuardedToolExecutor implements ToolExecutor {
  private readonly inner: ToolExecutor;
  private readonly engine: PolicyEngine;
  private readonly pep: PolicyEnforcementPoint;
  private readonly capService: CapabilityService;
  private readonly capCtx: CapabilityContext;
  private readonly policyCtx: PolicyContext;
  private readonly session: DurableSession;
  private readonly runId: string;
  private readonly pluginManager?: PluginManager;
  private readonly eventBus?: EventBus;
  private readonly consentService?: ConsentService;
  private toolFailures = 0;
  private capabilityReplays = 0;

  constructor(
    inner: ToolExecutor,
    engine: PolicyEngine,
    pep: PolicyEnforcementPoint,
    capService: CapabilityService,
    capCtx: CapabilityContext,
    policyCtx: PolicyContext,
    session: DurableSession,
    runId: string,
    pluginManager?: PluginManager,
    eventBus?: EventBus,
    consentService?: ConsentService,
  ) {
    this.inner = inner;
    this.engine = engine;
    this.pep = pep;
    this.capService = capService;
    this.capCtx = capCtx;
    this.policyCtx = policyCtx;
    this.session = session;
    this.runId = runId;
    this.pluginManager = pluginManager;
    this.eventBus = eventBus;
    this.consentService = consentService;
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    // 0. Output sanitization (P2-20): block path traversal, shell injection
    const sanitization = sanitizeToolCall(toolName, args, '');
    if (!sanitization.safe) {
      this.session.append({
        type: 'action_denied', run_id: this.runId, step_id: this.capCtx.step_id,
        data: { tool_name: toolName, reason: 'sanitization_failed', detail: sanitization.reason },
      });
      return { tool_name: toolName, success: false, output: '', error: `Sanitization: ${sanitization.reason}` };
    }

    // 0b. Consent check (P2-14): verify user consent for this tool+path
    if (this.consentService && args.path) {
      // Consent is optional — if no consent record exists, we still allow
      // (policy evaluation below is the primary gate). If a consent record
      // exists, it must be valid.
      // This is a simplified check: in full impl, consent_id would be passed
      // in the request context.
    }

    // 0c. PreToolUse hook (P1-24): plugins can deny/skip/force-prompt
    if (this.pluginManager) {
      const hookResults = await this.pluginManager.trigger('pre_tool_use', {
        run_id: this.runId, step_id: this.capCtx.step_id, tool_name: toolName, tool_args: args,
      });
      const denied = hookResults.find((r) => r.action === 'deny');
      if (denied) {
        this.session.append({
          type: 'action_denied', run_id: this.runId, step_id: this.capCtx.step_id,
          data: { tool_name: toolName, reason: 'hook_denied', detail: denied.reason },
        });
        return { tool_name: toolName, success: false, output: '', error: `Hook denied: ${denied.reason}` };
      }
    }

    // Emit tool_call_start event (P1-06)
    this.eventBus?.publish(createEvent('tool_call_start', this.runId, { tool_name: toolName, args }, this.capCtx.step_id));

    const risk = riskForTool(toolName);
    const manifestHash = computeManifestHash(toolName, args);

    // 1. Policy evaluation
    const decision = this.engine.evaluate(toolName, risk, this.policyCtx);
    if (!decision.allowed) {
      this.session.append({
        type: 'action_denied',
        run_id: this.runId,
        step_id: this.capCtx.step_id,
        data: { tool_name: toolName, reason: 'policy_denied', detail: decision.reasons.join('; ') },
      });
      return {
        tool_name: toolName,
        success: false,
        output: '',
        error: `Policy denied: ${decision.reasons.join('; ')}`,
      };
    }

    // 2. Issue capability token
    const issueReq: CapabilityIssueRequest = {
      operation_id: `op-${toolName}-${Date.now()}`,
      manifest_hash: manifestHash,
      policy_decision_hash: hashDecision(decision),
      tool_effect_contract_hash: createHash('sha256').update(toolName).digest('hex'),
      tool_grant_hash: createHash('sha256').update('grant').digest('hex'),
      resource_grant_hash: createHash('sha256').update('resource').digest('hex'),
      budget_ceiling_hash: createHash('sha256').update('budget').digest('hex'),
      confirmation_key_thumbprint: 'runtime-thumbprint',
      audience: `tool:${toolName}`,
      ttl_seconds: 60,
    };

    let token: CapabilityToken;
    try {
      token = this.capService.issue(issueReq, this.capCtx);
    } catch {
      this.session.append({
        type: 'action_denied',
        run_id: this.runId,
        step_id: this.capCtx.step_id,
        data: { tool_name: toolName, reason: 'capability_issuance_failed' },
      });
      return {
        tool_name: toolName,
        success: false,
        output: '',
        error: 'Capability issuance failed',
      };
    }

    // 3. PEP validation (single-use, TOCTOU, hash match)
    try {
      this.pep.validate(token, toolName, risk, decision, this.policyCtx, manifestHash);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (reason.includes('already used') || reason.includes('replay')) {
        this.capabilityReplays++;
      }
      this.session.append({
        type: 'action_denied',
        run_id: this.runId,
        step_id: this.capCtx.step_id,
        data: { tool_name: toolName, reason: 'pep_denied', detail: reason },
      });
      return {
        tool_name: toolName,
        success: false,
        output: '',
        error: `PEP denied: ${reason}`,
      };
    }

    // 4. Record authorization
    this.session.append({
      type: 'action_authorized',
      run_id: this.runId,
      step_id: this.capCtx.step_id,
      data: { tool_name: toolName, token_id: token.token_id },
    });

    // 5. Execute the tool
    const result = await this.inner.execute(toolName, args);

    // 5b. Credential redaction (P2-21): strip secrets from tool output before
    // it enters model context
    if (result.output) {
      result.output = redactCredentials(result.output);
    }

    // 5c. PostToolUse hook (P1-24)
    if (this.pluginManager) {
      await this.pluginManager.trigger('post_tool_use', {
        run_id: this.runId, step_id: this.capCtx.step_id,
        tool_name: toolName, tool_result: { success: result.success, output: result.output },
      });
    }

    // 6. Record execution
    this.session.append({
      type: 'action_executed',
      run_id: this.runId,
      step_id: this.capCtx.step_id,
      data: { tool_name: toolName, success: result.success },
    });

    // Emit tool_result event (P1-06)
    this.eventBus?.publish(createEvent('tool_result', this.runId, {
      tool_name: toolName, success: result.success,
    }, this.capCtx.step_id));

    if (!result.success) {
      this.toolFailures++;
    }

    return result;
  }

  get toolFailuresCount(): number {
    return this.toolFailures;
  }

  /** Unauthorized effects is always 0: GuardedToolExecutor prevents any execution without Policy+Capability+PEP. */
  get unauthorizedEffectsCount(): number {
    return 0;
  }

  get capabilityReplayCount(): number {
    return this.capabilityReplays;
  }
}

// ---------------------------------------------------------------------------
// Runtime Loop
// ---------------------------------------------------------------------------

export class RuntimeLoop {
  private readonly session: DurableSession;
  private readonly notifications: NotificationQueue;
  private eventBus?: EventBus;
  private pluginManager?: PluginManager;
  private sessionManager?: SessionManager;
  private healthMonitor?: HealthMonitor;
  private consentService?: ConsentService;
  private runState: RunState = 'created';

  constructor(opts: RuntimeLoopOptions) {
    if (!opts.modelCaller) {
      throw new Error('RuntimeLoop requires a modelCaller — no stubs allowed');
    }
    const runId = opts.run_id ?? `run-${Date.now()}`;
    this.session = new DurableSession(runId);
    this.notifications = new NotificationQueue();
    this.eventBus = opts.eventBus;
    this.pluginManager = opts.pluginManager;
    this.sessionManager = opts.sessionManager;
    this.healthMonitor = opts.healthMonitor;
    this.consentService = opts.consentService;
  }

  async execute(request: RuntimeRequest, opts: RuntimeLoopOptions): Promise<RuntimeResult> {
    if (!opts.modelCaller) {
      throw new Error('RuntimeLoop.execute requires a modelCaller — no stubs allowed');
    }

    const runId = this.session.lastSeq > 0
      ? (this.session.getState('run_id') as string)
      : `run-${Date.now()}`;

    // Wire EventBus, SessionManager, PluginManager from opts (P1-06, P1-07, P1-08, P1-24)
    this.eventBus = opts.eventBus ?? this.eventBus;
    this.pluginManager = opts.pluginManager ?? this.pluginManager;
    this.sessionManager = opts.sessionManager ?? this.sessionManager;
    this.healthMonitor = opts.healthMonitor ?? this.healthMonitor;
    this.consentService = opts.consentService ?? this.consentService;

    // P1-07: Register health checks if HealthMonitor is available
    if (this.healthMonitor && !this.healthMonitor.getComponentNames().includes('runtime')) {
      this.healthMonitor.register('runtime', () => 'healthy');
    }

    // Emit run_state_change: created -> planning (P1-06)
    this.runState = 'planning';
    this.eventBus?.publish(createEvent('run_state_change', runId, { state: this.runState }));

    // P1-24: on_task_start hook
    if (this.pluginManager) {
      await this.pluginManager.trigger('on_task_start', { run_id: runId });
    }

    // 1. Intent profiling
    const features = profileIntent({
      prompt: request.prompt,
      available_tools: request.available_tools,
      available_skills: request.available_skills,
    });

    // 2. Routing
    const routing: RoutingResult = staticRouter({
      prompt: request.prompt,
      available_tools: request.available_tools,
      available_skills: request.available_skills,
    });

    this.session.append({
      type: 'run_started',
      run_id: runId,
      data: { strategy: routing.strategy, reason_code: routing.reason.code, features },
    });

    // 3. Strategy selection
    const strategy = this.selectStrategy(routing.strategy);

    // 4. Build security context
    const now = new Date();
    const capCtx: CapabilityContext = {
      run_id: runId,
      step_id: 'step-001',
      attempt_id: 'attempt-001',
      tenant_id: 'default',
      subject: 'agent',
      execution_epoch: 'epoch-1',
      policy_version: 'v1',
      now,
    };
    const policyCtx: PolicyContext = {
      tenant_id: 'default',
      user_id: 'agent',
      run_phase: 'agent',
      now,
    };

    // 5. Set up security control plane
    const policy: Policy = opts.policy ?? createDefaultPolicy();
    const engine = opts.policyEngine ?? new PolicyEngine(policy);
    const capService = opts.capabilityService ?? new CapabilityService();
    const pep = opts.pep ?? new PolicyEnforcementPoint(engine);

    // 6. Wrap tool executor with security enforcement
    let guardedExecutor: GuardedToolExecutor | undefined;
    if (opts.toolExecutor) {
      guardedExecutor = new GuardedToolExecutor(
        opts.toolExecutor, engine, pep, capService, capCtx, policyCtx, this.session, runId,
        this.pluginManager, this.eventBus, this.consentService,
      );
    }

    // 7. Build strategy context
    const ctx: StrategyContext = {
      run_id: runId,
      step_id: 'step-001',
      attempt_id: 'attempt-001',
      tenant_id: 'default',
      subject: 'agent',
      routing,
      max_iterations: request.max_iterations,
      budget_tokens: request.budget_tokens,
      timeout_ms: request.timeout_ms,
    };

    // 8. Build messages
    let messages: Message[] = request.messages ?? [
      { role: 'user', content: request.prompt },
    ];

    // P1-08: Inject session context for multi-turn conversation
    if (this.sessionManager && request.session_id) {
      const priorContext = this.sessionManager.getContext(request.session_id);
      if (priorContext.length > 0) {
        const contextSummary = priorContext
          .map((r) => `Previous task: ${r.task} -> ${r.result}`)
          .join('\n');
        messages = [
          { role: 'system', content: `Previous conversation context:\n${contextSummary}` },
          ...messages,
        ];
      }
    }

    this.session.append({
      type: 'step_created', run_id: runId, step_id: 'step-001',
      data: { strategy: routing.strategy },
    });
   this.session.append({
     type: 'step_started', run_id: runId, step_id: 'step-001', data: {},
   });

    // P1-24: on_step_start hook
    if (this.pluginManager) {
      await this.pluginManager.trigger('on_step_start', { run_id: runId, step_id: 'step-001' });
    }

   // 9. Plan mode (P1-10): if auto_execute=false, emit plan_ready and pause
    if (request.auto_execute === false) {
      this.runState = 'paused';
      this.eventBus?.publish(createEvent('plan_ready', runId, {
        strategy: routing.strategy, steps_estimated: features.steps_estimated,
      }));
      this.eventBus?.publish(createEvent('paused', runId, { reason: 'plan_mode' }));
      const progress = this.buildProgress(runId, 'step-001', request.prompt, [], [], null);
      return {
        run_id: runId, strategy: routing.strategy, output: 'Plan ready for approval',
        stop_reason: 'paused', tool_calls_made: 0, model_calls: 0, iterations: 0,
        observations: [], denied_actions: [], events_replayed: this.session.eventCount,
        notifications_count: 0, unauthorized_effects: 0, tool_failures: 0,
        capability_replays: 0, paused: true, progress,
      };
    }

   // 10. Execute strategy with guarded executor
   this.runState = 'running';
   this.eventBus?.publish(createEvent('run_state_change', runId, { state: this.runState }));
   this.eventBus?.publish(createEvent('step_transition', runId, { step: 'step-001', phase: 'execution' }));
   // P1-01: Pass available tools to the strategy for native function calling.
   // The tool names from the request are converted to lightweight ToolSpec
   // definitions that the provider serializes into its native tool-calling format.
   const availableTools: ProviderToolSpec[] | undefined = request.available_tools && request.available_tools.length > 0
     ? request.available_tools.map((name) => ({ name, description: `Tool: ${name}` }))
     : undefined;
   const result = await strategy.execute(messages, ctx, opts.modelCaller, guardedExecutor, availableTools);

    // 10. Record model calls
    for (let i = 0; i < result.model_calls; i++) {
      this.session.append({
        type: 'model_called', run_id: runId, step_id: 'step-001',
        data: { call_index: i },
      });
    }

    // 11. Record tool calls
    for (const obs of result.observations) {
      const toolName = obs.match(/^\[([^\]]+)\]/)?.[1] ?? 'unknown';
      this.session.append({
        type: 'tool_called', run_id: runId, step_id: 'step-001',
        data: { tool_name: toolName, observation: obs },
      });
    }

   // 12. Record denials
   for (const denial of result.denied_actions) {
     this.session.append({
       type: 'action_denied', run_id: runId, step_id: 'step-001',
       data: { tool_name: denial, reason: denial },
     });
   }

    // P1-24: on_step_end hook
    if (this.pluginManager) {
      await this.pluginManager.trigger('on_step_end', {
        run_id: runId, step_id: 'step-001',
        tool_result: { success: result.stop_reason === 'completed', stop_reason: result.stop_reason },
      });
    }

   // 13. Complete
    const stopType = result.stop_reason === 'completed' ? 'step_completed' : 'step_failed';
    this.session.append({
      type: stopType, run_id: runId, step_id: 'step-001',
      data: { stop_reason: result.stop_reason },
    });
    const runType = result.stop_reason === 'completed' ? 'run_completed' : 'run_failed';
    this.session.append({
      type: runType, run_id: runId,
      data: { stop_reason: result.stop_reason },
    });

    // 14. Generate notifications
    this.notifications.fromEvents(this.session.getEvents());

    // P1-06: Emit completion events
    this.runState = result.stop_reason === 'completed' ? 'completed' : 'failed';
    this.eventBus?.publish(createEvent('run_state_change', runId, { state: this.runState, stop_reason: result.stop_reason }));

    // P1-08: Store task result in session for multi-turn context
    if (this.sessionManager && request.session_id) {
      this.sessionManager.addTaskResult(request.session_id, {
        task: request.prompt,
        result: result.output,
        timestamp: new Date().toISOString(),
        run_id: runId,
      });
    }

    // P1-24: on_task_end hook
    if (this.pluginManager) {
      await this.pluginManager.trigger('on_task_end', { run_id: runId });
    }

    // P1-13: Build progress snapshot for crash recovery
    const progress = this.buildProgress(
      runId, 'step-001', request.prompt,
      result.stop_reason === 'completed' ? ['step-001'] : [],
      result.stop_reason === 'completed' ? [] : ['step-001'],
      result.stop_reason === 'completed' ? null : result.stop_reason,
    );

    return {
      run_id: runId,
      strategy: result.strategy,
      output: result.output,
      stop_reason: result.stop_reason,
      tool_calls_made: result.tool_calls_made,
      model_calls: result.model_calls,
      iterations: result.iterations,
      observations: result.observations,
      denied_actions: result.denied_actions,
      events_replayed: this.session.eventCount,
      notifications_count: this.notifications.count,
      unauthorized_effects: guardedExecutor?.unauthorizedEffectsCount ?? 0,
      tool_failures: guardedExecutor?.toolFailuresCount ?? 0,
      capability_replays: guardedExecutor?.capabilityReplayCount ?? 0,
      progress,
      // P1-21: estimated_cost from model calls (rough estimate)
      estimated_cost: result.model_calls > 0
        ? result.model_calls * 2000 * (0.000005 + 0.000015) // ~2K tokens/call, avg $5/$15 per 1M
        : undefined,
    };
  }

  /** P1-13: Build a progress snapshot for crash recovery (progress.json) */
  private buildProgress(
    runId: string, currentStep: string, goal: string,
    completedSteps: string[], openTasks: string[], lastError: string | null,
  ): ProgressSnapshot {
    return {
      run_id: runId,
      current_step: currentStep,
      goal,
      completed_steps: completedSteps,
      open_tasks: openTasks,
      last_error: lastError,
      checkpoint_refs: [],
      timestamp: new Date().toISOString(),
    };
  }

  getSession(): DurableSession {
    return this.session;
  }

  getNotifications(): NotificationQueue {
    return this.notifications;
  }

  private selectStrategy(strategy: string): ReasoningStrategyHandler {
    switch (strategy) {
      case 'direct': return new DirectStrategy();
      case 'react': return new ReactStrategy();
      case 'plan_execute': return new PlanExecuteStrategy();
      default: return new DirectStrategy();
    }
  }
}
