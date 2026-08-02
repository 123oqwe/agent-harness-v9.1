import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  "scripts/gates/phase2-mutation.mjs",
  "scripts/run-phase2-mutation.mjs",
  "scripts/run-process-tree.mjs",
  "scripts/trusted-git.mjs",
  "verification/gates/phase2-gate.json",
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

  it("pins the exact Phase 1 prerequisite and rejects hidden or ignored working-tree overrides", async () => {
    expect(PHASE2_EXPECTED_PHASE1_SHA).toBe(expectedPhase1Sha);
    const parent = mkdtempSync(join(tmpdir(), "phase2-snapshot-"));
    const root = join(parent, "repository");
    try {
      git(parent, "clone", "--shared", repositoryRoot, root);
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
});
