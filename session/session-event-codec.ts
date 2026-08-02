import { createHash } from "node:crypto";

import type { SessionEvent, SessionEventType } from "./durable-session.js";

export const SESSION_EVENT_TYPES = Object.freeze([
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "compaction",
  "branch",
  "fork",
  "steer",
  "system",
  "error",
  "summary",
] as const satisfies readonly SessionEventType[]);

export function isSessionEventType(value: unknown): value is SessionEventType {
  return SESSION_EVENT_TYPES.some((candidate) => candidate === value);
}

export function hashSessionEvent(
  seq: number,
  type: SessionEventType,
  timestamp: string,
  data: unknown,
  previousHash: string,
): string {
  return createHash("sha256")
    .update(`${seq}|${type}|${timestamp}|${JSON.stringify(data)}|${previousHash}`)
    .digest("hex");
}

export function verifySessionEventChain(events: readonly SessionEvent[]): void {
  let previousHash = "";
  for (const [index, event] of events.entries()) {
    if (event.seq !== index + 1 || event.prev_hash !== previousHash) {
      throw new Error(`invalid session event ancestry at ${index + 1}`);
    }
    const expected = hashSessionEvent(
      event.seq,
      event.type,
      event.timestamp,
      event.data,
      event.prev_hash,
    );
    if (expected !== event.hash) {
      throw new Error(`session event hash mismatch at ${index + 1}`);
    }
    previousHash = event.hash;
  }
}
