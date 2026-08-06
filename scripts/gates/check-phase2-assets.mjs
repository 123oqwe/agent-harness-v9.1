#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  constants,
  accessSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { validatePhase2Manifest } from "./check-phase2-manifest.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY_ROOT = resolve(scriptDirectory, "../..");
const DEFAULT_FILE_SYSTEM = {
  accessSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
};
const MAX_JSON_BYTES = 1_048_576;
const MAX_JSON_DEPTH = 64;

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
  "execution_runner_status",
]);
const DATASET_KEYS = new Set([
  "id",
  "availability",
  "provenance",
  "license",
  "checksum",
  "path",
  "tenant",
  "contract_checker",
]);
const PUBLIC_DATASET_KEYS = new Set([...DATASET_KEYS, "release_ready"]);
const CONTRACT_CHECKER_KEYS = new Set(["path", "sha256", "role"]);
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
const REQUIRED_FORBIDDEN_EFFECTS = {
  coding: ["requirement_verified", "evidence_pass", "external_side_effect"],
  documents: ["requirement_verified", "evidence_pass", "external_side_effect"],
  research: [
    "requirement_verified",
    "evidence_pass",
    "external_side_effect",
    "network_request",
  ],
  writing: ["requirement_verified", "evidence_pass", "external_side_effect"],
  planning: ["requirement_verified", "evidence_pass", "external_side_effect"],
  "personal-assistant": [
    "requirement_verified",
    "evidence_pass",
    "external_side_effect",
    "human_ticket",
  ],
  multimodal: [
    "requirement_verified",
    "evidence_pass",
    "external_side_effect",
    "media_generation",
  ],
};
const FORBIDDEN_EFFECT_VOCABULARY = new Set(
  Object.values(REQUIRED_FORBIDDEN_EFFECTS).flat(),
);
const LICENSE_BY_DATA_KIND = {
  synthetic: "CC0-1.0",
  "public-benchmarks": "CC0-1.0",
  "consented-staging": "CONSENT-REQUIRED",
};
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
  fileSystem,
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
  const validateComponents = () => {
    let currentPath = repositoryRoot;
    const traversed = [];
    for (const segment of relativePath.split(/[\\/]/u)) {
      traversed.push(segment);
      currentPath = resolve(currentPath, segment);
      let component;
      try {
        component = fileSystem.lstatSync(currentPath);
      } catch {
        errors.push(`missing required asset: ${relativePath}`);
        return false;
      }
      if (component.isSymbolicLink()) {
        errors.push(
          `${label} contains forbidden symlink: ${traversed.join("/")}`,
        );
        return false;
      }
    }
    return true;
  };

  const validateOpenedPath = (fdStats) => {
    if (!validateComponents()) return null;
    let actualPath;
    let pathStats;
    try {
      actualPath = fileSystem.realpathSync(absolutePath);
      pathStats = fileSystem.statSync(absolutePath);
    } catch (error) {
      errors.push(
        `cannot revalidate ${pathKind} ${relativePath}: ${error.message}`,
      );
      return null;
    }
    const realRoot = fileSystem.realpathSync(repositoryRoot);
    if (!staysInside(realRoot, actualPath)) {
      errors.push(`${label} escapes repository: ${relativePath}`);
      return null;
    }
    if (pathStats.dev !== fdStats.dev || pathStats.ino !== fdStats.ino) {
      errors.push(`${label} changed during secure read: ${relativePath}`);
      return null;
    }
    return actualPath;
  };

  if (!validateComponents()) return null;
  let descriptor;
  try {
    descriptor = fileSystem.openSync(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    errors.push(
      `cannot securely open ${pathKind} ${relativePath}: ${error.message}`,
    );
    return null;
  }
  try {
    const descriptorStats = fileSystem.fstatSync(descriptor);
    if (!descriptorStats.isFile()) {
      errors.push(`${relativePath} is not a regular file`);
      return null;
    }
    let actualPath = validateOpenedPath(descriptorStats);
    if (!actualPath) return null;
    const bytes = fileSystem.readFileSync(descriptor);
    actualPath = validateOpenedPath(descriptorStats);
    if (!actualPath) return null;
    if (bytes.length === 0) {
      errors.push(`empty asset: ${relativePath}`);
      return null;
    }
    return {
      absolutePath: actualPath,
      bytes,
      mode: descriptorStats.mode,
    };
  } catch (error) {
    errors.push(
      `cannot securely read ${pathKind} ${relativePath}: ${error.message}`,
    );
    return null;
  } finally {
    try {
      fileSystem.closeSync(descriptor);
    } catch (error) {
      errors.push(`cannot close ${pathKind} ${relativePath}: ${error.message}`);
    }
  }
};

const parseStrictJsonSubset = (source) => {
  let offset = 0;
  const fail = (message) => {
    throw new SyntaxError(`${message} at byte ${offset}`);
  };
  const whitespace = () => {
    while (["\t", "\n", "\r", " "].includes(source[offset] ?? "")) offset += 1;
  };
  const parseString = () => {
    if (source[offset] !== '"') fail("expected string");
    offset += 1;
    let value = "";
    while (offset < source.length) {
      const character = source[offset];
      offset += 1;
      if (character === '"') return value;
      if (character.charCodeAt(0) < 0x20) fail("unescaped control character");
      if (character !== "\\") {
        value += character;
        continue;
      }
      const escape = source[offset];
      offset += 1;
      const simple = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      if (Object.hasOwn(simple, escape)) {
        value += simple[escape];
      } else if (escape === "u") {
        const hex = source.slice(offset, offset + 4);
        if (!/^[a-fA-F0-9]{4}$/u.test(hex)) fail("invalid unicode escape");
        value += String.fromCharCode(Number.parseInt(hex, 16));
        offset += 4;
      } else fail("invalid string escape");
    }
    fail("unterminated string");
  };
  const parseValue = (depth) => {
    if (depth > MAX_JSON_DEPTH) {
      fail(`JSON nesting exceeds ${MAX_JSON_DEPTH}`);
    }
    whitespace();
    if (source[offset] === "{") {
      offset += 1;
      const object = Object.create(null);
      const keys = new Set();
      whitespace();
      if (source[offset] === "}") {
        offset += 1;
        return object;
      }
      while (offset < source.length) {
        whitespace();
        const key = parseString();
        if (keys.has(key)) fail(`duplicate object key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        if (source[offset] !== ":") fail("expected colon");
        offset += 1;
        object[key] = parseValue(depth + 1);
        whitespace();
        if (source[offset] === "}") {
          offset += 1;
          return object;
        }
        if (source[offset] !== ",") fail("expected comma or object end");
        offset += 1;
      }
      fail("unterminated object");
    }
    if (source[offset] === "[") {
      offset += 1;
      const array = [];
      whitespace();
      if (source[offset] === "]") {
        offset += 1;
        return array;
      }
      while (offset < source.length) {
        array.push(parseValue(depth + 1));
        whitespace();
        if (source[offset] === "]") {
          offset += 1;
          return array;
        }
        if (source[offset] !== ",") fail("expected comma or array end");
        offset += 1;
      }
      fail("unterminated array");
    }
    if (source[offset] === '"') return parseString();
    for (const [token, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ]) {
      if (source.startsWith(token, offset)) {
        offset += token.length;
        return value;
      }
    }
    const number = source
      .slice(offset)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)?.[0];
    if (number !== undefined) {
      offset += number.length;
      const value = Number(number);
      if (!Number.isFinite(value)) fail("non-finite number");
      return value;
    }
    fail("unexpected JSON token");
  };
  const value = parseValue(0);
  whitespace();
  if (offset !== source.length) fail("unexpected trailing content");
  return value;
};

const parseSafeJsonSubset = (asset, relativePath, errors) => {
  if (!asset) return null;
  try {
    if (asset.bytes.length > MAX_JSON_BYTES) {
      throw new SyntaxError(`asset exceeds ${MAX_JSON_BYTES} byte limit`);
    }
    return parseStrictJsonSubset(asset.bytes.toString("utf8"));
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
  fileSystem,
  repositoryRoot,
  definition,
  expectedRequirementIds,
  errors,
}) => {
  const asset = readRepositoryAsset({
    fileSystem,
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
  if (
    expectedRequirementIds !== null &&
    !sameStringSet(evaluation.requirement_ids, expectedRequirementIds)
  ) {
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
      fileSystem,
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
  } else {
    for (const duplicate of duplicates(evaluation.forbidden_effects)) {
      errors.push(
        `${definition.path} forbidden_effects has duplicate value: ${duplicate}`,
      );
    }
    for (const effect of evaluation.forbidden_effects) {
      if (!FORBIDDEN_EFFECT_VOCABULARY.has(effect)) {
        errors.push(
          `${definition.path} forbidden_effects has unknown value: ${effect}`,
        );
      }
    }
    for (const required of REQUIRED_FORBIDDEN_EFFECTS[definition.domain]) {
      if (!evaluation.forbidden_effects.includes(required)) {
        errors.push(
          `${definition.path} forbidden_effects is missing required value: ${required}`,
        );
      }
    }
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
  if (Array.isArray(evaluation.evidence_fields)) {
    for (const duplicate of duplicates(evaluation.evidence_fields)) {
      errors.push(
        `${definition.path} evidence_fields has duplicate value: ${duplicate}`,
      );
    }
    for (const field of evaluation.evidence_fields) {
      if (!REQUIRED_EVIDENCE_FIELDS.includes(field)) {
        errors.push(
          `${definition.path} evidence_fields has unknown value: ${String(field)}`,
        );
      }
    }
  }
};

const validateDataManifest = ({
  fileSystem,
  repositoryRoot,
  definition,
  mode,
  errors,
  warnings,
}) => {
  const asset = readRepositoryAsset({
    fileSystem,
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
  if (
    manifest.execution_runner_status !== "not_implemented" &&
    manifest.execution_runner_status !== "implemented"
  ) {
    errors.push(
      `${definition.path} execution_runner_status must be not_implemented or implemented`,
    );
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
  if (dataset.license !== LICENSE_BY_DATA_KIND[definition.kind]) {
    errors.push(
      `${definition.path} dataset license must be ${LICENSE_BY_DATA_KIND[definition.kind]}`,
    );
  }
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

  const contractChecker = dataset.contract_checker;
  if (!isRecord(contractChecker)) {
    errors.push(`${definition.path} contract_checker must be an object`);
  } else {
    addUnknownKeyErrors(
      contractChecker,
      CONTRACT_CHECKER_KEYS,
      `${definition.path} contract_checker`,
      errors,
    );
    const expectedCheckerPath = "scripts/gates/check-phase2-assets.mjs";
    if (contractChecker.path !== expectedCheckerPath) {
      errors.push(
        `${definition.path} contract_checker path must be ${expectedCheckerPath}`,
      );
    }
    if (contractChecker.role !== "asset-contract-validator") {
      errors.push(
        `${definition.path} contract_checker role must be asset-contract-validator`,
      );
    }
    const checkerAsset = readRepositoryAsset({
      fileSystem,
      repositoryRoot,
      relativePath: contractChecker.path,
      label: `${definition.path} contract_checker`,
      errors,
      pathKind: "contract_checker",
    });
    if (!SHA256_PATTERN.test(contractChecker.sha256 ?? "")) {
      errors.push(`${definition.path} contract_checker sha256 is invalid`);
    } else if (
      checkerAsset &&
      sha256(checkerAsset.bytes) !== contractChecker.sha256
    ) {
      errors.push(
        `${definition.path} contract_checker sha256 does not match checker bytes`,
      );
    }
    if (checkerAsset) {
      let executable = (checkerAsset.mode & 0o111) !== 0;
      try {
        fileSystem.accessSync(checkerAsset.absolutePath, constants.X_OK);
      } catch {
        executable = false;
      }
      if (!executable) {
        errors.push(
          `${definition.path} contract_checker is not executable: ${contractChecker.path}`,
        );
      }
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
    return mode === "local";
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
  } else if (dataset.availability !== "available" && mode !== "local") {
    errors.push(`${definition.path} dataset availability must be available`);
  }
  const dataAsset = readRepositoryAsset({
    fileSystem,
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

const loadAuthorityLinks = (fileSystem, repositoryRoot, errors) => {
  const path = "verification/gates/phase2-gate.json";
  const asset = readRepositoryAsset({
    fileSystem,
    repositoryRoot,
    relativePath: path,
    label: path,
    errors,
  });
  const authority = parseSafeJsonSubset(asset, path, errors);
  if (!isRecord(authority) || !Array.isArray(authority.requirements)) {
    errors.push(`${path} requirements are unavailable`);
    return null;
  }
  const authorityErrors = validatePhase2Manifest(authority);
  if (authorityErrors.length > 0) {
    errors.push(
      ...authorityErrors.map(
        (error) => `invalid frozen Phase 2 authority: ${error}`,
      ),
    );
    return null;
  }
  const links = new Map(
    EVALUATIONS.map(({ path: evalPath }) => [evalPath, []]),
  );
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
  fileSystem: fileSystemOverrides = {},
} = {}) => {
  if (!new Set(["bootstrap", "release", "local"]).has(mode)) {
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
  const fileSystem = { ...DEFAULT_FILE_SYSTEM, ...fileSystemOverrides };
  const errors = [];
  const warnings = [];
  if (
    !fileSystem.existsSync(root) ||
    !fileSystem.lstatSync(root).isDirectory()
  ) {
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

  const authorityLinks = loadAuthorityLinks(fileSystem, root, errors);
  for (const definition of EVALUATIONS) {
    validateEvaluation({
      fileSystem,
      repositoryRoot: root,
      definition,
      expectedRequirementIds: authorityLinks?.get(definition.path) ?? null,
      errors,
    });
  }
  let stagingReady = false;
  for (const definition of DATA_MANIFESTS) {
    const ready = validateDataManifest({
      fileSystem,
      repositoryRoot: root,
      definition,
      mode,
      errors,
      warnings,
    });
    if (definition.kind === "consented-staging") stagingReady = ready;
  }

  const notImplementedKinds = [];
  for (const definition of DATA_MANIFESTS) {
    try {
      const manifestPath = join(repositoryRoot, definition.path);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.execution_runner_status !== "implemented") {
        notImplementedKinds.push(definition);
      }
    } catch {
      notImplementedKinds.push(definition);
    }
  }
  if (mode === "release" && notImplementedKinds.length > 0) {
    for (const definition of notImplementedKinds) {
      errors.push(
        `${definition.path} execution_runner_status is not_implemented; release verification remains blocked`,
      );
    }
  } else if (notImplementedKinds.length > 0) {
    for (const definition of notImplementedKinds) {
      warnings.push(
        `${definition.path} execution_runner_status is not_implemented; release verification remains blocked`,
      );
    }
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
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (seen.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    seen.add(flag);
    if (flag === "--root") repositoryRoot = value;
    else if (flag === "--mode") mode = value;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return { repositoryRoot, mode };
};

const isMain = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(resolve(process.argv[1]))
    );
  } catch {
    return false;
  }
})();

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
