#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import { validatePhase2Manifest } from "./check-phase2-manifest.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY_ROOT = resolve(scriptDirectory, "../..");
export const SEMANTIC_STUB_MARKERS = Object.freeze([
  "PHASE2_ACTIVE_STUB",
  "PHASE2_NOT_IMPLEMENTED",
  "throw new NotImplementedError",
]);

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".rs"]);
const GLOBAL_RELEASE_RECEIPTS = [
  "manifest",
  "assets",
  "contract-drift",
  "active-stubs",
  "typecheck",
  "cycles",
  "build",
  "lint",
  "phase1-regression",
  "coverage",
  "mutation",
  "evaluations",
  "data",
  "package-smoke",
  "source-checkout-reproduction",
  "production-audit",
];
const EVIDENCE_KEYS = new Set([
  "requirement_id",
  "status",
  "bindings",
  "source_files",
  "test_files",
  "command_receipts",
]);
const RECEIPT_KEYS = new Set([
  "id",
  "status",
  "exitCode",
  "signal",
  "argv",
  "stdout_sha256",
  "stderr_sha256",
]);

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const parseStrictJson = (bytes, label) => {
  if (bytes.length > MAX_JSON_BYTES)
    throw new SyntaxError(`${label} exceeds byte limit`);
  const source = bytes.toString("utf8");
  let offset = 0;
  const fail = (message) => {
    throw new SyntaxError(`${label}: ${message} at byte ${offset}`);
  };
  const whitespace = () => {
    while (["\t", "\n", "\r", " "].includes(source[offset] ?? "")) offset += 1;
  };
  const string = () => {
    if (source[offset] !== '"') fail("expected string");
    offset += 1;
    let value = "";
    while (offset < source.length) {
      const character = source[offset++];
      if (character === '"') return value;
      if (character.charCodeAt(0) < 0x20) fail("unescaped control character");
      if (character !== "\\") {
        value += character;
        continue;
      }
      const escape = source[offset++];
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
      if (Object.hasOwn(simple, escape)) value += simple[escape];
      else if (escape === "u") {
        const hex = source.slice(offset, offset + 4);
        if (!/^[a-fA-F0-9]{4}$/u.test(hex)) fail("invalid unicode escape");
        value += String.fromCharCode(Number.parseInt(hex, 16));
        offset += 4;
      } else fail("invalid escape");
    }
    fail("unterminated string");
  };
  const value = (depth) => {
    if (depth > MAX_JSON_DEPTH) fail("nesting limit exceeded");
    whitespace();
    if (source[offset] === "{") {
      offset += 1;
      const result = Object.create(null);
      const keys = new Set();
      whitespace();
      if (source[offset] === "}") {
        offset += 1;
        return result;
      }
      while (offset < source.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) fail(`duplicate object key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        if (source[offset++] !== ":") fail("expected colon");
        result[key] = value(depth + 1);
        whitespace();
        if (source[offset] === "}") {
          offset += 1;
          return result;
        }
        if (source[offset++] !== ",") fail("expected comma or object end");
      }
      fail("unterminated object");
    }
    if (source[offset] === "[") {
      offset += 1;
      const result = [];
      whitespace();
      if (source[offset] === "]") {
        offset += 1;
        return result;
      }
      while (offset < source.length) {
        result.push(value(depth + 1));
        whitespace();
        if (source[offset] === "]") {
          offset += 1;
          return result;
        }
        if (source[offset++] !== ",") fail("expected comma or array end");
      }
      fail("unterminated array");
    }
    if (source[offset] === '"') return string();
    for (const [token, parsed] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ]) {
      if (source.startsWith(token, offset)) {
        offset += token.length;
        return parsed;
      }
    }
    const number = source
      .slice(offset)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)?.[0];
    if (number !== undefined) {
      offset += number.length;
      const parsed = Number(number);
      if (!Number.isFinite(parsed)) fail("non-finite number");
      return parsed;
    }
    fail("unexpected token");
  };
  const parsed = value(0);
  whitespace();
  if (offset !== source.length) fail("trailing content");
  return parsed;
};

const safeRelativePath = (path) =>
  typeof path === "string" &&
  path.length > 0 &&
  !isAbsolute(path) &&
  !path.split(/[\\/]/u).includes("..") &&
  path.split(/[\\/]/u).every(Boolean);

const staysInside = (root, candidate) => {
  const relation = relative(root, candidate);
  return (
    relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`))
  );
};

const securePath = (root, path, expectedKind, errors, label) => {
  if (!safeRelativePath(path)) {
    errors.push(`${label}: unsafe path ${String(path)}`);
    return null;
  }
  let current = root;
  for (const segment of path.split(/[\\/]/u)) {
    current = join(current, segment);
    if (!existsSync(current)) {
      errors.push(`${label}: missing path ${path}`);
      return null;
    }
    if (lstatSync(current).isSymbolicLink()) {
      errors.push(`${label}: symlink is forbidden in ${path}`);
      return null;
    }
  }
  const actualRoot = realpathSync(root);
  const actual = realpathSync(join(root, path));
  if (!staysInside(actualRoot, actual)) {
    errors.push(`${label}: path escapes repository ${path}`);
    return null;
  }
  const stats = statSync(actual);
  if (expectedKind === "file" && !stats.isFile())
    errors.push(`${label}: not a regular file ${path}`);
  if (expectedKind === "directory" && !stats.isDirectory())
    errors.push(`${label}: not a directory ${path}`);
  return actual;
};

const readStrictRepositoryJson = (root, path, errors, label) => {
  const actual = securePath(root, path, "file", errors, label);
  if (!actual) return null;
  try {
    return parseStrictJson(readFileSync(actual), label);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return null;
  }
};

const loadManifest = (root, errors) => {
  const manifest = readStrictRepositoryJson(
    root,
    "verification/gates/phase2-gate.json",
    errors,
    "Phase 2 authority",
  );
  if (manifest) errors.push(...validatePhase2Manifest(manifest));
  return manifest;
};

const semanticSourceFiles = (root, owner, errors) => {
  const directory = securePath(
    root,
    owner,
    "directory",
    errors,
    `owner ${owner}`,
  );
  if (!directory) return [];
  const result = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        errors.push(
          `owner ${owner}: symlink is forbidden in ${relative(root, child)}`,
        );
      } else if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && sourceExtensions.has(extname(entry.name)))
        result.push(child);
    }
  };
  visit(directory);
  return result;
};

const emptyResult = (errors, activeRequirementIds = []) => ({
  errors,
  activeRequirementIds,
  semanticStubFiles: [],
  releaseReady: false,
  claims: { requirementsVerified: 0, evidencePassed: 0 },
});

export const scanActivePhase2Stubs = ({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
} = {}) => {
  const root = resolve(repositoryRoot);
  const errors = [];
  const manifest = loadManifest(root, errors);
  if (!manifest?.requirements) return emptyResult(errors);
  const active = new Set();
  const semanticStubFiles = [];
  const owners = new Map();
  for (const requirement of manifest.requirements) {
    const requirementErrors = [];
    securePath(
      root,
      requirement.owner,
      "directory",
      requirementErrors,
      requirement.id,
    );
    for (const suite of requirement.test_suites ?? []) {
      securePath(root, suite, "file", requirementErrors, requirement.id);
    }
    if (requirementErrors.length > 0) active.add(requirement.id);
    errors.push(...requirementErrors);
    const ownerRequirements = owners.get(requirement.owner) ?? [];
    ownerRequirements.push(requirement.id);
    owners.set(requirement.owner, ownerRequirements);
  }
  for (const [owner, requirementIds] of owners) {
    const ownerErrors = [];
    for (const file of semanticSourceFiles(root, owner, ownerErrors)) {
      const contents = readFileSync(file, "utf8");
      if (SEMANTIC_STUB_MARKERS.some((marker) => contents.includes(marker))) {
        semanticStubFiles.push(relative(root, file).replaceAll("\\", "/"));
        requirementIds.forEach((id) => active.add(id));
      }
    }
    errors.push(...ownerErrors);
  }
  errors.push(
    ...semanticStubFiles.map(
      (file) => `explicit active stub marker in ${file}`,
    ),
  );
  return {
    errors,
    activeRequirementIds: [...active],
    semanticStubFiles,
    releaseReady: false,
    claims: { requirementsVerified: 0, evidencePassed: 0 },
  };
};

const normalizedReceipt = (result) => ({
  id: result?.id,
  status: result?.status,
  exitCode: result?.exitCode,
  signal: result?.signal,
  argv: result?.argv,
  stdout_sha256: result?.stdout?.sha256,
  stderr_sha256: result?.stderr?.sha256,
});

const requiredReceiptIds = (requirement) => {
  const ids = new Set(GLOBAL_RELEASE_RECEIPTS);
  for (const suite of requirement.test_suites ?? []) {
    const category = suite.split("/")[2];
    if (["unit", "integration", "security", "e2e"].includes(category))
      ids.add(`phase2-${category}`);
  }
  return [...ids];
};

const validateEvidence = ({
  root,
  requirement,
  currentBindings,
  resultsById,
  errors,
}) => {
  const evidence = readStrictRepositoryJson(
    root,
    requirement.evidence_path,
    errors,
    `${requirement.id} evidence`,
  );
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence))
    return false;
  for (const key of Object.keys(evidence)) {
    if (!EVIDENCE_KEYS.has(key))
      errors.push(`${requirement.id}: unknown evidence field ${key}`);
  }
  if (
    evidence.requirement_id !== requirement.id ||
    evidence.status !== "verified"
  ) {
    errors.push(`${requirement.id}: evidence identity/status is invalid`);
  }
  if (stableJson(evidence.bindings) !== stableJson(currentBindings)) {
    errors.push(
      `${requirement.id}: evidence bindings do not match current release bindings`,
    );
  }
  if (
    !Array.isArray(evidence.source_files) ||
    evidence.source_files.length === 0
  ) {
    errors.push(`${requirement.id}: source_files must be non-empty`);
  } else {
    for (const path of evidence.source_files) {
      if (
        typeof path !== "string" ||
        !path.startsWith(`${requirement.owner}/`)
      ) {
        errors.push(
          `${requirement.id}: source file is outside owner ${String(path)}`,
        );
      } else securePath(root, path, "file", errors, requirement.id);
    }
  }
  if (
    stableJson([...(evidence.test_files ?? [])].sort()) !==
    stableJson([...requirement.test_suites].sort())
  ) {
    errors.push(
      `${requirement.id}: test_files must exactly match required suites`,
    );
  }
  for (const suite of requirement.test_suites)
    securePath(root, suite, "file", errors, requirement.id);

  const receipts = new Map();
  if (!Array.isArray(evidence.command_receipts)) {
    errors.push(`${requirement.id}: command_receipts must be an array`);
  } else {
    for (const receipt of evidence.command_receipts) {
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
        continue;
      for (const key of Object.keys(receipt)) {
        if (!RECEIPT_KEYS.has(key))
          errors.push(`${requirement.id}: unknown receipt field ${key}`);
      }
      if (receipts.has(receipt.id))
        errors.push(
          `${requirement.id}: duplicate receipt ${String(receipt.id)}`,
        );
      receipts.set(receipt.id, receipt);
    }
  }
  for (const id of requiredReceiptIds(requirement)) {
    const actual = resultsById.get(id);
    const received = receipts.get(id);
    if (
      !actual ||
      actual.status !== "passed" ||
      actual.exitCode !== 0 ||
      actual.signal !== null
    ) {
      errors.push(
        `${requirement.id}: required command result is not a clean pass: ${id}`,
      );
    } else if (stableJson(received) !== stableJson(normalizedReceipt(actual))) {
      errors.push(
        `${requirement.id}: receipt ${id} does not match this gate run`,
      );
    }
  }
  return errors.length === 0;
};

export const checkActivePhase2Stubs = ({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  currentBindings,
  commandResults,
} = {}) => {
  const root = resolve(repositoryRoot);
  const scan = scanActivePhase2Stubs({ repositoryRoot: root });
  if (!currentBindings || !Array.isArray(commandResults)) {
    return emptyResult(
      [
        ...scan.errors,
        "release Evidence validation requires current bindings and command results",
      ],
      scan.activeRequirementIds,
    );
  }
  const errors = [...scan.errors];
  const manifest = loadManifest(root, errors);
  if (!manifest?.requirements)
    return emptyResult(errors, scan.activeRequirementIds);
  const resultsById = new Map(
    commandResults.map((result) => [result?.id, result]),
  );
  const active = new Set(scan.activeRequirementIds);
  let evidencePassed = 0;
  for (const requirement of manifest.requirements) {
    const requirementErrors = [];
    const passed = validateEvidence({
      root,
      requirement,
      currentBindings,
      resultsById,
      errors: requirementErrors,
    });
    if (!passed || requirementErrors.length > 0) active.add(requirement.id);
    else evidencePassed += 1;
    errors.push(...requirementErrors);
  }
  const releaseReady =
    errors.length === 0 &&
    active.size === 0 &&
    evidencePassed === manifest.requirements.length;
  return {
    errors,
    activeRequirementIds: [...active],
    semanticStubFiles: scan.semanticStubFiles,
    releaseReady,
    claims: releaseReady
      ? { requirementsVerified: evidencePassed, evidencePassed }
      : { requirementsVerified: 0, evidencePassed: 0 },
  };
};

const parseArguments = (argv) => {
  let repositoryRoot = DEFAULT_REPOSITORY_ROOT;
  let mode = "scan";
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index] === "--root") repositoryRoot = argv[index + 1];
    else if (argv[index] === "--mode") mode = argv[index + 1];
    else throw new Error(`unknown argument ${String(argv[index])}`);
  }
  if (mode !== "scan")
    throw new Error(
      "CLI only supports --mode scan; release validation requires in-process bindings/results",
    );
  return { repositoryRoot };
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
    result = scanActivePhase2Stubs(parseArguments(process.argv.slice(2)));
  } catch (error) {
    result = emptyResult([
      error instanceof Error ? error.message : String(error),
    ]);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.errors.length === 0 ? 0 : 1;
}
