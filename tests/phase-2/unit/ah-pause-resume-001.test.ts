import { describe, expect, it, vi } from "vitest";

import {
  PauseResumeController,
  type PauseResumeEffectRecord,
  type PauseResumeJournalPort,
} from "../../../packages/runtime-core/src/pause-resume.js";

const operation = (
  effect_state: PauseResumeEffectRecord["effect_state"],
): PauseResumeEffectRecord => ({
  operation_id: "operation-1",
  run_id: "run-1",
  step_id: "step-1",
  attempt_id: "attempt-1",
  tool_name: "http_request",
  idempotency_key: "idempotency-1",
  effect_state,
  receipt_json: null,
});

class MemoryJournal implements PauseResumeJournalPort {
  record: PauseResumeEffectRecord;
  readonly transitions: PauseResumeEffectRecord[] = [];

  constructor(state: PauseResumeEffectRecord["effect_state"]) {
    this.record = operation(state);
  }

  getOperation(operationId: string): PauseResumeEffectRecord | null {
    return operationId === this.record.operation_id ? this.record : null;
  }

  recordOperation(record: PauseResumeEffectRecord): void {
    this.record = Object.freeze({ ...record });
    this.transitions.push(this.record);
  }
}

const request = {
  run_id: "run-1",
  operation_id: "operation-1",
} as const;

describe("AH-PAUSE-RESUME-001 effect-state-aware resume", () => {
  it.each([
    [undefined, "pause/resume journal is required"],
    [{}, "pause/resume journal is required"],
    [
      { journal: { getOperation: null, recordOperation: vi.fn() } },
      "pause/resume journal is required",
    ],
    [
      { journal: { getOperation: vi.fn(), recordOperation: null } },
      "pause/resume journal is required",
    ],
    [
      { journal: new MemoryJournal("PRE_DISPATCH") },
      "pause/resume read-back port is required",
    ],
    [
      {
        journal: new MemoryJournal("PRE_DISPATCH"),
        readBack: { query: null },
      },
      "pause/resume read-back port is required",
    ],
    [
      {
        journal: new MemoryJournal("PRE_DISPATCH"),
        readBack: { query: vi.fn() },
      },
      "pause/resume reconciliation port is required",
    ],
    [
      {
        journal: new MemoryJournal("PRE_DISPATCH"),
        readBack: { query: vi.fn() },
        reconciliation: { reconcile: null },
      },
      "pause/resume reconciliation port is required",
    ],
  ])("rejects an incomplete composition port", (options, message) => {
    expect(() => new PauseResumeController(options as never)).toThrow(message);
  });

  it.each([
    [undefined, "run_id is required"],
    [null, "run_id is required"],
    [42, "run_id is required"],
    ["", "run_id is required"],
    ["   ", "run_id is required"],
  ])("rejects an invalid run identity", async (run_id, message) => {
    const controller = new PauseResumeController({
      journal: new MemoryJournal("PRE_DISPATCH"),
      readBack: { query: vi.fn() },
      reconciliation: { reconcile: vi.fn() },
    });

    await expect(
      controller.resume({ ...request, run_id } as never),
    ).rejects.toThrow(message);
  });

  it.each([
    [undefined, "operation_id is required"],
    [null, "operation_id is required"],
    [42, "operation_id is required"],
    ["", "operation_id is required"],
    ["   ", "operation_id is required"],
  ])("rejects an invalid operation identity", async (operation_id, message) => {
    const controller = new PauseResumeController({
      journal: new MemoryJournal("PRE_DISPATCH"),
      readBack: { query: vi.fn() },
      reconciliation: { reconcile: vi.fn() },
    });

    await expect(
      controller.resume({ ...request, operation_id } as never),
    ).rejects.toThrow(message);
  });

  it("turns PRE_DISPATCH into a new attempt through the full action pipeline", async () => {
    const journal = new MemoryJournal("PRE_DISPATCH");
    const readBack = vi.fn();
    const reconcile = vi.fn();
    const controller = new PauseResumeController({
      journal,
      readBack: { query: readBack },
      reconciliation: { reconcile },
    });

    await expect(controller.resume(request)).resolves.toEqual({
      action: "retry_new_attempt",
      operation_id: "operation-1",
      previous_attempt_id: "attempt-1",
      requires_new_capability: true,
      restart_pipeline_at: "schema",
    });
    expect(journal.record.effect_state).toBe("DEFINITELY_FAILED_NO_EFFECT");
    expect(readBack).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("queries IN_FLIGHT before deciding and never returns a direct retry", async () => {
    const journal = new MemoryJournal("IN_FLIGHT");
    const readBack = vi.fn().mockResolvedValue({ status: "no_effect" });
    const controller = new PauseResumeController({
      journal,
      readBack: { query: readBack },
      reconciliation: { reconcile: vi.fn() },
    });

    const result = await controller.resume(request);

    expect(readBack).toHaveBeenCalledTimes(1);
    expect(journal.transitions.map((entry) => entry.effect_state)).toEqual([
      "DEFINITELY_FAILED_NO_EFFECT",
    ]);
    expect(result).toMatchObject({
      action: "retry_new_attempt",
      requires_new_capability: true,
      restart_pipeline_at: "schema",
    });
    expect(JSON.stringify(result)).not.toContain("reExecuteFromStep");
  });

  it("continues after a read-back confirms an IN_FLIGHT effect", async () => {
    const journal = new MemoryJournal("IN_FLIGHT");
    const controller = new PauseResumeController({
      journal,
      readBack: {
        query: vi.fn().mockResolvedValue({
          status: "confirmed",
          stored_outcome_json: '{"receipt":{"success":true}}',
        }),
      },
      reconciliation: { reconcile: vi.fn() },
    });

    await expect(controller.resume(request)).resolves.toEqual({
      action: "continue_next_step",
      operation_id: "operation-1",
    });
    expect(journal.record).toMatchObject({
      effect_state: "EFFECT_CONFIRMED",
      receipt_json: '{"receipt":{"success":true}}',
    });
  });

  it("moves unknown effects through RECONCILING before confirmation", async () => {
    const journal = new MemoryJournal("EFFECT_UNKNOWN");
    const reconcile = vi.fn().mockResolvedValue({
      status: "confirmed",
      stored_outcome_json: '{"receipt":{"success":true}}',
    });
    const controller = new PauseResumeController({
      journal,
      readBack: { query: vi.fn() },
      reconciliation: { reconcile },
    });

    await expect(controller.resume(request)).resolves.toEqual({
      action: "continue_next_step",
      operation_id: "operation-1",
    });
    expect(journal.transitions.map((entry) => entry.effect_state)).toEqual([
      "RECONCILING",
      "EFFECT_CONFIRMED",
    ]);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("persists AWAITING_HUMAN when reconciliation is indeterminate", async () => {
    const journal = new MemoryJournal("EFFECT_UNKNOWN");
    const controller = new PauseResumeController({
      journal,
      readBack: { query: vi.fn() },
      reconciliation: {
        reconcile: vi.fn().mockResolvedValue({ status: "indeterminate" }),
      },
    });

    await expect(controller.resume(request)).resolves.toEqual({
      action: "await_human",
      operation_id: "operation-1",
      reason: "effect_state_indeterminate",
    });
    expect(journal.record.effect_state).toBe("AWAITING_HUMAN");
  });

  it("resumes a crash-persisted RECONCILING operation without retrying it", async () => {
    const journal = new MemoryJournal("RECONCILING");
    const reconcile = vi.fn().mockResolvedValue({ status: "no_effect" });
    const controller = new PauseResumeController({
      journal,
      readBack: { query: vi.fn() },
      reconciliation: { reconcile },
    });

    await expect(controller.resume(request)).resolves.toMatchObject({
      action: "retry_new_attempt",
      requires_new_capability: true,
      restart_pipeline_at: "schema",
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(journal.record.effect_state).toBe("DEFINITELY_FAILED_NO_EFFECT");
  });

  it("does not re-query confirmed, definitely-failed, or human-blocked states", async () => {
    for (const [state, action] of [
      ["EFFECT_CONFIRMED", "continue_next_step"],
      ["DEFINITELY_FAILED_NO_EFFECT", "retry_new_attempt"],
      ["AWAITING_HUMAN", "await_human"],
    ] as const) {
      const journal = new MemoryJournal(state);
      const readBack = vi.fn();
      const reconcile = vi.fn();
      const controller = new PauseResumeController({
        journal,
        readBack: { query: readBack },
        reconciliation: { reconcile },
      });

      await expect(controller.resume(request)).resolves.toMatchObject({ action });
      expect(readBack).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
    }
  });

  it("fails closed for missing or cross-run operation identities", async () => {
    const journal = new MemoryJournal("PRE_DISPATCH");
    const controller = new PauseResumeController({
      journal,
      readBack: { query: vi.fn() },
      reconciliation: { reconcile: vi.fn() },
    });

    await expect(
      controller.resume({ ...request, operation_id: "missing" }),
    ).rejects.toThrow("pause/resume operation not found");
    await expect(
      controller.resume({ ...request, run_id: "run-2" }),
    ).rejects.toThrow("pause/resume operation scope mismatch");
  });

  it("fails closed to human review when read-back or reconciliation throws", async () => {
    for (const [state, readBack, reconcile] of [
      [
        "IN_FLIGHT",
        vi.fn().mockRejectedValue(new Error("provider offline")),
        vi.fn().mockRejectedValue(new Error("ledger offline")),
      ],
      [
        "EFFECT_UNKNOWN",
        vi.fn(),
        vi.fn().mockRejectedValue(new Error("ledger offline")),
      ],
    ] as const) {
      const journal = new MemoryJournal(state);
      const controller = new PauseResumeController({
        journal,
        readBack: { query: readBack },
        reconciliation: { reconcile },
      });

      await expect(controller.resume(request)).resolves.toEqual({
        action: "await_human",
        operation_id: "operation-1",
        reason: "effect_state_indeterminate",
      });
      expect(journal.record.effect_state).toBe("AWAITING_HUMAN");
      if (state === "IN_FLIGHT") {
        expect(journal.transitions.map((entry) => entry.effect_state)).toEqual([
          "EFFECT_UNKNOWN",
          "RECONCILING",
          "AWAITING_HUMAN",
        ]);
      }
    }
  });

  it("does not persist an unauthenticated malformed confirmed outcome", async () => {
    const journal = new MemoryJournal("IN_FLIGHT");
    const controller = new PauseResumeController({
      journal,
      readBack: {
        query: vi.fn().mockResolvedValue({
          status: "confirmed",
          stored_outcome_json: "{",
        }),
      },
      reconciliation: { reconcile: vi.fn() },
    });

    await expect(controller.resume(request)).rejects.toThrow(
      "confirmed effect outcome must be valid JSON",
    );
    expect(journal.record.effect_state).toBe("IN_FLIGHT");
  });

  it.each(["", "   "])(
    "does not persist an empty confirmed outcome",
    async (stored_outcome_json) => {
      const journal = new MemoryJournal("IN_FLIGHT");
      const controller = new PauseResumeController({
        journal,
        readBack: {
          query: vi.fn().mockResolvedValue({
            status: "confirmed",
            stored_outcome_json,
          }),
        },
        reconciliation: { reconcile: vi.fn() },
      });

      await expect(controller.resume(request)).rejects.toThrow(
        "stored_outcome_json is required",
      );
      expect(journal.record.effect_state).toBe("IN_FLIGHT");
    },
  );

  it("rejects a corrupted persisted effect state instead of returning undefined", async () => {
    const journal = new MemoryJournal("PRE_DISPATCH");
    journal.record = {
      ...journal.record,
      effect_state: "CORRUPTED" as never,
    };
    const controller = new PauseResumeController({
      journal,
      readBack: { query: vi.fn() },
      reconciliation: { reconcile: vi.fn() },
    });

    await expect(controller.resume(request)).rejects.toThrow(
      "unsupported pause/resume effect state",
    );
  });
});
