/**
 * AH-RUNTIME-001: Runtime Loop
 *
 * Connects request -> intent -> route -> plan -> step -> attempt ->
 * policy -> model/tool -> observation -> verification -> result.
 * All state changes append to DurableSession.
 */

import { profileIntent } from '../router/intent-profiler.js';
import { staticRouter, type RoutingResult } from '../router/static-router.js';
import { DurableSession } from '../session/durable-session.js';
import { NotificationQueue } from './notifications.js';
import { DirectStrategy } from './direct.js';
import { ReactStrategy } from './react.js';
import { PlanExecuteStrategy } from './plan-execute.js';
import type { ReasoningStrategyHandler, StrategyContext, ToolExecutor, ModelCaller } from './reasoning-strategy.js';
import type { Message, ProviderRequest, ParsedResponse } from '../gateway/provider.js';

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
}

export interface RuntimeLoopOptions {
  toolExecutor?: ToolExecutor;
  modelCaller?: ModelCaller;
  run_id?: string;
}

export class RuntimeLoop {
  private readonly session: DurableSession;
  private readonly notifications: NotificationQueue;

  constructor(opts: RuntimeLoopOptions = {}) {
    const runId = opts.run_id ?? `run-${Date.now()}`;
    this.session = new DurableSession(runId);
    this.notifications = new NotificationQueue();
  }

  async execute(request: RuntimeRequest, opts: RuntimeLoopOptions = {}): Promise<RuntimeResult> {
    const runId = this.session.lastSeq > 0 ? (this.session.getState('run_id') as string) : `run-${Date.now()}`;

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
      data: {
        strategy: routing.strategy,
        reason_code: routing.reason.code,
        features,
      },
    });

    // 3. Strategy selection
    const strategy = this.selectStrategy(routing.strategy);

    // 4. Build context
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

    // 5. Build messages
    const messages: Message[] = request.messages ?? [
      { role: 'user', content: request.prompt },
    ];

    this.session.append({
      type: 'step_created',
      run_id: runId,
      step_id: 'step-001',
      data: { strategy: routing.strategy },
    });

    this.session.append({
      type: 'step_started',
      run_id: runId,
      step_id: 'step-001',
      data: {},
    });

    // 6. Execute strategy
    const modelCaller = opts.modelCaller ?? this.createDefaultModelCaller(request.prompt);
    const result = await strategy.execute(messages, ctx, modelCaller, opts.toolExecutor);

    // 7. Record model calls
    for (let i = 0; i < result.model_calls; i++) {
      this.session.append({
        type: 'model_called',
        run_id: runId,
        step_id: 'step-001',
        data: { call_index: i },
      });
    }

    // 8. Record tool calls
    for (const obs of result.observations) {
      const toolName = obs.match(/^\[([^\]]+)\]/)?.[1] ?? 'unknown';
      this.session.append({
        type: 'tool_called',
        run_id: runId,
        step_id: 'step-001',
        data: { tool_name: toolName, observation: obs },
      });
    }

    // 9. Record denials
    for (const denial of result.denied_actions) {
      this.session.append({
        type: 'action_denied',
        run_id: runId,
        step_id: 'step-001',
        data: { tool_name: denial, reason: denial },
      });
    }

    // 10. Complete
    const stopType = result.stop_reason === 'completed' ? 'step_completed' : 'step_failed';
    this.session.append({
      type: stopType,
      run_id: runId,
      step_id: 'step-001',
      data: { stop_reason: result.stop_reason },
    });

    const runType = result.stop_reason === 'completed' ? 'run_completed' : 'run_failed';
    this.session.append({
      type: runType,
      run_id: runId,
      data: { stop_reason: result.stop_reason },
    });

    // 11. Generate notifications
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
      case 'direct':
        return new DirectStrategy();
      case 'react':
        return new ReactStrategy();
      case 'plan_execute':
        return new PlanExecuteStrategy();
      default:
        return new DirectStrategy();
    }
  }

  private createDefaultModelCaller(prompt: string): ModelCaller {
    return {
      complete(_req: ProviderRequest): ParsedResponse {
        return {
          content: `Response to: ${prompt}`,
          stop_reason: 'stop',
          usage: { input_tokens: prompt.length, output_tokens: 20 },
        };
      },
    };
  }
}
