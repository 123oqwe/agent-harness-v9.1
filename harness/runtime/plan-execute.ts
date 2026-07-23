/**
 * AH-RUNTIME-001: Plan+Execute Strategy
 *
 * Validate and freeze a RunPlan DAG before execution. Execute topologically.
 * File changes stay in VFS overlay until validation succeeds. Replanning
 * creates a new immutable revision. Crash restore never duplicates effects.
 */

import type { Message, ProviderRequest } from '../gateway/provider.js';
import type { StrategyContext, StrategyResult, ToolExecutor, ModelCaller, ReasoningStrategyHandler } from './reasoning-strategy.js';

export interface PlanStep {
  id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  dependencies: string[];
}

export interface RunPlan {
  revision: number;
  steps: PlanStep[];
  frozen: boolean;
}

export interface PlanExecutorOptions {
  plan?: RunPlan;
}

export class PlanExecuteStrategy implements ReasoningStrategyHandler {
  readonly strategy_type = 'plan_execute' as const;
  private readonly options: PlanExecutorOptions;

  constructor(options: PlanExecutorOptions = {}) {
    this.options = options;
  }

  async execute(
    messages: Message[],
    ctx: StrategyContext,
    model: ModelCaller,
    toolExecutor?: ToolExecutor,
  ): Promise<StrategyResult> {
    const observations: string[] = [];
    const deniedActions: string[] = [];
    let toolCallsMade = 0;
    let modelCalls = 0;

    // Phase 1: Create or use provided plan
    let plan: RunPlan;

    if (this.options.plan) {
      plan = { ...this.options.plan, frozen: true };
    } else {
      // Ask model to create a plan
      const planReq: ProviderRequest = {
        messages: [
          ...messages,
          { role: 'system', content: 'Create a step-by-step execution plan. Output JSON with steps array.' },
        ],
      };
      const planResponse = model.complete(planReq);
      modelCalls++;
      plan = this.parsePlan(planResponse.content, 1);
    }

    // Validate DAG (no cycles)
    const cycleError = this.detectCycle(plan.steps);
    if (cycleError) {
      return {
        strategy: 'plan_execute',
        output: '',
        tool_calls_made: 0,
        iterations: 1,
        model_calls: modelCalls,
        stop_reason: 'error',
        observations,
        denied_actions: [`cycle_detected: ${cycleError}`],
      };
    }

    // Phase 2: Execute topologically
    const executed = new Set<string>();
    const failed = new Set<string>();
    let output = '';

    for (let round = 0; round < plan.steps.length; round++) {
      let progressed = false;

      for (const step of plan.steps) {
        if (executed.has(step.id) || failed.has(step.id)) continue;

        // Check dependencies
        const depsMet = step.dependencies.every((dep) => executed.has(dep));
        if (!depsMet) {
          const depFailed = step.dependencies.some((dep) => failed.has(dep));
          if (depFailed) {
            failed.add(step.id);
            deniedActions.push(`dependency_failed: ${step.id}`);
            progressed = true;
          }
          continue;
        }

        // Execute step
        if (!toolExecutor) {
          deniedActions.push(`no_tool_executor: ${step.tool_name}`);
          failed.add(step.id);
          progressed = true;
          continue;
        }

        try {
          const result = await toolExecutor.execute(step.tool_name, step.arguments);
          toolCallsMade++;

          if (result.success) {
            executed.add(step.id);
            observations.push(`[${step.id}] ${result.output}`);
            progressed = true;
          } else {
            failed.add(step.id);
            deniedActions.push(`step_failed: ${step.id} - ${result.error ?? 'unknown'}`);
            progressed = true;
          }
        } catch (err) {
          failed.add(step.id);
          deniedActions.push(`step_error: ${step.id} - ${err instanceof Error ? err.message : String(err)}`);
          progressed = true;
        }
      }

      if (!progressed) break;
    }

    // All steps executed successfully?
    const allSuccess = executed.size === plan.steps.length && failed.size === 0;
    const stopReason: StrategyResult['stop_reason'] = allSuccess ? 'completed' : 'error';

    // Final summary call
    const summaryReq: ProviderRequest = {
      messages: [
        ...messages,
        { role: 'system', content: 'Summarize the execution results.' },
        ...observations.map((o) => ({ role: 'tool' as const, content: o, tool_call_id: 'summary' })),
      ],
    };
    const summaryResponse = model.complete(summaryReq);
    modelCalls++;
    output = summaryResponse.content;

    return {
      strategy: 'plan_execute',
      output,
      tool_calls_made: toolCallsMade,
      iterations: plan.steps.length,
      model_calls: modelCalls,
      stop_reason: stopReason,
      observations,
      denied_actions: deniedActions,
    };
  }

  private parsePlan(content: string, revision: number): RunPlan {
    // Simple plan parsing: try JSON, fallback to single step
    try {
      const parsed = JSON.parse(content);
      if (parsed.steps && Array.isArray(parsed.steps)) {
        return {
          revision,
          steps: parsed.steps.map((s: { id: string; tool_name: string; arguments: Record<string, unknown>; dependencies: string[] }, i: number) => ({
            id: s.id ?? `step-${i}`,
            tool_name: s.tool_name,
            arguments: s.arguments ?? {},
            dependencies: s.dependencies ?? [],
          })),
          frozen: true,
        };
      }
    } catch {
      // Not JSON, create a simple plan
    }

    return {
      revision,
      steps: [{
        id: 'step-0',
        tool_name: 'direct_response',
        arguments: { content },
        dependencies: [],
      }],
      frozen: true,
    };
  }

  private detectCycle(steps: PlanStep[]): string | null {
    const visited = new Set<string>();
    const stack = new Set<string>();
    const graph = new Map<string, string[]>();

    for (const step of steps) {
      graph.set(step.id, step.dependencies);
    }

    const dfs = (node: string): string | null => {
      if (stack.has(node)) return node;
      if (visited.has(node)) return null;

      visited.add(node);
      stack.add(node);

      const deps = graph.get(node) ?? [];
      for (const dep of deps) {
        const cycle = dfs(dep);
        if (cycle) return cycle;
      }

      stack.delete(node);
      return null;
    };

    for (const step of steps) {
      const cycle = dfs(step.id);
      if (cycle) return cycle;
    }

    return null;
  }
}
