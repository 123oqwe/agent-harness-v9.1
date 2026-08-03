import { createHash } from "node:crypto";

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
  it("requires each existing authority port", () => {
    const good = {
      vfs: { write: vi.fn() },
      beforeCompact: { dispatch: vi.fn() },
      freshSession: { prepare: vi.fn() },
    };
    for (const key of ["vfs", "beforeCompact", "freshSession"] as const) {
      expect(() => new ContextCompactor({ ...good, [key]: undefined } as never))
        .toThrow(key === "vfs" ? "compaction VFS port is required" : key === "beforeCompact" ? "compaction Hook port is required" : "fresh Session port is required");
    }
  });

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
    const payload = value.writes[0]!.bytes;
    expect(payload).toBe('{"content":{"result":"large"},"run_id":"run-1","schema_version":"context-offload/v1","session_id":"session-1","source_id":"tool-large","tenant_id":"tenant-1","token_count":15000}');
    const hash = createHash("sha256").update(payload).digest("hex");
    expect(result.offloaded[0]).toEqual({
      source_id: "tool-large",
      token_count: 15_000,
      path: `/scratch/context/tenant-1/run-1/session-1/${hash}.json`,
      sha256: hash,
    });
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
    expect(value.hook).toHaveBeenCalledWith({
      event: "session_before_compact",
      tenant_id: "tenant-1",
      run_id: "run-1",
      session_id: "session-1",
      action: "compact",
      pressure: 0.7,
    });
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

  it("uses the hook action as the fail-closed reason when no reason is supplied", async () => {
    const value = fixture();
    value.hook.mockResolvedValueOnce({ action: "deny" });
    await expect(value.compactor.compact({ ...input(70_000), offload_items: [] }))
      .resolves.toMatchObject({ action: "cancelled", reason_code: "hook_deny" });
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
    expect(result.handoff!.sha256).toBe(
      createHash("sha256").update(value.writes.at(-1)!.bytes).digest("hex"),
    );
  });

  it.each([
    ["context_generation", -1],
    ["context_generation", 1.5],
    ["context_capacity_tokens", 0],
    ["context_capacity_tokens", -1],
    ["used_tokens", -1],
    ["cache_breakpoint", -1],
  ] as const)("rejects invalid %s before side effects", async (field, invalid) => {
    const value = fixture();
    await expect(value.compactor.compact({ ...input(39_999), [field]: invalid }))
      .rejects.toThrow();
    expect(value.writes).toEqual([]);
    expect(value.hook).not.toHaveBeenCalled();
  });

  it("rejects a cache breakpoint beyond the stable prefix", async () => {
    const value = fixture();
    await expect(value.compactor.compact({ ...input(39_999), cache_breakpoint: 2 }))
      .rejects.toThrow("cache_breakpoint exceeds stable prefix");
  });

  it.each([
    { stable_prefix: [{ id: "../escape", token_count: 1, content: "x", key_fact: true }] },
    { recent_conversation: [{ id: "item", token_count: -1, content: "x", key_fact: true }] },
    { offload_items: [{ id: "item", token_count: 1.5, content: "x" }] },
  ])("validates every context item before side effects", async (override) => {
    const value = fixture();
    await expect(value.compactor.compact({ ...input(39_999), ...override } as CompactionInput))
      .rejects.toThrow();
    expect(value.writes).toEqual([]);
  });

  it.each(["approvals", "grants", "denials", "current_revocations", "effects", "receipts", "idempotency_ids"] as const)(
    "requires structured security.%s",
    async (field) => {
      const value = fixture();
      const base = input(39_999);
      const securityState = { ...base.state.security, [field]: null };
      await expect(value.compactor.compact({
        ...base,
        state: { ...base.state, security: securityState },
      } as never)).rejects.toThrow(`security.${field} must be an array`);
    },
  );

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
