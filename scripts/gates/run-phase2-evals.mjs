#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkPhase2Assets } from "./check-phase2-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const runPhase2Evaluations = ({
  repositoryRoot = root,
  mode = "bootstrap",
} = {}) => {
  const assets = checkPhase2Assets({ repositoryRoot, mode: "bootstrap" });
  const errors = [...assets.errors];
  const warnings = [...assets.warnings];
  const blocked =
    "Phase 2 product evaluation runner and Evidence Packages are not implemented";
  if (mode === "release") errors.push(blocked);
  else warnings.push(blocked);
  return {
    mode,
    errors,
    warnings,
    evaluationsExecuted: assets.evaluations,
    releaseReady: false,
    claims: { requirementsVerified: 0, evidencePassed: 0 },
  };
};

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const modeIndex = process.argv.indexOf("--mode");
  const mode = modeIndex === -1 ? "bootstrap" : process.argv[modeIndex + 1];
  const result = runPhase2Evaluations({ mode });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.errors.length === 0 ? 0 : 1;
}
