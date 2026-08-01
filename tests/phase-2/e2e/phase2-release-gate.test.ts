import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  phase2CommandGraph,
  verifyPhase2,
  // @ts-expect-error The production gate intentionally ships as plain Node ESM.
} from "../../../scripts/gates/verify-phase2-local.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

const runScript = (script: string) =>
  spawnSync("npm", ["run", script, "--silent"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  });

describe("Phase 2 real release gate", () => {
  it(
    "allows the dirty-tree development gate but makes zero release claims",
    { timeout: 30_000 },
    () => {
      const result = runScript("verify:phase2:dev");
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({
        mode: "dev",
        success: true,
        releaseReady: false,
        claims: { requirementsVerified: 0, evidencePassed: 0 },
      });
      expect(result.stdout).not.toMatch(/GLM|glm-5\.2/u);
    },
  );

  it("fails an injected local run while implementations and Evidence are absent", async () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "phase2-local-gate-test-"),
    );
    const visited: string[] = [];
    const report = await verifyPhase2({
      mode: "local",
      repositoryRoot,
      reportPath: join(temporaryRoot, "gate.json"),
      identityCollector: () => ({ errors: [], dirty: false, bindings: {} }),
      runner: async (command: { id: string }) => {
        visited.push(command.id);
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
    expect(report).toMatchObject({
      mode: "local",
      success: false,
      releaseReady: false,
      claims: { requirementsVerified: 0, evidencePassed: 0 },
    });
    expect(report.errors.length).toBeGreaterThan(0);
    expect(visited.length).toBeGreaterThan(0);
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("keeps the full E2E suite without spawning a nested local gate", () => {
    const e2e = phase2CommandGraph(repositoryRoot, "local").find(
      (entry: { id: string }) => entry.id === "phase2-e2e",
    );
    expect(e2e?.args).toEqual(
      expect.arrayContaining(["run", "tests/phase-2/e2e"]),
    );
    expect(JSON.stringify(e2e)).not.toContain("verify:phase2:local");
    const source = readFileSync(import.meta.filename, "utf8");
    const spawnedGateScripts = [
      ...source.matchAll(/runScript\("(verify:phase2:[^"]+)"\)/gu),
    ].map((match) => match[1]);
    expect(spawnedGateScripts).toEqual(["verify:phase2:dev"]);
  });

  it("serializes full regression commands that share the dist directory", () => {
    const graph = phase2CommandGraph(repositoryRoot, "local");
    for (const id of ["phase1-regression", "coverage"]) {
      const entry = graph.find(
        (candidate: { id: string }) => candidate.id === id,
      );
      expect(entry?.args).toEqual(
        expect.arrayContaining(["--", "--maxWorkers=1"]),
      );
    }
  });

  it("recognizes a symlinked script path as the CLI entry", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "phase2-gate-symlink-"));
    const link = join(temporaryRoot, "phase2-gate.mjs");
    symlinkSync(
      join(repositoryRoot, "scripts/gates/verify-phase2-local.mjs"),
      link,
    );
    const result = spawnSync(process.execPath, [link, "--mode", "invalid"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "unknown",
      success: false,
    });
    rmSync(temporaryRoot, { recursive: true, force: true });
  });
});
