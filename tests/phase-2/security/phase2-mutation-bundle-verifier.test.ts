import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  validateExternalArtifactAttestation,
  extractPhase2ArtifactZip,
  verifyPublishedPhase2MutationBundle,
  // @ts-expect-error The verifier intentionally ships as plain Node ESM.
} from "../../../scripts/gates/verify-phase2-mutation-bundle.mjs";

const root = resolve(import.meta.dirname, "../../..");
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");

describe("published Phase 2 mutation candidate verifier", () => {
  it("safely extracts bounded regular ZIP entries and rejects traversal and symlinks", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-safe-zip-"));
    try {
      const create = (name: string, mode = 0o100644) => {
        const path = join(directory, `${Math.random()}.zip`);
        const script = [
          "import sys, zipfile",
          "p,n,m=sys.argv[1],sys.argv[2],int(sys.argv[3])",
          "z=zipfile.ZipFile(p,'w',compression=zipfile.ZIP_DEFLATED)",
          "i=zipfile.ZipInfo(n); i.create_system=3; i.external_attr=m<<16",
          "z.writestr(i,b'candidate'); z.close()",
        ].join(";");
        const result = spawnSync("/usr/bin/python3", ["-c", script, path, name, String(mode)]);
        expect(result.status).toBe(0);
        return readFileSync(path);
      };
      expect([...extractPhase2ArtifactZip(create("mutation-publications/batch/candidate-report.json")).keys()])
        .toEqual(["mutation-publications/batch/candidate-report.json"]);
      expect(() => extractPhase2ArtifactZip(create("../escape"))).toThrow(/unsafe|traversal/iu);
      expect(() => extractPhase2ArtifactZip(create("link", 0o120777))).toThrow(/regular|symlink/iu);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("is candidate-only and never upgrades local bytes into formal Evidence", () => {
    const source = readFileSync(join(root, "scripts/gates/verify-phase2-mutation-bundle.mjs"), "utf8");
    expect(source).toContain("candidate-report.json");
    expect(source).not.toContain("final-report.json");
    expect(source).toContain('verdict: "CANDIDATE_ONLY"');
    expect(source).not.toMatch(/evidence_eligible\s*=\s*true/u);
  });

  it("returns a stable failure for a null publication receipt", async () => {
    await expect(verifyPublishedPhase2MutationBundle({
      repositoryRoot: root,
      publicationReceiptPath: null,
    })).resolves.toMatchObject({ ok: false, errors: expect.any(Array) });
  });

  it("rejects a forged external attestation fixture instead of proving a formal PASS", () => {
    const forged = {
      schema_version: "phase2-mutation-attestation-receipt/v1",
      repository: "attacker/repository",
      workflow_ref: "attacker/repository/.github/workflows/phase2-mutation.yml@refs/heads/main",
      run_id: 1,
      run_attempt: 1,
      head_sha: "a".repeat(40),
      conclusion: "success",
      artifact_name: `phase2-mutation-${"a".repeat(40)}`,
      artifact_id: 1,
      artifact_digest: `sha256:${"b".repeat(64)}`,
      verification_method: "github_actions_api",
      issuer: "https://api.github.com",
    };
    expect(validateExternalArtifactAttestation(forged).join("\n")).toMatch(/repository|workflow/u);
  });

  it("binds integrity to bytes, so copying an artifact to a new inode preserves its digest", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-artifact-copy-"));
    try {
      const original = join(directory, "original.zip");
      const copied = join(directory, "copied.zip");
      writeFileSync(original, Buffer.from("immutable candidate artifact\n"));
      copyFileSync(original, copied);
      expect(sha256(readFileSync(copied))).toBe(sha256(readFileSync(original)));
      const schema = JSON.parse(readFileSync(join(root, "verification/schemas/phase2-mutation-publication-receipt.schema.json"), "utf8"));
      expect(schema.properties).not.toHaveProperty("bundle_dev");
      expect(schema.properties).not.toHaveProperty("bundle_ino");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses fixed GitHub API metadata plus downloaded-byte digest verification", () => {
    const source = readFileSync(join(root, "scripts/gates/verify-phase2-mutation-bundle.mjs"), "utf8");
    expect(source).toContain('const API_HOST = "api.github.com"');
    expect(source).toMatch(/actions\/runs\/\$\{runId\}/u);
    expect(source).toMatch(/actions\/artifacts\/\$\{artifactId\}\/zip/u);
    expect(source).toMatch(/downloadedDigest/u);
    expect(source).not.toMatch(/fetchImpl|httpClient|requestImpl/u);
  });
});
