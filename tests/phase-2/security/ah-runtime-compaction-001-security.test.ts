import { describe, expect, it, vi } from "vitest";

import {
  ContextCompactor,
  type CompactionInput,
} from "../../../packages/runtime-core/src/compaction.js";

const request = (overrides: Partial<CompactionInput> = {}): CompactionInput => ({
  tenant_id: "tenant-1",
  run_id: "run-1",
  session_id: "session-1",
  context_generation: 1,
  context_capacity_tokens: 100_000,
  used_tokens: 70_000,
  cache_breakpoint: 0,
  stable_prefix: [],
  recent_conversation: [],
  offload_items: [],
  state: {
    goal: "safe",
    constraints: ["deny external write"],
    decisions: [],
    security: {
      approvals: [],
      grants: [],
      denials: [{ scope: "external_write" }],
      current_revocations: [{ capability_id: "revoked" }],
      effects: [{ operation_id: "op-1", state: "EFFECT_UNKNOWN" }],
      receipts: [],
      idempotency_ids: ["idem-1"],
    },
    active_plan: [],
    open_tasks: [],
    source_hashes: ["a".repeat(64)],
    tracked_file_changes: [],
  },
  ...overrides,
});

describe("AH-RUNTIME-COMPACTION-001 security boundary", () => {
  it("keeps current revocations immutable and independent of caller mutation", async () => {
    const input = request();
    const compactor = new ContextCompactor({
      vfs: { write: vi.fn() },
      beforeCompact: {
        dispatch: vi.fn().mockResolvedValue({ action: "continue" }),
      },
      freshSession: {
        prepare: vi.fn(() => ({ session_id: "session-2", commit: vi.fn() })),
      },
    });

    const result = await compactor.compact(input);
    (input.state.security.current_revocations as unknown[]).push({
      capability_id: "caller-added",
    });

    expect(result.state.security.current_revocations).toEqual([
      { capability_id: "revoked" },
    ]);
    expect(Object.isFrozen(result.state.security)).toBe(true);
    expect(() =>
      (result.state.security.denials as unknown[]).push({ scope: "weakened" }),
    ).toThrow();
  });

  it.each([
    { tenant_id: "../tenant" },
    { run_id: "run/escape" },
    { session_id: " session" },
  ])("rejects an unsafe scope before VFS or Hook access", async (override) => {
    const write = vi.fn();
    const dispatch = vi.fn();
    const compactor = new ContextCompactor({
      vfs: { write },
      beforeCompact: { dispatch },
      freshSession: {
        prepare: vi.fn(() => ({ session_id: "session-2", commit: vi.fn() })),
      },
    });

    await expect(compactor.compact(request(override))).rejects.toThrow(/invalid/u);
    expect(write).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not prepare or commit a reset when session_before_compact denies", async () => {
    const prepare = vi.fn();
    const compactor = new ContextCompactor({
      vfs: { write: vi.fn() },
      beforeCompact: {
        dispatch: vi.fn().mockResolvedValue({
          action: "deny",
          reason_code: "security_policy",
        }),
      },
      freshSession: { prepare },
    });

    await expect(
      compactor.compact(request({ used_tokens: 85_000 })),
    ).resolves.toMatchObject({
      action: "cancelled",
      reason_code: "security_policy",
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not return a successful reset when SessionTree commit fails", async () => {
    const writes: string[] = [];
    const compactor = new ContextCompactor({
      vfs: { write: (path) => writes.push(path) },
      beforeCompact: {
        dispatch: vi.fn().mockResolvedValue({ action: "continue" }),
      },
      freshSession: {
        prepare: vi.fn(() => ({
          session_id: "session-2",
          commit: vi.fn().mockRejectedValue(new Error("tree head conflict")),
        })),
      },
    });

    await expect(
      compactor.compact(request({ used_tokens: 85_000 })),
    ).rejects.toThrow("tree head conflict");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/\/handoff-[0-9a-f]{64}\.json$/u);
  });
});
