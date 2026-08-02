import { describe, expect, it, vi } from "vitest";

import {
  SteeringController,
  SteeringError,
  type SteeringEvent,
  type SteeringJournalPort,
  type SteeringScope,
} from "../../../packages/runtime-core/src/index.js";

class MemorySteeringJournal implements SteeringJournalPort {
  readonly events: SteeringEvent[] = [];

  constructor(events: readonly SteeringEvent[] = []) {
    this.events.push(...structuredClone(events));
  }

  read(): readonly SteeringEvent[] {
    return structuredClone(this.events);
  }

  append(event: SteeringEvent): void {
    this.events.push(structuredClone(event));
  }
}

const scope = (sessionId = "session-a"): SteeringScope => ({
  tenant_id: "tenant-a",
  run_id: "run-a",
  session_id: sessionId,
});

const request = (
  commandId: string,
  queue: "steer" | "follow_up" | "next_turn",
  priority:
    | "kill"
    | "security"
    | "human_cancel"
    | "human_correction"
    | "admin"
    | "user"
    | "supervisor"
    | "agent",
) => ({
  command_id: commandId,
  scope: scope(),
  queue,
  priority,
  content: { text: commandId },
});

describe("AH-RUNTIME-STEERING-001 steering authority", () => {
  it("delivers each queue only at its exact boundary", () => {
    const journal = new MemorySteeringJournal();
    const steering = new SteeringController({ scope: scope(), journal });
    steering.enqueue(request("current", "steer", "user"));
    steering.enqueue(request("after", "follow_up", "user"));
    steering.enqueue(request("next", "next_turn", "user"));

    expect(steering.drain("steer").map((item) => item.command_id)).toEqual([
      "current",
    ]);
    expect(steering.drain("steer")).toEqual([]);
    expect(steering.drain("follow_up").map((item) => item.command_id)).toEqual([
      "after",
    ]);
    expect(steering.drain("next_turn").map((item) => item.command_id)).toEqual([
      "next",
    ]);
  });

  it("uses the frozen priority order with FIFO ties", () => {
    const steering = new SteeringController({
      scope: scope(),
      journal: new MemorySteeringJournal(),
    });
    const priorities = [
      "agent",
      "user",
      "kill",
      "supervisor",
      "security",
      "admin",
      "human_correction",
      "human_cancel",
      "user",
    ] as const;
    priorities.forEach((priority, index) =>
      steering.enqueue(request(`command-${index}`, "steer", priority)),
    );

    expect(steering.drain("steer").map((item) => item.priority)).toEqual([
      "kill",
      "security",
      "human_cancel",
      "human_correction",
      "admin",
      "user",
      "user",
      "supervisor",
      "agent",
    ]);
  });

  it("is idempotent for an exact command and rejects collisions", () => {
    const steering = new SteeringController({
      scope: scope(),
      journal: new MemorySteeringJournal(),
    });
    expect(steering.enqueue(request("same", "steer", "user")).replayed).toBe(
      false,
    );
    expect(steering.enqueue(request("same", "steer", "user")).replayed).toBe(
      true,
    );
    expect(() =>
      steering.enqueue(request("same", "follow_up", "user")),
    ).toThrow("steering command id collision");
  });

  it("rebuilds pending queues from the event log without replaying consumed commands", () => {
    const journal = new MemorySteeringJournal();
    const first = new SteeringController({ scope: scope(), journal });
    first.enqueue(request("consumed", "steer", "user"));
    first.enqueue(request("pending", "follow_up", "security"));
    expect(first.drain("steer")).toHaveLength(1);

    const restarted = new SteeringController({ scope: scope(), journal });
    expect(restarted.drain("steer")).toEqual([]);
    expect(restarted.drain("follow_up").map((item) => item.command_id)).toEqual(
      ["pending"],
    );
  });

  it("fails closed on cross-session journal material and request scope", () => {
    const journal = new MemorySteeringJournal();
    const first = new SteeringController({ scope: scope(), journal });
    first.enqueue(request("private", "steer", "user"));

    expect(
      () => new SteeringController({ scope: scope("session-b"), journal }),
    ).toThrow("steering journal scope mismatch");
    expect(() =>
      first.enqueue({
        ...request("wrong", "steer", "user"),
        scope: scope("b"),
      }),
    ).toThrow("steering request scope mismatch");
  });

  it.each(["IN_FLIGHT", "EFFECT_UNKNOWN"] as const)(
    "does not cancel or retry an external action in %s",
    (effectState) => {
      const immediate = vi.fn();
      const steering = new SteeringController({
        scope: scope(),
        journal: new MemorySteeringJournal(),
        effectState: () => effectState,
        onImmediate: immediate,
      });

      const result = steering.enqueue(request("kill-now", "steer", "kill"));

      expect(result.disposition).toBe("reconciliation_required");
      expect(immediate).toHaveBeenCalledWith(
        expect.objectContaining({ command_id: "kill-now" }),
        "reconciliation_required",
      );
      expect(steering.drain("steer")).toHaveLength(1);
    },
  );

  it("requests immediate stop when no effect is uncertain", () => {
    const immediate = vi.fn();
    const steering = new SteeringController({
      scope: scope(),
      journal: new MemorySteeringJournal(),
      effectState: () => "PRE_DISPATCH",
      onImmediate: immediate,
    });

    expect(
      steering.enqueue(request("kill-now", "steer", "kill")).disposition,
    ).toBe("stop_requested");
    expect(immediate).toHaveBeenCalledWith(
      expect.objectContaining({ command_id: "kill-now" }),
      "stop_requested",
    );
  });

  it("rejects malformed priority, queue, content and identifiers", () => {
    const steering = new SteeringController({
      scope: scope(),
      journal: new MemorySteeringJournal(),
    });
    for (const candidate of [
      { ...request("bad-priority", "steer", "user"), priority: "root" },
      { ...request("bad-queue", "steer", "user"), queue: "system" },
      { ...request("bad-content", "steer", "user"), content: undefined },
      { ...request(" ", "steer", "user") },
    ]) {
      expect(() => steering.enqueue(candidate as never)).toThrow(SteeringError);
    }
  });
});
