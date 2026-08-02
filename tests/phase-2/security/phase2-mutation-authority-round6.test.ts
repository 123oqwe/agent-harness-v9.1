import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  compileMutationBubblewrapCommand,
  compileMutationSeatbeltProfile,
  PHASE2_BOOTSTRAP_AUTHORITY_PATHS,
  // @ts-expect-error The bootstrap intentionally ships as plain Node ESM.
} from "../../../scripts/run-phase2-mutation-bootstrap.mjs";
import {
  PHASE2_MUTATION_AUTHORITY_PATHS,
  // @ts-expect-error The runner intentionally ships as plain Node ESM.
} from "../../../scripts/run-phase2-mutation.mjs";

const root = resolve(import.meta.dirname, "../../..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("Phase 2 mutation authority review round 6", () => {
  it("keeps the core runner permanently draft-only even under forged FORMAL environment", () => {
    const runner = source("scripts/run-phase2-mutation.mjs");
    expect(runner).not.toMatch(/finalizePhase2MutationEvidence/u);
    expect(runner).not.toMatch(/evidence_eligible:\s*true/u);
    expect(runner).not.toMatch(/process\.env\.PHASE2_FORMAL_/u);
    expect(runner).not.toMatch(/securePublish\(\{[\s\S]*mutation-bundles/u);
  });

  it("defines and enforces exact draft, candidate, execution, publication, and attestation schemas", () => {
    const paths = [
      "verification/schemas/phase2-mutation-draft.schema.json",
      "verification/schemas/phase2-mutation-candidate.schema.json",
      "verification/schemas/phase2-mutation-execution-receipt.schema.json",
      "verification/schemas/phase2-mutation-publication-receipt.schema.json",
      "verification/schemas/phase2-mutation-attestation-receipt.schema.json",
    ];
    expect(paths.every((path) => existsSync(join(root, path)))).toBe(true);
    for (const path of paths) {
      const schema = JSON.parse(source(path));
      expect(schema.additionalProperties, path).toBe(false);
    }
    const gate = source("scripts/gates/phase2-mutation.mjs");
    expect(gate).toMatch(/validatePhase2MutationDraftSchema/u);
    expect(gate).toMatch(/validatePhase2MutationCandidateSchema/u);
    expect(gate).toMatch(/unknown.*field|additionalProperties/iu);
  });

  it("uses GitHub OIDC artifact attestation as the only formal authority", () => {
    const workflow = source(".github/workflows/phase2-mutation.yml");
    expect(workflow).toMatch(/id-token:\s*write/u);
    expect(workflow).toMatch(
      /actions\/attest-build-provenance@[0-9a-f]{40}/u,
    );
    expect(workflow).toMatch(/subject-digest:/u);
    expect(workflow).toMatch(/artifact-id:/u);
    expect(workflow).toMatch(/artifact-name:/u);
    expect(workflow).not.toMatch(/external_exact_sha/u);
  });

  it("does not let the launcher overwrite provenance and loads the bootstrap from the attested exact SHA", () => {
    const launcher = source("scripts/run-phase2-mutation-launcher.mjs");
    expect(launcher).not.toMatch(/PHASE2_MUTATION_LAUNCH_PROVENANCE:\s*["']/u);
    expect(launcher).toMatch(/PHASE2_MUTATION_ATTESTED_SHA/u);
    expect(launcher).toMatch(/HEAD\^\{commit\}/u);
    expect(launcher).toMatch(/\$\{attestedSha\}:scripts\/run-phase2-mutation-bootstrap\.mjs/u);
    expect(launcher).toMatch(/PHASE2_MUTATION_EXTRACTED_BOOTSTRAP/u);
  });

  it("publishes one candidate report and exposes only bundle URIs plus a small stdout protocol", () => {
    const runner = source("scripts/run-phase2-mutation.mjs");
    const bootstrap = source("scripts/run-phase2-mutation-bootstrap.mjs");
    expect(runner).toContain("candidate-report.json");
    expect(runner).not.toContain("final-report.json");
    expect(runner).not.toMatch(/atomicWriteJson\([\s\S]*mutation\.json/u);
    expect(runner).toMatch(/bundle:\/\/\$\{[^}]+\}\/raw\//u);
    expect(bootstrap).toMatch(/batch_sha256.*report_sha256.*path.*status/su);
    expect(bootstrap).not.toMatch(/JSON\.stringify\(report/u);
  });

  it("keeps candidate inode identity in memory without upgrading it to formal Evidence", () => {
    const receipt = JSON.parse(
      source(
        "verification/schemas/phase2-mutation-publication-receipt.schema.json",
      ),
    );
    expect(receipt.properties).not.toHaveProperty("bundle_dev");
    expect(receipt.properties).not.toHaveProperty("bundle_ino");
    const bootstrap = source("scripts/run-phase2-mutation-bootstrap.mjs");
    expect(bootstrap).toMatch(/publishCandidateTree[\s\S]*dev[\s\S]*ino/iu);
    expect(bootstrap).toMatch(/CANDIDATE_ONLY[\s\S]*formal_evidence_eligible:\s*false/iu);
    expect(bootstrap).toMatch(/candidate-report[\s\S]*publication-receipt/iu);
  });

  it(
    "prevents a real Seatbelt process from reading a live repository secret",
    { timeout: 20_000 },
    () => {
      if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))
        return;
      const parent = mkdtempSync(join(tmpdir(), "phase2-seatbelt-live-read-"));
      const live = join(parent, "live");
      const snapshot = join(parent, "snapshot");
      try {
        mkdirSync(live);
        mkdirSync(join(snapshot, "reports"), { recursive: true });
        mkdirSync(join(snapshot, ".stryker-tmp"));
        writeFileSync(join(live, "LIVE_SECRET"), "must-not-be-readable\n");
        const run = spawnSync(
          "/usr/bin/sandbox-exec",
          [
            "-p",
            compileMutationSeatbeltProfile({
              liveRoot: live,
              snapshot,
              dependencyRoot: join(snapshot, "node_modules"),
            }),
            process.execPath,
            "-e",
            `require("node:fs").readFileSync(${JSON.stringify(join(live, "LIVE_SECRET"))});`,
          ],
          { encoding: "utf8", shell: false, timeout: 20_000 },
        );
        expect(run.status).not.toBe(0);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  it("allows formal CI only on Linux bubblewrap with explicit CPU, memory, PID, and wall-clock authorities", () => {
    const bootstrap = source("scripts/run-phase2-mutation-bootstrap.mjs");
    expect(bootstrap).toMatch(/authority_scope:\s*"candidate_only"/u);
    expect(bootstrap).toMatch(/formal_authority_status:\s*"external_required_unprovisioned"/u);
    const command = compileMutationBubblewrapCommand({
      executable: "/usr/bin/bwrap",
      snapshot: "/snapshot",
      dependencyRoot: "/snapshot/node_modules",
      target: "phase2",
      nodeExecutable: "/runtime/bin/node",
      nodeRuntimeRoot: "/runtime",
      systemRoots: ["/usr", "/bin"],
    });
    expect(command.args).toContain("/usr/bin/prlimit");
    expect(command.args.join(" ")).toMatch(/--cpu=\d+/u);
    expect(command.args.join(" ")).toMatch(/--as=\d+/u);
    expect(command.args.join(" ")).toMatch(/--nproc=\d+/u);
    expect(command).toHaveProperty("wallClockTimeoutMs");
  });

  it("builds dependencies outside the execution snapshot with a frozen toolchain and a real native clean-install fixture", () => {
    const bootstrap = source("scripts/run-phase2-mutation-bootstrap.mjs");
    expect(bootstrap).toMatch(/dependency-builder/u);
    expect(bootstrap).toMatch(/npm@10\.8\.2/u);
    expect(bootstrap).toMatch(/registry\.npmjs\.org/u);
    expect(bootstrap).toMatch(/reject.*\.npmrc|\.npmrc.*reject/iu);
    expect(bootstrap).not.toMatch(/node_modules\/patch-package\/index\.js/u);
    expect(bootstrap).toMatch(/applyCommittedPatch/u);
    expect(
      existsSync(
        join(root, "tests/phase-2/fixtures/native-clean-install/package.json"),
      ),
    ).toBe(true);
  });

  it("hashes the recursive static import closure from one trusted-git authority", () => {
    for (const paths of [
      PHASE2_BOOTSTRAP_AUTHORITY_PATHS,
      PHASE2_MUTATION_AUTHORITY_PATHS,
    ]) {
      expect(paths).toContain("scripts/gates/trusted-git.mjs");
      expect(paths).not.toContain("scripts/trusted-git.mjs");
    }
    const bootstrap = source("scripts/run-phase2-mutation-bootstrap.mjs");
    expect(bootstrap).toMatch(/collectStaticImportClosure/u);
    expect(bootstrap).toMatch(/unknown dynamic import/iu);
  });

  it("freezes workflow semantics and validates null receipts without throwing", async () => {
    const verifier = await import(
      // @ts-expect-error The verifier intentionally ships as plain Node ESM.
      "../../../scripts/gates/verify-phase2-mutation-bundle.mjs"
    );
    await expect(
      verifier.verifyPublishedPhase2MutationBundle({
        repositoryRoot: root,
        publicationReceiptPath: null,
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(typeof verifier.validatePhase2MutationWorkflow).toBe("function");
    expect(typeof verifier.validateExternalArtifactAttestation).toBe(
      "function",
    );
    const launcher = source("scripts/run-phase2-mutation-launcher.mjs");
    expect(launcher).toMatch(/process\.execPath,\s*\["--",/u);
    expect(launcher).toMatch(/EPIPE/u);
  });

  it("binds external attestation to the exact repository, workflow run, artifact, and GitHub issuer", () => {
    const path =
      "verification/schemas/phase2-mutation-attestation-receipt.schema.json";
    expect(existsSync(join(root, path))).toBe(true);
    const expected = source(path);
    expect(expected).toContain("123oqwe/agentharness91");
    expect(expected).toMatch(/workflow_ref/u);
    expect(expected).toMatch(/run_id/u);
    expect(expected).toMatch(/run_attempt/u);
    expect(expected).toMatch(/head_sha/u);
    expect(expected).toMatch(/conclusion/u);
    expect(expected).toMatch(/artifact_name/u);
    expect(expected).toMatch(/artifact_id/u);
    expect(expected).toMatch(/artifact_digest/u);
    expect(expected).toMatch(/sigstore|token\.actions\.githubusercontent\.com/iu);
    expect(expected).toMatch(/github_actions_api/u);
  });
});
