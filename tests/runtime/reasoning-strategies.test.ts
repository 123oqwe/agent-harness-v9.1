import { describe, it, expect } from "vitest";
import {
  profileIntent,
  selectStrategy,
  type ReasoningStrategy,
} from "../../router/static-router.js";
import type { TaskContract } from "../../contracts/index.js";
import { runDirect } from "../../runtime/direct.js";
import { runPlanExecute } from "../../runtime/plan-execute.js";
import { runReact } from "../../runtime/react.js";
import type { StrategyContext } from "../../runtime/reasoning-strategy.js";
import type { LoopTurn, TerminationReason } from "../../runtime/loop.js";

function task(goal: string): TaskContract {
  return {
    goal,
    success_criteria: [
      { criterion: "done", verification_method: "deterministic" },
    ],
    constraints: [],
  } as TaskContract;
}

function strategyContext(strategy: "direct" | "react" | "plan_execute") {
  const terminations: TerminationReason[] = [];
  const turns: LoopTurn[] = [];
  let terminated = false;
  const context: StrategyContext = {
    config: {
      strategy,
      max_iterations: 2,
      run_id: `strategy-${strategy}`,
      goal: "return a deterministic answer",
    },
    deps: {
      session: { append: () => undefined } as never,
      modelCall: async () => ({
        content: "done",
        decision_summary: "completed without a tool",
        stop_reason: "stop",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    },
    turns,
    iterations: 0,
    get terminated() {
      return terminated;
    },
    decisionSummaries: [],
    startTime: 0,
    preflight: () => null,
    nextModelBudget: () => ({ remaining_tokens: 10, max_output_tokens: 10 }),
    budgetExceeded: () => false,
    recordTurn: (turn) => {
      const recorded: LoopTurn = {
        iteration: context.iterations,
        model: turn,
        tool_observations: [],
        timestamp: "2026-01-01T00:00:00.000Z",
      };
      turns.push(recorded);
      return recorded;
    },
    recordToolCall: () => undefined,
    recordObservation: () => {
      throw new Error("tool observation is unreachable in this fixture");
    },
    terminate: (reason) => {
      terminations.push(reason);
      terminated = true;
    },
    setStepState: () => undefined,
  };
  return { context, terminations, turns };
}

describe("reasoning strategies", () => {
  it("binds the three executable strategy authorities", () => {
    expect(
      [runDirect, runReact, runPlanExecute].every(
        (strategy) => typeof strategy === "function",
      ),
    ).toBe(true);
  });
  it("executes direct and exposes its terminal state", async () => {
    const { context, terminations, turns } = strategyContext("direct");
    await runDirect(context, []);
    expect({
      iterations: context.iterations,
      terminations,
      turns: turns.length,
    }).toEqual({ iterations: 1, terminations: ["completed"], turns: 1 });
  });
  it("executes react and exposes its terminal state", async () => {
    const { context, terminations, turns } = strategyContext("react");
    await runReact(context, []);
    expect({
      iterations: context.iterations,
      terminations,
      turns: turns.length,
    }).toEqual({ iterations: 1, terminations: ["completed"], turns: 1 });
  });
  it("rejects plan_execute without a frozen RunPlan", async () => {
    const { context } = strategyContext("plan_execute");
    await expect(runPlanExecute(context, [])).rejects.toThrow(
      "plan_execute requires a frozen RunPlan",
    );
  });
  it("direct: tool-free single-call task", () => {
    expect(
      selectStrategy(
        profileIntent(task("rewrite this paragraph more concisely")),
      ),
    ).toBe<ReasoningStrategy>("direct");
  });
  it("react: observation-dependent tool task", () => {
    expect(
      selectStrategy(
        profileIntent(task("list the directory and read the matching file")),
      ),
    ).toBe<ReasoningStrategy>("react");
  });
  it("plan_execute: dependent multi-step write+test", () => {
    expect(
      selectStrategy(
        profileIntent(task("fix the bug then run the tests then verify")),
      ),
    ).toBe<ReasoningStrategy>("plan_execute");
  });
  it("plan_execute: explicit plan request", () => {
    expect(
      selectStrategy(
        profileIntent(task("plan the feature implementation step by step")),
      ),
    ).toBe<ReasoningStrategy>("plan_execute");
  });
  it("direct: no tools, no multi-step", () => {
    const i = profileIntent(task("translate this to French"));
    expect(i.requires_tools).toBe(false);
    expect(i.multi_step).toBe(false);
    expect(selectStrategy(i)).toBe<ReasoningStrategy>("direct");
  });
  it("react: requires tool but not multi-step", () => {
    const i = profileIntent(task("search for the keyword in the file"));
    expect(i.requires_tools).toBe(true);
    expect(i.multi_step).toBe(false);
    expect(selectStrategy(i)).toBe<ReasoningStrategy>("react");
  });
  it("plan_execute: writes and tests together", () => {
    const i = profileIntent(task("implement the feature and run the tests"));
    expect(i.requires_writes).toBe(true);
    expect(i.requires_tests).toBe(true);
    expect(i.multi_step).toBe(true);
    expect(selectStrategy(i)).toBe<ReasoningStrategy>("plan_execute");
  });
  it("strategies are mutually exclusive for a given task", () => {
    const strategies = new Set<ReasoningStrategy>();
    strategies.add(selectStrategy(profileIntent(task("rewrite text"))));
    strategies.add(selectStrategy(profileIntent(task("read the file"))));
    strategies.add(selectStrategy(profileIntent(task("fix bug then test"))));
    expect(strategies.size).toBe(3);
  });
});
