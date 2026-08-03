import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ContextCompiler,
  type ContextCompilerInput,
  type ContextCompilerItem,
  type ContextContentLayer,
} from "../../../packages/runtime-core/src/context-compiler.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const item = (
  id: string,
  layer: ContextContentLayer,
  token_count: number,
  trust: ContextCompilerItem["trust"] = "trusted",
): ContextCompilerItem => ({
  id,
  layer,
  token_count,
  trust,
  tenant_id: "tenant-a",
  acl: { tenant_id: "tenant-a", principal_ids: ["principal-a"] },
  content: layer === "active_plan" ? {
    goal: "preserve security",
    completed: [],
    in_progress: null,
    open_tasks: [],
    blockers: [],
    last_error: null,
    constraints: ["deny external writes"],
  } : { text: id },
  source_hash: hash(id),
  provenance: {
    source_type: layer === "memory" ? "memory_port" : "fixture",
    source_id: id,
  },
  key_fact: true,
});

const state = {
  goal: "preserve security",
  constraints: ["deny external writes"],
  decisions: [],
  security: {
    approvals: [], grants: [], denials: [], current_revocations: [],
    effects: [], receipts: [], idempotency_ids: [],
  },
  active_plan: [], open_tasks: [], source_hashes: [hash("source")],
  tracked_file_changes: [],
};

const input = (): ContextCompilerInput => ({
  tenant_id: "tenant-a",
  principal_id: "principal-a",
  run_id: "run-a",
  session_id: "session-a",
  context_generation: 1,
  context_capacity_tokens: 1_000,
  reserved_output_tokens: 100,
  cache_breakpoint: 1,
  layers: {
    system_policy: [item("system", "system_policy", 10, "policy")],
    task: [item("task", "task", 10)],
    active_plan: [item("plan", "active_plan", 10)],
    recent_conversation: [item("recent", "recent_conversation", 500)],
    retrieved_evidence: [item("rag", "retrieved_evidence", 10, "untrusted")],
    tool_definitions: [item("tools", "tool_definitions", 10)],
    tool_results: [item("result", "tool_results", 10, "untrusted")],
    memory: [item("memory", "memory", 10, "untrusted")],
  },
  selected: {
    tool_ids: ["tool-read"],
    skill_ids: [],
    rag_source_ids: ["rag"],
    disclosures: ["memory-port-only"],
  },
  compaction_state: state,
});

describe("AH-CONTEXT-COMPILER-001 fail-closed security boundaries", () => {
  it("rejects cross-tenant and ACL-denied items before pressure side effects", async () => {
    const compact = vi.fn();
    const compiler = new ContextCompiler({ compactor: { compact } });
    const foreign = input();
    foreign.layers.task = [{
      ...item("foreign", "task", 10),
      tenant_id: "tenant-b",
      acl: { tenant_id: "tenant-b", principal_ids: ["principal-a"] },
    }];

    await expect(compiler.compile(foreign)).rejects.toThrow("cross-tenant");
    expect(compact).not.toHaveBeenCalled();

    const denied = input();
    denied.layers.task = [{
      ...item("denied", "task", 10),
      acl: { tenant_id: "tenant-a", principal_ids: ["principal-b"] },
    }];
    await expect(compiler.compile(denied)).rejects.toThrow("ACL");
    expect(compact).not.toHaveBeenCalled();
  });

  it("rejects generation overflow and unrecoverable retained facts before compaction", async () => {
    const compact = vi.fn();
    const compiler = new ContextCompiler({ compactor: { compact } });
    const overflow = input();
    overflow.context_generation = Number.MAX_SAFE_INTEGER;
    await expect(compiler.compile(overflow)).rejects.toThrow("context_generation");
    expect(compact).not.toHaveBeenCalled();

    const cannotFit = input();
    cannotFit.layers.recent_conversation = [
      { ...item("required-fact", "recent_conversation", 2_000), key_fact: true },
    ];
    await expect(compiler.compile(cannotFit)).rejects.toThrow("cannot fit");
    expect(compact).not.toHaveBeenCalled();
  });

  it("fails closed when the existing compactor cancels the operation", async () => {
    const compiler = new ContextCompiler({
      compactor: {
        compact: vi.fn(async () => ({
          action: "cancelled" as const,
          state,
          stable_prefix: [],
          recent_conversation: [],
          offloaded: [],
          omitted_ids: [],
          cache_breakpoint: 1,
          pressure_after_offload: 0.7,
          reason_code: "policy_denied",
        })),
      },
    });

    await expect(compiler.compile(input())).rejects.toThrow("policy_denied");
  });

  it("requires exact RAG disclosure and never promotes untrusted layers", async () => {
    const value = input();
    value.context_capacity_tokens = 2_000;
    value.selected.rag_source_ids = [];
    const compiler = new ContextCompiler();
    await expect(compiler.compile(value)).rejects.toThrow("RAG disclosure");

    const safe = input();
    safe.context_capacity_tokens = 2_000;
    const result = await compiler.compile(safe);
    for (const layer of ["retrieved_evidence", "tool_results", "memory"] as const) {
      expect(result.messages.find((entry) => entry.layer === layer))
        .toMatchObject({ trust: "untrusted", isolated: true });
    }
    expect(result.messages[0]).toMatchObject({ layer: "system_policy", trust: "policy" });
  });
});
