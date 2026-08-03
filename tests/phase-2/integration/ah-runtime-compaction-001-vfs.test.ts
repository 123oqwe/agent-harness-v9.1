import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { ContextCompactor } from "../../../packages/runtime-core/src/index.js";
import { StoreBackend, VirtualFilesystem } from "../../../vfs/virtual-filesystem.js";

describe("AH-RUNTIME-COMPACTION-001 VFS handoff integration", () => {
  it("writes a hash-bound cross-tenant-isolated handoff through the existing VFS", async () => {
    const vfs = new VirtualFilesystem([
      { prefix: "/scratch", read: true, write: true },
    ]);
    vfs.mount(new StoreBackend("/scratch"));
    const hook = vi.fn().mockResolvedValue({ action: "continue" });
    const commit = vi.fn();
    const prepare = vi.fn().mockResolvedValue({
      session_id: "session-next",
      commit,
    });
    const compactor = new ContextCompactor({
      vfs,
      beforeCompact: { dispatch: hook },
      freshSession: { prepare },
    });

    const result = await compactor.compact({
      tenant_id: "tenant-a",
      run_id: "run-a",
      session_id: "session-a",
      context_generation: 7,
      context_capacity_tokens: 100_000,
      used_tokens: 85_000,
      cache_breakpoint: 1,
      stable_prefix: [
        { id: "system", token_count: 10_000, content: "policy", key_fact: true },
      ],
      recent_conversation: [
        { id: "fact", token_count: 5_000, content: "retain", key_fact: true },
      ],
      offload_items: [],
      state: {
        goal: "resume safely",
        constraints: ["deny external write"],
        decisions: [],
        security: {
          approvals: [],
          grants: [],
          denials: [{ scope: "external_write" }],
          current_revocations: [{ capability_id: "old" }],
          effects: [],
          receipts: [],
          idempotency_ids: ["idem-a"],
        },
        active_plan: [{ id: "step-a" }],
        open_tasks: [{ id: "task-a" }],
        source_hashes: ["a".repeat(64)],
        tracked_file_changes: [],
      },
    });

    expect(result.action).toBe("context_reset");
    expect(result.handoff!.path).toMatch(
      /^\/scratch\/context\/tenant-a\/run-a\/session-a\/handoff-[0-9a-f]{64}\.json$/u,
    );
    const bytes = vfs.readText(result.handoff!.path);
    expect(prepare).toHaveBeenCalledWith({
      tenant_id: "tenant-a",
      run_id: "run-a",
      previous_session_id: "session-a",
      context_generation: 7,
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "session_before_compact",
        action: "context_reset",
        pressure: 0.85,
      }),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      result.handoff!.sha256,
    );
    expect(JSON.parse(bytes).state.security.current_revocations).toEqual([
      { capability_id: "old" },
    ]);
    expect(vfs.exists(result.handoff!.path.replace("tenant-a", "tenant-b"))).toBe(false);
  });
});
