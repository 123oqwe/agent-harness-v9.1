import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkActivePhase2Stubs,
  SEMANTIC_STUB_MARKERS,
  // @ts-expect-error The production gate intentionally ships as plain Node ESM.
} from "../../../scripts/gates/check-active-stubs.mjs";
// @ts-expect-error The production gate intentionally ships as plain Node ESM.
import { checkPhase2ContractDrift } from "../../../scripts/gates/check-contract-drift.mjs";
// @ts-expect-error The production gate intentionally ships as plain Node ESM.
import { collectGateBindings } from "../../../scripts/gates/verify-phase2-local.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const copyAssetAuthority = () => {
  const root = mkdtempSync(join(tmpdir(), "phase2-contract-drift-"));
  for (const path of [
    "verification/gates/phase2-gate.json",
    "scripts/gates/check-phase2-assets.mjs",
    "evals",
    "data-tests",
    "fixtures/phase-2/assets",
  ]) {
    cpSync(join(repositoryRoot, path), join(root, path), { recursive: true });
  }
  return root;
};

describe("Phase 2 gate tamper resistance", () => {
  it("binds the frozen manifest and executable asset contracts", () => {
    const result = checkPhase2ContractDrift({ repositoryRoot });
    expect(result.errors).toEqual([]);
    expect(result.bindings.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.bindings.assetsSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects authority or fixture tampering", () => {
    const root = copyAssetAuthority();
    const manifestPath = join(root, "verification/gates/phase2-gate.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.requirements[0].priority = "P2";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = checkPhase2ContractDrift({ repositoryRoot: root });
    expect(result.errors.join("\n")).toMatch(/frozen|authority|SHA-256/u);
  });

  it("does not confuse ordinary TODO text with explicit active stubs", () => {
    expect(SEMANTIC_STUB_MARKERS).not.toContain("TODO");
    const result = checkActivePhase2Stubs({ repositoryRoot });
    expect(result.releaseReady).toBe(false);
    expect(result.activeRequirementIds).toHaveLength(64);
    expect(result.claims).toEqual({
      requirementsVerified: 0,
      evidencePassed: 0,
    });
    expect(
      result.errors.some((error: string) => error.includes("missing evidence")),
    ).toBe(true);
  });

  it("detects a dirty tree from real Git state", () => {
    const root = mkdtempSync(join(tmpdir(), "phase2-git-identity-"));
    writeFileSync(join(root, "README.md"), "clean\n");
    for (const args of [
      ["init"],
      ["add", "README.md"],
      [
        "-c",
        "user.name=Phase2 Test",
        "-c",
        "user.email=phase2@example.invalid",
        "commit",
        "-m",
        "fixture",
      ],
    ]) {
      const result = spawnSync("git", args, {
        cwd: root,
        shell: false,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(collectGateBindings(root).dirty).toBe(false);
    writeFileSync(join(root, "dirty.txt"), "dirty\n");
    expect(collectGateBindings(root).dirty).toBe(true);
  });
});
import { spawnSync } from "node:child_process";
