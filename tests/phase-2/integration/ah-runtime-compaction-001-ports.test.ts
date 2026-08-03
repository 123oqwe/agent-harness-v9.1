import { describe, expect, it, vi } from "vitest";

import {
  CompactionHookRuntimeAdapter,
  ContextResetSessionAdapter,
} from "../../../runtime/compaction-port.js";

describe("AH-RUNTIME-COMPACTION-001 existing authority adapters", () => {
  it("dispatches session_before_compact through the managed Hook boundary", async () => {
    const dispatch = vi.fn(async (request) => ({
      event: request.event,
      action: "skip" as const,
      payload: request.payload,
      reason_code: "operator_cancelled",
      follow_ups: [],
      replayed: false,
    }));
    const adapter = new CompactionHookRuntimeAdapter({
      hooks: { dispatch },
      timeout_ms: 1_000,
    });

    await expect(
      adapter.dispatch({
        event: "session_before_compact",
        tenant_id: "tenant-1",
        run_id: "run-1",
        session_id: "session-1",
        action: "compact",
        pressure: 0.7,
      }),
    ).resolves.toEqual({
      action: "skip",
      reason_code: "operator_cancelled",
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "session_before_compact",
        scope: {
          tenant_id: "tenant-1",
          run_id: "run-1",
          session_id: "session-1",
        },
        payload: { action: "compact", pressure: 0.7 },
      }),
    );
  });

  it("fails closed when the managed Hook throws", async () => {
    const adapter = new CompactionHookRuntimeAdapter({
      hooks: { dispatch: vi.fn().mockRejectedValue(new Error("hook offline")) },
      timeout_ms: 1_000,
    });

    await expect(
      adapter.dispatch({
        event: "session_before_compact",
        tenant_id: "tenant-1",
        run_id: "run-1",
        session_id: "session-1",
        action: "compact",
        pressure: 0.7,
      }),
    ).resolves.toEqual({ action: "deny", reason_code: "hook_failed" });
  });

  it("creates a deterministic fresh branch through the existing SessionTree", async () => {
    const branch = vi.fn().mockResolvedValue({ replayed: false });
    const adapter = new ContextResetSessionAdapter({
      tenant_id: "tenant-1",
      root_session_id: "run-1",
      tree: { branch },
    });
    const request = {
      tenant_id: "tenant-1",
      run_id: "run-1",
      previous_session_id: "session-1",
      context_generation: 2,
    } as const;

    const first = adapter.prepare(request);
    const replay = adapter.prepare(request);

    expect(first.session_id).toMatch(/^context-reset-[0-9a-f]{32}$/u);
    expect(replay.session_id).toBe(first.session_id);
    expect(branch).not.toHaveBeenCalled();
    await first.commit();
    await replay.commit();
    expect(branch).toHaveBeenNthCalledWith(1, {
      command_id: expect.stringMatching(/^context-reset-command-[0-9a-f]{32}$/u),
      source_session_id: "session-1",
      child_session_id: first.session_id,
    });
    expect(branch).toHaveBeenNthCalledWith(2, {
      command_id: expect.any(String),
      source_session_id: "session-1",
      child_session_id: first.session_id,
    });
  });

  it("rejects a cross-scope context reset before touching SessionTree", async () => {
    const branch = vi.fn();
    const adapter = new ContextResetSessionAdapter({
      tenant_id: "tenant-1",
      root_session_id: "run-1",
      tree: { branch },
    });

    await expect(
      Promise.resolve().then(() => adapter.prepare({
        tenant_id: "tenant-2",
        run_id: "run-1",
        previous_session_id: "session-1",
        context_generation: 2,
      })),
    ).rejects.toThrow("context reset SessionTree scope mismatch");
    expect(branch).not.toHaveBeenCalled();
  });
});
