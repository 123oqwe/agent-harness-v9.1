#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validatePhase2Manifest } from "./check-phase2-manifest.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY_ROOT = resolve(scriptDirectory, "../..");
export const SEMANTIC_STUB_MARKERS = Object.freeze([
  "PHASE2_ACTIVE_STUB",
  "PHASE2_NOT_IMPLEMENTED",
  "throw new NotImplementedError",
]);

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".rs"]);

const sourceFiles = (path) => {
  if (!existsSync(path)) return [];
  const stats = statSync(path, { throwIfNoEntry: false });
  if (stats?.isFile()) return sourceExtensions.has(extname(path)) ? [path] : [];
  if (!stats?.isDirectory()) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() || sourceExtensions.has(extname(entry.name))
      ? sourceFiles(join(path, entry.name))
      : [],
  );
};

const parseEvidence = (path, requirement, root, errors) => {
  if (!existsSync(path)) {
    errors.push(
      `${requirement.id}: missing evidence ${requirement.evidence_path}`,
    );
    return null;
  }
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(
      `${requirement.id}: invalid evidence JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  if (
    evidence?.requirement_id !== requirement.id ||
    evidence?.status !== "verified" ||
    !/^[a-f0-9]{40}$/u.test(evidence?.commit_sha ?? "") ||
    !/^[a-f0-9]{40}$/u.test(evidence?.tree_sha ?? "") ||
    !Array.isArray(evidence?.source_files) ||
    evidence.source_files.length === 0 ||
    !Array.isArray(evidence?.test_files) ||
    !Array.isArray(evidence?.command_receipts) ||
    evidence.command_receipts.length === 0 ||
    !evidence.command_receipts.every(
      (receipt) =>
        receipt?.status === "passed" &&
        typeof receipt?.command_id === "string" &&
        /^[a-f0-9]{64}$/u.test(receipt?.stdout_sha256 ?? "") &&
        /^[a-f0-9]{64}$/u.test(receipt?.stderr_sha256 ?? ""),
    )
  ) {
    errors.push(
      `${requirement.id}: evidence is not bound to a verified commit, tree, source/test mapping, and real command receipts`,
    );
    return null;
  }
  for (const pathValue of [...evidence.source_files, ...evidence.test_files]) {
    if (typeof pathValue !== "string" || !existsSync(join(root, pathValue))) {
      errors.push(
        `${requirement.id}: evidence references missing path ${String(pathValue)}`,
      );
    }
  }
  for (const suite of requirement.test_suites) {
    if (!evidence.test_files.includes(suite)) {
      errors.push(
        `${requirement.id}: evidence does not bind required suite ${suite}`,
      );
    }
  }
  return evidence;
};

export const checkActivePhase2Stubs = ({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
} = {}) => {
  const root = resolve(repositoryRoot);
  const errors = [];
  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(join(root, "verification/gates/phase2-gate.json"), "utf8"),
    );
  } catch (error) {
    return {
      errors: [
        `cannot read Phase 2 authority: ${error instanceof Error ? error.message : String(error)}`,
      ],
      activeRequirementIds: [],
      semanticStubFiles: [],
      releaseReady: false,
      claims: { requirementsVerified: 0, evidencePassed: 0 },
    };
  }
  errors.push(...validatePhase2Manifest(manifest));
  const activeRequirementIds = [];
  const semanticStubFiles = [];
  let evidencePassed = 0;

  for (const requirement of manifest.requirements ?? []) {
    const requirementErrors = [];
    const ownerPath = join(root, requirement.owner);
    if (!existsSync(ownerPath))
      requirementErrors.push(
        `${requirement.id}: missing owner ${requirement.owner}`,
      );
    for (const suite of requirement.test_suites ?? []) {
      if (!existsSync(join(root, suite)))
        requirementErrors.push(
          `${requirement.id}: missing behavioral suite ${suite}`,
        );
    }
    const evidence = parseEvidence(
      join(root, requirement.evidence_path),
      requirement,
      root,
      requirementErrors,
    );
    if (!evidence)
      requirementErrors.push(
        `${requirement.id}: source mapping is unavailable until a verified Evidence Package binds source_files`,
      );
    if (evidence && requirementErrors.length === 0) evidencePassed += 1;
    if (requirementErrors.length > 0) {
      activeRequirementIds.push(requirement.id);
      errors.push(...requirementErrors);
    }
  }

  const owners = [
    ...new Set((manifest.requirements ?? []).map((entry) => entry.owner)),
  ];
  for (const owner of owners) {
    for (const file of sourceFiles(join(root, owner))) {
      const contents = readFileSync(file, "utf8");
      if (SEMANTIC_STUB_MARKERS.some((marker) => contents.includes(marker))) {
        semanticStubFiles.push(file.slice(root.length + 1));
      }
    }
  }
  if (semanticStubFiles.length > 0) {
    errors.push(
      ...semanticStubFiles.map(
        (file) => `explicit active stub marker in ${file}`,
      ),
    );
  }

  const requirementsVerified = errors.length === 0 ? evidencePassed : 0;
  if (errors.length > 0) evidencePassed = 0;
  return {
    errors,
    activeRequirementIds,
    semanticStubFiles,
    releaseReady:
      errors.length === 0 &&
      requirementsVerified === 64 &&
      evidencePassed === 64,
    claims: { requirementsVerified, evidencePassed },
  };
};

const isDirectExecution =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  const rootIndex = process.argv.indexOf("--root");
  const repositoryRoot =
    rootIndex === -1 ? DEFAULT_REPOSITORY_ROOT : process.argv[rootIndex + 1];
  const result = checkActivePhase2Stubs({ repositoryRoot });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.releaseReady ? 0 : 1;
}
