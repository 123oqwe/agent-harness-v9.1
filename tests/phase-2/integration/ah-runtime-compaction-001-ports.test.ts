import { createHash } from "node:crypto";

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
    const hookRequest = dispatch.mock.calls[0]![0];
    const identity = createHash("sha256").update(JSON.stringify({
      event: "session_before_compact",
      tenant_id: "tenant-1",
      run_id: "run-1",
      session_id: "session-1",
      action: "compact",
      pressure: 0.7,
    })).digest("hex");
    expect(hookRequest.invocation_id).toBe(`hook-${identity}`);
    expect(hookRequest.idempotency_key).toBe(`hook-idempotency-${identity}`);
  });

  it("omits optional Hook fields and reason codes when absent", async () => {
    const dispatch = vi.fn(async (request) => ({
      event: request.event,
      action: "continue" as const,
      payload: request.payload,
      follow_ups: [], replayed: false,
    }));
    const adapter = new CompactionHookRuntimeAdapter({ hooks: { dispatch } });
    await expect(adapter.dispatch({
      event: "session_before_compact", tenant_id: "tenant-1", run_id: "run-1",
      session_id: "session-1", action: "compact", pressure: 0.7,
    })).resolves.toEqual({ action: "continue" });
    expect(dispatch.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
    const result = await adapter.dispatch({
      event: "session_before_compact", tenant_id: "tenant-1", run_id: "run-1",
      session_id: "session-1", action: "compact", pressure: 0.7,
    });
    expect(Object.hasOwn(result, "reason_code")).toBe(false);
  });

  it("enforces the configured Hook timeout at the existing boundary", async () => {
    vi.useFakeTimers();
    const adapter = new CompactionHookRuntimeAdapter({
      hooks: { dispatch: vi.fn(() => new Promise(() => undefined)) },
      timeout_ms: 5,
    });
    try {
      const result = adapter.dispatch({
        event: "session_before_compact", tenant_id: "tenant-1", run_id: "run-1",
        session_id: "session-1", action: "compact", pressure: 0.7,
      });
      await vi.advanceTimersByTimeAsync(5);
      await expect(result).resolves.toEqual({ action: "deny", reason_code: "hook_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors an already-aborted caller signal", async () => {
    const dispatch = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error("caller stopped"));
    const adapter = new CompactionHookRuntimeAdapter({ hooks: { dispatch }, signal: controller.signal });
    await expect(adapter.dispatch({
      event: "session_before_compact", tenant_id: "tenant-1", run_id: "run-1",
      session_id: "session-1", action: "compact", pressure: 0.7,
    })).resolves.toMatchObject({ action: "deny" });
    expect(dispatch).not.toHaveBeenCalled();
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
    const expected = createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 32);
    expect(first.session_id).toBe(`context-reset-${expected}`);
    expect(branch.mock.calls[0]![0].command_id).toBe(`context-reset-command-${expected}`);
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

  it("rejects a wrong run scope independently of tenant scope", () => {
    const branch = vi.fn();
    const adapter = new ContextResetSessionAdapter({
      tenant_id: "tenant-1", root_session_id: "run-1", tree: { branch },
    });
    expect(() => adapter.prepare({
      tenant_id: "tenant-1", run_id: "run-2", previous_session_id: "session-1", context_generation: 2,
    })).toThrow("context reset SessionTree scope mismatch");
    expect(branch).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, Number.NaN])("rejects invalid context generation %s", (context_generation) => {
    const adapter = new ContextResetSessionAdapter({
      tenant_id: "tenant-1", root_session_id: "run-1", tree: { branch: vi.fn() },
    });
    expect(() => adapter.prepare({
      tenant_id: "tenant-1", run_id: "run-1", previous_session_id: "session-1", context_generation,
    })).toThrow("context_generation must be a non-negative safe integer");
  });

  it("accepts generation zero and binds it into a distinct branch identity", () => {
    const adapter = new ContextResetSessionAdapter({
      tenant_id: "tenant-1", root_session_id: "run-1", tree: { branch: vi.fn() },
    });
    const zero = adapter.prepare({
      tenant_id: "tenant-1", run_id: "run-1", previous_session_id: "session-1", context_generation: 0,
    });
    const one = adapter.prepare({
      tenant_id: "tenant-1", run_id: "run-1", previous_session_id: "session-1", context_generation: 1,
    });
    expect(zero.session_id).not.toBe(one.session_id);
  });
});
