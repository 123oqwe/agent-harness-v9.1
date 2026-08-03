import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ContextCompactor,
  ContextCompiler,
  type ContextCompilerInput,
  type ContextCompilerItem,
  type ContextContentLayer,
} from "../../../packages/runtime-core/src/index.js";
import { StoreBackend, VirtualFilesystem } from "../../../vfs/virtual-filesystem.js";

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
    goal: "inspect a large result",
    completed: [],
    in_progress: null,
    open_tasks: [],
    blockers: [],
    last_error: null,
    constraints: ["local only"],
  } : { text: id },
  source_hash: hash(id),
  provenance: {
    source_type: layer === "memory" ? "memory_port" : "fixture",
    source_id: id,
  },
  key_fact: true,
});

describe("AH-CONTEXT-COMPILER-001 existing VFS integration", () => {
  it("stores the full tool result once and exposes only a hash-bound pointer plus preview", async () => {
    const vfs = new VirtualFilesystem([{ prefix: "/scratch", read: true, write: true }]);
    vfs.mount(new StoreBackend("/scratch"));
    const hook = vi.fn(async () => ({ action: "continue" as const }));
    const freshSession = vi.fn();
    const compiler = new ContextCompiler({
      compactor: new ContextCompactor({
        vfs,
        beforeCompact: { dispatch: hook },
        freshSession: { prepare: freshSession },
      }),
    });
    const fullLines = Array.from({ length: 100 }, (_, index) => `sensitive-line-${index}`);
    const preview = { lines: fullLines.slice(0, 10) };
    const largeResult = {
      ...item("large-result", "tool_results", 40_000, "untrusted"),
      content: { lines: fullLines },
      preview,
      preview_token_count: 40,
    };
    const value: ContextCompilerInput = {
      tenant_id: "tenant-a",
      principal_id: "principal-a",
      run_id: "run-a",
      session_id: "session-a",
      context_generation: 5,
      context_capacity_tokens: 100_000,
      reserved_output_tokens: 100,
      cache_breakpoint: 1,
      layers: {
        system_policy: [item("system", "system_policy", 50, "policy")],
        task: [item("task", "task", 40)],
        active_plan: [item("plan", "active_plan", 30)],
        recent_conversation: [item("recent", "recent_conversation", 100)],
        retrieved_evidence: [item("rag", "retrieved_evidence", 60, "untrusted")],
        tool_definitions: [item("tools", "tool_definitions", 20)],
        tool_results: [largeResult],
        memory: [item("memory", "memory", 10, "untrusted")],
      },
      selected: {
        tool_ids: ["tool-read"], skill_ids: [], rag_source_ids: ["rag"],
        disclosures: ["memory-port-only"],
      },
      compaction_state: {
        goal: "inspect a large result",
        constraints: ["local only"],
        decisions: [],
        security: {
          approvals: [], grants: [], denials: [], current_revocations: [],
          effects: [], receipts: [], idempotency_ids: [],
        },
        active_plan: [], open_tasks: [], source_hashes: [hash("source")],
        tracked_file_changes: [],
      },
    };

    const result = await compiler.compile(value);
    const handle = result.manifest.offloaded_vfs_handles[0]!;
    expect(result.manifest.context_generation).toBe(6);
    expect(result.messages.find((entry) => entry.layer === "tool_results")!.content)
      .toEqual([{
        kind: "vfs_pointer",
        path: handle.path,
        sha256: handle.sha256,
        source_id: "large-result",
        preview,
      }]);
    const stored = vfs.readText(handle.path);
    expect(createHash("sha256").update(stored).digest("hex")).toBe(handle.sha256);
    expect(JSON.parse(stored).content).toEqual({ lines: fullLines });
    expect(vfs.exists(handle.path.replace("tenant-a", "tenant-b"))).toBe(false);
    expect(hook).not.toHaveBeenCalled();
    expect(freshSession).not.toHaveBeenCalled();
  });
});
