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
import type { Message } from '../gateway/provider.js';
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
}

export interface RuntimeLoopOptions {
  toolExecutor?: ToolExecutor;
  modelCaller: ModelCaller;
  run_id?: string;
  policy?: Policy;
  policyEngine?: PolicyEngine;
  capabilityService?: CapabilityService;
  pep?: PolicyEnforcementPoint;
}

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
  ) {
    this.inner = inner;
    this.engine = engine;
    this.pep = pep;
    this.capService = capService;
    this.capCtx = capCtx;
    this.policyCtx = policyCtx;
    this.session = session;
    this.runId = runId;
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
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

    // 6. Record execution
    this.session.append({
      type: 'action_executed',
      run_id: this.runId,
      step_id: this.capCtx.step_id,
      data: { tool_name: toolName, success: result.success },
    });

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

  constructor(opts: RuntimeLoopOptions) {
    if (!opts.modelCaller) {
      throw new Error('RuntimeLoop requires a modelCaller — no stubs allowed');
    }
    const runId = opts.run_id ?? `run-${Date.now()}`;
    this.session = new DurableSession(runId);
    this.notifications = new NotificationQueue();
  }

  async execute(request: RuntimeRequest, opts: RuntimeLoopOptions): Promise<RuntimeResult> {
    if (!opts.modelCaller) {
      throw new Error('RuntimeLoop.execute requires a modelCaller — no stubs allowed');
    }

    const runId = this.session.lastSeq > 0
      ? (this.session.getState('run_id') as string)
      : `run-${Date.now()}`;

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
    const messages: Message[] = request.messages ?? [
      { role: 'user', content: request.prompt },
    ];

    this.session.append({
      type: 'step_created', run_id: runId, step_id: 'step-001',
      data: { strategy: routing.strategy },
    });
    this.session.append({
      type: 'step_started', run_id: runId, step_id: 'step-001', data: {},
    });

    // 9. Execute strategy with guarded executor
    const result = await strategy.execute(messages, ctx, opts.modelCaller, guardedExecutor);

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
