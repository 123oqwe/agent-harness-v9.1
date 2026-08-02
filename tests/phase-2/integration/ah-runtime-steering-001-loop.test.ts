import { describe, expect, it } from "vitest";

import {
  SteeringController,
  type SteeringEvent,
  type SteeringJournalPort,
} from "../../../packages/runtime-core/src/index.js";
import { LoopEngine, type ModelTurn } from "../../../runtime/loop.js";
import { DurableSession } from "../../../session/durable-session.js";

class Journal implements SteeringJournalPort {
  constructor(readonly events: SteeringEvent[] = []) {}
  read(): readonly SteeringEvent[] {
    return structuredClone(this.events);
  }
  append(event: SteeringEvent): void {
    this.events.push(structuredClone(event));
  }
}

const scope = {
  tenant_id: "tenant-a",
  run_id: "run-a",
  session_id: "session-a",
};
const command = (id: string, priority: "human_correction" | "kill") => ({
  command_id: id,
  scope,
  queue: "steer" as const,
  priority,
  content: { text: id },
});

describe("AH-RUNTIME-STEERING-001 Loop integration", () => {
  it("interrupts a provider call and recompiles the current turn with user-trust steering", async () => {
    const steering = new SteeringController({ scope, journal: new Journal() });
    const seen: unknown[][] = [];
    let calls = 0;
    const loop = new LoopEngine(
      {
        strategy: "direct",
        max_iterations: 1,
        run_id: scope.run_id,
        goal: "initial goal",
      },
      {
        session: new DurableSession(scope.session_id),
        steering,
        modelCall: async (messages, _attempt, _budget, _directive, signal) => {
          calls += 1;
          seen.push(structuredClone(messages));
          if (calls === 1) {
            setTimeout(
              () =>
                steering.enqueue(command("correct-now", "human_correction")),
              0,
            );
            return new Promise<ModelTurn>((_resolve, reject) =>
              signal?.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                {
                  once: true,
                },
              ),
            );
          }
          return { content: "done", decision_summary: "done" };
        },
      },
    );

    const result = await loop.run();

    expect(result.termination_reason).toBe("completed");
    expect(calls).toBe(2);
    expect(seen[1]).toContainEqual({
      role: "user",
      content: { text: "correct-now" },
      metadata: {
        source: "steering",
        trust: "user",
        command_id: "correct-now",
        priority: "human_correction",
      },
    });
  });

  it("aborts an in-flight provider call when the kill priority arrives", async () => {
    const steering = new SteeringController({ scope, journal: new Journal() });
    const loop = new LoopEngine(
      {
        strategy: "direct",
        max_iterations: 1,
        run_id: scope.run_id,
        goal: "initial goal",
      },
      {
        session: new DurableSession(scope.session_id),
        steering,
        modelCall: async (_messages, _attempt, _budget, _directive, signal) => {
          setTimeout(() => steering.enqueue(command("kill-now", "kill")), 0);
          return new Promise<ModelTurn>((_resolve, reject) =>
            signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              {
                once: true,
              },
            ),
          );
        },
      },
    );

    await expect(loop.run()).resolves.toMatchObject({
      termination_reason: "user_cancel",
      iterations: 1,
    });
  });

  it("honors an unconsumed kill reconstructed from the event log before provider dispatch", async () => {
    const journal = new Journal();
    new SteeringController({ scope, journal }).enqueue({
      ...command("kill-before-crash", "kill"),
      queue: "next_turn",
    });
    const steering = new SteeringController({ scope, journal });
    let calls = 0;
    const loop = new LoopEngine(
      {
        strategy: "direct",
        max_iterations: 1,
        run_id: scope.run_id,
        goal: "must not dispatch",
      },
      {
        session: new DurableSession(scope.session_id),
        steering,
        modelCall: async () => {
          calls += 1;
          return { content: "unsafe", decision_summary: "unsafe" };
        },
      },
    );

    await expect(loop.run()).resolves.toMatchObject({
      termination_reason: "user_cancel",
      iterations: 0,
    });
    expect(calls).toBe(0);
  });

  it("does not lose steering that arrives during an asynchronous before-turn hook", async () => {
    const steering = new SteeringController({ scope, journal: new Journal() });
    let releaseHook: (() => void) | undefined;
    const hookStarted = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const seen: unknown[][] = [];
    const loop = new LoopEngine(
      {
        strategy: "direct",
        max_iterations: 1,
        run_id: scope.run_id,
        goal: "initial goal",
      },
      {
        session: new DurableSession(scope.session_id),
        steering,
        turnHooks: {
          beforeTurn: async () => hookStarted,
          afterTurn: async () => undefined,
        },
        modelCall: async (messages) => {
          seen.push(structuredClone(messages));
          return { content: "done", decision_summary: "done" };
        },
      },
    );

    const running = loop.run();
    await Promise.resolve();
    steering.enqueue(command("during-hook", "human_correction"));
    releaseHook?.();
    await running;

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: { text: "during-hook" },
      }),
    );
  });
});
