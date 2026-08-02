import { describe, expect, it } from "vitest";

import { SteeringController } from "../../../packages/runtime-core/src/index.js";
import { SessionSteeringJournal } from "../../../runtime/session-steering-journal.js";
import type { RuntimeSteeringEvent } from "../../../runtime/steering-port.js";
import { DurableSession } from "../../../session/durable-session.js";

const scope = {
  tenant_id: "tenant-a",
  run_id: "run-a",
  session_id: "session-a",
};

describe("AH-RUNTIME-STEERING-001 session event authority", () => {
  it("rebuilds pending steering from the durable session log after restart", () => {
    const session = new DurableSession(scope.session_id);
    session.acquireWriter();
    const first = new SteeringController({
      scope,
      journal: new SessionSteeringJournal(session, scope),
    });
    first.enqueue({
      command_id: "persisted",
      scope,
      queue: "follow_up",
      priority: "security",
      content: { text: "preserve security constraint" },
    });
    session.releaseWriter();

    const restored = DurableSession.restore(session.export_());
    restored.acquireWriter();
    const restarted = new SteeringController({
      scope,
      journal: new SessionSteeringJournal(restored, scope),
    });

    expect(restarted.drain("follow_up")).toEqual([
      expect.objectContaining({ command_id: "persisted" }),
    ]);
    expect(
      restored.getEvents().filter((event) => event.type === "steer"),
    ).toHaveLength(2);
    restored.releaseWriter();
  });

  it("cannot bind a journal to another session", () => {
    expect(
      () => new SessionSteeringJournal(new DurableSession("session-b"), scope),
    ).toThrow("steering session journal scope mismatch");
  });

  it("rejects append scope drift in every dimension without writing", () => {
    const session = new DurableSession(scope.session_id);
    session.acquireWriter();
    const journal = new SessionSteeringJournal(session, scope);
    const base: RuntimeSteeringEvent = {
      schema_version: "steering-event/v1",
      kind: "consumed",
      scope,
      command_id: "command-a",
    };
    for (const key of ["tenant_id", "run_id", "session_id"] as const) {
      expect(() =>
        journal.append({
          ...base,
          scope: { ...scope, [key]: "other" },
        }),
      ).toThrow("steering session journal scope mismatch");
    }
    expect(session.getEvents()).toEqual([]);
    session.releaseWriter();
  });

  it("fails closed instead of dropping malformed steering log entries", () => {
    for (const data of [
      null,
      [],
      "steer",
      {},
      { schema_version: "steering-event/v2" },
    ]) {
      const session = new DurableSession(scope.session_id);
      session.acquireWriter();
      session.append("steer", data);
      const journal = new SessionSteeringJournal(session, scope);
      expect(() => journal.read()).toThrow("invalid steering session event");
      session.releaseWriter();
    }
  });

  it("ignores unrelated session events but preserves valid steering order", () => {
    const session = new DurableSession(scope.session_id);
    session.acquireWriter();
    session.append("system", { status: "unrelated" });
    const journal = new SessionSteeringJournal(session, scope);
    const first: RuntimeSteeringEvent = {
      schema_version: "steering-event/v1",
      kind: "consumed",
      scope,
      command_id: "first",
    };
    const second: RuntimeSteeringEvent = {
      schema_version: "steering-event/v1",
      kind: "consumed",
      scope,
      command_id: "second",
    };
    journal.append(first);
    journal.append(second);
    expect(journal.read()).toEqual([first, second]);
    session.releaseWriter();
  });
});
