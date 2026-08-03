import { describe, expect, it, vi } from "vitest";

import {
  ContextCompactor,
  type CompactionInput,
  type CompactionSecurityState,
} from "../../../packages/runtime-core/src/compaction.js";

const security: CompactionSecurityState = {
  approvals: [{ id: "approval-1", state: "granted" }],
  grants: [{ id: "grant-1", scope: "read:/workspace" }],
  denials: [{ id: "denial-1", scope: "write:/external" }],
  current_revocations: [{ id: "grant-old", revoked_at: "2026-08-03T00:00:00Z" }],
  effects: [{ operation_id: "operation-1", state: "EFFECT_CONFIRMED" }],
  receipts: [{ operation_id: "operation-1", success: true }],
  idempotency_ids: ["idempotency-1"],
};

const input = (used_tokens: number): CompactionInput => ({
  tenant_id: "tenant-1",
  run_id: "run-1",
  session_id: "session-1",
  context_generation: 1,
  context_capacity_tokens: 100_000,
  used_tokens,
  cache_breakpoint: 1,
  stable_prefix: [{ id: "system", token_count: 10_000, content: "policy", key_fact: true }],
  recent_conversation: [
    { id: "old-chatter", token_count: 20_000, content: "chatter", key_fact: false },
    { id: "fact-1", token_count: 10_000, content: "must preserve", key_fact: true },
  ],
  offload_items: [
    { id: "tool-large", token_count: 15_000, content: { result: "large" } },
  ],
  state: {
    goal: "ship safely",
    constraints: ["no external writes"],
    decisions: ["use the existing VFS"],
    security,
    active_plan: [{ id: "step-1", status: "active" }],
    open_tasks: [{ id: "task-1", status: "open" }],
    source_hashes: ["a".repeat(64)],
    tracked_file_changes: [{ path: "/workspace/a.ts", hash: "b".repeat(64) }],
  },
});

const fixture = (hookAction: "continue" | "skip" = "continue") => {
  const writes: Array<{ path: string; bytes: string }> = [];
  const hook = vi.fn().mockResolvedValue({
    action: hookAction,
    reason_code: hookAction === "continue" ? undefined : "operator_cancelled",
  });
  const compactor = new ContextCompactor({
    vfs: { write: (path, bytes) => writes.push({ path, bytes }) },
    beforeCompact: { dispatch: hook },
    freshSession: {
      prepare: vi.fn(() => ({ session_id: "session-2", commit: vi.fn() })),
    },
  });
  return { compactor, hook, writes };
};

describe("AH-RUNTIME-COMPACTION-001 deterministic compaction", () => {
  it("does nothing below 40% context pressure", async () => {
    const value = fixture();
    const result = await value.compactor.compact(input(39_999));

    expect(result.action).toBe("none");
    expect(value.writes).toEqual([]);
    expect(value.hook).not.toHaveBeenCalled();
  });

  it("mechanically offloads through VFS at the exact 40% boundary", async () => {
    const value = fixture();
    const result = await value.compactor.compact(input(40_000));

    expect(result.action).toBe("offload");
    expect(result.offloaded).toHaveLength(1);
    expect(result.offloaded[0]).toMatchObject({
      source_id: "tool-large",
      token_count: 15_000,
    });
    expect(value.writes).toHaveLength(1);
    expect(value.writes[0]!.path).toMatch(/^\/scratch\/context\/tenant-1\/run-1\/session-1\/[0-9a-f]{64}\.json$/u);
    expect(value.hook).not.toHaveBeenCalled();
  });

  it("does not compact when mechanical offload recovers below 70%", async () => {
    const value = fixture();
    const result = await value.compactor.compact(input(70_000));

    expect(result.action).toBe("offload");
    expect(result.pressure_after_offload).toBe(0.55);
    expect(result.recent_conversation).toHaveLength(2);
    expect(result.omitted_ids).toEqual([]);
    expect(value.hook).not.toHaveBeenCalled();
  });

  it("compacts at 70% while preserving security and key facts exactly", async () => {
    const value = fixture();
    const original = { ...input(70_000), offload_items: [] };
    const result = await value.compactor.compact(original);

    expect(result.action).toBe("compact");
    expect(value.hook).toHaveBeenCalledTimes(1);
    expect(result.state.security).toEqual(security);
    expect(result.state.security).not.toBe(original.state.security);
    expect(result.state.constraints).toEqual(["no external writes"]);
    expect(result.state.active_plan).toEqual([{ id: "step-1", status: "active" }]);
    expect(result.state.open_tasks).toEqual([{ id: "task-1", status: "open" }]);
    expect(result.state.source_hashes).toEqual(["a".repeat(64)]);
    expect(result.state.tracked_file_changes).toEqual(original.state.tracked_file_changes);
    expect(result.recent_conversation.map((entry) => entry.id)).toEqual(["fact-1"]);
    expect(result.omitted_ids).toEqual(["old-chatter"]);
    expect(result.cache_breakpoint).toBe(1);
  });

  it("lets session_before_compact cancel without discarding state", async () => {
    const value = fixture("skip");
    const original = { ...input(70_000), offload_items: [] };
    const result = await value.compactor.compact(original);

    expect(result).toMatchObject({
      action: "cancelled",
      reason_code: "operator_cancelled",
      state: original.state,
    });
    expect(value.writes).toHaveLength(0);
  });

  it("writes a structured handoff and restores into a fresh session at 85%", async () => {
    const value = fixture();
    const original = { ...input(85_000), offload_items: [] };
    const result = await value.compactor.compact(original);

    expect(result.action).toBe("context_reset");
    expect(result.previous_session_id).toBe("session-1");
    expect(result.session_id).toBe("session-2");
    expect(result.state.security).toEqual(security);
    expect(result.handoff!.path).toMatch(/^\/scratch\/context\/tenant-1\/run-1\/session-1\/handoff-[0-9a-f]{64}\.json$/u);
    const handoff = JSON.parse(value.writes.at(-1)!.bytes);
    expect(handoff).toMatchObject({
      schema_version: "context-handoff/v1",
      tenant_id: "tenant-1",
      run_id: "run-1",
      previous_session_id: "session-1",
      session_id: "session-2",
      state: { security },
    });
    expect(handoff.state).toEqual(result.state);
  });

  it("does not commit a fresh SessionTree branch when handoff persistence fails", async () => {
    const commit = vi.fn();
    const compactor = new ContextCompactor({
      vfs: { write: () => { throw new Error("VFS unavailable"); } },
      beforeCompact: {
        dispatch: vi.fn().mockResolvedValue({ action: "continue" }),
      },
      freshSession: {
        prepare: vi.fn(() => ({ session_id: "session-2", commit })),
      },
    });

    await expect(
      compactor.compact({ ...input(85_000), offload_items: [] }),
    ).rejects.toThrow("VFS unavailable");
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects reusing the previous session identity before writing handoff", async () => {
    const writes = vi.fn();
    const compactor = new ContextCompactor({
      vfs: { write: writes },
      beforeCompact: {
        dispatch: vi.fn().mockResolvedValue({ action: "continue" }),
      },
      freshSession: {
        prepare: vi.fn(() => ({ session_id: "session-1", commit: vi.fn() })),
      },
    });

    await expect(
      compactor.compact({ ...input(85_000), offload_items: [] }),
    ).rejects.toThrow("context reset requires a fresh session");
    expect(writes).not.toHaveBeenCalled();
  });
});
