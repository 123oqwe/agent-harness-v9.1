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
  it("preserves the typed steering error identity", () => {
    const error = new SteeringError("typed-boundary");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SteeringError);
    expect(error.name).toBe("SteeringError");
    expect(error.message).toBe("typed-boundary");
  });

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

  it("deep-clones and freezes every accepted authority value", () => {
    let appended: SteeringEvent | undefined;
    const journal: SteeringJournalPort = {
      read: () => [],
      append: (event) => {
        appended = event;
      },
    };
    const steering = new SteeringController({ scope: scope(), journal });
    const content = { nested: { value: 1 }, list: [{ value: 2 }] };
    const result = steering.enqueue({
      ...request("frozen", "steer", "user"),
      content,
    });
    content.nested.value = 99;
    content.list[0]!.value = 99;

    expect(result.command.content).toEqual({
      nested: { value: 1 },
      list: [{ value: 2 }],
    });
    for (const value of [
      result,
      result.command,
      result.command.scope,
      result.command.content,
      (result.command.content as typeof content).nested,
      (result.command.content as typeof content).list,
      (result.command.content as typeof content).list[0],
      appended,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(result.command.ordinal).toBe(0);
    expect(result.command.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("canonicalizes object keys and accepts null content without aliasing", () => {
    const steering = new SteeringController({
      scope: scope(),
      journal: new MemorySteeringJournal(),
    });
    const first = steering.enqueue({
      ...request("canonical", "steer", "user"),
      content: { z: 1, nested: { b: 2, a: 1 }, a: null },
    });
    const replay = steering.enqueue({
      ...request("canonical", "steer", "user"),
      content: { a: null, nested: { a: 1, b: 2 }, z: 1 },
    });
    expect(replay).toMatchObject({
      replayed: true,
      command: { fingerprint: first.command.fingerprint },
    });
    expect(
      steering.enqueue({
        ...request("null-content", "steer", "user"),
        content: null,
      }).command.content,
    ).toBeNull();
  });

  it("validates constructor scope and both journal methods independently", () => {
    const validJournal = new MemorySteeringJournal();
    for (const [options, message] of [
      [undefined, "steering scope is required"],
      [null, "steering scope is required"],
      [{ scope: null, journal: validJournal }, "steering scope is required"],
      [{ scope: [], journal: validJournal }, "steering scope is required"],
      [
        { scope: { ...scope(), tenant_id: " " }, journal: validJournal },
        "tenant_id is required",
      ],
      [
        { scope: { ...scope(), run_id: "" }, journal: validJournal },
        "run_id is required",
      ],
      [
        { scope: { ...scope(), session_id: 1 }, journal: validJournal },
        "session_id is required",
      ],
    ] as const) {
      expect(() => new SteeringController(options as never)).toThrow(message);
    }
    for (const journal of [
      undefined,
      null,
      {},
      { read: () => [] },
      { append: () => undefined },
      { read: 1, append: () => undefined },
      { read: () => [], append: 1 },
    ]) {
      expect(
        () => new SteeringController({ scope: scope(), journal } as never),
      ).toThrow("steering journal is required");
    }
  });

  it("rejects every scope dimension and non-JSON content before append", () => {
    const journal = new MemorySteeringJournal();
    const steering = new SteeringController({ scope: scope(), journal });
    for (const changedScope of [
      { ...scope(), tenant_id: "tenant-b" },
      { ...scope(), run_id: "run-b" },
      { ...scope(), session_id: "session-b" },
    ]) {
      expect(() =>
        steering.enqueue({
          ...request("wrong-scope", "steer", "user"),
          scope: changedScope,
        }),
      ).toThrow("steering request scope mismatch");
    }
    const circular: { self?: unknown } = {};
    circular.self = circular;
    for (const [content, message] of [
      [undefined, "steering content must be JSON-serializable"],
      [1n, "steering content must be JSON-serializable"],
      [circular, "steering content must be JSON-serializable"],
    ] as const) {
      expect(() =>
        steering.enqueue({
          ...request("bad-json", "steer", "user"),
          content,
        }),
      ).toThrow(message);
    }
    expect(journal.events).toEqual([]);
  });

  it("notifies active listeners exactly once and rejects unmanaged callbacks", () => {
    const steering = new SteeringController({
      scope: scope(),
      journal: new MemorySteeringJournal(),
    });
    expect(() => steering.subscribe(null as never)).toThrow(
      "steering listener must be a function",
    );
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = steering.subscribe(first);
    steering.subscribe(second);
    const commandA = steering.enqueue(request("notify-a", "steer", "user"));
    unsubscribeFirst();
    unsubscribeFirst();
    const commandB = steering.enqueue(request("notify-b", "steer", "user"));
    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(commandA.command);
    expect(second).toHaveBeenNthCalledWith(1, commandA.command);
    expect(second).toHaveBeenNthCalledWith(2, commandB.command);
  });

  it("distinguishes cancel priorities from queued priorities and replays disposition", () => {
    let effectState: "PRE_DISPATCH" | "EFFECT_UNKNOWN" = "PRE_DISPATCH";
    const immediate = vi.fn();
    const steering = new SteeringController({
      scope: scope(),
      journal: new MemorySteeringJournal(),
      effectState: () => effectState,
      onImmediate: immediate,
    });
    expect(
      steering.enqueue(request("ordinary", "steer", "security")).disposition,
    ).toBe("queued");
    expect(immediate).not.toHaveBeenCalled();
    expect(
      steering.enqueue(request("cancel", "steer", "human_cancel"))
        .disposition,
    ).toBe("stop_requested");
    effectState = "EFFECT_UNKNOWN";
    expect(
      steering.enqueue(request("cancel", "steer", "human_cancel")),
    ).toMatchObject({ replayed: true, disposition: "reconciliation_required" });
    expect(immediate).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid drain queue and preserves FIFO command identity", () => {
    const steering = new SteeringController({
      scope: scope(),
      journal: new MemorySteeringJournal(),
    });
    expect(() => steering.drain("invalid" as never)).toThrow(
      "invalid steering queue",
    );
    steering.enqueue(request("fifo-a", "steer", "user"));
    steering.enqueue(request("fifo-b", "steer", "user"));
    expect(steering.drain("steer").map(({ command_id }) => command_id)).toEqual(
      ["fifo-a", "fifo-b"],
    );
  });

  it("fails closed on malformed journal roots and envelope variants", () => {
    const badRead = (value: unknown) => ({
      read: () => value,
      append: () => undefined,
    });
    expect(
      () => new SteeringController({ scope: scope(), journal: badRead({}) as never }),
    ).toThrow("steering journal must return an event array");
    for (const event of [
      null,
      [],
      "event",
      {},
      { schema_version: "steering-event/v2" },
      { schema_version: "steering-event/v1", kind: "unknown", scope: scope() },
    ]) {
      expect(
        () =>
          new SteeringController({
            scope: scope(),
            journal: new MemorySteeringJournal([event as never]),
          }),
      ).toThrow(SteeringError);
    }
  });

  it("validates reconstructed command ordinals, fingerprints and duplicate state", () => {
    const journal = new MemorySteeringJournal();
    new SteeringController({ scope: scope(), journal }).enqueue(
      request("valid-event", "steer", "user"),
    );
    const valid = structuredClone(journal.events[0]!);
    expect(valid.kind).toBe("enqueued");
    if (valid.kind !== "enqueued") return;

    const invalidCommands: Array<[Partial<typeof valid.command>, string]> = [
      [{ command_id: "" }, "steering command_id is required"],
      [{ queue: "bad" as never }, "invalid steering queue"],
      [{ priority: "bad" as never }, "invalid steering priority"],
      [{ content: undefined }, "steering content must be JSON-serializable"],
      [{ ordinal: -1 }, "invalid steering ordinal"],
      [{ ordinal: 0.5 }, "invalid steering ordinal"],
      [{ fingerprint: `g${"0".repeat(63)}` }, "steering fingerprint mismatch"],
      [{ fingerprint: `${valid.command.fingerprint}0` }, "steering fingerprint mismatch"],
      [{ fingerprint: valid.command.fingerprint.slice(1) }, "steering fingerprint mismatch"],
    ];
    for (const [change, message] of invalidCommands) {
      const event = structuredClone(valid);
      Object.assign(event.command, change);
      expect(
        () =>
          new SteeringController({
            scope: scope(),
            journal: new MemorySteeringJournal([event]),
          }),
      ).toThrow(message);
    }

    expect(
      () =>
        new SteeringController({
          scope: scope(),
          journal: new MemorySteeringJournal([valid, valid]),
        }),
    ).toThrow("duplicate steering journal command");
  });

  it("rejects mismatched event and command scope along each dimension", () => {
    const journal = new MemorySteeringJournal();
    new SteeringController({ scope: scope(), journal }).enqueue(
      request("scope-event", "steer", "user"),
    );
    const valid = structuredClone(journal.events[0]!);
    if (valid.kind !== "enqueued") throw new Error("expected enqueue event");
    for (const key of ["tenant_id", "run_id", "session_id"] as const) {
      const envelopeMismatch = structuredClone(valid);
      (envelopeMismatch.scope as unknown as Record<string, string>)[key] =
        "other";
      expect(
        () =>
          new SteeringController({
            scope: scope(),
            journal: new MemorySteeringJournal([envelopeMismatch]),
          }),
      ).toThrow("steering journal scope mismatch");

      const commandMismatch = structuredClone(valid);
      (commandMismatch.command.scope as unknown as Record<string, string>)[
        key
      ] = "other";
      expect(
        () =>
          new SteeringController({
            scope: scope(),
            journal: new MemorySteeringJournal([commandMismatch]),
          }),
      ).toThrow(SteeringError);
    }
  });

  it("rejects unknown, duplicate and out-of-order consumed journal events", () => {
    const journal = new MemorySteeringJournal();
    const first = new SteeringController({ scope: scope(), journal });
    first.enqueue(request("consume-me", "steer", "user"));
    first.drain("steer");
    const [enqueued, consumed] = structuredClone(journal.events);
    expect(
      () =>
        new SteeringController({
          scope: scope(),
          journal: new MemorySteeringJournal([consumed!]),
        }),
    ).toThrow("invalid steering consumed event");
    expect(
      () =>
        new SteeringController({
          scope: scope(),
          journal: new MemorySteeringJournal([enqueued!, consumed!, consumed!]),
        }),
    ).toThrow("invalid steering consumed event");
    const blank = structuredClone(consumed!);
    if (blank.kind === "consumed")
      (blank as { command_id: string }).command_id = "";
    expect(
      () =>
        new SteeringController({
          scope: scope(),
          journal: new MemorySteeringJournal([enqueued!, blank]),
        }),
    ).toThrow("steering command_id is required");
  });

  it("continues ordinals from the highest reconstructed command", () => {
    const journal = new MemorySteeringJournal();
    const first = new SteeringController({ scope: scope(), journal });
    first.enqueue(request("older-a", "steer", "user"));
    first.enqueue(request("older-b", "steer", "user"));
    const events = structuredClone(journal.events);
    if (events[0]?.kind === "enqueued")
      (events[0].command as { ordinal: number }).ordinal = 5;
    if (events[1]?.kind === "enqueued")
      (events[1].command as { ordinal: number }).ordinal = 2;
    const restarted = new SteeringController({
      scope: scope(),
      journal: new MemorySteeringJournal(events),
    });
    expect(
      restarted.enqueue(request("newest", "steer", "user")).command.ordinal,
    ).toBe(6);
  });
});
