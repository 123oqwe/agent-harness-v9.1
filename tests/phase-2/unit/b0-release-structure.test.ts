import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error The production checker intentionally ships as plain Node ESM.
import { EXPECTED_WORKSPACES } from "../../../scripts/check-workspace-boundaries.mjs";
// @ts-expect-error The production checker intentionally ships as plain Node ESM.
import * as manifestChecker from "../../../scripts/gates/check-phase2-manifest.mjs";
// @ts-expect-error The production smoke runner intentionally ships as plain Node ESM.
import * as packageSmoke from "../../../scripts/gates/package-smoke.mjs";
// @ts-expect-error The production gate intentionally ships as plain Node ESM.
import * as phase2Gate from "../../../scripts/gates/verify-phase2-local.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const authorityPath = join(
  repositoryRoot,
  "verification/gates/phase2-gate.json",
);
const snapshotPath = join(
  repositoryRoot,
  "fixtures/phase-2/valid/phase2-gate.json",
);
const acceptedPhase1Sha = "8dca581e11b8043aed257cb07c5161237633c40e";
const supersededPhase1Sha = "bf5eac648527205603de7d26278276ad78819850";

type Manifest = {
  baseline: { sha: string };
};

const readManifest = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as Manifest;

describe("Phase 2 batch-zero release structure", () => {
  it("pins the accepted hardened Phase 1 baseline and rejects its superseded SHA", () => {
    const authority = readManifest(authorityPath);
    const snapshot = readManifest(snapshotPath);

    expect(authority.baseline.sha).toBe(acceptedPhase1Sha);
    expect(snapshot.baseline.sha).toBe(acceptedPhase1Sha);

    const oldBaseline = structuredClone(authority);
    oldBaseline.baseline.sha = supersededPhase1Sha;
    expect(manifestChecker.validatePhase2Manifest(oldBaseline)).toContain(
      `manifest.baseline.sha must be "${acceptedPhase1Sha}"; received "${supersededPhase1Sha}"`,
    );
  });

  it("preserves the accepted Phase 1 root exports and limits the Phase 2 integration port", () => {
    const accepted = spawnSync(
      "/usr/bin/git",
      ["show", `${acceptedPhase1Sha}:index.ts`],
      { cwd: repositoryRoot, encoding: "utf8", shell: false },
    );
    expect(accepted.status, accepted.stderr).toBe(0);
    const current = readFileSync(join(repositoryRoot, "index.ts"), "utf8");
    const additions = [
      "export * from './session/session-state-root.js';\n",
      "export * from './runtime/hook-port.js';\n",
      "export * from './runtime/sandboxed-hook-execution-port.js';\n",
    ];
    expect(
      additions.reduce((source, addition) => source.replace(addition, ""), current),
    ).toBe(accepted.stdout);
    for (const addition of additions) expect(current.split(addition)).toHaveLength(2);
  });

  it("proves the accepted baseline is in HEAD history and includes all 30 hardening files", () => {
    for (const workflowPath of [
      ".github/workflows/ci.yml",
      ".github/workflows/glm-acceptance.yml",
    ]) {
      const workflow = readFileSync(join(repositoryRoot, workflowPath), "utf8");
      const fullTestCheckout = workflow.slice(0, workflow.indexOf("npm test"));
      expect(fullTestCheckout, workflowPath).toMatch(/fetch-depth:\s*0/u);
    }

    const ancestry = spawnSync(
      "/usr/bin/git",
      ["merge-base", "--is-ancestor", acceptedPhase1Sha, "HEAD"],
      { cwd: repositoryRoot, encoding: "utf8", shell: false },
    );
    expect(ancestry.status, ancestry.stderr).toBe(0);

    const binding = (manifestChecker as Record<string, unknown>)
      .PHASE1_HARDENING_BINDING;
    const verifyHistory = (manifestChecker as Record<string, unknown>)
      .verifyPhase1PrerequisiteHistory;
    expect(Array.isArray(binding)).toBe(true);
    expect(typeof verifyHistory).toBe("function");
    if (!Array.isArray(binding) || typeof verifyHistory !== "function") return;

    expect(binding).toHaveLength(30);
    expect(
      (verifyHistory as (options: { repositoryRoot: string }) => string[])({
        repositoryRoot,
      }),
    ).toEqual([]);
    expect(binding.map((entry) => (entry as { path: string }).path)).toEqual(
      [...binding]
        .map((entry) => (entry as { path: string }).path)
        .sort((left, right) => left.localeCompare(right)),
    );
  });

  it("rejects same-count path substitution and blob, mode, or status drift", () => {
    const checker = manifestChecker as Record<string, unknown>;
    const binding = checker.PHASE1_HARDENING_BINDING;
    const validate = checker.validatePhase1HardeningBinding;
    expect(Array.isArray(binding)).toBe(true);
    expect(typeof validate).toBe("function");
    if (!Array.isArray(binding) || typeof validate !== "function") return;

    const validateBinding = validate as (candidate: unknown) => string[];
    expect(validateBinding(binding)).toEqual([]);
    for (const [field, replacement] of [
      ["path", "same-count-substitution.txt"],
      ["oldBlob", "f".repeat(40)],
      ["newBlob", "e".repeat(40)],
      ["oldMode", "100755"],
      ["newMode", "100755"],
      ["status", "D"],
    ] as const) {
      const attack = structuredClone(binding) as Array<Record<string, unknown>>;
      attack[0]![field] = replacement;
      expect(validateBinding(attack), field).not.toEqual([]);
    }
  });

  it("fails closed when the pinned prerequisite commits are absent from a shallow checkout", () => {
    const verifyHistory = (manifestChecker as Record<string, unknown>)
      .verifyPhase1PrerequisiteHistory;
    expect(typeof verifyHistory).toBe("function");
    if (typeof verifyHistory !== "function") return;

    const temporaryRoot = mkdtempSync(join(tmpdir(), "phase1-shallow-"));
    try {
      const clone = spawnSync(
        "/usr/bin/git",
        [
          "clone",
          "--quiet",
          "--depth=1",
          `file://${repositoryRoot}`,
          temporaryRoot,
        ],
        { encoding: "utf8", shell: false, timeout: 30_000 },
      );
      expect(clone.status, clone.stderr).toBe(0);
      expect(
        (verifyHistory as (options: { repositoryRoot: string }) => string[])({
          repositoryRoot: temporaryRoot,
        }).join("\n"),
      ).toMatch(/missing.*Phase 1 prerequisite|shallow/u);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("extends the accepted ADR-001 package topology without replacing its modules", () => {
    expect(
      EXPECTED_WORKSPACES.map(({ path }: { path: string }) => path),
    ).toEqual([
      "packages/contracts",
      "packages/runtime-core",
      "packages/router",
      "packages/security",
      "packages/tools",
      "packages/ui",
      "packages/api",
      "packages/eval",
      "packages/documents",
      "packages/rag",
      "packages/multimodal",
      "apps/api",
      "apps/web",
      "apps/desktop",
      "apps/tui",
    ]);
  });

  it("treats the checked-in valid manifest as a byte-frozen snapshot, not a second authority", () => {
    const validateSnapshot = (manifestChecker as Record<string, unknown>)
      .validatePhase2ManifestSnapshotFile;
    expect(typeof validateSnapshot).toBe("function");
    if (typeof validateSnapshot !== "function") return;

    expect(
      (validateSnapshot as (path: string) => string[])(snapshotPath),
    ).toEqual([]);

    const temporaryRoot = mkdtempSync(join(tmpdir(), "phase2-snapshot-"));
    try {
      const drifted = join(temporaryRoot, "phase2-gate.json");
      writeFileSync(drifted, `${readFileSync(authorityPath, "utf8")}\n`);
      expect(
        (validateSnapshot as (path: string) => string[])(drifted),
      ).toContain("frozen snapshot bytes differ from the Phase 2 authority");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("separates packed-root readiness from private workspace composition readiness", () => {
    expect(typeof packageSmoke.runPackedPackageSmoke).toBe("function");
    expect(typeof packageSmoke.runWorkspaceCompositionSmoke).toBe("function");

    const source = readFileSync(
      join(repositoryRoot, "scripts/gates/package-smoke.mjs"),
      "utf8",
    );
    const packedBody = source.slice(
      source.indexOf("export const runPackedPackageSmoke"),
      source.indexOf("export const runWorkspaceCompositionSmoke"),
    );
    expect(packedBody).not.toContain("apps/api/dist/index.js");
    expect(packedBody).not.toContain("checkWorkspaceBoundaries");
  });

  it("classifies a complete local run as a candidate rather than formal release authority", () => {
    const classify = (phase2Gate as Record<string, unknown>)
      .classifyLocalGateReadiness;
    expect(typeof classify).toBe("function");
    if (typeof classify !== "function") return;
    expect(
      (classify as (input: {
        executionOk: boolean;
        identityStable: boolean;
        candidateEvidenceCount: number;
        errors: readonly unknown[];
      }) => unknown)({
        executionOk: true,
        identityStable: true,
        candidateEvidenceCount: 64,
        errors: [],
      }),
    ).toEqual({ candidateReady: true, releaseReady: false });
  });

  it("documents the root authority and private Phase 2 migration boundaries", () => {
    const readme = readFileSync(join(repositoryRoot, "README.md"), "utf8");
    expect(readme).toContain("Phase 2 batch-zero source scaffold");
    expect(readme).toContain(
      "only formal Phase 1 release artifact and publication authority",
    );
    expect(readme).not.toContain("only packable Phase 1 runtime authority");
    expect(readme).toContain("atomic authority migration");
    for (const path of [
      "packages/",
      "apps/",
      "evals/",
      "data-tests/",
      "fixtures/phase-2/",
      "verification/gates/",
    ]) {
      expect(readme, path).toContain(path);
    }
  });
});
