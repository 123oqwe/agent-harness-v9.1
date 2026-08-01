#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_SCHEMA_VERSION = "1.0.0";
const EXPECTED_PHASE = 2;
const EXPECTED_REPOSITORY = "https://github.com/123oqwe/agentharness91.git";
const EXPECTED_SHA = "bf5eac648527205603de7d26278276ad78819850";
const EXPECTED_EVIDENCE_ROOT = "artifacts/phase-2";
const EXPECTED_REQUIREMENT_COUNT = 64;
export const AUTHORITY_CANONICAL_SHA256 =
  "bcdaeb0b3339c60f89bd7e43843ada27a765ae9a605280b541cbfbe71ae0ba2a";

const ROOT_KEYS = new Set([
  "schema_version",
  "phase",
  "baseline",
  "evidence_root",
  "mutation_thresholds",
  "phase1_prerequisites",
  "requirements",
]);
const BASELINE_KEYS = new Set(["repository", "sha"]);
const MUTATION_THRESHOLD_KEYS = new Set(["critical", "core"]);
const REQUIREMENT_KEYS = new Set([
  "id",
  "priority",
  "dependencies",
  "owner",
  "test_suites",
  "eval_suites",
  "evidence_path",
  "mutation_class",
]);

const REQUIRED_REQUIREMENT_IDS = [
  "AH-CONTEXT-COMPILER-001",
  "AH-DOC-INGEST-DOCX-001",
  "AH-DOC-INGEST-ENC-001",
  "AH-DOC-INGEST-IMG-001",
  "AH-DOC-INGEST-MD-001",
  "AH-DOC-INGEST-PDF-001",
  "AH-DOC-INGEST-PPTX-001",
  "AH-DOC-INGEST-UNSUPPORTED-001",
  "AH-DOC-INGEST-WEB-001",
  "AH-DOC-INGEST-XLSX-001",
  "AH-DOC-PARSE-HEAD-001",
  "AH-DOC-PARSE-IMGREF-001",
  "AH-DOC-PARSE-PROVENANCE-001",
  "AH-DOC-PARSE-TABLE-001",
  "AH-HOOK-001",
  "AH-MCP-STDIO-001",
  "AH-MM-ARTIFACT-001",
  "AH-MM-DOC-VISION-001",
  "AH-MM-IMAGE-EDIT-001",
  "AH-MM-IMAGE-GEN-001",
  "AH-MM-IMAGE-IN-001",
  "AH-MM-VISION-VERIFY-001",
  "AH-PAUSE-RESUME-001",
  "AH-SANDBOX-OCI-001",
  "AH-RAG-CHUNK-001",
  "AH-RAG-CITE-001",
  "AH-RAG-DELETE-001",
  "AH-RAG-EMBED-001",
  "AH-RAG-EMBED-MIG-001",
  "AH-RAG-FTS-001",
  "AH-RAG-GRAPH-001",
  "AH-RAG-INJECTION-001",
  "AH-RAG-META-001",
  "AH-RAG-QUERY-001",
  "AH-RAG-RERANK-001",
  "AH-RUNTIME-BUDGET-002",
  "AH-RUNTIME-COMPACTION-001",
  "AH-RUNTIME-MODELFALLBACK-001",
  "AH-RUNTIME-SESSIONTREE-001",
  "AH-RUNTIME-STEERING-001",
  "AH-TOOL-BEHAVIOR-VERIFY-001",
  "AH-TOOL-IMAGE-GEN-001",
  "AH-TOOL-SPEECH-GEN-001",
  "AH-TOOL-TRANSCRIBE-001",
  "AH-TOOL-SPREADSHEET-001",
  "AH-TOOL-PRESENTATION-001",
  "AH-TOOL-DOCUMENT-001",
  "AH-TOOL-OCR-001",
  "AH-TOOL-ESCALATE-001",
  "AH-TOOL-WEB-FETCH-001",
  "AH-TOOL-WEB-SEARCH-001",
  "AH-UI-DOC-001",
  "AH-UI-MM-001",
  "AH-UI-NOTIFY-001",
  "AH-UI-PLANNING-001",
  "AH-UI-RECONCILE-001",
  "AH-UI-RESEARCH-001",
  "AH-UI-TUI-001",
  "AH-UI-WRITING-001",
  "AH-UX-API-001",
  "AH-UX-CONTRACT-001",
  "AH-UX-DESKTOP-001",
  "AH-UX-STATES-001",
  "AH-UX-WEB-001",
];

const REQUIRED_PHASE1_PREREQUISITES = [
  "AH-CAPMAP-020",
  "AH-CONTRACT-EFFECTRISK-001",
  "AH-CONTRACT-TOOLSPEC-001",
  "AH-DOC-VERTICAL-001",
  "AH-EVIDENCE-001",
  "AH-PA-VERTICAL-001",
  "AH-PLANNING-VERTICAL-001",
  "AH-POLICY-ENGINE-001",
  "AH-RESEARCH-VERTICAL-001",
  "AH-RUNTIME-LOOP-001",
  "AH-RUNTIME-SESSION-001",
  "AH-SANDBOX-001",
  "AH-STATE-EXTERNAL-001",
  "AH-TOOL-READ-001",
  "AH-UI-CHAT-001",
  "AH-VFS-001",
  "AH-WRITING-VERTICAL-001",
];

const ALLOWED_OWNERS = new Set([
  "packages/context",
  "packages/documents",
  "packages/rag",
  "packages/multimodal",
  "packages/tool-fabric",
  "packages/api",
  "packages/ui",
  "apps/api",
  "apps/web",
  "apps/desktop",
  "apps/tui",
]);

const TEST_SUITE_PATTERN =
  /^tests\/phase-2\/(?:unit|integration|e2e|security)\/[a-z0-9]+(?:-[a-z0-9]+)*\.test\.ts$/;

const ALLOWED_EVAL_SUITES = new Set(
  [
    "coding",
    "documents",
    "research",
    "writing",
    "planning",
    "personal-assistant",
    "multimodal",
  ].map((domain) => `evals/${domain}/phase-2.yaml`),
);

const PERSONAL_ASSISTANT_EVAL = "evals/personal-assistant/phase-2.yaml";
const PA_CLOSED_LOOP_REQUIREMENTS = [
  "AH-PAUSE-RESUME-001",
  "AH-TOOL-ESCALATE-001",
  "AH-UI-NOTIFY-001",
  "AH-UI-PLANNING-001",
  "AH-UI-RECONCILE-001",
];

const REQUIRED_EDGES = {
  "AH-DOC-INGEST-WEB-001": ["AH-TOOL-WEB-FETCH-001"],
  "AH-RAG-QUERY-001": ["AH-RAG-FTS-001", "AH-RAG-EMBED-001", "AH-RAG-META-001"],
  "AH-RAG-DELETE-001": [
    "AH-RAG-FTS-001",
    "AH-RAG-EMBED-001",
    "AH-RAG-META-001",
    "AH-RAG-GRAPH-001",
  ],
  "AH-RUNTIME-COMPACTION-001": ["AH-HOOK-001"],
  "AH-TOOL-ESCALATE-001": [
    "AH-CONTRACT-TOOLSPEC-001",
    "AH-POLICY-ENGINE-001",
    "AH-CAPMAP-020",
    "AH-PAUSE-RESUME-001",
  ],
  "AH-UI-DOC-001": [
    "AH-UX-WEB-001",
    "AH-UX-CONTRACT-001",
    "AH-DOC-VERTICAL-001",
  ],
  "AH-UI-MM-001": ["AH-UX-WEB-001", "AH-UX-CONTRACT-001", "AH-MM-ARTIFACT-001"],
  "AH-UI-NOTIFY-001": [
    "AH-UX-WEB-001",
    "AH-UX-CONTRACT-001",
    "AH-CAPMAP-020",
    "AH-TOOL-ESCALATE-001",
  ],
  "AH-UI-PLANNING-001": [
    "AH-UX-WEB-001",
    "AH-UX-CONTRACT-001",
    "AH-PLANNING-VERTICAL-001",
    "AH-PA-VERTICAL-001",
  ],
  "AH-UI-RECONCILE-001": [
    "AH-UX-WEB-001",
    "AH-UX-CONTRACT-001",
    "AH-PAUSE-RESUME-001",
  ],
  "AH-UI-RESEARCH-001": [
    "AH-UX-WEB-001",
    "AH-UX-CONTRACT-001",
    "AH-RESEARCH-VERTICAL-001",
  ],
  "AH-UI-WRITING-001": [
    "AH-UX-WEB-001",
    "AH-UX-CONTRACT-001",
    "AH-WRITING-VERTICAL-001",
  ],
  "AH-UI-TUI-001": [
    "AH-UI-CHAT-001",
    "AH-UX-API-001",
    "AH-UX-CONTRACT-001",
    "AH-RUNTIME-STEERING-001",
  ],
  "AH-UX-STATES-001": [
    "AH-UX-WEB-001",
    "AH-UI-DOC-001",
    "AH-UI-MM-001",
    "AH-UI-NOTIFY-001",
    "AH-UI-PLANNING-001",
    "AH-UI-RECONCILE-001",
    "AH-UI-RESEARCH-001",
    "AH-UI-WRITING-001",
    "AH-UI-TUI-001",
  ],
};

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MANIFEST_PATH = resolve(
  scriptDirectory,
  "../../verification/gates/phase2-gate.json",
);

const display = (value) =>
  value === undefined ? "undefined" : JSON.stringify(value);

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isPlainObject = (value) => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export class CanonicalJsonError extends TypeError {
  constructor(message, options) {
    super(message, options);
    this.name = "CanonicalJsonError";
    this.code = "ERR_INVALID_CANONICAL_JSON";
  }
}

const childPath = (path, key) =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;

const stableErrorMessage = (error) => {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown validation error";
  }
};

const dataDescriptorValue = (value, key, path) => {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    throw new CanonicalJsonError(`missing property descriptor at ${path}`);
  }
  if ("get" in descriptor || "set" in descriptor) {
    throw new CanonicalJsonError(`accessor property at ${path}`);
  }
  if (!descriptor.enumerable) {
    throw new CanonicalJsonError(`non-enumerable property at ${path}`);
  }
  return descriptor.value;
};

const canonicalJson = (value, path = "$", ancestors = new Set()) => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError(
        `non-finite number ${String(value)} at ${path}`,
      );
    }
    return JSON.stringify(value);
  }
  if (["undefined", "bigint", "function", "symbol"].includes(typeof value)) {
    throw new CanonicalJsonError(`unsupported ${typeof value} at ${path}`);
  }

  if (ancestors.has(value)) {
    throw new CanonicalJsonError(`circular reference at ${path}`);
  }
  ancestors.add(value);

  if (Array.isArray(value)) {
    try {
      const descriptors = new Map();
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === "symbol") {
          throw new CanonicalJsonError(`unsupported symbol key at ${path}`);
        }
        if (key === "length") continue;
        const keyPath = childPath(path, key);
        const descriptorValue = dataDescriptorValue(value, key, keyPath);
        const index = Number(key);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          String(index) !== key ||
          index >= value.length
        ) {
          throw new CanonicalJsonError(
            `unsupported array property ${key} at ${path}`,
          );
        }
        descriptors.set(index, descriptorValue);
      }

      const entries = [];
      for (let index = 0; index < value.length; index += 1) {
        const entryPath = `${path}[${index}]`;
        if (!descriptors.has(index)) {
          throw new CanonicalJsonError(`unsupported undefined at ${entryPath}`);
        }
        entries.push(
          canonicalJson(descriptors.get(index), entryPath, ancestors),
        );
      }
      return `[${entries.join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }

  if (!isPlainObject(value)) {
    ancestors.delete(value);
    const constructorName = value?.constructor?.name ?? "unknown";
    throw new CanonicalJsonError(
      `non-plain object ${constructorName} at ${path}`,
    );
  }

  try {
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (typeof key === "symbol") {
        throw new CanonicalJsonError(`unsupported symbol key at ${path}`);
      }
    }
    return `{${keys
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(
            dataDescriptorValue(value, key, childPath(path, key)),
            childPath(path, key),
            ancestors,
          )}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
};

export const computePhase2CanonicalSha256 = (manifest) => {
  try {
    return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
  } catch (error) {
    if (error instanceof CanonicalJsonError) throw error;
    throw new CanonicalJsonError(
      `unexpected canonicalization error: ${stableErrorMessage(error)}`,
      { cause: error },
    );
  }
};

const addUnexpectedFieldErrors = (errors, value, allowedKeys, label) => {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value).sort()) {
    if (!allowedKeys.has(key)) {
      errors.push(`${label} contains unexpected field ${key}`);
    }
  }
};

let frozenAuthorityCache;

const loadFrozenAuthority = () => {
  if (frozenAuthorityCache) return frozenAuthorityCache;

  let authority;
  try {
    authority = JSON.parse(readFileSync(DEFAULT_MANIFEST_PATH, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to load frozen Phase 2 authority: ${message}`, {
      cause: error,
    });
  }

  let authorityHash;
  try {
    authorityHash = computePhase2CanonicalSha256(authority);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `unable to canonicalize frozen Phase 2 authority: ${message}`,
      { cause: error },
    );
  }
  if (authorityHash !== AUTHORITY_CANONICAL_SHA256) {
    throw new Error(
      `frozen authority snapshot canonical SHA-256 mismatch; expected ${display(AUTHORITY_CANONICAL_SHA256)}; received ${display(authorityHash)}`,
    );
  }

  const requirementsById = new Map(
    Array.isArray(authority.requirements)
      ? authority.requirements.map((requirement) => [
          requirement.id,
          requirement,
        ])
      : [],
  );
  frozenAuthorityCache = { authority, requirementsById };
  return frozenAuthorityCache;
};

const addFrozenAuthorityErrors = (
  errors,
  requirementsById,
  manifestCanonicalHash,
) => {
  let frozenAuthority;
  try {
    frozenAuthority = loadFrozenAuthority();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    return;
  }
  const frozenFields = [
    "priority",
    "dependencies",
    "owner",
    "test_suites",
    "eval_suites",
    "mutation_class",
  ];
  for (const id of REQUIRED_REQUIREMENT_IDS) {
    const expected = frozenAuthority.requirementsById.get(id);
    const received = requirementsById.get(id);
    if (!expected || !received) continue;
    for (const field of frozenFields) {
      const expectedValue = expected[field];
      const receivedValue = received[field];
      if (JSON.stringify(receivedValue) !== JSON.stringify(expectedValue)) {
        errors.push(
          `requirement ${id} ${field} must exactly match frozen authority; expected ${display(expectedValue)}, received ${display(receivedValue)}`,
        );
      }
    }
  }

  if (manifestCanonicalHash !== AUTHORITY_CANONICAL_SHA256) {
    errors.push(
      `manifest canonical SHA-256 does not match frozen authority; expected ${display(AUTHORITY_CANONICAL_SHA256)}; received ${display(manifestCanonicalHash)}`,
    );
  }
};

const findDependencyCycle = (requirementsById) => {
  const visited = new Set();
  const active = new Set();
  const stack = [];

  const visit = (id) => {
    if (active.has(id)) {
      const cycleStart = stack.indexOf(id);
      return [...stack.slice(cycleStart), id];
    }
    if (visited.has(id)) return undefined;

    visited.add(id);
    active.add(id);
    stack.push(id);
    const requirement = requirementsById.get(id);
    const dependencies = Array.isArray(requirement?.dependencies)
      ? requirement.dependencies
      : [];
    for (const dependency of dependencies) {
      if (!requirementsById.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(id);
    return undefined;
  };

  for (const id of requirementsById.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return undefined;
};

const validatePhase2ManifestInternal = (manifest, manifestCanonicalHash) => {
  const errors = [];

  addUnexpectedFieldErrors(errors, manifest, ROOT_KEYS, "manifest");

  if (manifest.schema_version !== EXPECTED_SCHEMA_VERSION) {
    errors.push(
      `manifest.schema_version must be ${display(EXPECTED_SCHEMA_VERSION)}; received ${display(manifest.schema_version)}`,
    );
  }
  if (manifest.phase !== EXPECTED_PHASE) {
    errors.push(
      `manifest.phase must be ${EXPECTED_PHASE}; received ${display(manifest.phase)}`,
    );
  }
  if (!isRecord(manifest.baseline)) {
    errors.push("manifest.baseline must be a JSON object");
  } else {
    addUnexpectedFieldErrors(
      errors,
      manifest.baseline,
      BASELINE_KEYS,
      "manifest.baseline",
    );
    if (manifest.baseline.repository !== EXPECTED_REPOSITORY) {
      errors.push(
        `manifest.baseline.repository must be ${display(EXPECTED_REPOSITORY)}; received ${display(manifest.baseline.repository)}`,
      );
    }
    if (manifest.baseline.sha !== EXPECTED_SHA) {
      errors.push(
        `manifest.baseline.sha must be ${display(EXPECTED_SHA)}; received ${display(manifest.baseline.sha)}`,
      );
    }
  }
  if (manifest.evidence_root !== EXPECTED_EVIDENCE_ROOT) {
    errors.push(
      `manifest.evidence_root must be ${display(EXPECTED_EVIDENCE_ROOT)}; received ${display(manifest.evidence_root)}`,
    );
  }

  const thresholds = isRecord(manifest.mutation_thresholds)
    ? manifest.mutation_thresholds
    : {};
  addUnexpectedFieldErrors(
    errors,
    manifest.mutation_thresholds,
    MUTATION_THRESHOLD_KEYS,
    "manifest.mutation_thresholds",
  );
  if (typeof thresholds.critical !== "number" || thresholds.critical < 90) {
    errors.push(
      `mutation_thresholds.critical must be at least 90; received ${display(thresholds.critical)}`,
    );
  }
  if (typeof thresholds.core !== "number" || thresholds.core < 85) {
    errors.push(
      `mutation_thresholds.core must be at least 85; received ${display(thresholds.core)}`,
    );
  }

  const prerequisites = Array.isArray(manifest.phase1_prerequisites)
    ? manifest.phase1_prerequisites
    : [];
  if (!Array.isArray(manifest.phase1_prerequisites)) {
    errors.push("manifest.phase1_prerequisites must be an array");
  }
  const prerequisiteSet = new Set();
  for (const prerequisite of prerequisites) {
    if (prerequisiteSet.has(prerequisite)) {
      errors.push(`duplicate phase1 prerequisite: ${prerequisite}`);
    }
    prerequisiteSet.add(prerequisite);
    if (!REQUIRED_PHASE1_PREREQUISITES.includes(prerequisite)) {
      errors.push(
        `phase1_prerequisites contains unknown prerequisite: ${prerequisite}`,
      );
    }
  }
  for (const prerequisite of REQUIRED_PHASE1_PREREQUISITES) {
    if (!prerequisiteSet.has(prerequisite)) {
      errors.push(
        `phase1_prerequisites is missing required prerequisite: ${prerequisite}`,
      );
    }
  }

  if (!Array.isArray(manifest.requirements)) {
    errors.push("manifest.requirements must be an array");
    return errors;
  }
  const requirements = manifest.requirements;
  if (requirements.length !== EXPECTED_REQUIREMENT_COUNT) {
    errors.push(
      `manifest.requirements must contain exactly ${EXPECTED_REQUIREMENT_COUNT} entries; received ${requirements.length}`,
    );
  }

  const requirementsById = new Map();
  for (const entry of requirements) {
    if (!isRecord(entry)) {
      errors.push("each manifest requirement must be a JSON object");
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id : display(entry.id);
    addUnexpectedFieldErrors(
      errors,
      entry,
      REQUIREMENT_KEYS,
      `requirement ${id}`,
    );
    if (requirementsById.has(id))
      errors.push(`duplicate requirement id: ${id}`);
    else requirementsById.set(id, entry);

    if (!REQUIRED_REQUIREMENT_IDS.includes(id)) {
      errors.push(`manifest requirement set contains unknown id: ${id}`);
    }
    if (!["P0", "P1", "P2"].includes(entry.priority)) {
      errors.push(
        `requirement ${id} priority must be "P0", "P1", or "P2"; received ${display(entry.priority)}`,
      );
    }
    if (!Array.isArray(entry.dependencies)) {
      errors.push(`requirement ${id} dependencies must be an array`);
    }
    if (typeof entry.owner !== "string" || entry.owner.length === 0) {
      errors.push(`requirement ${id} owner must be a non-empty string`);
    } else if (!ALLOWED_OWNERS.has(entry.owner)) {
      errors.push(
        `requirement ${id} owner is outside the Phase 2 monorepo boundaries: ${entry.owner}`,
      );
    }
    if (!Array.isArray(entry.test_suites) || entry.test_suites.length === 0) {
      errors.push(`requirement ${id} test_suites must be a non-empty array`);
    } else {
      for (const suite of entry.test_suites) {
        if (typeof suite !== "string" || !TEST_SUITE_PATTERN.test(suite)) {
          errors.push(
            `requirement ${id} test_suites entry must be a concrete Phase 2 test path without traversal; received ${display(suite)}`,
          );
        }
      }
    }
    if (!Array.isArray(entry.eval_suites) || entry.eval_suites.length === 0) {
      errors.push(`requirement ${id} eval_suites must be a non-empty array`);
    } else {
      for (const suite of entry.eval_suites) {
        if (typeof suite !== "string" || !ALLOWED_EVAL_SUITES.has(suite)) {
          errors.push(
            `requirement ${id} eval_suites entry must be one of the seven Phase 2 eval paths; received ${display(suite)}`,
          );
        }
      }
    }
    const expectedEvidencePath = `${EXPECTED_EVIDENCE_ROOT}/${id}.json`;
    if (entry.evidence_path !== expectedEvidencePath) {
      errors.push(
        `requirement ${id} evidence_path must be ${display(expectedEvidencePath)}; received ${display(entry.evidence_path)}`,
      );
    }
    if (!["critical", "core"].includes(entry.mutation_class)) {
      errors.push(
        `requirement ${id} mutation_class must be "critical" or "core"; received ${display(entry.mutation_class)}`,
      );
    }
  }

  for (const id of REQUIRED_REQUIREMENT_IDS) {
    if (!requirementsById.has(id)) {
      errors.push(`manifest requirement set is missing required id: ${id}`);
    }
  }

  for (const [id, entry] of requirementsById) {
    if (!Array.isArray(entry.dependencies)) continue;
    for (const dependency of entry.dependencies) {
      if (
        !requirementsById.has(dependency) &&
        !prerequisiteSet.has(dependency)
      ) {
        errors.push(
          `requirement ${id} depends on unknown requirement ${dependency}; add it to phase1_prerequisites if it is an external prerequisite`,
        );
      }
    }
  }

  const cycle = findDependencyCycle(requirementsById);
  if (cycle) errors.push(`dependency cycle detected: ${cycle.join(" -> ")}`);

  for (const [id, dependencies] of Object.entries(REQUIRED_EDGES)) {
    const declaredDependencies = requirementsById.get(id)?.dependencies;
    for (const dependency of dependencies) {
      if (
        !Array.isArray(declaredDependencies) ||
        !declaredDependencies.includes(dependency)
      ) {
        errors.push(
          `requirement ${id} is missing required dependency ${dependency}`,
        );
      }
    }
  }

  for (const id of PA_CLOSED_LOOP_REQUIREMENTS) {
    const evalSuites = requirementsById.get(id)?.eval_suites;
    if (
      !Array.isArray(evalSuites) ||
      !evalSuites.includes(PERSONAL_ASSISTANT_EVAL)
    ) {
      errors.push(
        `requirement ${id} is missing required eval suite ${PERSONAL_ASSISTANT_EVAL}`,
      );
    }
  }

  addFrozenAuthorityErrors(errors, requirementsById, manifestCanonicalHash);

  return errors;
};

export const validatePhase2Manifest = (manifest) => {
  try {
    if (manifest === null || typeof manifest !== "object") {
      return ["manifest must be a JSON object"];
    }

    let manifestCanonicalHash;
    try {
      manifestCanonicalHash = computePhase2CanonicalSha256(manifest);
    } catch (error) {
      return [`manifest canonicalization failed: ${stableErrorMessage(error)}`];
    }
    if (!isRecord(manifest)) return ["manifest must be a JSON object"];
    return validatePhase2ManifestInternal(manifest, manifestCanonicalHash);
  } catch (error) {
    return [`manifest validation failed: ${stableErrorMessage(error)}`];
  }
};

export const validatePhase2ManifestFile = (
  filePath = DEFAULT_MANIFEST_PATH,
) => {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`unable to read Phase 2 manifest ${filePath}: ${message}`];
  }
  return validatePhase2Manifest(manifest);
};

const isDirectExecution =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  const manifestPath = process.argv[2]
    ? resolve(process.argv[2])
    : DEFAULT_MANIFEST_PATH;
  const errors = validatePhase2ManifestFile(manifestPath);
  if (errors.length > 0) {
    for (const error of errors) console.error(`phase2-manifest: ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`phase2-manifest: valid (${manifestPath})`);
  }
}
