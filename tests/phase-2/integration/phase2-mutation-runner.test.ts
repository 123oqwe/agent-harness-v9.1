import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
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
  planPhase2MutationChunks,
  runPhase2RequirementDiagnostic,
  validatePhase2MutationArtifacts,
  // @ts-expect-error The mutation runner intentionally ships as plain Node ESM.
} from "../../../scripts/run-phase2-mutation.mjs";
import { PHASE2_MUTATION_CHUNK_LINES } from "../../../scripts/gates/phase2-mutation.mjs";

const harnessRoot = resolve(import.meta.dirname, "../../..");
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const write = (root: string, path: string, content: string) => {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
};

const git = (root: string, ...args: string[]) => {
  const result = spawnSync("/usr/bin/git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
};

describe("Phase 2 mutation runner", () => {
  it("plans complete bounded chunks without dropping source lines", () => {
    const root = mkdtempSync(join(tmpdir(), "phase2-chunk-plan-"));
    try {
      write(
        root,
        "src/large.ts",
        Array.from({ length: 160 }, (_, index) => `// source line ${index + 1}`).join(
          "\n",
        ),
      );
      write(root, ".gitignore", "reports/\n.stryker-tmp/\nnode_modules\n");
      git(root, "init");
      git(root, "add", ".");
      git(
        root,
        "-c",
        "user.name=Phase2 Mutation Test",
        "-c",
        "user.email=phase2-mutation@example.invalid",
        "commit",
        "-m",
        "chunk plan fixture",
      );
      const commitSha = git(root, "rev-parse", "HEAD");
      expect(
        planPhase2MutationChunks(
          { id: "AH-CHUNK-PLAN-001", sources: ["src/large.ts"] },
          root,
          commitSha,
        ).map(
          ({ start_line, end_line }: { start_line: number; end_line: number }) => [
            start_line,
            end_line,
          ],
        ),
      ).toEqual([
        ...Array.from(
          { length: Math.ceil(160 / PHASE2_MUTATION_CHUNK_LINES) },
          (_, index) => {
            const startLine = index * PHASE2_MUTATION_CHUNK_LINES + 1;
            const endLine = Math.min(
              160,
              index * PHASE2_MUTATION_CHUNK_LINES + PHASE2_MUTATION_CHUNK_LINES,
            );
            return [startLine, endLine];
          },
        ),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    "runs real Stryker mutants for a synthetic diagnostic without producing product Evidence",
    { timeout: 120_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "phase2-real-mutant-"));
      try {
        write(
          root,
          "src/predicate.ts",
          [
            "export function isAdult(age: number): boolean {",
            "  return age >= 18;",
            "}",
            "",
          ].join("\n"),
        );
        write(
          root,
          "tests/predicate.test.ts",
          [
            'import { describe, expect, it } from "vitest";',
            'import { isAdult } from "../src/predicate";',
            'describe("isAdult", () => {',
            '  it("checks both sides of the boundary", () => {',
            "    expect(isAdult(17)).toBe(false);",
            "    expect(isAdult(18)).toBe(true);",
            "    expect(isAdult(80)).toBe(true);",
            "  });",
            "});",
            "",
          ].join("\n"),
        );
        write(
          root,
          "vitest.phase2-mutation.config.mjs",
          [
            "export default {",
            '  test: { globals: true, environment: "node", include: ["tests/predicate.test.ts"] },',
            "};",
            "",
          ].join("\n"),
        );
        write(
          root,
          "mutation/stryker.base.mjs",
          readFileSync(join(harnessRoot, "mutation/stryker.base.mjs"), "utf8"),
        );
        write(
          root,
          "package.json",
          '{"name":"phase2-mutant-fixture","type":"module"}\n',
        );
        write(root, ".gitignore", "reports/\n.stryker-tmp/\nnode_modules\n");
        symlinkSync(
          join(harnessRoot, "node_modules"),
          join(root, "node_modules"),
        );
        git(root, "init");
        git(root, "add", ".");
        git(
          root,
          "-c",
          "user.name=Phase2 Mutation Test",
          "-c",
          "user.email=phase2-mutation@example.invalid",
          "commit",
          "-m",
          "synthetic mutation fixture",
        );
        const commitSha = git(root, "rev-parse", "HEAD");
        const treeSha = git(root, "rev-parse", "HEAD^{tree}");
        const reportRoot = join(root, "reports/mutation/phase2-diagnostic");

        const result = await runPhase2RequirementDiagnostic({
          repositoryRoot: root,
          requirement: {
            id: "AH-SYNTHETIC-MUTATION-001",
            mutationClass: "critical",
            threshold: 90,
            status: "ready",
            sources: ["src/predicate.ts"],
            tests: ["tests/predicate.test.ts"],
          },
          commitSha,
          treeSha,
          registrySha256: "a".repeat(64),
          manifestSha256: "b".repeat(64),
          phase1MutationSha256: "d".repeat(64),
          configurationHash: "c".repeat(64),
          strykerExecutable: join(harnessRoot, "node_modules/.bin/stryker"),
          vitestConfigPath: "vitest.phase2-mutation.config.mjs",
          reportRoot,
        });

        expect(result.evidence_eligible).toBe(false);
        expect(result.synthetic_fixture).toBe(true);
        expect(result.commit_sha).toBe(commitSha);
        expect(result.tree_sha).toBe(treeSha);
        expect(result.integration_sources).toEqual([]);
        expect(result.integration_source_modules).toEqual({});
        expect(result.counts.total).toBeGreaterThan(0);
        expect(result.counts.killed + result.counts.timeout).toBeGreaterThan(0);
        expect(Object.keys(result.per_file)).toEqual(["src/predicate.ts"]);
        expect(result.chunks).toHaveLength(result.expected_chunk_count);
        expect(result.chunks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              source_file: "src/predicate.ts",
              start_line: 1,
              end_line: 3,
              complete: true,
              raw_report_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
              config_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
              mutant_identity_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
              raw_report_path: expect.stringMatching(/mutation\.json$/u),
              config_path: expect.stringMatching(/stryker\.config\.json$/u),
            }),
          ]),
        );
        expect(
          await validatePhase2MutationArtifacts({
            repositoryRoot: root,
            reportRoot,
            result,
          }),
        ).toMatchObject({ ok: true, mutantCount: result.counts.total });

        await expect(
          validatePhase2MutationArtifacts({
            repositoryRoot: root,
            reportRoot,
            result: { ...result, tree_sha: "e".repeat(40) },
          }),
        ).rejects.toThrow(/tree SHA mismatch/u);

        const partial = structuredClone(result);
        partial.chunks = [];
        partial.expected_chunk_count = 0;
        await expect(
          validatePhase2MutationArtifacts({
            repositoryRoot: root,
            reportRoot,
            result: partial,
          }),
        ).rejects.toThrow(/partial chunk set/u);

        const rawPath = join(reportRoot, result.chunks[0].raw_report_path);
        const rawText = readFileSync(rawPath, "utf8");
        writeFileSync(rawPath, `${rawText}\n`);
        await expect(
          validatePhase2MutationArtifacts({
            repositoryRoot: root,
            reportRoot,
            result,
          }),
        ).rejects.toThrow(/raw report hash mismatch/u);
        writeFileSync(rawPath, rawText);

        const configPath = join(reportRoot, result.chunks[0].config_path);
        const configText = readFileSync(configPath, "utf8");
        expect(JSON.parse(configText).testFiles).toEqual([
          "tests/predicate.test.ts",
        ]);
        writeFileSync(configPath, `${configText}\n`);
        await expect(
          validatePhase2MutationArtifacts({
            repositoryRoot: root,
            reportRoot,
            result,
          }),
        ).rejects.toThrow(/config hash mismatch/u);
        writeFileSync(configPath, configText);

        const wrongTests = structuredClone(result);
        const wrongConfig = {
          ...JSON.parse(configText),
          testFiles: ["tests/not-authorized-for-this-requirement.test.ts"],
        };
        const wrongConfigText = `${JSON.stringify(wrongConfig)}\n`;
        writeFileSync(configPath, wrongConfigText);
        wrongTests.chunks[0].config_sha256 = sha256(wrongConfigText);
        await expect(
          validatePhase2MutationArtifacts({
            repositoryRoot: root,
            reportRoot,
            result: wrongTests,
          }),
        ).rejects.toThrow(/canonical Stryker config mismatch/u);
        writeFileSync(configPath, configText);

        const baseConfig = JSON.parse(configText);
        const canonicalConfigDrifts = [
          { ...baseConfig, testRunner: "command" },
          { ...baseConfig, coverageAnalysis: "all" },
          { ...baseConfig, reporters: ["json", "progress"] },
          { ...baseConfig, concurrency: 2 },
          { ...baseConfig, timeoutMS: 1 },
          { ...baseConfig, symlinkNodeModules: false },
          { ...baseConfig, cleanTempDir: "never" },
          {
            ...baseConfig,
            vitest: {
              ...baseConfig.vitest,
              configFile: "vitest.config.ts",
            },
          },
          {
            ...baseConfig,
            tempDirName: ".stryker-tmp/phase2/forged/chunk",
          },
          {
            ...baseConfig,
            jsonReporter: {
              fileName: join(reportRoot, "forged/mutation.json"),
            },
          },
          { ...baseConfig, forged_extra_key: true },
        ];
        for (const driftedConfig of canonicalConfigDrifts) {
          const driftedConfigText = `${JSON.stringify(driftedConfig)}\n`;
          const drifted = structuredClone(result);
          drifted.chunks[0].config_sha256 = sha256(driftedConfigText);
          writeFileSync(configPath, driftedConfigText);
          await expect(
            validatePhase2MutationArtifacts({
              repositoryRoot: root,
              reportRoot,
              result: drifted,
            }),
          ).rejects.toThrow(/canonical Stryker config mismatch/u);
        }
        writeFileSync(configPath, configText);

        const relocatedRawPath =
          "runs/forged/AH-SYNTHETIC-MUTATION-001/chunks/forged/mutation.json";
        const relocatedConfigPath =
          "runs/forged/AH-SYNTHETIC-MUTATION-001/chunks/forged/stryker.config.json";
        write(reportRoot, relocatedRawPath, rawText);
        const relocatedConfig = {
          ...baseConfig,
          tempDirName: ".stryker-tmp/phase2/forged/forged",
          jsonReporter: {
            fileName: join(reportRoot, relocatedRawPath),
          },
        };
        const relocatedConfigText = `${JSON.stringify(relocatedConfig)}\n`;
        write(reportRoot, relocatedConfigPath, relocatedConfigText);
        const relocated = structuredClone(result);
        relocated.chunks[0].raw_report_path = relocatedRawPath;
        relocated.chunks[0].config_path = relocatedConfigPath;
        relocated.chunks[0].config_sha256 = sha256(relocatedConfigText);
        await expect(
          validatePhase2MutationArtifacts({
            repositoryRoot: root,
            reportRoot,
            result: relocated,
          }),
        ).rejects.toThrow(/deterministic mutation artifact path/u);

        const forged = structuredClone(result);
        const forgedRaw = JSON.parse(rawText);
        const [sourceFile, file] = Object.entries(forgedRaw.files)[0] as [
          string,
          { mutants: Array<Record<string, unknown>> },
        ];
        file.mutants[0]!.replacement = "__forged_mutation__";
        const forgedRawText = `${JSON.stringify(forgedRaw)}\n`;
        writeFileSync(rawPath, forgedRawText);
        const identities = file.mutants
          .map((mutant) =>
            canonicalJson({
              source_file: sourceFile,
              mutator_name: mutant.mutatorName,
              replacement: mutant.replacement,
              location: mutant.location,
            }),
          )
          .sort();
        forged.chunks[0].raw_report_sha256 = sha256(forgedRawText);
        forged.chunks[0].mutant_identity_sha256 = sha256(
          canonicalJson(identities),
        );
        forged.mutant_identity_sha256 = sha256(canonicalJson(identities));
        await expect(
          validatePhase2MutationArtifacts({
            repositoryRoot: root,
            reportRoot,
            result: forged,
          }),
        ).rejects.toThrow(/independent mutant identity mismatch/u);
        writeFileSync(rawPath, rawText);

        symlinkSync("predicate.ts", join(root, "src/shared-link.ts"));
        git(root, "add", "src/shared-link.ts");
        git(
          root,
          "-c",
          "user.name=Phase2 Mutation Test",
          "-c",
          "user.email=phase2-mutation@example.invalid",
          "commit",
          "-m",
          "add adversarial committed symlink",
        );
        const symlinkCommit = git(root, "rev-parse", "HEAD");
        const symlinkTree = git(root, "rev-parse", "HEAD^{tree}");
        const sharedSymlink = {
          ...structuredClone(result),
          commit_sha: symlinkCommit,
          tree_sha: symlinkTree,
          integration_sources: ["src/shared-link.ts"],
          integration_source_modules: { "src/shared-link.ts": ["runtime"] },
        };
        await expect(
          validatePhase2MutationArtifacts({
            repositoryRoot: root,
            reportRoot,
            result: sharedSymlink,
          }),
        ).rejects.toThrow(/Git tree mode.*120000|ancestor is a symlink/u);

        const ownedSymlink = {
          ...structuredClone(sharedSymlink),
          sources: ["src/shared-link.ts"],
          integration_sources: [],
          integration_source_modules: {},
        };
        await expect(
          validatePhase2MutationArtifacts({
            repositoryRoot: root,
            reportRoot,
            result: ownedSymlink,
          }),
        ).rejects.toThrow(/Git tree mode.*120000|ancestor is a symlink/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
