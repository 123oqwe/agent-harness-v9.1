import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkActivePhase2Stubs,
  scanActivePhase2Stubs,
  SEMANTIC_STUB_MARKERS,
  // @ts-expect-error The production gate intentionally ships as plain Node ESM.
} from "../../../scripts/gates/check-active-stubs.mjs";
// @ts-expect-error The production gate intentionally ships as plain Node ESM.
import { checkPhase2ContractDrift } from "../../../scripts/gates/check-contract-drift.mjs";
import {
  collectGateBindings,
  verifyEvidenceBundle,
  verifyPhase2,
  // @ts-expect-error The production gate intentionally ships as plain Node ESM.
} from "../../../scripts/gates/verify-phase2-local.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const releaseCommandIds = [
  "manifest",
  "workspace-boundaries",
  "assets",
  "contract-drift",
  "active-stubs",
  "typecheck",
  "cycles",
  "build",
  "phase2-architecture",
  "lint",
  "phase1-regression",
  "coverage",
  "workspace-coverage",
  "phase2-unit",
  "phase2-integration",
  "phase2-security",
  "phase2-e2e",
  "mutation",
  "evaluations",
  "data",
  "package-smoke",
  "workspace-smoke",
  "source-checkout-reproduction",
  "production-audit",
];
const bindingValue = {
  commitSha: "a".repeat(40),
  treeSha: "b".repeat(40),
  packageLockSha256: "c".repeat(64),
  manifestSha256: "d".repeat(64),
  mutationConfigSha256: "e".repeat(64),
  assetsSha256: "f".repeat(64),
  runnerSha256: "1".repeat(64),
  runnerVersion: "phase2-gate-report/v1",
};
const commandResults = releaseCommandIds.map((id) => ({
  id,
  argv: ["node", `<arg-sha256:${"2".repeat(64)}>`],
  status: "passed",
  exitCode: 0,
  signal: null,
  stdout: { sha256: "3".repeat(64) },
  stderr: { sha256: "4".repeat(64) },
}));

const copyAssetAuthority = () => {
  const root = mkdtempSync(join(tmpdir(), "phase2-contract-drift-"));
  for (const path of [
    "verification/gates/phase2-gate.json",
    "scripts/gates/check-phase2-assets.mjs",
    "scripts/gates/secure-publish.py",
    "evals",
    "data-tests",
    "fixtures/phase-2/assets",
  ]) {
    cpSync(join(repositoryRoot, path), join(root, path), { recursive: true });
  }
  return root;
};

const createFakeEvidenceRepository = () => {
  const root = mkdtempSync(join(tmpdir(), "phase2-fake-evidence-"));
  const manifest = JSON.parse(
    readFileSync(
      join(repositoryRoot, "verification/gates/phase2-gate.json"),
      "utf8",
    ),
  );
  const manifestPath = join(root, "verification/gates/phase2-gate.json");
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const helperPath = "scripts/gates/secure-publish.py";
  mkdirSync(join(root, dirname(helperPath)), { recursive: true });
  cpSync(join(repositoryRoot, helperPath), join(root, helperPath));
  for (const requirement of manifest.requirements) {
    const sourcePath = `${requirement.owner}/src/${requirement.id.toLowerCase()}.ts`;
    const absoluteSource = join(root, sourcePath);
    mkdirSync(dirname(absoluteSource), { recursive: true });
    writeFileSync(absoluteSource, "export const implemented = true;\n");
    for (const suite of requirement.test_suites) {
      const absoluteSuite = join(root, suite);
      mkdirSync(dirname(absoluteSuite), { recursive: true });
      writeFileSync(absoluteSuite, "export {};\n");
    }
    const evidencePath = join(root, requirement.evidence_path);
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(
      evidencePath,
      `${JSON.stringify(
        {
          requirement_id: requirement.id,
          status: "verified",
          bindings: bindingValue,
          source_files: [sourcePath],
          test_files: requirement.test_suites,
          command_receipts: commandResults.map((result) => ({
            id: result.id,
            status: result.status,
            exitCode: result.exitCode,
            signal: result.signal,
            argv: result.argv,
            stdout_sha256: "3".repeat(64),
            stderr_sha256: "4".repeat(64),
          })),
        },
        null,
        2,
      )}\n`,
    );
  }
  for (const args of [
    ["init"],
    ["add", "."],
    [
      "-c",
      "user.name=Phase2 Test",
      "-c",
      "user.email=phase2@example.invalid",
      "commit",
      "-m",
      "precommitted forged evidence",
    ],
  ]) {
    const result = spawnSync("git", args, {
      cwd: root,
      shell: false,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
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

  it("scans explicit stubs without making release claims", () => {
    expect(SEMANTIC_STUB_MARKERS).not.toContain("TODO");
    const result = scanActivePhase2Stubs({ repositoryRoot });
    const manifest = JSON.parse(
      readFileSync(
        join(repositoryRoot, "verification/gates/phase2-gate.json"),
        "utf8",
      ),
    ) as { requirements: Array<{ id: string }> };
    const expectedActive = manifest.requirements
      .map((requirement) => requirement.id)
      .filter(
        (id) =>
          id !== "AH-RUNTIME-SESSIONTREE-001" &&
          id !== "AH-HOOK-001" &&
          id !== "AH-RUNTIME-STEERING-001",
      )
      .sort();
    expect(result.releaseReady).toBe(false);
    expect(result.activeRequirementIds).toHaveLength(61);
    expect([...result.activeRequirementIds].sort()).toEqual(expectedActive);
    expect(result.claims).toEqual({
      requirementsVerified: 0,
      evidencePassed: 0,
    });
    expect(result.errors.join("\n")).not.toMatch(/missing evidence/u);
  });

  it("refuses final Evidence validation without current release context", () => {
    const result = checkActivePhase2Stubs({ repositoryRoot });
    expect(result.releaseReady).toBe(false);
    expect(result.claims).toEqual({
      requirementsVerified: 0,
      evidencePassed: 0,
    });
    expect(result.errors.join("\n")).toMatch(
      /current bindings|command results/u,
    );
  });

  it("ignores 64 precommitted Evidence files even when their receipts look current", () => {
    const root = createFakeEvidenceRepository();
    expect(
      spawnSync("git", ["ls-files", "artifacts/phase-2"], {
        cwd: root,
        encoding: "utf8",
      })
        .stdout.trim()
        .split("\n"),
    ).toHaveLength(64);
    const result = checkActivePhase2Stubs({
      repositoryRoot: root,
      currentBindings: bindingValue,
      commandResults,
    });
    expect(result.releaseReady).toBe(false);
    expect(result.activeRequirementIds).toHaveLength(64);
    expect(result.claims).toEqual({
      requirementsVerified: 0,
      evidencePassed: 0,
    });
    expect(result.errors.join("\n")).toMatch(/generated evidence records/u);
  });

  it(
    "rejects duplicate Evidence keys, owner escapes, and test symlinks",
    { timeout: 30_000 },
    () => {
      const manifest = JSON.parse(
        readFileSync(
          join(repositoryRoot, "verification/gates/phase2-gate.json"),
          "utf8",
        ),
      );
      const requirement = manifest.requirements[0];

      const duplicateRoot = createFakeEvidenceRepository();
      const duplicateBundle = join(
        duplicateRoot,
        "reports/phase2/evidence/duplicate-test",
      );
      mkdirSync(duplicateBundle, { recursive: true });
      cpSync(
        join(duplicateRoot, "artifacts"),
        join(duplicateBundle, "artifacts"),
        {
          recursive: true,
        },
      );
      const duplicatePath = join(duplicateBundle, requirement.evidence_path);
      const duplicateSource = readFileSync(duplicatePath, "utf8").replace(
        '"requirement_id":',
        '"requirement_id":"DUPLICATE","requirement_id":',
      );
      writeFileSync(duplicatePath, duplicateSource);
      const duplicateTreeSha = spawnSync(
        "git",
        ["rev-parse", "HEAD^{tree}"],
        { cwd: duplicateRoot, encoding: "utf8", shell: false },
      ).stdout.trim();
      expect(
        verifyEvidenceBundle({
          repositoryRoot: duplicateRoot,
          directory: "reports/phase2/evidence/duplicate-test",
          currentBindings: { ...bindingValue, treeSha: duplicateTreeSha },
          commandResults,
        }).errors.join("\n"),
      ).toMatch(/duplicate object key/u);

      const escapeRoot = createFakeEvidenceRepository();
      const escapeRecords = manifest.requirements.map(
        (candidate: { evidence_path: string }) =>
          JSON.parse(
            readFileSync(join(escapeRoot, candidate.evidence_path), "utf8"),
          ),
      );
      escapeRecords[0].source_files = ["outside-owner.ts"];
      writeFileSync(join(escapeRoot, "outside-owner.ts"), "export {};\n");
      expect(
        checkActivePhase2Stubs({
          repositoryRoot: escapeRoot,
          currentBindings: bindingValue,
          commandResults,
          evidenceRecords: escapeRecords,
        }).errors.join("\n"),
      ).toMatch(/outside owner/u);

      const symlinkRoot = createFakeEvidenceRepository();
      const symlinkRecords = manifest.requirements.map(
        (candidate: { evidence_path: string }) =>
          JSON.parse(
            readFileSync(join(symlinkRoot, candidate.evidence_path), "utf8"),
          ),
      );
      const suitePath = join(symlinkRoot, requirement.test_suites[0]);
      const targetPath = join(symlinkRoot, "symlink-target.test.ts");
      writeFileSync(targetPath, "export {};\n");
      rmSync(suitePath);
      symlinkSync(targetPath, suitePath);
      expect(
        checkActivePhase2Stubs({
          repositoryRoot: symlinkRoot,
          currentBindings: bindingValue,
          commandResults,
          evidenceRecords: symlinkRecords,
        }).errors.join("\n"),
      ).toMatch(/symlink is forbidden/u);
    },
  );

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

  it("rejects assume-unchanged and skip-worktree index flags", () => {
    const root = mkdtempSync(join(tmpdir(), "phase2-git-flags-"));
    writeFileSync(join(root, "tracked.txt"), "tracked\n");
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, {
        cwd: root,
        shell: false,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
    };
    git("init");
    git("add", "tracked.txt");
    git(
      "-c",
      "user.name=Phase2 Test",
      "-c",
      "user.email=phase2@example.invalid",
      "commit",
      "-m",
      "fixture",
    );

    git("update-index", "--skip-worktree", "tracked.txt");
    expect(collectGateBindings(root).errors.join("\n")).toMatch(
      /skip-worktree/u,
    );
    git("update-index", "--no-skip-worktree", "tracked.txt");
    git("update-index", "--assume-unchanged", "tracked.txt");
    expect(collectGateBindings(root).errors.join("\n")).toMatch(
      /assume-unchanged/u,
    );
  });

  it("detects a command that mutates the real temporary Git tree and does not restore it", async () => {
    const root = copyAssetAuthority();
    cpSync(
      join(repositoryRoot, "package-lock.json"),
      join(root, "package-lock.json"),
    );
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, {
        cwd: root,
        shell: false,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
    };
    git("init");
    git("add", ".");
    git(
      "-c",
      "user.name=Phase2 Test",
      "-c",
      "user.email=phase2@example.invalid",
      "commit",
      "-m",
      "fixture",
    );

    let mutated = false;
    const result = await verifyPhase2({
      repositoryRoot: root,
      mode: "local",
      reportPath: join(root, "reports/phase2/gate.json"),
      runner: async (command: { id: string }) => {
        if (!mutated) {
          writeFileSync(
            join(root, "unrestored-command-write.txt"),
            "tampered\n",
          );
          mutated = true;
        }
        return {
          id: command.id,
          argv: [],
          status: "passed",
          exitCode: 0,
          signal: null,
          durationMs: 0,
          stdout: {
            bytes: 0,
            capturedBytes: 0,
            truncated: false,
            sha256: "0".repeat(64),
          },
          stderr: {
            bytes: 0,
            capturedBytes: 0,
            truncated: false,
            sha256: "0".repeat(64),
          },
          error: null,
        };
      },
    });
    expect(result.releaseReady).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "repository_changed_during_gate" }),
      ]),
    );
  });
});
