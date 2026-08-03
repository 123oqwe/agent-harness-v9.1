import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  phase2MutationRequirements,
  // @ts-expect-error The mutation registry intentionally ships as plain Node ESM.
} from "../../../mutation/phase2-modules.mjs";
import {
  buildPhase2MutationReport,
  PHASE2_MUTATION_DRAFT_SCHEMA_VERSION,
  PHASE2_MUTATION_FINAL_SCHEMA_VERSION,
  inspectPhase2MutationReadiness,
  loadPhase2MutationAuthority,
  resolvePhase2MutationTarget,
  validatePhase2MutationReport,
  validateFinalPhase2MutationReport,
  // @ts-expect-error The mutation gate intentionally ships as plain Node ESM.
} from "../../../scripts/gates/phase2-mutation.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const git = (root: string, ...args: string[]) => {
  const result = spawnSync("/usr/bin/git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
};
const manifest = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "verification/gates/phase2-gate.json"),
    "utf8",
  ),
);

const cloneRegistry = () => structuredClone(phase2MutationRequirements);

const readyAuthority = () => {
  const readyManifest = structuredClone(manifest);
  const registry = cloneRegistry().map(
    (requirement: { id: string }) => ({
      ...requirement,
      status: "ready",
      sources: [`packages/synthetic/src/${requirement.id.toLowerCase()}.ts`],
    }),
  );
  for (const requirement of readyManifest.requirements) {
    requirement.owned_sources = [
      `packages/synthetic/src/${requirement.id.toLowerCase()}.ts`,
    ];
  }
  const authority = loadPhase2MutationAuthority({
    manifest: readyManifest,
    registry,
  });
  expect(authority.errors).toEqual([]);
  return authority;
};

const counts = (killed = 9, survived = 1) => ({
  total: killed + survived,
  killed,
  timeout: 0,
  survived,
  noCoverage: 0,
  ignored: 0,
});

const passingResults = (authority: ReturnType<typeof readyAuthority>) =>
  authority.requirements.map(
    (requirement: {
      id: string;
      mutationClass: "critical" | "core";
      threshold: number;
      sources: string[];
      integrationSources: string[];
      integrationSourceModules: Record<string, string[]>;
      tests: string[];
    }) => {
      const source = requirement.sources[0]!;
      return {
        requirement_id: requirement.id,
        mutation_class: requirement.mutationClass,
        threshold: requirement.threshold,
        status: "PASS",
        evidence_eligible: false,
        synthetic_fixture: false,
        commit_sha: "a".repeat(40),
        tree_sha: "f".repeat(40),
        registry_sha256: authority.registrySha256,
        manifest_sha256: authority.manifestSha256,
        phase1_mutation_registry_sha256: authority.phase1MutationSha256,
        configuration_hash: "b".repeat(64),
        run_id: `${requirement.id.toLowerCase()}-00000000-0000-4000-8000-000000000000`,
        vitest_config_path: "vitest.mutation.config.ts",
        sources: requirement.sources,
        integration_sources: requirement.integrationSources,
        integration_source_modules: requirement.integrationSourceModules,
        tests: requirement.tests,
        counts: counts(),
        score: 90,
        per_file: {
          [source]: { ...counts(), score: 90 },
        },
        expected_chunk_count: 1,
        chunks: [
          {
            chunk_id: `${requirement.id.toLowerCase()}-1-10`,
            source_file: source,
            start_line: 1,
            end_line: 10,
            complete: true,
            raw_report_sha256: "c".repeat(64),
            config_sha256: "d".repeat(64),
            mutant_identity_sha256: "e".repeat(64),
          },
        ],
      };
    },
  );

describe("Phase 2 mutation authority", () => {
  it("derives thresholds, classes, and tests from the gate instead of duplicating them", () => {
    const authority = loadPhase2MutationAuthority({ manifest });

    expect(authority.thresholds).toEqual(manifest.mutation_thresholds);
    expect(authority.errors).toEqual([]);
    expect(authority.requirements).toHaveLength(64);
    expect(
      phase2MutationRequirements.every(
        (entry: Record<string, unknown>) =>
          JSON.stringify(Object.keys(entry).sort()) ===
          JSON.stringify(["id", "integrationSources", "sources", "status"]),
      ),
    ).toBe(true);
    expect(
      authority.requirements.map(
        (entry: { id: string; mutationClass: string; tests: string[] }) => [
          entry.id,
          entry.mutationClass,
          entry.tests,
        ],
      ),
    ).toEqual(
      manifest.requirements.map(
        (entry: {
          id: string;
          mutation_class: string;
          test_suites: string[];
        }) => [entry.id, entry.mutation_class, entry.test_suites],
      ),
    );
  });

  it("preserves the frozen all-critical Phase 2 mutation classification", () => {
    const authority = loadPhase2MutationAuthority({ manifest });
    const criticalIds = authority.requirements
      .filter(
        (entry: { mutationClass: string }) =>
          entry.mutationClass === "critical",
      )
      .map((entry: { id: string }) => entry.id);
    expect(criticalIds).toHaveLength(64);
    expect(criticalIds).toEqual(
      phase2MutationRequirements.map((entry: { id: string }) => entry.id),
    );
    expect(
      authority.requirements.filter(
        (entry: { mutationClass: string }) => entry.mutationClass === "core",
      ),
    ).toHaveLength(0);
  });

  it("derives the integrated Hook and SessionTree suites from the gate", () => {
    const authority = loadPhase2MutationAuthority({ manifest });
    const hook = authority.requirements.find(
      (entry: { id: string }) => entry.id === "AH-HOOK-001",
    );
    const testsFor = (id: string) =>
      authority.requirements.find((entry: { id: string }) => entry.id === id)
        ?.tests;

    expect(testsFor("AH-HOOK-001")).toEqual([
      "tests/phase-2/unit/ah-hook-001.test.ts",
      "tests/phase-2/integration/ah-hook-001-pipeline.test.ts",
      "tests/phase-2/security/ah-hook-001-injection.test.ts",
      "tests/phase-2/security/ah-hook-001-attenuation.test.ts",
      "tests/phase-2/security/ah-hook-001-external-execution.test.ts",
      "tests/phase-2/security/ah-hook-001-sqlite-journal.test.ts",
    ]);
    expect(hook.integrationSources).toContain("router/static-router.ts");
    expect(testsFor("AH-RUNTIME-SESSIONTREE-001")).toEqual([
      "tests/phase-2/unit/ah-runtime-sessiontree-001.test.ts",
      "tests/phase-2/integration/ah-runtime-sessiontree-001.sqlite-lock.test.ts",
      "tests/phase-2/security/ah-runtime-sessiontree-001-security.test.ts",
      "tests/phase-2/security/ah-runtime-sessiontree-001-round6-security.test.ts",
      "tests/phase-2/security/trusted-python-host.security.test.ts",
    ]);
  });

  it("separates owned mutation sources from shared integration sources covered by Phase 1", () => {
    const registry = cloneRegistry();
    const compiler = registry.find(
      (entry: { id: string }) => entry.id === "AH-CONTEXT-COMPILER-001",
    );
    compiler.integrationSources = ["harness.ts"];
    const projectedManifest = structuredClone(manifest);
    projectedManifest.requirements.find(
      (entry: { id: string }) => entry.id === "AH-CONTEXT-COMPILER-001",
    ).integration_sources = ["harness.ts"];
    const authority = loadPhase2MutationAuthority({
      manifest: projectedManifest,
      registry,
    });
    const requirement = authority.requirements.find(
      (entry: { id: string }) => entry.id === "AH-CONTEXT-COMPILER-001",
    );

    expect(authority.errors).toEqual([]);
    expect(requirement.sources).toEqual([]);
    expect(requirement.integrationSources).toEqual(["harness.ts"]);
    expect(requirement.integrationSourceModules).toEqual({
      "harness.ts": ["runtime"],
    });
  });

  it("rejects a shared integration source that escapes every Phase 1 mutation module", () => {
    const registry = cloneRegistry();
    const compiler = registry.find(
      (entry: { id: string }) => entry.id === "AH-CONTEXT-COMPILER-001",
    );
    compiler.integrationSources = ["runtime/uncovered-shared-consumer.ts"];
    const projectedManifest = structuredClone(manifest);
    projectedManifest.requirements.find(
      (entry: { id: string }) => entry.id === "AH-CONTEXT-COMPILER-001",
    ).integration_sources = ["runtime/uncovered-shared-consumer.ts"];

    expect(
      loadPhase2MutationAuthority({
        manifest: projectedManifest,
        registry,
      }).errors.join("\n"),
    ).toMatch(/integration source.*not covered.*Phase 1 mutation module/u);
  });

  it.each([
    [
      "missing",
      (registry: unknown[]) => registry.slice(1),
      /missing requirement/u,
    ],
    [
      "duplicate",
      (registry: unknown[]) => [...registry, structuredClone(registry[0])],
      /duplicate requirement/u,
    ],
    [
      "unknown",
      (registry: unknown[]) => [
        ...registry,
        {
          id: "AH-UNKNOWN-001",
          mutationClass: "critical",
          status: "not_started",
          sources: [],
          tests: [],
        },
      ],
      /unknown requirement/u,
    ],
  ])("rejects a %s registry entry set", (_name, mutate, pattern) => {
    const authority = loadPhase2MutationAuthority({
      manifest,
      registry: mutate(cloneRegistry()),
    });
    expect(authority.errors.join("\n")).toMatch(pattern);
  });

  it("fails closed when a gate threshold leaves the frozen 90/85 policy", () => {
    const thresholdDrift = structuredClone(manifest);
    thresholdDrift.mutation_thresholds.critical = 91;
    expect(
      loadPhase2MutationAuthority({
        manifest: thresholdDrift,
      }).errors.join("\n"),
    ).toMatch(/critical threshold.*exactly 90/u);
  });

  it("does not let an empty full-phase scope pass and resolves diagnostics exactly", () => {
    const authority = loadPhase2MutationAuthority({ manifest });
    const readiness = inspectPhase2MutationReadiness({
      authority,
      repositoryRoot,
    });

    expect(readiness).toMatchObject({
      ok: false,
      completed: 6,
      required: 64,
    });
    expect(readiness.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "mutation_incomplete" }),
      ]),
    );
    expect(resolvePhase2MutationTarget("AH-RAG-QUERY-001", authority).id).toBe(
      "AH-RAG-QUERY-001",
    );
    expect(() =>
      resolvePhase2MutationTarget("AH-UNKNOWN-001", authority),
    ).toThrow(/unknown Phase 2 mutation target/u);
  });

  it("does not treat symlinked source or test paths as mutation-ready files", () => {
    const root = mkdtempSync(resolve(tmpdir(), "phase2-mutation-paths-"));
    try {
      const sourceTarget = resolve(root, "source-target.ts");
      const testTarget = resolve(root, "test-target.ts");
      writeFileSync(sourceTarget, "export const value = true;\n", "utf8");
      writeFileSync(testTarget, "export {};\n", "utf8");
      symlinkSync(sourceTarget, resolve(root, "source.ts"));
      symlinkSync(testTarget, resolve(root, "test.ts"));

      const readiness = inspectPhase2MutationReadiness({
        repositoryRoot: root,
        authority: {
          errors: [],
          manifestSha256: "a".repeat(64),
          registrySha256: "b".repeat(64),
          thresholds: manifest.mutation_thresholds,
          requirements: [
            {
              id: "AH-SYNTHETIC-001",
              mutationClass: "critical",
              threshold: 90,
              status: "ready",
              sources: ["source.ts"],
              tests: ["test.ts"],
            },
          ],
        },
      });

      expect(readiness.ready).toEqual([]);
      expect(readiness.incomplete[0]?.missingSources).toEqual(["source.ts"]);
      expect(readiness.incomplete[0]?.missingTests).toEqual(["test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    "wires the package command to the candidate launcher and keeps stdout bounded",
    { timeout: 30_000 },
    () => {
      const packageJson = JSON.parse(
        readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
      );
      expect(packageJson.scripts["test:mutation:phase2"]).toBe(
        "node scripts/run-phase2-mutation-launcher.mjs phase2",
      );
      const bootstrap = readFileSync(resolve(repositoryRoot, "scripts/run-phase2-mutation-bootstrap.mjs"), "utf8");
      const mutationVitest = readFileSync(
        resolve(repositoryRoot, "vitest.mutation.config.ts"),
        "utf8",
      );
      expect(bootstrap).toMatch(/batch_sha256.*report_sha256.*path.*status/su);
      expect(bootstrap).toMatch(/explicitReady\s*!==\s*64/u);
      expect(bootstrap).not.toContain("mutation-bundles");
      expect(mutationVitest).toMatch(/testTimeout:\s*120_000/u);
      expect(mutationVitest).toMatch(/hookTimeout:\s*120_000/u);
    },
  );
});

describe("Phase 2 mutation report integrity", () => {
  it("keeps draft and candidate report schemas explicit without a local formal schema", () => {
    expect(PHASE2_MUTATION_DRAFT_SCHEMA_VERSION).toBe(
      "phase2-mutation-draft/v1",
    );
    expect(PHASE2_MUTATION_FINAL_SCHEMA_VERSION).toBe(
      "phase2-mutation-candidate/v1",
    );
    expect(typeof validateFinalPhase2MutationReport).toBe("function");
  });
  it("keeps a complete threshold-passing pure report draft Evidence-ineligible", () => {
    const authority = readyAuthority();
    const results = passingResults(authority);
    const originalResults = structuredClone(results);
    const report = buildPhase2MutationReport({
      authority,
      target: "phase2",
      commitSha: "a".repeat(40),
      treeSha: "f".repeat(40),
      configurationHash: "b".repeat(64),
      results,
    });

    expect(report.status).toBe("PASS");
    expect(report.evidence_eligible).toBe(false);
    expect(report.phase1_mutation_registry_sha256).toBe(
      authority.phase1MutationSha256,
    );
    expect(report.tree_sha).toBe("f".repeat(40));
    expect(report.completed).toBe(64);
    expect(results).toEqual(originalResults);
    expect(validatePhase2MutationReport(report, authority)).toEqual([]);
  });

  it("does not launder 64 independent diagnostics into full Evidence", () => {
    const authority = readyAuthority();
    const diagnostics = passingResults(authority).map(
      (result: ReturnType<typeof passingResults>[number]) => ({
        ...result,
        evidence_eligible: false,
        synthetic_fixture: false,
        execution_provenance: "diagnostic",
        formal_run_id: null,
      }),
    );
    const original = structuredClone(diagnostics);
    const report = buildPhase2MutationReport({
      authority,
      target: "phase2",
      commitSha: "a".repeat(40),
      treeSha: "f".repeat(40),
      configurationHash: "b".repeat(64),
      results: diagnostics,
    });

    expect(report.evidence_eligible).toBe(false);
    expect(report.results).toEqual(original);
  });

  it("does not grant Evidence to a pure report built with invented Git identities", () => {
    const authority = readyAuthority();
    const report = buildPhase2MutationReport({
      authority,
      target: "phase2",
      commitSha: "a".repeat(40),
      treeSha: "f".repeat(40),
      configurationHash: "b".repeat(64),
      results: passingResults(authority),
    });

    expect(report.status).toBe("PASS");
    expect(report.evidence_eligible).toBe(false);
  });

  it("rejects a forged local attempt to upgrade a candidate into formal Evidence", () => {
    const authority = readyAuthority();
    const formalRunId = "00000000-0000-4000-8000-000000000000";
    const report = buildPhase2MutationReport({
      authority,
      target: "phase2",
      commitSha: "a".repeat(40),
      treeSha: "f".repeat(40),
      configurationHash: "b".repeat(64),
      results: passingResults(authority),
    });
    Object.assign(report, {
      evidence_eligible: true,
      execution_provenance: "formal_isolated",
      isolation_mechanism: "seatbelt",
      formal_run_id: formalRunId,
      snapshot_sha256: "1".repeat(64),
      batch_sha256: "2".repeat(64),
    });
    for (const result of report.results) {
      Object.assign(result, {
        evidence_eligible: true,
        synthetic_fixture: false,
        execution_provenance: "formal_isolated",
        isolation_mechanism: "seatbelt",
        formal_run_id: formalRunId,
        snapshot_sha256: "1".repeat(64),
        batch_sha256: "2".repeat(64),
      });
    }

    expect(validatePhase2MutationReport(report, authority).join("\n")).toMatch(/Evidence eligibility/u);
    Object.assign(report, {
      schema_version: PHASE2_MUTATION_FINAL_SCHEMA_VERSION,
      source_root: `commit://${"a".repeat(40)}/`,
      artifact_root: `bundle://${"2".repeat(64)}/`,
      execution_receipt: {
        child_exit_status: 0,
        runner_sha256: "4".repeat(64),
        configuration_sha256: "b".repeat(64),
        source_snapshot_sha256: "1".repeat(64),
        dependency_snapshot_sha256: "5".repeat(64),
        dependency_manifest_sha256: "6".repeat(64),
        authority_closure_sha256: "7".repeat(64),
        toolchain: {
          node_version: "v20.18.1",
          node_sha256: "8".repeat(64),
          npm_version: "10.8.2",
          npm_sha256: "9".repeat(64),
          registry: "https://registry.npmjs.org/",
        },
        isolation_mechanism: "seatbelt",
      },
    });
    expect(validateFinalPhase2MutationReport(report, authority).join("\n")).toMatch(
      /candidate can never be Evidence-eligible|unknown field|execution receipt/u,
    );
  });

  it("rejects a forged 64-result full report made entirely from synthetic diagnostics", () => {
    const authority = readyAuthority();
    const results = passingResults(authority).map(
      (result: ReturnType<typeof passingResults>[number]) => ({
        ...result,
        evidence_eligible: true,
        synthetic_fixture: true,
      }),
    );
    const report = buildPhase2MutationReport({
      authority,
      target: "phase2",
      commitSha: "a".repeat(40),
      treeSha: "f".repeat(40),
      configurationHash: "b".repeat(64),
      results,
    });

    expect(report.status).toBe("FAIL");
    expect(report.evidence_eligible).toBe(false);
    expect(report.errors.join("\n")).toMatch(
      /synthetic.*Evidence|Evidence.*synthetic/u,
    );
  });

  it("keeps a diagnostic or synthetic result permanently ineligible for Evidence", () => {
    const authority = readyAuthority();
    const result = {
      ...passingResults(authority)[0],
      evidence_eligible: false,
      synthetic_fixture: true,
    };
    const report = buildPhase2MutationReport({
      authority,
      target: result.requirement_id,
      commitSha: "a".repeat(40),
      treeSha: "f".repeat(40),
      configurationHash: "b".repeat(64),
      results: [result],
    });

    expect(report.status).toBe("PASS");
    expect(report.evidence_eligible).toBe(false);
    expect(report.results[0].evidence_eligible).toBe(false);

    report.evidence_eligible = true;
    report.results[0].evidence_eligible = true;
    expect(validatePhase2MutationReport(report, authority).join("\n")).toMatch(
      /diagnostic.*Evidence|Evidence.*diagnostic|synthetic.*Evidence|Evidence.*synthetic/u,
    );
  });

  it.each([
    [
      "missing result",
      (results: unknown[]) => results.slice(1),
      /partial|missing/u,
    ],
    [
      "duplicate result",
      (results: unknown[]) => [...results, structuredClone(results[0])],
      /duplicate/u,
    ],
    [
      "unknown result",
      (results: Array<Record<string, unknown>>) => [
        ...results,
        { ...structuredClone(results[0]), requirement_id: "AH-UNKNOWN-001" },
      ],
      /unknown/u,
    ],
  ])("rejects a %s in full mode", (_name, mutate, pattern) => {
    const authority = readyAuthority();
    const report = buildPhase2MutationReport({
      authority,
      target: "phase2",
      commitSha: "a".repeat(40),
      treeSha: "f".repeat(40),
      configurationHash: "b".repeat(64),
      results: mutate(passingResults(authority)),
    });
    expect(validatePhase2MutationReport(report, authority).join("\n")).toMatch(
      pattern,
    );
    expect(report.status).toBe("FAIL");
    expect(report.evidence_eligible).toBe(false);
  });

  it("rejects mixed SHAs, partial chunks, and a below-threshold result", () => {
    const authority = readyAuthority();
    const results = passingResults(authority);
    results[0].commit_sha = "f".repeat(40);
    results[0].tree_sha = "e".repeat(40);
    results[1].expected_chunk_count = 2;
    results[3].configuration_hash = "f".repeat(64);
    results[2].counts = counts(8, 2);
    results[2].score = 80;
    results[2].per_file[results[2].sources[0]] = {
      ...counts(8, 2),
      score: 80,
    };
    results[2].status = "FAIL";
    const report = buildPhase2MutationReport({
      authority,
      target: "phase2",
      commitSha: "a".repeat(40),
      treeSha: "f".repeat(40),
      configurationHash: "b".repeat(64),
      results,
    });
    const errors = validatePhase2MutationReport(report, authority).join("\n");

    expect(errors).toMatch(/mixed commit SHA/u);
    expect(errors).toMatch(/mixed tree SHA/u);
    expect(errors).toMatch(/partial chunk/u);
    expect(errors).toMatch(/below.*90/u);
    expect(errors).toMatch(/configuration_hash mismatch/u);
    expect(report.status).toBe("FAIL");
  });

  it("rejects an aggregate pass when any source file is below its requirement threshold", () => {
    const authority = readyAuthority();
    const requirement = authority.requirements[0];
    const secondSource = "packages/synthetic/src/second-source.ts";
    requirement.sources.push(secondSource);
    const results = passingResults(authority);
    const result = results[0];
    result.counts = counts(9, 1);
    result.score = 90;
    result.per_file[result.sources[0]] = {
      ...counts(9, 0),
      score: 100,
    };
    result.per_file[secondSource] = { ...counts(0, 1), score: 0 };
    result.expected_chunk_count = 2;
    result.chunks.push({
      ...result.chunks[0],
      chunk_id: `${requirement.id.toLowerCase()}-second-source-1-10`,
      source_file: secondSource,
    });

    const report = buildPhase2MutationReport({
      authority,
      target: "phase2",
      commitSha: "a".repeat(40),
      treeSha: "f".repeat(40),
      configurationHash: "b".repeat(64),
      results,
    });

    expect(report.status).toBe("FAIL");
    expect(report.errors.join("\n")).toMatch(/per-file.*below.*90/u);
  });

  it("binds the formal report to the exact frozen thresholds", () => {
    const authority = readyAuthority();
    const report = buildPhase2MutationReport({
      authority,
      target: "phase2",
      commitSha: "a".repeat(40),
      treeSha: "f".repeat(40),
      configurationHash: "b".repeat(64),
      results: passingResults(authority),
    });
    report.thresholds.critical = 89;

    expect(validatePhase2MutationReport(report, authority).join("\n")).toMatch(
      /thresholds mismatch/u,
    );
  });

  it("rejects report drift in shared integration sources or their Phase 1 coverage", () => {
    const authority = readyAuthority();
    const results = passingResults(authority);
    results[0].integration_sources = ["harness.ts"];
    results[0].integration_source_modules = { "harness.ts": ["runtime"] };
    const report = buildPhase2MutationReport({
      authority,
      target: "phase2",
      commitSha: "a".repeat(40),
      treeSha: "f".repeat(40),
      configurationHash: "b".repeat(64),
      results,
    });

    expect(report.status).toBe("FAIL");
    expect(report.errors.join("\n")).toMatch(/integration source/u);
  });

  it("rejects an empty full report instead of treating an empty aggregate as PASS", () => {
    const authority = readyAuthority();
    const report = buildPhase2MutationReport({
      authority,
      target: "phase2",
      commitSha: "a".repeat(40),
      treeSha: "f".repeat(40),
      configurationHash: "b".repeat(64),
      results: [],
    });

    expect(report.status).toBe("FAIL");
    expect(report.evidence_eligible).toBe(false);
    expect(validatePhase2MutationReport(report, authority).join("\n")).toMatch(
      /empty|partial|missing/u,
    );
  });
});
