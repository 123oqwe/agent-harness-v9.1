import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectPhase2MutationSnapshotPaths,
  PHASE2_EXPECTED_PHASE1_SHA,
  PHASE2_MUTATION_AUTHORITY_PATHS,
  validatePhase2RepositorySnapshot,
  // @ts-expect-error The mutation runner intentionally ships as plain Node ESM.
} from "../../../scripts/run-phase2-mutation.mjs";
import {
  PHASE2_BOOTSTRAP_AUTHORITY_PATHS,
  // @ts-expect-error The mutation bootstrap intentionally ships as plain Node ESM.
} from "../../../scripts/run-phase2-mutation-bootstrap.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const expectedPhase1Sha = "2d59a526fcf7cd067fbe9d44981537a42d441360";
const requiredAuthorityPaths = [
  "mutation/modules.mjs",
  "mutation/phase2-modules.mjs",
  "mutation/stryker.base.mjs",
  "package-lock.json",
  "package.json",
  "patches/@stryker-mutator+core+9.6.1.patch",
  "patches/@stryker-mutator+vitest-runner+9.6.1.patch",
  "scripts/gates/json-schema.mjs",
  "scripts/gates/phase2-mutation.mjs",
  "scripts/gates/secure-publish.mjs",
  "scripts/gates/secure-publish.py",
  "scripts/gates/verify-phase2-mutation-bundle.mjs",
  "scripts/gates/verify-phase2-mutant-completeness.mjs",
  "scripts/gates/workflow-contract.mjs",
  "scripts/run-phase2-mutation-launcher.mjs",
  "scripts/run-phase2-mutation-bootstrap.mjs",
  "scripts/run-phase2-mutation.mjs",
  "scripts/run-process-tree.mjs",
  "scripts/gates/trusted-git.mjs",
  "verification/gates/phase2-gate.json",
  "verification/gates/phase2-mutation-workflow-contract.json",
  "verification/schemas/phase2-mutation-attestation-receipt.schema.json",
  "verification/schemas/phase2-mutation-candidate.schema.json",
  "verification/schemas/phase2-mutation-draft.schema.json",
  "verification/schemas/phase2-mutation-execution-receipt.schema.json",
  "verification/schemas/phase2-mutation-publication-receipt.schema.json",
  "tests/phase-2/fixtures/native-clean-install/package.json",
  "tests/phase-2/fixtures/native-clean-install/package-lock.json",
  ".github/workflows/phase2-mutation.yml",
  "vitest.mutation.config.ts",
];

const git = (root: string, ...args: string[]) => {
  const result = spawnSync("/usr/bin/git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
};

describe("Phase 2 committed mutation snapshot", () => {
  it("collects every authority and selected requirement input without trusting status output", () => {
    expect([...PHASE2_MUTATION_AUTHORITY_PATHS].sort()).toEqual(
      [...requiredAuthorityPaths].sort(),
    );
    expect([...PHASE2_BOOTSTRAP_AUTHORITY_PATHS].sort()).toEqual(
      [...requiredAuthorityPaths].sort(),
    );
    expect(
      collectPhase2MutationSnapshotPaths({
        requirements: [
          {
            sources: ["packages/example/src/owned.ts"],
            integrationSources: ["runtime/shared.ts"],
            tests: ["tests/phase-2/unit/example.test.ts"],
          },
        ],
        vitestConfigPath: "vitest.mutation.config.ts",
      }),
    ).toEqual(
      [
        ...requiredAuthorityPaths,
        "packages/example/src/owned.ts",
        "runtime/shared.ts",
        "tests/phase-2/unit/example.test.ts",
      ].sort(),
    );
  });

  it("pins the exact Phase 1 prerequisite and rejects hidden or ignored working-tree overrides", { timeout: 60_000 }, async () => {
    expect(PHASE2_EXPECTED_PHASE1_SHA).toBe(expectedPhase1Sha);
    const parent = mkdtempSync(join(tmpdir(), "phase2-snapshot-"));
    const root = join(parent, "repository");
    try {
      git(parent, "clone", "--shared", repositoryRoot, root);
      for (const path of requiredAuthorityPaths) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        copyFileSync(join(repositoryRoot, path), join(root, path));
      }
      git(root, "add", ...requiredAuthorityPaths);
      git(
        root,
        "-c",
        "user.name=Phase2 Snapshot Test",
        "-c",
        "user.email=phase2-snapshot@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "sync current mutation authority",
      );
      const commitSha = git(root, "rev-parse", "HEAD");
      await expect(
        validatePhase2RepositorySnapshot({
          repositoryRoot: root,
          commitSha,
          requiredPaths: requiredAuthorityPaths,
        }),
      ).resolves.toMatchObject({ commitSha, baselineSha: expectedPhase1Sha });

      const packageJson = readFileSync(join(root, "package.json"));
      git(root, "update-index", "--assume-unchanged", "package.json");
      writeFileSync(join(root, "package.json"), '{"forged":true}\n');
      expect(git(root, "status", "--porcelain=v1")).toBe("");
      await expect(
        validatePhase2RepositorySnapshot({
          repositoryRoot: root,
          commitSha,
          requiredPaths: requiredAuthorityPaths,
        }),
      ).rejects.toThrow(/working tree bytes.*package\.json/u);
      git(root, "update-index", "--no-assume-unchanged", "package.json");
      writeFileSync(join(root, "package.json"), packageJson);

      const packageLock = readFileSync(join(root, "package-lock.json"));
      git(root, "update-index", "--skip-worktree", "package-lock.json");
      writeFileSync(join(root, "package-lock.json"), '{"forged":true}\n');
      expect(git(root, "status", "--porcelain=v1")).toBe("");
      await expect(
        validatePhase2RepositorySnapshot({
          repositoryRoot: root,
          commitSha,
          requiredPaths: requiredAuthorityPaths,
        }),
      ).rejects.toThrow(/working tree bytes.*package-lock\.json/u);
      git(root, "update-index", "--no-skip-worktree", "package-lock.json");
      writeFileSync(join(root, "package-lock.json"), packageLock);

      appendFileSync(join(root, ".git/info/exclude"), "\nignored-override/\n");
      mkdirSync(join(root, "ignored-override"));
      writeFileSync(join(root, "ignored-override/source.ts"), "forged\n");
      expect(git(root, "status", "--porcelain=v1")).toBe("");
      await expect(
        validatePhase2RepositorySnapshot({
          repositoryRoot: root,
          commitSha,
          requiredPaths: [
            ...requiredAuthorityPaths,
            "ignored-override/source.ts",
          ],
        }),
      ).rejects.toThrow(
        /Git tree has 0 entries.*ignored-override\/source\.ts/u,
      );

      git(root, "checkout", "--orphan", "unrelated-history");
      git(
        root,
        "-c",
        "user.name=Phase2 Snapshot Test",
        "-c",
        "user.email=phase2-snapshot@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "unrelated history",
      );
      const unrelatedCommit = git(root, "rev-parse", "HEAD");
      await expect(
        validatePhase2RepositorySnapshot({
          repositoryRoot: root,
          commitSha: unrelatedCommit,
          requiredPaths: requiredAuthorityPaths,
        }),
      ).rejects.toThrow(
        new RegExp(`not a descendant of ${expectedPhase1Sha}`, "u"),
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects a symlink at every required-path ancestor even when index flags hide it", async () => {
    const parent = mkdtempSync(join(tmpdir(), "phase2-snapshot-ancestor-"));
    const root = join(parent, "repository");
    const external = join(parent, "external");
    try {
      git(parent, "clone", "--shared", repositoryRoot, root);
      mkdirSync(join(root, "protected"));
      writeFileSync(join(root, "protected/assume.txt"), "assume\n");
      writeFileSync(join(root, "protected/skip.txt"), "skip\n");
      git(root, "add", "protected/assume.txt", "protected/skip.txt");
      git(
        root,
        "-c",
        "user.name=Phase2 Snapshot Test",
        "-c",
        "user.email=phase2-snapshot@example.invalid",
        "commit",
        "-m",
        "add protected snapshot inputs",
      );
      const commitSha = git(root, "rev-parse", "HEAD");

      git(root, "update-index", "--assume-unchanged", "protected/assume.txt");
      git(root, "update-index", "--skip-worktree", "protected/skip.txt");
      mkdirSync(external);
      writeFileSync(join(external, "assume.txt"), "assume\n");
      writeFileSync(join(external, "skip.txt"), "skip\n");
      rmSync(join(root, "protected"), { recursive: true });
      symlinkSync(external, join(root, "protected"), "dir");
      appendFileSync(join(root, ".git/info/exclude"), "\n/protected\n");

      expect(git(root, "status", "--porcelain=v1")).toBe("");
      await expect(
        validatePhase2RepositorySnapshot({
          repositoryRoot: root,
          commitSha,
          requiredPaths: ["protected/assume.txt", "protected/skip.txt"],
        }),
      ).rejects.toThrow(/ancestor.*symlink|symlink.*ancestor/u);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
