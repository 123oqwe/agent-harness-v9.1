import { describe, expect, it } from "vitest";

import { SteeringController } from "../../../packages/runtime-core/src/index.js";
import { SessionSteeringJournal } from "../../../runtime/session-steering-journal.js";
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
});
