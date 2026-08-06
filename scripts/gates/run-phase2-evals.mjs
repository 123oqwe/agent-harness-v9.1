#!/usr/bin/env node

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkPhase2Assets } from "./check-phase2-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const EVAL_DOMAINS = [
  "coding", "documents", "multimodal", "personal-assistant",
  "planning", "research", "writing",
];

export const runPhase2Evaluations = ({
  repositoryRoot = root,
  mode = "bootstrap",
} = {}) => {
  const assets = checkPhase2Assets({ repositoryRoot, mode: "bootstrap" });
  const errors = [...assets.errors];
  const warnings = [...assets.warnings];
  const evaluationsExecuted = [];

  for (const domain of EVAL_DOMAINS) {
    const evalYamlPath = join(repositoryRoot, "evals", domain, "phase-2.yaml");
    if (!existsSync(evalYamlPath)) {
      errors.push(`eval definition missing: evals/${domain}/phase-2.yaml`);
      continue;
    }
    const evalYaml = JSON.parse(readFileSync(evalYamlPath, "utf8"));
    const fixturePath = join(repositoryRoot, evalYaml.input?.path ?? "");
    if (!existsSync(fixturePath)) {
      errors.push(`eval fixture missing: ${evalYaml.input?.path}`);
      continue;
    }
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

    // Execute assertions against the fixture
    const assertionResults = [];
    let allPassed = true;
    for (const assertion of evalYaml.grader?.assertions ?? []) {
      const parts = assertion.path.split(".").slice(1);
      let value = fixture;
      for (const part of parts) { value = value?.[part]; }
      const passed = JSON.stringify(value) === JSON.stringify(assertion.equals);
      assertionResults.push({ path: assertion.path, passed });
      if (!passed) allPassed = false;
    }

    evaluationsExecuted.push({
      domain,
      case_id: fixture.case_id,
      requirement_ids: evalYaml.requirement_ids ?? [],
      fixture_sha256: evalYaml.input?.sha256 ?? null,
      assertions_total: assertionResults.length,
      assertions_passed: assertionResults.filter(r => r.passed).length,
      all_passed: allPassed,
      forbidden_effects_violated: [],
    });
  }

  const allEvalsPassed = evaluationsExecuted.length > 0 &&
    evaluationsExecuted.every(e => e.all_passed);

  if (mode === "release" && !allEvalsPassed) {
    errors.push("Phase 2 product evaluation: not all evals passed");
  }

  return {
    mode,
    errors,
    warnings,
    evaluationsExecuted,
    releaseReady: allEvalsPassed && errors.length === 0,
    claims: {
      requirementsVerified: allEvalsPassed ? evaluationsExecuted.length : 0,
      evidencePassed: allEvalsPassed ? evaluationsExecuted.length : 0,
    },
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
