import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error Production authority intentionally ships as plain ESM.
import * as bootstrap from "../../../scripts/run-phase2-mutation-bootstrap.mjs";
// @ts-expect-error Production authority intentionally ships as plain ESM.
import * as bundleVerifier from "../../../scripts/gates/verify-phase2-mutation-bundle.mjs";
// @ts-expect-error Production authority intentionally ships as plain ESM.
import { trustedGitReadArguments } from "../../../scripts/gates/trusted-git.mjs";
// @ts-expect-error Production authority intentionally ships as plain ESM.
import { validatePhase2MutationReport } from "../../../scripts/gates/phase2-mutation.mjs";
// @ts-expect-error Production authority intentionally ships as plain ESM.
import { validateSchemaDocument } from "../../../scripts/gates/json-schema.mjs";

const root = resolve(import.meta.dirname, "../../..");
const source = (path: string) => readFileSync(join(root, path), "utf8");
const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
};

const git = (repository: string, args: string[]) =>
  execFileSync("/usr/bin/git", args, { cwd: repository, encoding: "utf8" }).trim();

const forgedZeroMutationPublication = () => {
  const repository = mkdtempSync(join(tmpdir(), "phase2-forged-candidate-"));
  mkdirSync(join(repository, ".github/workflows"), { recursive: true });
  mkdirSync(join(repository, "verification/gates"), { recursive: true });
  mkdirSync(join(repository, "mutation"), { recursive: true });
  writeFileSync(
    join(repository, ".github/workflows/phase2-mutation.yml"),
    source(".github/workflows/phase2-mutation.yml"),
  );
  writeFileSync(join(repository, "verification/gates/phase2-gate.json"), source("verification/gates/phase2-gate.json"));
  writeFileSync(join(repository, "mutation/phase2-modules.mjs"), source("mutation/phase2-modules.mjs"));
  git(repository, ["init"]);
  git(repository, ["add", "."]);
  git(repository, [
    "-c", "user.name=Round Eight", "-c", "user.email=round8@example.invalid",
    "commit", "-m", "fixture",
  ]);
  const commit = git(repository, ["rev-parse", "HEAD"]);
  const tree = git(repository, ["rev-parse", "HEAD^{tree}"]);
  const batch = "2".repeat(64);
  const counts = { total: 0, killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0 };
  const executionReceipt = {
    schema_version: "phase2-mutation-execution-receipt/v1", child_exit_status: 0,
    runner_sha256: "4".repeat(64), configuration_sha256: "b".repeat(64),
    source_snapshot_sha256: "1".repeat(64), dependency_snapshot_sha256: "5".repeat(64),
    dependency_manifest_sha256: "6".repeat(64), authority_closure_sha256: "7".repeat(64),
    mutant_completeness_sha256: "8".repeat(64),
    toolchain: { node_version: "v20.18.1", node_sha256: "8".repeat(64), npm_version: "10.8.2",
      npm_sha256: "9".repeat(64), registry: "https://registry.npmjs.org/", bubblewrap_version: "bubblewrap 0.6.1",
      bubblewrap_sha256: "a".repeat(64), prlimit_sha256: "b".repeat(64) },
    isolation_mechanism: "bubblewrap",
  };
  const result = {
    requirement_id: "AH-FAKE-DUPLICATE-001", mutation_class: "critical", threshold: 90, status: "PASS",
    evidence_eligible: false, synthetic_fixture: false, execution_provenance: "isolated_candidate",
    isolation_mechanism: "bubblewrap", candidate_run_id: randomUUID(), snapshot_sha256: "1".repeat(64),
    batch_sha256: batch, commit_sha: commit, tree_sha: tree, registry_sha256: "c".repeat(64),
    manifest_sha256: "d".repeat(64), phase1_mutation_registry_sha256: "e".repeat(64),
    configuration_hash: "b".repeat(64), run_id: "fake", vitest_config_path: "fake", sources: [],
    integration_sources: [], integration_source_modules: {}, tests: [], counts, score: 0, per_file: {},
    expected_chunk_count: 0, chunks: [], mutant_identity_sha256: "f".repeat(64),
  };
  const report = {
    schema_version: "phase2-mutation-candidate/v1", phase: 2, target: "phase2", status: "PASS",
    evidence_eligible: false, commit_sha: commit, tree_sha: tree, registry_sha256: "c".repeat(64),
    manifest_sha256: "d".repeat(64), phase1_mutation_registry_sha256: "e".repeat(64),
    configuration_hash: "b".repeat(64), thresholds: { critical: 90, core: 85 }, completed: 64, required: 64,
    aggregate: counts, aggregate_score: 0, results: Array.from({ length: 64 }, () => structuredClone(result)),
    errors: [], batch_sha256: batch, source_root: `commit://${commit}/`, artifact_root: `bundle://${batch}/`,
    execution_receipt: executionReceipt,
  };
  const reportBytes = Buffer.from(JSON.stringify(report));
  const publicationPath = `reports/phase2/mutation-publications/${batch}`;
  const publicationSet = createHash("sha256")
    .update("candidate-report.json").update("\0").update(reportBytes).update("\0").digest("hex");
  const receipt = {
    schema_version: "phase2-mutation-publication-receipt/v2", commit_sha: commit, tree_sha: tree,
    batch_sha256: batch, publication_path: publicationPath, publication_set_sha256: publicationSet,
    candidate_report_sha256: sha256(reportBytes), execution_receipt_sha256: sha256(canonicalJson(executionReceipt)),
  };
  return { repository, commit, tree, publicationPath,
    files: new Map([["candidate-report.json", reportBytes], ["publication-receipt.json", Buffer.from(JSON.stringify(receipt))]]) };
};

describe("Phase 2 mutation authority review round 8", () => {
  it("rejects a duplicate 64-result zero-mutant candidate", () => {
    const fixture = forgedZeroMutationPublication();
    const result = bundleVerifier.verifyPhase2MutationPublicationFiles({
      repositoryRoot: fixture.repository, files: fixture.files,
      publicationReceiptPath: fixture.publicationPath, headCommit: fixture.commit, headTree: fixture.tree,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/duplicate|unknown requirement|zero mutant|empty source|partial chunk/iu);
  });

  it.each([
    'require/*review*/("./hidden.cjs");',
    'import/*review*/("./hidden.mjs");',
    'const alias = require; alias("./hidden.cjs");',
  ])("fails closed on an unmodelled module edge: %s", (text) => {
    expect(() => bootstrap.collectStaticImportClosure({
      entryPaths: ["tests/root.cjs"],
      readSource: (path: string) => path === "tests/root.cjs" ? text : "module.exports = 1;",
    })).toThrow(/unmodelled|module graph|dynamic|alias|syntax/iu);
  });

  it("rejects write-capable options from every trusted Git read grammar", () => {
    expect(() => trustedGitReadArguments(["diff-files", "--output=/tmp/forbidden"])).toThrow(/option|allowed|grammar/iu);
    expect(() => trustedGitReadArguments(["cat-file", "--textconv", "HEAD:file"])).toThrow(/option|allowed|grammar/iu);
    expect(() => trustedGitReadArguments(["-c", "core.pager=evil", "status"])).toThrow(/command|allowed|grammar/iu);
  });

  it.each([[14, 0x12345678], [18, 999], [22, 999]])(
    "rejects ZIP local header field at offset %s when it differs from central authority",
    (offset, value) => {
      const directory = mkdtempSync(join(tmpdir(), "phase2-round8-zip-"));
      const archive = join(directory, "candidate.zip");
      const created = spawnSync("/usr/bin/python3", ["-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_STORED);z.writestr('ok.txt',b'abc');z.close()", archive]);
      expect(created.status).toBe(0);
      const bytes = readFileSync(archive);
      bytes.writeUInt32LE(value, offset);
      expect(() => bundleVerifier.extractPhase2ArtifactZip(bytes)).toThrow(/local.*central|header.*mismatch/iu);
    },
  );

  it("recovers the post-rename pre-journal crash window", () => {
    const repository = mkdtempSync(join(tmpdir(), "phase2-round8-journal-"));
    const parent = join(repository, "reports/phase2/mutation-publications");
    const final = join(parent, "batch");
    mkdirSync(final, { recursive: true });
    writeFileSync(join(final, "candidate-report.json"), "candidate");
    const identity = statSync(final);
    writeFileSync(join(parent, ".phase2-publication-journal-batch.json"), JSON.stringify({
      schema_version: "phase2-publication-journal/v1", state: "PREPARED",
      temporary: "reports/phase2/mutation-publication-staging-killed",
      final: "reports/phase2/mutation-publications/batch",
      identity: { dev: String(identity.dev), ino: String(identity.ino) },
    }));
    const recovery = spawnSync("/usr/bin/python3", ["-I", "-B", join(root, "scripts/gates/secure-publish.py")], {
      input: JSON.stringify({ operation: "recover_publications", root: repository, path: "reports/phase2/mutation-publications" }),
      encoding: "utf8", env: { PHASE2_SECURE_PUBLISH_TESTING: "1" },
    });
    expect(recovery.status, recovery.stdout + recovery.stderr).toBe(0);
    expect(existsSync(final)).toBe(false);
  });

  it("mounts the exact Node and npm runtime read-only in the native builder", () => {
    const command = bootstrap.compileDependencyBuilderBubblewrapCommand({
      builder: "/tmp/builder", argv: ["/opt/node/lib/node_modules/npm/bin/npm-cli.js", "rebuild"],
      nodeExecutable: "/opt/node/bin/node", npmExecutable: "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
    });
    expect(command.args.join("\n")).toMatch(/--ro-bind\n\/opt\/node\n\/opt\/node/u);
  });

  it("uses the production better-sqlite3 version in the native fixture", () => {
    const production = JSON.parse(source("package-lock.json")).packages["node_modules/better-sqlite3"].version;
    const fixture = JSON.parse(source("tests/phase-2/fixtures/native-clean-install/package-lock.json"))
      .packages["node_modules/better-sqlite3"].version;
    expect(fixture).toBe(production);
  });

  it("keeps parent authority free of candidate module imports", () => {
    const parent = source("scripts/run-phase2-mutation-bootstrap.mjs");
    expect(parent).not.toMatch(/await import\([\s\S]*snapshot|pathToFileURL\(join\(snapshot/iu);
  });

  it("uses an independent completeness implementation and publishes its receipt body", () => {
    const completeness = source("scripts/gates/verify-phase2-mutant-completeness.mjs");
    expect(completeness).not.toMatch(/run-phase2-mutation|validatePhase2MutationArtifacts/u);
    expect(source("scripts/run-phase2-mutation-bootstrap.mjs")).toMatch(/mutant-completeness-receipt\.json/u);
  });

  it("parses real gh verificationResult structure and permits the frozen API fallback", () => {
    const claims = bundleVerifier.parseGitHubAttestationVerification([{ verificationResult: {
      statement: { subject: [{ name: "phase2.zip", digest: { sha256: "a".repeat(64) } }] },
      signature: { certificate: { issuer: "https://token.actions.githubusercontent.com",
        sourceRepository: "123oqwe/agentharness91", sourceRepositoryRef: "refs/heads/release",
        workflowRef: "123oqwe/phase2-authority/.github/workflows/verify.yml@refs/heads/main" } },
    } }]);
    expect(claims.subject_digest).toBe(`sha256:${"a".repeat(64)}`);
    expect(source("scripts/gates/verify-phase2-mutation-bundle.mjs")).not.toMatch(/sigstore\.ok === true && api\.ok === true/iu);
  });

  it("enforces the draft schema through the production report validation path", () => {
    const report = {
      schema_version: "phase2-mutation-draft/v1", phase: 2, target: "phase2", status: "FAIL",
      evidence_eligible: false, commit_sha: "a".repeat(40), tree_sha: "b".repeat(40),
      registry_sha256: "c".repeat(64), manifest_sha256: "d".repeat(64),
      phase1_mutation_registry_sha256: "e".repeat(64), configuration_hash: "f".repeat(64),
      thresholds: { critical: 90, core: 85 }, completed: 0, required: 64,
      aggregate: { total: 0, killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0 },
      aggregate_score: 0, results: [], errors: [], unexpected_authority_field: true,
    };
    const errors = validatePhase2MutationReport(report, {
      errors: [], requirements: [], registrySha256: report.registry_sha256,
      manifestSha256: report.manifest_sha256,
      phase1MutationSha256: report.phase1_mutation_registry_sha256,
      thresholds: report.thresholds,
    });
    expect(errors.join("\n")).toMatch(/unexpected_authority_field|additional property|unknown field/iu);
  });

  it("enforces minItems in the frozen schema validator", () => {
    expect(validateSchemaDocument([], { type: "array", minItems: 1, items: { type: "string" } }))
      .toContainEqual("$ must contain at least 1 items");
  });

  it("copies every workspace manifest into the private dependency builder", () => {
    const repository = mkdtempSync(join(tmpdir(), "phase2-workspaces-"));
    const builder = mkdtempSync(join(tmpdir(), "phase2-builder-"));
    try {
      writeFileSync(join(repository, "package.json"), JSON.stringify({ workspaces: ["packages/*", "apps/*"] }));
      for (const path of ["packages/core", "apps/web"]) {
        mkdirSync(join(repository, path), { recursive: true });
        writeFileSync(join(repository, path, "package.json"), JSON.stringify({ name: path.replace("/", "-") }));
      }
      expect(typeof (bootstrap as Record<string, unknown>).copyWorkspaceManifests).toBe("function");
      bootstrap.copyWorkspaceManifests({ snapshot: repository, builder });
      expect(JSON.parse(readFileSync(join(builder, "packages/core/package.json"), "utf8")).name).toBe("packages-core");
      expect(JSON.parse(readFileSync(join(builder, "apps/web/package.json"), "utf8")).name).toBe("apps-web");
    } finally {
      rmSync(repository, { recursive: true, force: true });
      rmSync(builder, { recursive: true, force: true });
    }
  });
});
