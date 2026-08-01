#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  constants,
  accessSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY_ROOT = resolve(scriptDirectory, "../..");

const EVALUATIONS = [
  "coding",
  "documents",
  "research",
  "writing",
  "planning",
  "personal-assistant",
  "multimodal",
].map((domain) => ({ domain, path: `evals/${domain}/phase-2.yaml` }));

const DATA_MANIFESTS = [
  "synthetic",
  "public-benchmarks",
  "consented-staging",
].map((kind) => ({
  kind,
  path: `data-tests/${kind}/phase-2/manifest.json`,
}));

const EVAL_KEYS = new Set([
  "schema_version",
  "format",
  "id",
  "domain",
  "requirement_ids",
  "input",
  "grader",
  "forbidden_effects",
  "evidence_fields",
]);
const INPUT_KEYS = new Set(["path", "sha256"]);
const GRADER_KEYS = new Set(["type", "assertions"]);
const ASSERTION_KEYS = new Set(["path", "equals"]);
const DATA_ROOT_KEYS = new Set([
  "schema_version",
  "kind",
  "dataset",
  "external_contract",
]);
const DATASET_KEYS = new Set([
  "id",
  "availability",
  "provenance",
  "license",
  "checksum",
  "path",
  "tenant",
  "expected_runner",
]);
const PUBLIC_DATASET_KEYS = new Set([...DATASET_KEYS, "release_ready"]);
const PROVENANCE_KEYS = new Set([
  "publisher",
  "source_uri",
  "created_at",
  "purpose",
]);
const CHECKSUM_KEYS = new Set(["algorithm", "value"]);
const EXTERNAL_CONTRACT_KEYS = new Set([
  "required_environment",
  "required_fields",
  "must_be_outside_repository",
]);
const REQUIRED_EVIDENCE_FIELDS = [
  "case_id",
  "requirement_ids",
  "fixture_sha256",
  "grader_results",
  "forbidden_effects",
  "evidence_path",
];
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const addUnknownKeyErrors = (value, allowed, label, errors) => {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label} has unknown key: ${key}`);
  }
};

const duplicates = (values) => {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const result = new Set();
  for (const value of values) {
    if (seen.has(value)) result.add(value);
    seen.add(value);
  }
  return [...result];
};

const sameStringSet = (left, right) =>
  Array.isArray(left) &&
  left.every(nonEmptyString) &&
  left.length === right.length &&
  [...left].sort().every((value, index) => value === [...right].sort()[index]);

const safeRelativePath = (path) =>
  nonEmptyString(path) &&
  !isAbsolute(path) &&
  !path.split(/[\\/]/u).includes("..") &&
  path.split(/[\\/]/u).every((segment) => segment !== "");

const staysInside = (root, candidate) => {
  const relation = relative(root, candidate);
  return (
    relation === "" || (!relation.startsWith(`..${sep}`) && relation !== "..")
  );
};

const readRepositoryAsset = ({
  repositoryRoot,
  relativePath,
  label,
  errors,
  pathKind = "asset",
}) => {
  if (!safeRelativePath(relativePath)) {
    errors.push(
      `${label} has unsafe repository-relative path: ${String(relativePath)}`,
    );
    return null;
  }
  const absolutePath = resolve(repositoryRoot, relativePath);
  if (!staysInside(repositoryRoot, absolutePath)) {
    errors.push(
      `${label} has unsafe repository-relative path: ${relativePath}`,
    );
    return null;
  }
  if (!existsSync(absolutePath)) {
    errors.push(`missing required asset: ${relativePath}`);
    return null;
  }
  let actualPath;
  try {
    actualPath = realpathSync(absolutePath);
  } catch (error) {
    errors.push(`cannot resolve ${pathKind} ${relativePath}: ${error.message}`);
    return null;
  }
  const realRoot = realpathSync(repositoryRoot);
  if (!staysInside(realRoot, actualPath)) {
    errors.push(`${label} escapes repository through symlink: ${relativePath}`);
    return null;
  }
  let stats;
  try {
    stats = statSync(actualPath);
  } catch (error) {
    errors.push(`cannot stat ${pathKind} ${relativePath}: ${error.message}`);
    return null;
  }
  if (!stats.isFile()) {
    errors.push(`${relativePath} is not a regular file`);
    return null;
  }
  const bytes = readFileSync(actualPath);
  if (bytes.length === 0) {
    errors.push(`empty asset: ${relativePath}`);
    return null;
  }
  return { absolutePath: actualPath, bytes };
};

const parseSafeJsonSubset = (asset, relativePath, errors) => {
  if (!asset) return null;
  try {
    return JSON.parse(asset.bytes.toString("utf8"));
  } catch (error) {
    errors.push(`invalid safe YAML/JSON at ${relativePath}: ${error.message}`);
    return null;
  }
};

const getAssertionValue = (value, path) => {
  if (!/^\$\.[a-z_][a-z0-9_]*$/u.test(path)) return { found: false };
  const key = path.slice(2);
  if (!isRecord(value) || !Object.hasOwn(value, key)) return { found: false };
  return { found: true, value: value[key] };
};

const validateEvaluation = ({
  repositoryRoot,
  definition,
  expectedRequirementIds,
  errors,
}) => {
  const asset = readRepositoryAsset({
    repositoryRoot,
    relativePath: definition.path,
    label: definition.path,
    errors,
  });
  const evaluation = parseSafeJsonSubset(asset, definition.path, errors);
  if (!isRecord(evaluation)) {
    if (evaluation !== null)
      errors.push(`${definition.path} must contain an object`);
    return;
  }
  addUnknownKeyErrors(evaluation, EVAL_KEYS, definition.path, errors);
  if (evaluation.schema_version !== "1.0.0") {
    errors.push(`${definition.path} schema_version must be 1.0.0`);
  }
  if (evaluation.format !== "yaml-json-subset-v1") {
    errors.push(`${definition.path} format must be yaml-json-subset-v1`);
  }
  if (
    evaluation.domain !== definition.domain ||
    !nonEmptyString(evaluation.id)
  ) {
    errors.push(
      `${definition.path} identity does not match ${definition.domain}`,
    );
  }
  for (const duplicate of duplicates(evaluation.requirement_ids)) {
    errors.push(
      `${definition.path} has duplicate requirement link: ${duplicate}`,
    );
  }
  if (!sameStringSet(evaluation.requirement_ids, expectedRequirementIds)) {
    errors.push(
      `${definition.path} requirement_ids does not exactly match authority links`,
    );
  }

  if (!isRecord(evaluation.input)) {
    errors.push(`${definition.path} input must be an object`);
  } else {
    addUnknownKeyErrors(
      evaluation.input,
      INPUT_KEYS,
      `${definition.path} input`,
      errors,
    );
    const inputAsset = readRepositoryAsset({
      repositoryRoot,
      relativePath: evaluation.input.path,
      label: `${definition.path} input`,
      errors,
      pathKind: "input",
    });
    if (!SHA256_PATTERN.test(evaluation.input.sha256 ?? "")) {
      errors.push(
        `${definition.path} input sha256 must be a lowercase SHA-256`,
      );
    } else if (
      inputAsset &&
      sha256(inputAsset.bytes) !== evaluation.input.sha256
    ) {
      errors.push(
        `${definition.path} input checksum does not match ${evaluation.input.path}`,
      );
    }

    if (!isRecord(evaluation.grader)) {
      errors.push(`${definition.path} grader must be an object`);
    } else {
      addUnknownKeyErrors(
        evaluation.grader,
        GRADER_KEYS,
        `${definition.path} grader`,
        errors,
      );
      if (evaluation.grader.type !== "json_assertions_v1") {
        errors.push(
          `${definition.path} grader type must be json_assertions_v1`,
        );
      }
      if (
        !Array.isArray(evaluation.grader.assertions) ||
        evaluation.grader.assertions.length === 0
      ) {
        errors.push(`${definition.path} grader assertions must be non-empty`);
      } else if (inputAsset) {
        const fixture = parseSafeJsonSubset(
          inputAsset,
          evaluation.input.path,
          errors,
        );
        evaluation.grader.assertions.forEach((assertion, index) => {
          const label = `${definition.path} grader assertion ${index}`;
          if (!isRecord(assertion)) {
            errors.push(`${label} must be an object`);
            return;
          }
          addUnknownKeyErrors(assertion, ASSERTION_KEYS, label, errors);
          const actual = getAssertionValue(fixture, assertion.path);
          if (
            !actual.found ||
            JSON.stringify(actual.value) !== JSON.stringify(assertion.equals)
          ) {
            errors.push(
              `${definition.path} grader assertion failed at ${String(assertion.path)}`,
            );
          }
        });
      }
    }
  }

  if (
    !Array.isArray(evaluation.forbidden_effects) ||
    evaluation.forbidden_effects.length === 0
  ) {
    errors.push(`${definition.path} forbidden_effects must be non-empty`);
  } else if (!evaluation.forbidden_effects.every(nonEmptyString)) {
    errors.push(
      `${definition.path} forbidden_effects must contain non-empty strings`,
    );
  } else if (duplicates(evaluation.forbidden_effects).length > 0) {
    errors.push(`${definition.path} forbidden_effects contains duplicates`);
  }
  if (
    !Array.isArray(evaluation.evidence_fields) ||
    !REQUIRED_EVIDENCE_FIELDS.every((field) =>
      evaluation.evidence_fields.includes(field),
    )
  ) {
    const requiredFields = `${REQUIRED_EVIDENCE_FIELDS.slice(0, -1).join(", ")}, and ${REQUIRED_EVIDENCE_FIELDS.at(-1)}`;
    errors.push(
      `${definition.path} evidence_fields must include ${requiredFields}`,
    );
  }
};

const validateDataManifest = ({
  repositoryRoot,
  definition,
  mode,
  errors,
  warnings,
}) => {
  const asset = readRepositoryAsset({
    repositoryRoot,
    relativePath: definition.path,
    label: definition.path,
    errors,
  });
  const manifest = parseSafeJsonSubset(asset, definition.path, errors);
  if (!isRecord(manifest)) {
    if (manifest !== null)
      errors.push(`${definition.path} must contain an object`);
    return false;
  }
  addUnknownKeyErrors(manifest, DATA_ROOT_KEYS, definition.path, errors);
  if (
    manifest.schema_version !== "1.0.0" ||
    manifest.kind !== definition.kind
  ) {
    errors.push(`${definition.path} identity is invalid`);
  }
  if (!isRecord(manifest.dataset)) {
    errors.push(`${definition.path} dataset must be an object`);
    return false;
  }
  const dataset = manifest.dataset;
  addUnknownKeyErrors(
    dataset,
    definition.kind === "public-benchmarks"
      ? PUBLIC_DATASET_KEYS
      : DATASET_KEYS,
    `${definition.path} dataset`,
    errors,
  );
  if (!nonEmptyString(dataset.id))
    errors.push(`${definition.path} dataset id is invalid`);
  if (!nonEmptyString(dataset.license))
    errors.push(`${definition.path} dataset license is invalid`);
  if (!nonEmptyString(dataset.tenant))
    errors.push(`${definition.path} dataset tenant is invalid`);
  if (!isRecord(dataset.provenance)) {
    errors.push(`${definition.path} dataset provenance is invalid`);
  } else {
    addUnknownKeyErrors(
      dataset.provenance,
      PROVENANCE_KEYS,
      `${definition.path} dataset provenance`,
      errors,
    );
    if (
      !["publisher", "source_uri", "created_at", "purpose"].every((key) =>
        nonEmptyString(dataset.provenance[key]),
      )
    ) {
      errors.push(`${definition.path} dataset provenance is incomplete`);
    }
  }
  if (!isRecord(dataset.checksum)) {
    errors.push(`${definition.path} dataset checksum is invalid`);
  } else {
    addUnknownKeyErrors(
      dataset.checksum,
      CHECKSUM_KEYS,
      `${definition.path} dataset checksum`,
      errors,
    );
    if (dataset.checksum.algorithm !== "sha256") {
      errors.push(
        `${definition.path} dataset checksum algorithm must be sha256`,
      );
    }
  }

  const runnerAsset = readRepositoryAsset({
    repositoryRoot,
    relativePath: dataset.expected_runner,
    label: `${definition.path} expected_runner`,
    errors,
    pathKind: "expected_runner",
  });
  if (runnerAsset) {
    try {
      accessSync(runnerAsset.absolutePath, constants.X_OK);
    } catch {
      errors.push(
        `${definition.path} expected_runner is not executable: ${dataset.expected_runner}`,
      );
    }
  }

  if (definition.kind === "consented-staging") {
    addUnknownKeyErrors(
      manifest.external_contract,
      EXTERNAL_CONTRACT_KEYS,
      `${definition.path} external_contract`,
      errors,
    );
    const contract = manifest.external_contract;
    if (
      !isRecord(contract) ||
      !nonEmptyString(contract.required_environment) ||
      !Array.isArray(contract.required_fields) ||
      contract.required_fields.length === 0 ||
      contract.must_be_outside_repository !== true
    ) {
      errors.push(`${definition.path} external_contract is invalid`);
    }
    const unavailable =
      dataset.availability === "unavailable" &&
      dataset.path === null &&
      dataset.checksum?.value === null;
    if (!unavailable) {
      errors.push(
        `${definition.path} must remain unavailable until an authorized external manifest is supplied`,
      );
      return false;
    }
    const blocked =
      "consented-staging dataset is unavailable; release verification remains blocked";
    if (mode === "release") errors.push(blocked);
    else warnings.push(blocked);
    return false;
  }

  if (manifest.external_contract !== undefined) {
    errors.push(
      `${definition.path} external_contract is only valid for consented-staging`,
    );
  }
  if (definition.kind === "public-benchmarks") {
    const blocked =
      "public-benchmarks dataset is bootstrap-only; release verification remains blocked";
    if (
      dataset.availability !== "bootstrap-only" ||
      dataset.release_ready !== false
    ) {
      errors.push(
        `${definition.path} must remain bootstrap-only until a real public benchmark is approved`,
      );
    } else if (mode === "release") errors.push(blocked);
    else warnings.push(blocked);
  } else if (dataset.availability !== "available") {
    errors.push(`${definition.path} dataset availability must be available`);
  }
  const dataAsset = readRepositoryAsset({
    repositoryRoot,
    relativePath: dataset.path,
    label: `${definition.path} dataset path`,
    errors,
    pathKind: "dataset",
  });
  if (!SHA256_PATTERN.test(dataset.checksum?.value ?? "")) {
    errors.push(`${definition.path} dataset checksum is invalid`);
  } else if (dataAsset && sha256(dataAsset.bytes) !== dataset.checksum.value) {
    errors.push(
      `${definition.path} dataset checksum does not match ${dataset.path}`,
    );
  }
  return true;
};

const loadAuthorityLinks = (repositoryRoot, errors) => {
  const path = "verification/gates/phase2-gate.json";
  const asset = readRepositoryAsset({
    repositoryRoot,
    relativePath: path,
    label: path,
    errors,
  });
  const authority = parseSafeJsonSubset(asset, path, errors);
  const links = new Map(
    EVALUATIONS.map(({ path: evalPath }) => [evalPath, []]),
  );
  if (!isRecord(authority) || !Array.isArray(authority.requirements)) {
    errors.push(`${path} requirements are unavailable`);
    return links;
  }
  for (const requirement of authority.requirements) {
    if (
      !isRecord(requirement) ||
      !nonEmptyString(requirement.id) ||
      !Array.isArray(requirement.eval_suites)
    ) {
      errors.push(`${path} contains an invalid requirement eval mapping`);
      continue;
    }
    for (const evalPath of requirement.eval_suites) {
      if (!links.has(evalPath)) {
        errors.push(`${path} links unknown evaluation: ${String(evalPath)}`);
        continue;
      }
      links.get(evalPath).push(requirement.id);
    }
  }
  return links;
};

export const checkPhase2Assets = ({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  mode = "bootstrap",
} = {}) => {
  if (!new Set(["bootstrap", "release"]).has(mode)) {
    return {
      mode,
      errors: [`unsupported verification mode: ${String(mode)}`],
      warnings: [],
      releaseReady: false,
      evaluations: 0,
      dataManifests: 0,
      claims: { requirementsVerified: 0, evidencePassed: 0 },
    };
  }
  const root = resolve(repositoryRoot);
  const errors = [];
  const warnings = [];
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    errors.push(`repository root is not a directory: ${root}`);
    return {
      mode,
      errors,
      warnings,
      releaseReady: false,
      evaluations: 0,
      dataManifests: 0,
      claims: { requirementsVerified: 0, evidencePassed: 0 },
    };
  }

  const authorityLinks = loadAuthorityLinks(root, errors);
  for (const definition of EVALUATIONS) {
    validateEvaluation({
      repositoryRoot: root,
      definition,
      expectedRequirementIds: authorityLinks.get(definition.path) ?? [],
      errors,
    });
  }
  let stagingReady = false;
  for (const definition of DATA_MANIFESTS) {
    const ready = validateDataManifest({
      repositoryRoot: root,
      definition,
      mode,
      errors,
      warnings,
    });
    if (definition.kind === "consented-staging") stagingReady = ready;
  }

  return {
    mode,
    errors,
    warnings,
    releaseReady: errors.length === 0 && stagingReady,
    evaluations: EVALUATIONS.length,
    dataManifests: DATA_MANIFESTS.length,
    claims: { requirementsVerified: 0, evidencePassed: 0 },
  };
};

const parseArguments = (argv) => {
  let repositoryRoot = DEFAULT_REPOSITORY_ROOT;
  let mode = "bootstrap";
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--root") repositoryRoot = value;
    else if (flag === "--mode") mode = value;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return { repositoryRoot, mode };
};

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  let result;
  try {
    result = checkPhase2Assets(parseArguments(process.argv.slice(2)));
  } catch (error) {
    result = {
      mode: "unknown",
      errors: [error instanceof Error ? error.message : String(error)],
      warnings: [],
      releaseReady: false,
      evaluations: 0,
      dataManifests: 0,
      claims: { requirementsVerified: 0, evidencePassed: 0 },
    };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.errors.length === 0 ? 0 : 1;
}
