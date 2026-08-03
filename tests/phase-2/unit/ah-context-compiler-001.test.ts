import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { ContextCompactor } from "../../../packages/runtime-core/src/compaction.js";

import {
  ContextCompiler,
  CONTEXT_LAYERS,
  type ContextCompilerInput,
  type ContextCompilerItem,
} from "../../../packages/runtime-core/src/context-compiler.js";

type Mutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T extends object
      ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
      : T;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
};
const item = (
  id: string,
  layer: ContextCompilerItem["layer"],
  token_count: number,
  trust: ContextCompilerItem["trust"] = "trusted",
): Mutable<ContextCompilerItem> => ({
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

const input = (): Mutable<ContextCompilerInput> => ({
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
    expect(result.messages.map(({ role, trust, isolated, item_ids }) => ({
      role, trust, isolated, item_ids,
    }))).toEqual([
      { role: "system", trust: "policy", isolated: false, item_ids: ["system"] },
      { role: "user", trust: "trusted", isolated: false, item_ids: ["task"] },
      { role: "user", trust: "trusted", isolated: false, item_ids: ["plan-current"] },
      { role: "assistant", trust: "trusted", isolated: false, item_ids: ["recent"] },
      { role: "user", trust: "untrusted", isolated: true, item_ids: ["rag"] },
      { role: "user", trust: "trusted", isolated: false, item_ids: ["tool-def"] },
      { role: "tool", trust: "untrusted", isolated: true, item_ids: ["tool-result"] },
      { role: "user", trust: "untrusted", isolated: true, item_ids: ["memory-port"] },
    ]);
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
    const { manifest_hash, ...manifestBody } = result.manifest;
    expect(manifest_hash).toBe(hash(canonical(manifestBody)));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.messages)).toBe(true);
    expect(Object.isFrozen(result.messages[0]!.content[0]!)).toBe(true);
    expect(Object.isFrozen(result.manifest.layers[0]!.items[0]!.provenance)).toBe(true);
    expect(Object.isFrozen(result.manifest.selected.tool_ids)).toBe(true);
  });

  it("canonicalizes property order and attenuates mixed or empty layers", async () => {
    const firstInput = input();
    firstInput.layers.task = [
      item("trusted-task", "task", 10),
      item("untrusted-task", "task", 10, "untrusted"),
    ];
    firstInput.layers.retrieved_evidence = [];
    firstInput.selected.rag_source_ids = [];
    const secondInput = input();
    secondInput.layers.task = firstInput.layers.task.map((entry) => ({
      ...entry,
      provenance: {
        source_id: entry.provenance.source_id,
        source_type: entry.provenance.source_type,
      },
    }));
    secondInput.layers.retrieved_evidence = [];
    secondInput.selected.rag_source_ids = [];
    const compiler = new ContextCompiler();
    const first = await compiler.compile(firstInput);
    const second = await compiler.compile(secondInput);

    expect(first.manifest.manifest_hash).toBe(second.manifest.manifest_hash);
    expect(first.messages.find((entry) => entry.layer === "task"))
      .toMatchObject({ trust: "untrusted", isolated: true });
    expect(first.manifest.layers.find((entry) => entry.layer === "task"))
      .toMatchObject({ trust: "mixed", token_count: 20 });
    expect(first.messages.find((entry) => entry.layer === "retrieved_evidence"))
      .toMatchObject({ trust: "untrusted", isolated: false, item_ids: [], content: [] });
    expect(first.manifest.layers.find((entry) => entry.layer === "retrieved_evidence"))
      .toMatchObject({ trust: "mixed", token_count: 0, items: [] });
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
    value.layers.recent_conversation = Array.from({ length: 200 }, (_, index) => ({
      ...item(`turn-${index}`, "recent_conversation", 1_000),
      key_fact: index < 190,
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
      .toHaveLength(200);
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

  it.each([
    ["missing compactor method", { compactor: {} }, "context compactor port is invalid"],
    ["zero threshold", { offload_token_threshold: 0 }, "offload_token_threshold must be a positive safe integer"],
    ["negative threshold", { offload_token_threshold: -1 }, "offload_token_threshold must be a positive safe integer"],
    ["fractional threshold", { offload_token_threshold: 1.5 }, "offload_token_threshold must be a positive safe integer"],
  ] as const)("rejects invalid constructor option: %s", (_name, options, message) => {
    expect(() => new ContextCompiler(options as never)).toThrow(message);
  });

  it.each([
    ["tenant id", (value: any) => { value.tenant_id = "../bad"; }, "tenant_id is invalid"],
    ["principal id", (value: any) => { value.principal_id = "../bad"; }, "principal_id is invalid"],
    ["run id", (value: any) => { value.run_id = "../bad"; }, "run_id is invalid"],
    ["session id", (value: any) => { value.session_id = "../bad"; }, "session_id is invalid"],
    ["negative generation", (value: any) => { value.context_generation = -1; }, "context_generation must be a non-negative safe integer"],
    ["fractional generation", (value: any) => { value.context_generation = 1.5; }, "context_generation must be a non-negative safe integer"],
    ["zero capacity", (value: any) => { value.context_capacity_tokens = 0; }, "context_capacity_tokens must be positive"],
    ["negative capacity", (value: any) => { value.context_capacity_tokens = -1; }, "context_capacity_tokens must be a non-negative safe integer"],
    ["fractional capacity", (value: any) => { value.context_capacity_tokens = 1.5; }, "context_capacity_tokens must be a non-negative safe integer"],
    ["negative reserve", (value: any) => { value.reserved_output_tokens = -1; }, "reserved_output_tokens must be a non-negative safe integer"],
    ["reserve overflow", (value: any) => { value.reserved_output_tokens = 2_001; }, "reserved_output_tokens exceeds context capacity"],
    ["negative breakpoint", (value: any) => { value.cache_breakpoint = -1; }, "cache_breakpoint must be a non-negative safe integer"],
    ["missing layers", (value: any) => { value.layers = null; }, "context layers are required"],
    ["empty system", (value: any) => { value.layers.system_policy = []; }, "system_policy must not be empty"],
    ["breakpoint overflow", (value: any) => { value.cache_breakpoint = 3; }, "cache_breakpoint exceeds stable-prefix boundary"],
    ["invalid item id", (value: any) => { value.layers.task[0].id = "../bad"; }, "context item id is invalid"],
    ["duplicate item", (value: any) => { value.layers.task[0].id = "system"; }, "context item ids must be unique"],
    ["layer mismatch", (value: any) => { value.layers.task[0].layer = "memory"; }, "context item layer mismatch"],
    ["ACL tenant", (value: any) => { value.layers.task[0].acl.tenant_id = "tenant-2"; }, "context item ACL denied"],
    ["ACL list", (value: any) => { value.layers.task[0].acl.principal_ids = null; }, "context item ACL denied"],
    ["ACL denied", (value: any) => { value.layers.task[0].acl.principal_ids = ["other"]; }, "context item ACL denied"],
    ["ACL invalid principal", (value: any) => { value.layers.task[0].acl.principal_ids = ["principal-1", "../bad"]; }, "context item ACL principal_id is invalid"],
    ["ACL duplicate principal", (value: any) => { value.layers.task[0].acl.principal_ids = ["principal-1", "principal-1"]; }, "context item ACL principal_ids must be unique"],
    ["negative item tokens", (value: any) => { value.layers.task[0].token_count = -1; }, "context item token_count must be a non-negative safe integer"],
    ["fractional item tokens", (value: any) => { value.layers.task[0].token_count = 1.5; }, "context item token_count must be a non-negative safe integer"],
    ["token accounting overflow", (value: any) => { value.reserved_output_tokens = Number.MAX_SAFE_INTEGER; value.context_capacity_tokens = Number.MAX_SAFE_INTEGER; value.layers.task[0].token_count = 1; }, "context token accounting exceeds safe integer range"],
    ["source hash", (value: any) => { value.layers.task[0].source_hash = "bad"; }, "context item source_hash is invalid"],
    ["trust", (value: any) => { value.layers.task[0].trust = "admin"; }, "context item trust is invalid"],
    ["policy outside system", (value: any) => { value.layers.task[0].trust = "policy"; }, "policy trust is restricted to system_policy"],
    ["trusted evidence", (value: any) => { value.layers.retrieved_evidence[0].trust = "trusted"; }, "retrieved_evidence trust must be untrusted"],
    ["trusted memory", (value: any) => { value.layers.memory[0].trust = "trusted"; }, "memory trust must be untrusted"],
    ["array provenance", (value: any) => { value.layers.task[0].provenance = []; }, "context item provenance is required"],
    ["negative preview", (value: any) => { value.layers.tool_results[0].preview_token_count = -1; }, "context item preview_token_count must be a non-negative safe integer"],
    ["fractional preview", (value: any) => { value.layers.tool_results[0].preview_token_count = 1.5; }, "context item preview_token_count must be a non-negative safe integer"],
    ["preview overflow", (value: any) => { value.layers.tool_results[0].preview_token_count = 81; }, "context item preview_token_count exceeds token_count"],
    ["missing active plan", (value: any) => { value.layers.active_plan = []; }, "active plan layer must contain exactly one current plan"],
    ["duplicate active plan", (value: any) => { value.layers.active_plan.push({ ...value.layers.active_plan[0], id: "plan-2", source_hash: hash("plan-2") }); }, "active plan layer must contain exactly one current plan"],
    ["invalid active plan", (value: any) => { value.layers.active_plan[0].content.goal = 1; }, "active plan content is invalid"],
    ["memory authority", (value: any) => { value.layers.memory[0].provenance.source_type = "store"; }, "memory layer must use memory_port provenance"],
    ["missing selection", (value: any) => { value.selected = null; }, "context selection disclosure is required"],
    ["tool selection list", (value: any) => { value.selected.tool_ids = null; }, "selected.tool_ids must be an array"],
    ["skill selection list", (value: any) => { value.selected.skill_ids = null; }, "selected.skill_ids must be an array"],
    ["RAG selection list", (value: any) => { value.selected.rag_source_ids = null; }, "selected.rag_source_ids must be an array"],
    ["selection id", (value: any) => { value.selected.tool_ids = ["../bad"]; }, "selected.tool_ids item is invalid"],
    ["selection duplicate", (value: any) => { value.selected.tool_ids = ["tool-read", "tool-read"]; }, "selected.tool_ids must be unique"],
    ["disclosure list", (value: any) => { value.selected.disclosures = null; }, "selected.disclosures must be an array"],
    ["empty disclosure", (value: any) => { value.selected.disclosures = [""]; }, "selected.disclosures item is invalid"],
    ["long disclosure", (value: any) => { value.selected.disclosures = ["x".repeat(257)]; }, "selected.disclosures item is invalid"],
    ["non-string disclosure", (value: any) => { value.selected.disclosures = [1]; }, "selected.disclosures item is invalid"],
    ["RAG disclosure mismatch", (value: any) => { value.selected.rag_source_ids = []; }, "selected RAG disclosure does not match included evidence"],
  ] as const)("rejects invalid compiler input: %s", async (_name, change, message) => {
    const value: any = input();
    change(value);
    await expect(new ContextCompiler().compile(value)).rejects.toThrow(message);
  });

  it.each([
    "system_policy", "task", "active_plan", "recent_conversation",
    "retrieved_evidence", "tool_definitions", "tool_results", "memory",
  ] as const)("requires the %s layer array", async (layer) => {
    const value: any = input();
    value.layers[layer] = null;
    await expect(new ContextCompiler().compile(value)).rejects.toThrow(`${layer} must be an array`);
  });

  it.each([
    ["null plan", null],
    ["completed", { completed: null }],
    ["in progress", { in_progress: "bad" }],
    ["open tasks", { open_tasks: null }],
    ["blockers", { blockers: null }],
    ["last error", { last_error: 1 }],
    ["constraints", { constraints: null }],
  ] as const)("rejects malformed active-plan field: %s", async (_name, override) => {
    const value: any = input();
    value.layers.active_plan[0].content = override === null
      ? null
      : { ...value.layers.active_plan[0].content, ...override };
    await expect(new ContextCompiler().compile(value)).rejects
      .toThrow("active plan content is invalid");
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
    expect(atBoundary.manifest.context_generation).toBe(3);
    expect(atBoundary.manifest.stable_prefix_hash)
      .toBe(beforeBoundary.manifest.stable_prefix_hash);
    expect(compact.mock.calls[0]![0]).toEqual({
      tenant_id: "tenant-1",
      run_id: "run-1",
      session_id: "session-1",
      context_generation: 3,
      context_capacity_tokens: 2_000,
      used_tokens: 800,
      cache_breakpoint: 1,
      stable_prefix: [
        { id: "system", token_count: 50, content: { text: "system" }, key_fact: true },
        { id: "tool-def", token_count: 20, content: { text: "tool-def" }, key_fact: true },
      ],
      recent_conversation: [{
        id: "at-boundary", token_count: 410,
        content: { text: "at-boundary" }, key_fact: true,
      }],
      offload_items: [],
      state,
    });

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
    expect(offloaded.manifest.context_generation).toBe(4);
    expect(offloaded.manifest.offloaded_vfs_handles).toHaveLength(1);
    expect(offloaded.messages.find((entry) => entry.layer === "tool_results")!.content[0])
      .toMatchObject({ kind: "vfs_pointer", preview: at40.layers.tool_results[0]!.preview });
    expect(writes[0]!.path).toBe(offloaded.manifest.offloaded_vfs_handles[0]!.path);
    expect(compact.mock.calls[1]![0].offload_items).toEqual([{
      id: "large-tool-result",
      token_count: 40_000,
      retained_token_count: 20,
      content: { lines: Array.from({ length: 20 }, (_, index) => `line-${index}`) },
    }]);

    const withoutPreview = input();
    withoutPreview.context_capacity_tokens = 100_000;
    withoutPreview.compaction_state = state;
    withoutPreview.layers.tool_results = [
      item("no-preview", "tool_results", 40_000, "untrusted"),
    ];
    const pointerOnly = await compiler.compile(withoutPreview);
    expect(pointerOnly.messages.find((entry) => entry.layer === "tool_results")!.content[0])
      .toMatchObject({ kind: "vfs_pointer", source_id: "no-preview", preview: null });
    expect(pointerOnly.manifest.layers.find((entry) => entry.layer === "tool_results")!.token_count)
      .toBe(0);

    const at70 = input();
    at70.context_capacity_tokens = 1_000;
    at70.compaction_state = state;
    at70.layers.recent_conversation = [
      { ...item("key-fact", "recent_conversation", 100), key_fact: true },
      { ...item("old-chatter", "recent_conversation", 210), key_fact: false },
    ];
    const compacted = await compiler.compile(at70);
    expect(compacted.manifest.context_generation).toBe(4);
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
