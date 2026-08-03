import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { ContextCompactor } from "../../../packages/runtime-core/src/compaction.js";

import {
  ContextCompiler,
  CONTEXT_LAYERS,
  type ContextCompilerInput,
  type ContextCompilerItem,
} from "../../../packages/runtime-core/src/context-compiler.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const item = (
  id: string,
  layer: ContextCompilerItem["layer"],
  token_count: number,
  trust: ContextCompilerItem["trust"] = "trusted",
): ContextCompilerItem => ({
  id, layer, token_count, trust, tenant_id: "tenant-1",
  acl: { tenant_id: "tenant-1", principal_ids: ["principal-1"] },
  content: layer === "active_plan" ? {
    goal: id,
    completed: [],
    in_progress: null,
    open_tasks: [],
    blockers: [],
    last_error: null,
    constraints: ["no external writes"],
  } : { text: id },
  source_hash: hash(id),
  provenance: {
    source_type: layer === "memory" ? "memory_port" : "fixture",
    source_id: id,
  },
  key_fact: true,
});

const input = (): ContextCompilerInput => ({
  tenant_id: "tenant-1",
  principal_id: "principal-1",
  run_id: "run-1",
  session_id: "session-1",
  context_generation: 3,
  context_capacity_tokens: 2_000,
  reserved_output_tokens: 100,
  cache_breakpoint: 1,
  layers: {
    system_policy: [item("system", "system_policy", 50, "policy")],
    task: [item("task", "task", 40)],
    active_plan: [item("plan-current", "active_plan", 30)],
    recent_conversation: [item("recent", "recent_conversation", 100)],
    retrieved_evidence: [item("rag", "retrieved_evidence", 60, "untrusted")],
    tool_definitions: [item("tool-def", "tool_definitions", 20)],
    tool_results: [item("tool-result", "tool_results", 80, "untrusted")],
    memory: [item("memory-port", "memory", 10, "untrusted")],
  },
  selected: {
    tool_ids: ["tool-read"], skill_ids: ["skill-research"],
    rag_source_ids: ["rag"], disclosures: ["memory-port-only"],
  },
});

describe("AH-CONTEXT-COMPILER-001 deterministic nine-layer compiler", () => {
  it("emits ordered messages and a complete provenance manifest", async () => {
    const compiler = new ContextCompiler();
    const result = await compiler.compile(input());

    expect(CONTEXT_LAYERS).toEqual([
      "system_policy", "task", "active_plan", "recent_conversation",
      "retrieved_evidence", "tool_definitions", "tool_results", "memory",
      "reserved_output",
    ]);
    expect(result.messages.map((message) => message.layer)).toEqual(CONTEXT_LAYERS.slice(0, 8));
    expect(result.messages.find((message) => message.layer === "retrieved_evidence"))
      .toMatchObject({ role: "user", trust: "untrusted", isolated: true });
    expect(result.manifest.layers.map((layer) => layer.layer)).toEqual(CONTEXT_LAYERS);
    expect(result.manifest.layers.at(-1)).toMatchObject({
      layer: "reserved_output", token_count: 100, trust: "reserved",
    });
    expect(result.manifest).toMatchObject({
      context_generation: 3,
      cache_breakpoint: 1,
      selected: input().selected,
      omitted_items: [],
      offloaded_vfs_handles: [],
    });
    expect(result.manifest.layers[0]!.items[0]).toMatchObject({
      id: "system", source_hash: hash("system"),
      provenance: { source_type: "fixture", source_id: "system" },
    });
    expect(result.total_input_tokens).toBe(390);
    expect(result.reserved_output_tokens).toBe(100);
  });

  it("rewrites the active plan layer from current input instead of appending history", async () => {
    const compiler = new ContextCompiler();
    const first = await compiler.compile(input());
    const next = input();
    next.layers.active_plan = [item("plan-next", "active_plan", 25)];
    const second = await compiler.compile(next);

    expect(first.messages.find((entry) => entry.layer === "active_plan")!.item_ids)
      .toEqual(["plan-current"]);
    expect(second.messages.find((entry) => entry.layer === "active_plan")!.item_ids)
      .toEqual(["plan-next"]);
    expect(JSON.stringify(second)).not.toContain("plan-current");
  });

  it("is byte-deterministic for a 200k-token conversation and preserves every constraint", async () => {
    const value = input();
    value.context_capacity_tokens = 1_000_000;
    value.layers.recent_conversation = Array.from({ length: 2_000 }, (_, index) => ({
      ...item(`turn-${index}`, "recent_conversation", 100),
      key_fact: index < 1_900,
    }));
    value.layers.task = Array.from({ length: 20 }, (_, index) => ({
      ...item(`constraint-${index}`, "task", 1),
      content: { constraint: `must-${index}` },
    }));
    const compiler = new ContextCompiler();
    const first = await compiler.compile(value);
    const second = await compiler.compile(value);

    expect(first.manifest.manifest_hash).toBe(second.manifest.manifest_hash);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.messages.find((entry) => entry.layer === "recent_conversation")!.item_ids)
      .toHaveLength(2_000);
    expect(first.messages.find((entry) => entry.layer === "task")!.content)
      .toEqual(value.layers.task.map((entry) => entry.content));
  });

  it("enforces ACL, trust boundaries, stable cache boundaries, and the active-plan budget", async () => {
    const compiler = new ContextCompiler();
    const crossTenant = input();
    crossTenant.layers.task = [{
      ...item("foreign", "task", 1),
      tenant_id: "tenant-2",
      acl: { tenant_id: "tenant-2", principal_ids: ["principal-1"] },
    }];
    await expect(compiler.compile(crossTenant)).rejects.toThrow("cross-tenant");

    const denied = input();
    denied.layers.task = [{
      ...item("denied", "task", 1),
      acl: { tenant_id: "tenant-1", principal_ids: ["other-principal"] },
    }];
    await expect(compiler.compile(denied)).rejects.toThrow("ACL");

    const untrustedPolicy = input();
    untrustedPolicy.layers.system_policy = [item("bad-policy", "system_policy", 1, "untrusted")];
    await expect(compiler.compile(untrustedPolicy)).rejects.toThrow("system_policy trust");

    const oversizedPlan = input();
    oversizedPlan.layers.active_plan = [item("large-plan", "active_plan", 2_001)];
    oversizedPlan.context_capacity_tokens = 3_000;
    await expect(compiler.compile(oversizedPlan)).rejects.toThrow("active plan");

    const unstableBreakpoint = input();
    unstableBreakpoint.cache_breakpoint = 3;
    await expect(compiler.compile(unstableBreakpoint)).rejects.toThrow("cache_breakpoint");
  });

  it("uses the existing compactor for 40/70/85 pressure, VFS pointers, and reset recovery", async () => {
    const writes: Array<{ path: string; bytes: string }> = [];
    const authority = new ContextCompactor({
      vfs: { write: (path, bytes) => writes.push({ path, bytes }) },
      beforeCompact: { dispatch: async () => ({ action: "continue" as const }) },
      freshSession: {
        prepare: async () => ({ session_id: "session-reset", commit: async () => undefined }),
      },
    });
    const compact = vi.fn(authority.compact.bind(authority));
    const compiler = new ContextCompiler({ compactor: { compact } });
    const state = {
      goal: "compile safely",
      constraints: ["no external writes"],
      decisions: [],
      security: {
        approvals: [], grants: [], denials: [], current_revocations: [],
        effects: [], receipts: [], idempotency_ids: [],
      },
      active_plan: [], open_tasks: [], source_hashes: [hash("source")],
      tracked_file_changes: [],
    };

    const below40 = input();
    below40.context_capacity_tokens = 2_000;
    below40.layers.recent_conversation = [
      { ...item("below-boundary", "recent_conversation", 409), key_fact: true },
    ];
    const beforeBoundary = await compiler.compile(below40);
    expect(compact).not.toHaveBeenCalled();

    const exact40 = input();
    exact40.context_capacity_tokens = 2_000;
    exact40.compaction_state = state;
    exact40.layers.recent_conversation = [
      { ...item("at-boundary", "recent_conversation", 410), key_fact: true },
    ];
    const atBoundary = await compiler.compile(exact40);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(atBoundary.manifest.stable_prefix_hash)
      .toBe(beforeBoundary.manifest.stable_prefix_hash);

    const at40 = input();
    at40.context_capacity_tokens = 100_000;
    at40.compaction_state = state;
    at40.layers.tool_results = [{
      ...item("large-tool-result", "tool_results", 40_000, "untrusted"),
      content: { lines: Array.from({ length: 20 }, (_, index) => `line-${index}`) },
      preview: { lines: Array.from({ length: 10 }, (_, index) => `line-${index}`) },
      preview_token_count: 20,
    }];
    const offloaded = await compiler.compile(at40);
    expect(offloaded.manifest.offloaded_vfs_handles).toHaveLength(1);
    expect(offloaded.messages.find((entry) => entry.layer === "tool_results")!.content[0])
      .toMatchObject({ kind: "vfs_pointer", preview: at40.layers.tool_results[0]!.preview });
    expect(writes[0]!.path).toBe(offloaded.manifest.offloaded_vfs_handles[0]!.path);

    const at70 = input();
    at70.context_capacity_tokens = 1_000;
    at70.compaction_state = state;
    at70.layers.recent_conversation = [
      { ...item("key-fact", "recent_conversation", 100), key_fact: true },
      { ...item("old-chatter", "recent_conversation", 210), key_fact: false },
    ];
    const compacted = await compiler.compile(at70);
    expect(compacted.manifest.omitted_items).toEqual(["old-chatter"]);
    expect(compacted.messages.find((entry) => entry.layer === "recent_conversation")!.item_ids)
      .toEqual(["key-fact"]);

    const at85 = input();
    at85.context_capacity_tokens = 1_000;
    at85.compaction_state = state;
    at85.layers.recent_conversation = [
      { ...item("reset-fact", "recent_conversation", 460), key_fact: true },
    ];
    const reset = await compiler.compile(at85);
    expect(reset.manifest.session_id).toBe("session-reset");
    expect(reset.manifest.context_generation).toBe(4);
    expect(writes.at(-1)!.path).toContain("/handoff-");
  });
});
