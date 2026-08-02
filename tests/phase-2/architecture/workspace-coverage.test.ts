import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error The production checker intentionally ships as plain Node ESM.
import { EXPECTED_WORKSPACES } from "../../../scripts/check-workspace-boundaries.mjs";
// @ts-expect-error The production checker intentionally ships as plain Node ESM.
import * as workspaceCoverageModule from "../../../scripts/gates/check-workspace-coverage.mjs";

const { API_APP_BRANCH_THRESHOLD, checkWorkspaceCoverage } =
  workspaceCoverageModule;

const temporaryRoots = new Set<string>();

afterEach(() => {
  for (const root of temporaryRoots)
    rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-coverage-test-"));
  temporaryRoots.add(root);
  mkdirSync(join(root, "coverage"));
  const summary: Record<string, unknown> = {};
  for (const workspace of EXPECTED_WORKSPACES) {
    summary[join(root, workspace.path, "src/index.ts")] = {
      lines: { total: 1, covered: 1, skipped: 0, pct: 100 },
      branches: { total: 2, covered: 2, skipped: 0, pct: 100 },
    };
  }
  const write = () =>
    writeFileSync(
      join(root, "coverage/coverage-summary.json"),
      JSON.stringify(summary),
    );
  return { root, summary, write };
};

describe("workspace coverage gate", () => {
  it("requires source coverage for every frozen workspace entrypoint", () => {
    const { root, write } = fixture();
    write();

    const result = checkWorkspaceCoverage({ repositoryRoot: root });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(EXPECTED_WORKSPACES.length);
  });

  it("fails closed for missing, zero-line, and weak API composition coverage", () => {
    const { root, summary, write } = fixture();
    delete summary[join(root, "packages/context/src/index.ts")];
    summary[join(root, "packages/rag/src/index.ts")] = {
      lines: { total: 1, covered: 0, skipped: 0, pct: 0 },
      branches: { total: 0, covered: 0, skipped: 0, pct: 100 },
    };
    summary[join(root, "apps/api/src/index.ts")] = {
      lines: { total: 10, covered: 10, skipped: 0, pct: 100 },
      branches: {
        total: 100,
        covered: API_APP_BRANCH_THRESHOLD - 1,
        skipped: 0,
        pct: API_APP_BRANCH_THRESHOLD - 1,
      },
    };
    write();

    const result = checkWorkspaceCoverage({ repositoryRoot: root });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/context.*missing/u);
    expect(result.errors.join("\n")).toMatch(/rag.*non-zero/u);
    expect(result.errors.join("\n")).toMatch(/apps\/api.*85%/u);
  });

  it("fails closed when the coverage summary cannot be read", () => {
    const { root } = fixture();

    const result = checkWorkspaceCoverage({ repositoryRoot: root });

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/unreadable/u);
  });
});
