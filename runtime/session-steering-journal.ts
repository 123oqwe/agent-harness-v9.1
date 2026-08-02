import type { DurableSession } from "../session/durable-session.js";
import type {
  RuntimeSteeringEvent,
  RuntimeSteeringScope,
} from "./steering-port.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameScope(
  left: RuntimeSteeringScope,
  right: RuntimeSteeringScope,
): boolean {
  return (
    left.tenant_id === right.tenant_id &&
    left.run_id === right.run_id &&
    left.session_id === right.session_id
  );
}

export class SessionSteeringJournal {
  constructor(
    private readonly session: DurableSession,
    private readonly scope: RuntimeSteeringScope,
  ) {
    if (session.session_id !== scope.session_id) {
      throw new Error("steering session journal scope mismatch");
    }
  }

  read(): readonly RuntimeSteeringEvent[] {
    return this.session
      .getEvents()
      .filter((event) => event.type === "steer")
      .map((event) => event.data)
      .filter(
        (data): data is RuntimeSteeringEvent =>
          isRecord(data) && data.schema_version === "steering-event/v1",
      );
  }

  append(event: RuntimeSteeringEvent): void {
    if (!sameScope(this.scope, event.scope)) {
      throw new Error("steering session journal scope mismatch");
    }
    this.session.append("steer", event);
  }
}
