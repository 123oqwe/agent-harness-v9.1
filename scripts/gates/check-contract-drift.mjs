#!/usr/bin/env node

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkPhase2Assets } from "./check-phase2-assets.mjs";
import { validatePhase2ManifestFile } from "./check-phase2-manifest.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY_ROOT = resolve(scriptDirectory, "../..");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const collectFiles = (repositoryRoot, paths) => {
  const files = [];
  const visit = (absolutePath) => {
    if (!existsSync(absolutePath)) return;
    const stats = statSync(absolutePath, { throwIfNoEntry: false });
    if (stats?.isFile()) {
      files.push(absolutePath);
      return;
    }
    if (!stats?.isDirectory()) return;
    for (const entry of readdirSync(absolutePath).sort())
      visit(join(absolutePath, entry));
  };
  for (const path of paths) visit(join(repositoryRoot, path));
  return files.sort((left, right) =>
    relative(repositoryRoot, left).localeCompare(
      relative(repositoryRoot, right),
    ),
  );
};

const hashFileSet = (repositoryRoot, paths) => {
  const hash = createHash("sha256");
  const files = collectFiles(repositoryRoot, paths);
  for (const file of files) {
    const path = relative(repositoryRoot, file).replaceAll("\\", "/");
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return { sha256: hash.digest("hex"), files: files.length };
};

export const checkPhase2ContractDrift = ({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
} = {}) => {
  const root = resolve(repositoryRoot);
  const manifestPath = join(root, "verification/gates/phase2-gate.json");
  const errors = validatePhase2ManifestFile(manifestPath).map(
    (error) => `manifest authority drift: ${error}`,
  );
  const assets = checkPhase2Assets({ repositoryRoot: root, mode: "bootstrap" });
  errors.push(
    ...assets.errors.map((error) => `asset contract drift: ${error}`),
  );

  const manifestBytes = existsSync(manifestPath)
    ? readFileSync(manifestPath)
    : Buffer.alloc(0);
  const assetBinding = hashFileSet(root, [
    "evals",
    "data-tests",
    "fixtures/phase-2/assets",
  ]);
  return {
    errors,
    warnings: assets.warnings,
    releaseReady: false,
    bindings: {
      manifestSha256: sha256(manifestBytes),
      assetsSha256: assetBinding.sha256,
      assetFiles: assetBinding.files,
    },
    claims: { requirementsVerified: 0, evidencePassed: 0 },
  };
};

const isDirectExecution =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  const rootIndex = process.argv.indexOf("--root");
  const repositoryRoot =
    rootIndex === -1 ? DEFAULT_REPOSITORY_ROOT : process.argv[rootIndex + 1];
  const result = checkPhase2ContractDrift({ repositoryRoot });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.errors.length === 0 ? 0 : 1;
}
