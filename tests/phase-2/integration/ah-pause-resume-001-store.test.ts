import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PauseResumeController } from "../../../packages/runtime-core/src/index.js";
import { createTrustedSessionStateRoot } from "../../../session/session-state-root.js";
import { SqliteSessionStore } from "../../../session/sqlite-session-store.js";

const roots: string[] = [];
const MASTER_KEY = Buffer.alloc(32, 0x71);

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "pause-resume-"));
  roots.push(root);
  return {
    path: join(root, "session.db"),
    stateRoot: createTrustedSessionStateRoot(root),
  };
};

const base = {
  operation_id: "operation-1",
  run_id: "run-1",
  step_id: "step-1",
  attempt_id: "attempt-1",
  tool_name: "http_request",
  idempotency_key: "idempotency-1",
  receipt_json: null,
} as const;

describe("AH-PAUSE-RESUME-001 durable effect-state integration", () => {
  it("persists UNKNOWN -> RECONCILING -> CONFIRMED across restart", async () => {
    const { path, stateRoot } = fixture();
    const first = new SqliteSessionStore(path, {
      masterKey: MASTER_KEY,
      state_root: stateRoot,
    });
    first.createRun(base.run_id, "resume safely");
    first.recordOperation({ ...base, effect_state: "PRE_DISPATCH" });
    first.recordOperation({ ...base, effect_state: "IN_FLIGHT" });
    first.recordOperation({ ...base, effect_state: "EFFECT_UNKNOWN" });
    const controller = new PauseResumeController({
      journal: first,
      readBack: { query: vi.fn() },
      reconciliation: {
        reconcile: vi.fn().mockResolvedValue({
          status: "confirmed",
          stored_outcome_json: '{"receipt":{"success":true}}',
        }),
      },
    });

    await expect(
      controller.resume({
        run_id: base.run_id,
        operation_id: base.operation_id,
      }),
    ).resolves.toEqual({
      action: "continue_next_step",
      operation_id: base.operation_id,
    });
    first.close();

    const restarted = new SqliteSessionStore(path, {
      masterKey: MASTER_KEY,
      state_root: stateRoot,
    });
    expect(restarted.getOperation(base.operation_id)).toMatchObject({
      effect_state: "EFFECT_CONFIRMED",
      receipt_json: '{"receipt":{"success":true}}',
    });
    restarted.close();
  });

  it("recovers a crash-persisted reconciliation before allowing a fresh attempt", async () => {
    const { path, stateRoot } = fixture();
    const first = new SqliteSessionStore(path, {
      masterKey: MASTER_KEY,
      state_root: stateRoot,
    });
    first.createRun(base.run_id, "resume safely");
    first.recordOperation({ ...base, effect_state: "PRE_DISPATCH" });
    first.recordOperation({ ...base, effect_state: "IN_FLIGHT" });
    first.recordOperation({ ...base, effect_state: "EFFECT_UNKNOWN" });
    first.recordOperation({ ...base, effect_state: "RECONCILING" });
    first.close();

    const restarted = new SqliteSessionStore(path, {
      masterKey: MASTER_KEY,
      state_root: stateRoot,
    });
    const readBack = vi.fn();
    const reconcile = vi.fn().mockResolvedValue({ status: "no_effect" });
    const controller = new PauseResumeController({
      journal: restarted,
      readBack: { query: readBack },
      reconciliation: { reconcile },
    });

    await expect(
      controller.resume({
        run_id: base.run_id,
        operation_id: base.operation_id,
      }),
    ).resolves.toMatchObject({
      action: "retry_new_attempt",
      previous_attempt_id: "attempt-1",
      requires_new_capability: true,
      restart_pipeline_at: "schema",
    });
    expect(readBack).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(1);
    restarted.recordOperation({
      ...base,
      attempt_id: "attempt-2",
      effect_state: "PRE_DISPATCH",
    });
    expect(restarted.getOperation(base.operation_id)).toMatchObject({
      attempt_id: "attempt-2",
      effect_state: "PRE_DISPATCH",
    });
    restarted.close();
  });
});
