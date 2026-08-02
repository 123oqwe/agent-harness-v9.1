#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXPECTED_WORKSPACES } from "../check-workspace-boundaries.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY_ROOT = resolve(scriptDirectory, "../..");
export const API_APP_BRANCH_THRESHOLD = 85;

const metric = (entry, name) => {
  const value = entry?.[name];
  return value && typeof value === "object" ? value : null;
};

export const checkWorkspaceCoverage = ({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  summaryPath = join(repositoryRoot, "coverage/coverage-summary.json"),
} = {}) => {
  const root = resolve(repositoryRoot);
  const errors = [];
  let summary = null;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch (error) {
    errors.push(
      `coverage summary is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const entries = [];
  if (summary && typeof summary === "object") {
    for (const workspace of EXPECTED_WORKSPACES) {
      const source = join(root, workspace.path, "src/index.ts");
      const report = summary[source];
      const lines = metric(report, "lines");
      const branches = metric(report, "branches");
      const label = relative(root, source).replaceAll("\\", "/");
      if (!report) {
        errors.push(`${label} is missing from coverage`);
      } else if (
        typeof lines?.total !== "number" ||
        lines.total <= 0 ||
        typeof lines.covered !== "number" ||
        lines.covered <= 0
      ) {
        errors.push(`${label} must have non-zero line coverage`);
      }
      if (
        workspace.path === "apps/api" &&
        (typeof branches?.pct !== "number" ||
          branches.pct < API_APP_BRANCH_THRESHOLD)
      ) {
        errors.push(
          `${label} branch coverage must be at least ${API_APP_BRANCH_THRESHOLD}%`,
        );
      }
      entries.push({
        path: label,
        lines: lines?.pct ?? null,
        branches: branches?.pct ?? null,
      });
    }
  }

  return { ok: errors.length === 0, errors, entries };
};

const isMain = (() => {
  if (process.argv[1] === undefined || !existsSync(process.argv[1]))
    return false;
  return (
    realpathSync(fileURLToPath(import.meta.url)) ===
    realpathSync(process.argv[1])
  );
})();

if (isMain) {
  const result = checkWorkspaceCoverage();
  if (result.ok) {
    process.stdout.write(
      `workspace-coverage: valid (${result.entries.length} workspaces)\n`,
    );
  } else {
    for (const error of result.errors)
      process.stderr.write(`workspace-coverage: ${error}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
}
