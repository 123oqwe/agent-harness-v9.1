#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

import { spawnTrustedGitSync } from "./trusted-git.mjs";

const EXPECTED_SCHEMA_VERSION = "1.0.0";
const EXPECTED_PHASE = 2;
const EXPECTED_REPOSITORY = "https://github.com/123oqwe/agentharness91.git";
const EXPECTED_SHA = "8dca581e11b8043aed257cb07c5161237633c40e";
const EXPECTED_EVIDENCE_ROOT = "artifacts/phase-2";
const PHASE2_AUTHORITY_PATH = "verification/gates/phase2-gate.json";
const EXPECTED_REQUIREMENT_COUNT = 64;
const SUPERSEDED_PHASE1_SHA = "bf5eac648527205603de7d26278276ad78819850";
export const AUTHORITY_CANONICAL_SHA256 =
  "f0ee8953eea22b141a7b56dd3ecf4602ff616e6f760699997f8cdd20f8883df9";
export const PHASE1_HARDENING_BINDING_SHA256 =
  "13623818373a47cc0bc240b259d759fb96aa28b9c81bbe07e08fdbd0b904ab78";

export const PHASE1_HARDENING_BINDING = Object.freeze(
  [
    [
      ".github/workflows/ci.yml",
      "M",
      "100644",
      "100644",
      "49b99d46ca47952f7effa7433af50597ccbc5d06",
      "eed42f8408542a94c027a2897ab9c3958e12b320",
    ],
    [
      ".github/workflows/glm-acceptance.yml",
      "A",
      "000000",
      "100644",
      "0000000000000000000000000000000000000000",
      "13fd4c7e9536c57e6e55a87c89ec86079d48f925",
    ],
    [
      ".github/workflows/mutation.yml",
      "M",
      "100644",
      "100644",
      "4f24690c8c3d6aef20e31cc4d849b7f96c65623d",
      "bf9c33768f3242ed4f925a3248b52c8c75700ddd",
    ],
    [
      "benchmarks/phase1/final-evidence.schema.json",
      "A",
      "000000",
      "100644",
      "0000000000000000000000000000000000000000",
      "a565c049da82680ed4bc1bc1fda99cfc92d01797",
    ],
    [
      "benchmarks/phase1/result.schema.json",
      "M",
      "100644",
      "100644",
      "b8afbf511031586b8d788084816428987cb660b3",
      "9747542603a8a9faef82ed1f6cd90342e492258c",
    ],
    [
      "benchmarks/phase1/runner/run-agent.mjs",
      "M",
      "100644",
      "100644",
      "66e89339d2730e9f7e1579afc028be5e0874310c",
      "d3166f9fcb4300542011e871243812bc822676d4",
    ],
    [
      "mutation/modules.mjs",
      "M",
      "100644",
      "100644",
      "2e7f52a33d0ae1373d6d4bdf33c2485d3b19cc42",
      "c68987ee2737a5491768690f325037d3143a47d8",
    ],
    [
      "package-lock.json",
      "M",
      "100644",
      "100644",
      "952f59e7f5e227dd8d1803385d2dff699d6aa17a",
      "f70be0e2f864893f37b0fe9ed4906ac83fc891af",
    ],
    [
      "package.json",
      "M",
      "100644",
      "100644",
      "52513025166d9719ff9179480d4d8a4046b02c36",
      "006efefaf04e2dba1560b64dcd0cbaa4b75e34a5",
    ],
    [
      "scripts/check-mutation-thresholds.mjs",
      "M",
      "100644",
      "100644",
      "3ffba6e08786907115607b167607551fb5054a00",
      "b4ce7fb22cb249d85b8e8ea4dbd13862a798244e",
    ],
    [
      "scripts/release-evidence.mjs",
      "A",
      "000000",
      "100644",
      "0000000000000000000000000000000000000000",
      "b7728192342bd21bd89bea0d1227aa09efcb1abe",
    ],
    [
      "scripts/run-glm-acceptance.mjs",
      "M",
      "100644",
      "100644",
      "571e9290699d633a253b823850978157054f01d7",
      "6d8fb9eeae3c75421f6a0a6a72e37b55756ebb18",
    ],
    [
      "scripts/run-mutation.mjs",
      "M",
      "100644",
      "100644",
      "210de1e41263343c6283a0188376ddbefc6f69a9",
      "0b724ad62c22326e8bfb7e66547c9eb9d992a7ce",
    ],
    [
      "scripts/run-process-tree.mjs",
      "A",
      "000000",
      "100644",
      "0000000000000000000000000000000000000000",
      "0e5e3a8b621d80d9f8f9cb92b09870ea2cc2a8ec",
    ],
    [
      "scripts/secure-release-io.mjs",
      "A",
      "000000",
      "100644",
      "0000000000000000000000000000000000000000",
      "e52234b172b6094a4f8a6796a52256361ab0aa40",
    ],
    [
      "scripts/secure-release-io.py",
      "A",
      "000000",
      "100644",
      "0000000000000000000000000000000000000000",
      "6cfe84f1b5a791b8e84d314cd3ad4cd2a5512254",
    ],
    [
      "scripts/trusted-git.mjs",
      "A",
      "000000",
      "100644",
      "0000000000000000000000000000000000000000",
      "5bba57cdfaee60a724b87f5a2476339dfefe3cfc",
    ],
    [
      "tests/glm-acceptance/glm-acceptance.test.ts",
      "M",
      "100644",
      "100644",
      "898cab95cc322c535ea437af70f2fe05110ed845",
      "644e19f0d84425992d359df9d6b366dd15542396",
    ],
    [
      "tests/glm-acceptance/release-evidence-boundaries.test.ts",
      "A",
      "000000",
      "100644",
      "0000000000000000000000000000000000000000",
      "f42dfdeb66125529100016e9ee765a02ce573dab",
    ],
    [
      "tests/glm-acceptance/runner-output-boundaries.test.ts",
      "A",
      "000000",
      "100644",
      "0000000000000000000000000000000000000000",
      "4407b76de2ad6cae2d179144d4282117676bbfe3",
    ],
    [
      "tests/glm-acceptance/secure-release-io.test.ts",
      "A",
      "000000",
      "100644",
      "0000000000000000000000000000000000000000",
      "cd8a24bfbdcb90a9d42b526a58180b23f3dbff21",
    ],
    [
      "tests/glm-acceptance/workflow-contract.test.ts",
      "A",
      "000000",
      "100644",
      "0000000000000000000000000000000000000000",
      "120747a5885f1ab1e1293f42705a43f0008751af",
    ],
    [
      "tests/mutation/fixtures/process-tree-grandchild.mjs",
      "A",
      "000000",
      "100644",
      "0000000000000000000000000000000000000000",
      "1d64510ffe9a92e50fc60ee924ea5d1d3dd5dac9",
    ],
    [
      "tests/mutation/fixtures/process-tree-orphaning-parent.mjs",
      "A",
      "000000",
      "100644",
      "0000000000000000000000000000000000000000",
      "b3634e0956812aefb21568af6e881902f75d397b",
    ],
    [
      "tests/mutation/fixtures/process-tree-parent.mjs",
      "A",
      "000000",
      "100644",
      "0000000000000000000000000000000000000000",
      "700b49c3fe507a075ce8a736eab0fa65bd555062",
    ],
    [
      "tests/mutation/fixtures/process-tree-success.mjs",
      "A",
      "000000",
      "100644",
      "0000000000000000000000000000000000000000",
      "56bcf1d75b0a4176dafadbd36dd6d6cc3cb82762",
    ],
    [
      "tests/mutation/infrastructure.test.ts",
      "M",
      "100644",
      "100644",
      "df8205e1f93d0f459347b4f69370ad86b0dbf055",
      "6acc224737122521125751ddd551fba448d9b16c",
    ],
    [
      "tests/mutation/process-tree-runner.test.ts",
      "A",
      "000000",
      "100644",
      "0000000000000000000000000000000000000000",
      "ed94322257e5938d8e6dcc109019f1d44f21c97f",
    ],
    [
      "tests/mutation/published-artifact-integrity.test.ts",
      "A",
      "000000",
      "100644",
      "0000000000000000000000000000000000000000",
      "60efa7d8c8fe77c512c442a52404a07e9891b12e",
    ],
    [
      "tests/packaging/package.test.ts",
      "M",
      "100644",
      "100644",
      "1916a94f622ca792a693f411541ddb6677ab5df6",
      "c41bb6bdc68686ea9a293f3e955f2e876d5e736c",
    ],
  ].map(([path, status, oldMode, newMode, oldBlob, newBlob]) =>
    Object.freeze({ path, status, oldMode, newMode, oldBlob, newBlob }),
  ),
);

const ROOT_KEYS = new Set([
  "schema_version",
  "phase",
  "baseline",
  "evidence_root",
  "mutation_thresholds",
  "source_authorities",
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
  "source_files",
  "test_files",
]);
const SOURCE_AUTHORITY_KEYS = new Set([
  "id",
  "migration_requirement",
  "root",
  "workspace",
]);
const SOURCE_AUTHORITY_ROOT_KEYS = new Set([
  "state",
  "paths",
  "exports",
  "tests",
]);
const SOURCE_AUTHORITY_WORKSPACE_KEYS = new Set([
  "state",
  "owner",
  "paths",
  "exports",
  "tests",
]);
const REQUIRED_SOURCE_AUTHORITY_IDS = [
  "Harness",
  "Gateway",
  "Router",
  "Runtime",
  "Strategies",
  "Tools",
  "Skills",
  "Policy",
  "PEP",
  "Capability",
  "Auth",
  "Secrets",
  "VFS",
  "Sandbox",
  "Session",
  "Verification",
];
const PHASE1_INTERNAL_AUTHORITY_EXPORTS = new Set([
  "ToolDispatcher",
  "runDirect",
  "runReact",
  "runPlanExecute",
]);
const CANONICAL_SOURCE_AUTHORITY_BINDINGS = Object.freeze({
  Harness: { owner: "packages/runtime-core", exports: ["Harness"] },
  Gateway: { owner: "packages/runtime-core", exports: ["ModelGateway"] },
  Router: { owner: "packages/router", exports: ["StaticRouter"] },
  Runtime: { owner: "packages/runtime-core", exports: ["LoopEngine"] },
  Strategies: {
    owner: "packages/runtime-core",
    exports: ["runDirect", "runReact", "runPlanExecute"],
  },
  Tools: {
    owner: "packages/tools",
    exports: ["ToolRegistry", "ToolDispatcher"],
  },
  Skills: {
    owner: "packages/tools",
    exports: ["SkillRegistry", "SkillLoader"],
  },
  Policy: { owner: "packages/security", exports: ["PolicyEngine"] },
  PEP: {
    owner: "packages/security",
    exports: ["PolicyEnforcementPoint"],
  },
  Capability: {
    owner: "packages/security",
    exports: ["signCapabilityClaims", "verifyCapabilityClaims"],
  },
  Auth: { owner: "packages/security", exports: ["AuthService"] },
  Secrets: { owner: "packages/security", exports: ["SecretsBroker"] },
  VFS: { owner: "packages/tools", exports: ["VirtualFilesystem"] },
  Sandbox: { owner: "packages/tools", exports: ["execSandboxed"] },
  Session: { owner: "packages/runtime-core", exports: ["DurableSession"] },
  Verification: {
    owner: "packages/runtime-core",
    exports: ["VerificationEngine"],
  },
});

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
  "packages/runtime-core",
  "packages/router",
  "packages/security",
  "packages/tools",
  "packages/eval",
  "packages/documents",
  "packages/rag",
  "packages/multimodal",
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

const phase1BindingCanonical = (binding) =>
  JSON.stringify(
    binding.map(({ path, status, oldMode, newMode, oldBlob, newBlob }) => ({
      path,
      status,
      oldMode,
      newMode,
      oldBlob,
      newBlob,
    })),
  );

const EXPECTED_PHASE1_BINDING_CANONICAL = phase1BindingCanonical(
  PHASE1_HARDENING_BINDING,
);

if (
  createHash("sha256")
    .update(EXPECTED_PHASE1_BINDING_CANONICAL)
    .digest("hex") !== PHASE1_HARDENING_BINDING_SHA256
) {
  throw new Error("frozen Phase 1 hardening binding SHA-256 mismatch");
}

export const validatePhase1HardeningBinding = (candidate) => {
  if (!Array.isArray(candidate))
    return ["Phase 1 hardening binding must be an array"];
  let canonical;
  try {
    canonical = phase1BindingCanonical(candidate);
  } catch (error) {
    return [
      `Phase 1 hardening binding is malformed: ${stableErrorMessage(error)}`,
    ];
  }
  return canonical === EXPECTED_PHASE1_BINDING_CANONICAL
    ? []
    : ["Phase 1 hardening path/blob/mode/status binding drifted"];
};

const readTrustedTree = (repositoryRoot, revision) => {
  const result = spawnTrustedGitSync(
    ["ls-tree", "-r", "-z", "--full-tree", revision],
    {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `missing Phase 1 prerequisite ${revision}; shallow checkout is unsupported`,
    );
  }
  const entries = new Map();
  for (const record of result.stdout.toString("utf8").split("\0")) {
    if (record.length === 0) continue;
    const match = record.match(/^(\d{6}) (blob|commit) ([a-f0-9]{40})\t(.+)$/u);
    if (!match)
      throw new Error(`malformed trusted Git tree entry for ${revision}`);
    entries.set(match[4], { mode: match[1], blob: match[3] });
  }
  return entries;
};

const trustedHistoryContains = (repositoryRoot, start, expected) => {
  const result = spawnTrustedGitSync(["rev-list", "--parents", start], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.status !== 0) return false;
  return result.stdout.split(/\s+/u).some((revision) => revision === expected);
};

const derivePhase1Binding = (oldTree, newTree) => {
  const zero = "0".repeat(40);
  const paths = [...new Set([...oldTree.keys(), ...newTree.keys()])].sort(
    (left, right) => left.localeCompare(right),
  );
  return paths.flatMap((path) => {
    const oldEntry = oldTree.get(path);
    const newEntry = newTree.get(path);
    if (oldEntry?.mode === newEntry?.mode && oldEntry?.blob === newEntry?.blob)
      return [];
    return [
      {
        path,
        status: oldEntry ? (newEntry ? "M" : "D") : "A",
        oldMode: oldEntry?.mode ?? "000000",
        newMode: newEntry?.mode ?? "000000",
        oldBlob: oldEntry?.blob ?? zero,
        newBlob: newEntry?.blob ?? zero,
      },
    ];
  });
};

export const verifyPhase1PrerequisiteHistory = ({ repositoryRoot }) => {
  const errors = [];
  try {
    const headResult = spawnTrustedGitSync(["rev-parse", "HEAD^{commit}"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (headResult.status !== 0)
      throw new Error("unable to resolve trusted HEAD commit");
    const head = headResult.stdout.trim();
    if (!trustedHistoryContains(repositoryRoot, head, EXPECTED_SHA)) {
      throw new Error(
        `missing accepted Phase 1 prerequisite ${EXPECTED_SHA}; shallow checkout is unsupported`,
      );
    }
    if (
      !trustedHistoryContains(
        repositoryRoot,
        EXPECTED_SHA,
        SUPERSEDED_PHASE1_SHA,
      )
    ) {
      throw new Error(
        `missing superseded Phase 1 prerequisite ${SUPERSEDED_PHASE1_SHA}; shallow checkout is unsupported`,
      );
    }
    const oldTree = readTrustedTree(repositoryRoot, SUPERSEDED_PHASE1_SHA);
    const newTree = readTrustedTree(repositoryRoot, EXPECTED_SHA);
    errors.push(
      ...validatePhase1HardeningBinding(derivePhase1Binding(oldTree, newTree)),
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
};

const trustedCommitFile = (repositoryRoot, revision, path) => {
  const result = spawnTrustedGitSync(
    ["cat-file", "-p", `${revision}:${path}`],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return result.status === 0 ? result.stdout : null;
};

const parsedCommitManifest = (repositoryRoot, revision) => {
  const bytes = trustedCommitFile(
    repositoryRoot,
    revision,
    PHASE2_AUTHORITY_PATH,
  );
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes);
  } catch {
    return null;
  }
};

const activeWorkspaceAuthority = (manifest, id) =>
  manifest?.source_authorities?.find(
    (authority) =>
      authority?.id === id &&
      authority?.root?.state === "retired" &&
      authority?.workspace?.state === "active",
  ) ?? null;

export const verifyAtomicAuthorityMigrations = ({ repositoryRoot }) => {
  const errors = [];
  let live;
  try {
    live = JSON.parse(
      readFileSync(join(repositoryRoot, PHASE2_AUTHORITY_PATH), "utf8"),
    );
  } catch (error) {
    return [
      `unable to read authority migration manifest: ${stableErrorMessage(error)}`,
    ];
  }
  const active = (live.source_authorities ?? []).filter(
    (authority) =>
      authority?.root?.state === "retired" &&
      authority?.workspace?.state === "active",
  );
  if (active.length === 0) return errors;
  const history = spawnTrustedGitSync(["rev-list", "--reverse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (history.status !== 0) return ["unable to read trusted migration history"];
  const revisions = history.stdout.trim().split(/\s+/u).filter(Boolean);
  const head = revisions.at(-1);
  if (!head) return ["trusted migration history is empty"];
  const headBytes = trustedCommitFile(
    repositoryRoot,
    head,
    PHASE2_AUTHORITY_PATH,
  );
  if (
    headBytes === null ||
    headBytes !==
      readFileSync(join(repositoryRoot, PHASE2_AUTHORITY_PATH), "utf8")
  ) {
    errors.push(
      "active authority migration must be committed atomically before validation",
    );
    return errors;
  }
  const manifests = revisions.map((revision) =>
    parsedCommitManifest(repositoryRoot, revision),
  );
  for (const authority of active) {
    const transitionIndex = manifests.findIndex((manifest) =>
      activeWorkspaceAuthority(manifest, authority.id),
    );
    if (transitionIndex <= 0) {
      errors.push(
        `source authority ${String(authority.id)} has no provable atomic migration transition`,
      );
      continue;
    }
    const transitionRevision = revisions[transitionIndex];
    const parentRevision = revisions[transitionIndex - 1];
    const transitionManifest = manifests[transitionIndex];
    const parentManifest = manifests[transitionIndex - 1];
    const transitionAuthority = activeWorkspaceAuthority(
      transitionManifest,
      authority.id,
    );
    const parentAuthority = parentManifest?.source_authorities?.find(
      (candidate) => candidate?.id === authority.id,
    );
    if (
      parentAuthority?.root?.state !== "active" ||
      parentAuthority?.workspace?.state !== "scaffold"
    ) {
      errors.push(
        `source authority ${String(authority.id)} did not transition atomically from active/scaffold`,
      );
      continue;
    }
    const requirementId = transitionAuthority?.migration_requirement;
    const requirement = transitionManifest?.requirements?.find(
      (candidate) => candidate?.id === requirementId,
    );
    const parentRequirement = parentManifest?.requirements?.find(
      (candidate) => candidate?.id === requirementId,
    );
    if (
      !requirement ||
      JSON.stringify(requirement.source_files) ===
        JSON.stringify(parentRequirement?.source_files) ||
      JSON.stringify(requirement.test_files) ===
        JSON.stringify(parentRequirement?.test_files)
    ) {
      errors.push(
        `source authority ${String(authority.id)} requirement/source/test binding was not introduced in the same commit`,
      );
    }
    for (const path of [
      ...(requirement?.source_files ?? []),
      ...(requirement?.test_files ?? []),
    ]) {
      const next = trustedCommitFile(repositoryRoot, transitionRevision, path);
      const previous = trustedCommitFile(repositoryRoot, parentRevision, path);
      if (next === null || next === previous) {
        errors.push(
          `source authority ${String(authority.id)} ${String(path)} was not introduced atomically`,
        );
      }
    }
    const nextIndex = trustedCommitFile(
      repositoryRoot,
      transitionRevision,
      "index.ts",
    );
    const previousIndex = trustedCommitFile(
      repositoryRoot,
      parentRevision,
      "index.ts",
    );
    if (nextIndex === null || nextIndex === previousIndex) {
      errors.push(
        `source authority ${String(authority.id)} root export did not change in the same commit`,
      );
    }
  }
  return errors;
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
    "source_files",
    "test_files",
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

const validateStringList = (
  errors,
  value,
  label,
  { nonEmpty = false } = {},
) => {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return [];
  }
  if (nonEmpty && value.length === 0) errors.push(`${label} must not be empty`);
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      errors.push(`${label} entries must be non-empty strings`);
      continue;
    }
    if (seen.has(entry)) errors.push(`${label} contains duplicate ${entry}`);
    seen.add(entry);
  }
  return value;
};

const validateSourceAuthorities = (errors, manifest, requirementsById) => {
  if (!Array.isArray(manifest.source_authorities)) {
    errors.push("manifest.source_authorities must be an array");
    return;
  }
  const ids = manifest.source_authorities.map((entry) => entry?.id);
  if (JSON.stringify(ids) !== JSON.stringify(REQUIRED_SOURCE_AUTHORITY_IDS)) {
    errors.push(
      "manifest.source_authorities must contain the canonical ordered authority set",
    );
  }
  for (const authority of manifest.source_authorities) {
    if (!isRecord(authority)) {
      errors.push("each source authority must be a JSON object");
      continue;
    }
    const id =
      typeof authority.id === "string" ? authority.id : display(authority.id);
    addUnexpectedFieldErrors(
      errors,
      authority,
      SOURCE_AUTHORITY_KEYS,
      `source authority ${id}`,
    );
    for (const [side, allowedKeys] of [
      ["root", SOURCE_AUTHORITY_ROOT_KEYS],
      ["workspace", SOURCE_AUTHORITY_WORKSPACE_KEYS],
    ]) {
      const endpoint = authority[side];
      if (!isRecord(endpoint)) {
        errors.push(`source authority ${id} ${side} must be a JSON object`);
        continue;
      }
      addUnexpectedFieldErrors(
        errors,
        endpoint,
        allowedKeys,
        `source authority ${id} ${side}`,
      );
      validateStringList(
        errors,
        endpoint.paths,
        `source authority ${id} ${side}.paths`,
        { nonEmpty: true },
      );
      validateStringList(
        errors,
        endpoint.exports,
        `source authority ${id} ${side}.exports`,
        {
          nonEmpty: side === "root" || endpoint.state === "active",
        },
      );
      validateStringList(
        errors,
        endpoint.tests,
        `source authority ${id} ${side}.tests`,
        {
          nonEmpty: side === "root" || endpoint.state === "active",
        },
      );
    }
    const rootState = authority.root?.state;
    const workspaceState = authority.workspace?.state;
    const canonical = CANONICAL_SOURCE_AUTHORITY_BINDINGS[id];
    if (canonical) {
      if (authority.workspace?.owner !== canonical.owner) {
        errors.push(
          `source authority ${id} workspace.owner must remain ${canonical.owner}`,
        );
      }
      if (
        JSON.stringify(authority.root?.exports) !==
        JSON.stringify(canonical.exports)
      ) {
        errors.push(
          `source authority ${id} root.exports must remain ${JSON.stringify(canonical.exports)}`,
        );
      }
      if (
        workspaceState === "active" &&
        JSON.stringify(authority.workspace?.exports) !==
          JSON.stringify(canonical.exports)
      ) {
        errors.push(
          `source authority ${id} active workspace.exports must remain ${JSON.stringify(canonical.exports)}`,
        );
      }
    }
    if (!["active", "retired"].includes(rootState)) {
      errors.push(
        `source authority ${id} root.state must be active or retired`,
      );
    }
    if (!["active", "scaffold"].includes(workspaceState)) {
      errors.push(
        `source authority ${id} workspace.state must be active or scaffold`,
      );
    }
    if (
      [rootState, workspaceState].filter((state) => state === "active")
        .length !== 1
    ) {
      errors.push(
        `source authority ${id} must have exactly one active implementation`,
      );
    }
    if (
      typeof authority.workspace?.owner !== "string" ||
      !ALLOWED_OWNERS.has(authority.workspace.owner)
    ) {
      errors.push(
        `source authority ${id} workspace.owner must be a Phase 2 workspace`,
      );
    }
    if (rootState === "active" && workspaceState === "scaffold") {
      if (authority.migration_requirement !== null) {
        errors.push(
          `source authority ${id} migration_requirement must be null before migration`,
        );
      }
      if (
        JSON.stringify(authority.workspace?.exports) !==
          JSON.stringify(["workspaceIdentity"]) ||
        JSON.stringify(authority.workspace?.tests) !== JSON.stringify([])
      ) {
        errors.push(
          `source authority ${id} workspace must remain an identity-only scaffold`,
        );
      }
    } else if (rootState === "retired" && workspaceState === "active") {
      const requirement = requirementsById.get(authority.migration_requirement);
      if (!requirement) {
        errors.push(
          `source authority ${id} migration_requirement must name a Phase 2 requirement`,
        );
      } else {
        if (requirement.owner !== authority.workspace.owner) {
          errors.push(
            `source authority ${id} migration_requirement owner must match workspace.owner`,
          );
        }
        if (
          JSON.stringify(authority.workspace.paths) !==
          JSON.stringify(requirement.source_files)
        ) {
          errors.push(
            `source authority ${id} migration paths must exactly match requirement source_files`,
          );
        }
        if (
          JSON.stringify(authority.workspace.tests) !==
            JSON.stringify(requirement.test_files) ||
          JSON.stringify(requirement.test_files) !==
            JSON.stringify(requirement.test_suites)
        ) {
          errors.push(
            `source authority ${id} migration tests must exactly match requirement test_files and test_suites`,
          );
        }
      }
    }
  }
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
    for (const field of ["source_files", "test_files"]) {
      if (!Object.hasOwn(entry, field)) continue;
      validateStringList(errors, entry[field], `requirement ${id} ${field}`, {
        nonEmpty: true,
      });
    }
    if (
      Object.hasOwn(entry, "source_files") !==
      Object.hasOwn(entry, "test_files")
    ) {
      errors.push(
        `requirement ${id} must declare source_files and test_files together`,
      );
    }
    if (
      Array.isArray(entry.test_files) &&
      JSON.stringify(entry.test_files) !== JSON.stringify(entry.test_suites)
    ) {
      errors.push(
        `requirement ${id} test_files must exactly match test_suites`,
      );
    }
    if (Array.isArray(entry.source_files)) {
      for (const path of entry.source_files) {
        if (
          typeof path !== "string" ||
          !path.startsWith(`${entry.owner}/src/`) ||
          path.startsWith("/") ||
          path.split("/").includes("..")
        ) {
          errors.push(
            `requirement ${id} source_files entry must be inside owner/src: ${display(path)}`,
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

  validateSourceAuthorities(errors, manifest, requirementsById);

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

const sourcePathInside = (repositoryRoot, relativePath) => {
  if (
    typeof relativePath !== "string" ||
    relativePath.startsWith("/") ||
    relativePath.split("/").includes("..")
  )
    return null;
  const absolute = resolve(repositoryRoot, relativePath);
  return absolute.startsWith(`${resolve(repositoryRoot)}/`) ? absolute : null;
};

export const parseTrackedGitIndex = (output) => {
  if (
    typeof output !== "string" ||
    output.length === 0 ||
    !output.endsWith("\0")
  )
    return null;
  const records = output.split("\0");
  if (records.pop() !== "") return null;
  const entries = new Map();
  for (const record of records) {
    const separator = record.indexOf("\t");
    if (separator <= 0 || separator === record.length - 1) return null;
    const header = record.slice(0, separator);
    const path = record.slice(separator + 1);
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path
        .split("/")
        .some(
          (component) =>
            component.length === 0 || component === "." || component === "..",
        )
    ) {
      return null;
    }
    const match = /^(100644|100755) ([0-9a-f]{40}|[0-9a-f]{64}) (0)$/u.exec(
      header,
    );
    if (!match || entries.has(path)) return null;
    entries.set(
      path,
      Object.freeze({ mode: match[1], blob: match[2], status: match[3] }),
    );
  }
  return entries.size > 0 ? entries : null;
};

const trackedRepositoryEntries = (repositoryRoot) => {
  const tracked = spawnTrustedGitSync(["ls-files", "--stage", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (tracked.status !== 0) return null;
  return parseTrackedGitIndex(tracked.stdout);
};

const trackedRegularFileError = (
  repositoryRoot,
  relativePath,
  label,
  trackedEntries,
) => {
  const absolute = sourcePathInside(repositoryRoot, relativePath);
  if (!absolute)
    return `${label} path escapes repository: ${display(relativePath)}`;
  let stats;
  let bytes;
  try {
    stats = lstatSync(absolute);
    if (!stats.isFile() || stats.isSymbolicLink())
      return `${label} must be a regular non-symlink file: ${relativePath}`;
    bytes = readFileSync(absolute);
  } catch {
    return `${label} file is missing: ${relativePath}`;
  }
  if (!trackedEntries)
    return `${label} cannot verify tracked files from repository index`;
  const entry = trackedEntries.get(relativePath);
  if (!entry) return `${label} file is not tracked: ${relativePath}`;
  const workingMode = (stats.mode & 0o111) === 0 ? "100644" : "100755";
  if (entry.mode !== workingMode) {
    return `${label} Git index mode ${entry.mode} differs from working mode ${workingMode}: ${relativePath}`;
  }
  const algorithm = entry.blob.length === 64 ? "sha256" : "sha1";
  const workingBlob = createHash(algorithm)
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest("hex");
  return workingBlob === entry.blob
    ? null
    : `${label} Git index blob differs from working bytes: ${relativePath}`;
};

const typescriptSource = (absolute, label, errors) => {
  let source;
  try {
    source = ts.createSourceFile(
      absolute,
      readFileSync(absolute, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      absolute.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
  } catch (error) {
    errors.push(`${label} is unreadable: ${stableErrorMessage(error)}`);
    return null;
  }
  if (source.parseDiagnostics.length > 0) {
    errors.push(`${label} contains unsupported or malformed syntax`);
    return null;
  }
  return source;
};

const resolveStaticModule = (fromFile, specifier) => {
  if (typeof specifier !== "string" || !specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = specifier.endsWith(".js")
    ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx", base]
    : [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")];
  for (const candidate of candidates) {
    try {
      const stats = lstatSync(candidate);
      if (stats.isFile() && !stats.isSymbolicLink()) return candidate;
    } catch {
      // Try the next supported static extension.
    }
  }
  return null;
};

const valueExportTargets = ({ absolute, exportName, program, checker }) => {
  const source = program.getSourceFile(absolute);
  if (!source) return new Set();
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) return new Set();
  const exported = checker
    .getExportsOfModule(moduleSymbol)
    .filter((symbol) => symbol.name === exportName);
  const targets = new Set();
  for (const symbol of exported) {
    let resolved = symbol;
    if ((resolved.flags & ts.SymbolFlags.Alias) !== 0) {
      try {
        resolved = checker.getAliasedSymbol(resolved);
      } catch {
        continue;
      }
    }
    if ((resolved.flags & ts.SymbolFlags.Value) === 0) continue;
    for (const declaration of resolved.declarations ?? []) {
      const path = declaration.getSourceFile().fileName;
      if (!declaration.getSourceFile().isDeclarationFile)
        targets.add(resolve(path));
    }
  }
  return targets;
};

const callFamilyName = (call) => {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression)
  ) {
    return expression.expression.text;
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression)
  ) {
    return expression.expression.expression.text;
  }
  return null;
};

const functionArgument = (call) =>
  [...call.arguments]
    .reverse()
    .find(
      (argument) =>
        ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
    ) ?? null;

const nodeIsInside = (node, container) => {
  let current = node;
  while (current) {
    if (current === container) return true;
    current = current.parent;
  }
  return false;
};

const callableDeclaration = (symbol) => {
  for (const declaration of symbol?.declarations ?? []) {
    if (
      ts.isFunctionDeclaration(declaration) ||
      ts.isFunctionExpression(declaration) ||
      ts.isArrowFunction(declaration)
    ) {
      return declaration;
    }
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      (ts.isFunctionExpression(declaration.initializer) ||
        ts.isArrowFunction(declaration.initializer))
    ) {
      return declaration.initializer;
    }
  }
  return null;
};

const reachableCallables = (roots, checker) => {
  const reachable = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const root of [...reachable]) {
      const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const declaration = callableDeclaration(
            checker.getSymbolAtLocation(node.expression),
          );
          if (declaration && !reachable.has(declaration)) {
            reachable.add(declaration);
            changed = true;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(root);
    }
  }
  return reachable;
};

const resolvedSymbol = (checker, node) => {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol;
};

const authorityRuntimeKind = (checker, localSymbol) => {
  const symbol =
    (localSymbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(localSymbol)
      : localSymbol;
  return (symbol?.declarations ?? []).some((declaration) =>
    ts.isClassDeclaration(declaration),
  )
    ? "class"
    : "function";
};

const assertionMatcherNames = (expectCall) => {
  const names = [];
  let current = expectCall.parent;
  while (
    current &&
    (ts.isPropertyAccessExpression(current) || ts.isCallExpression(current))
  ) {
    if (ts.isPropertyAccessExpression(current)) names.push(current.name.text);
    current = current.parent;
  }
  return names;
};

const hasCausalBehaviorAssertion = ({
  roots,
  checker,
  classAuthorities,
  functionAuthorities,
}) => {
  const reachable = reachableCallables(roots, checker);
  const instances = new Set();
  const behaviors = new Set();
  const instanceCallables = new Set();
  const behaviorCallables = new Set();
  const insideReachable = (node) =>
    [...reachable].some((container) => nodeIsInside(node, container));

  const flow = (node) => {
    if (!node) return 0;
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      return (instances.has(symbol) ? 1 : 0) | (behaviors.has(symbol) ? 2 : 0);
    }
    if (ts.isNewExpression(node)) {
      const symbol = resolvedSymbol(checker, node.expression);
      if (classAuthorities.has(symbol) || instanceCallables.has(symbol))
        return 1;
    }
    if (ts.isCallExpression(node)) {
      const symbol = resolvedSymbol(checker, node.expression);
      if (functionAuthorities.has(symbol) || behaviorCallables.has(symbol))
        return 2;
      if (instanceCallables.has(symbol)) return 1;
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        (flow(node.expression.expression) & 3) !== 0
      ) {
        return 2;
      }
    }
    let result = 0;
    ts.forEachChild(node, (child) => {
      result |= flow(child);
    });
    return result;
  };

  let changed = true;
  while (changed) {
    changed = false;
    const add = (set, symbol) => {
      if (symbol && !set.has(symbol)) {
        set.add(symbol);
        changed = true;
      }
    };
    const visit = (node) => {
      if (!insideReachable(node)) return;
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      ) {
        const valueFlow = flow(node.initializer);
        const symbol = checker.getSymbolAtLocation(node.name);
        if ((valueFlow & 1) !== 0) add(instances, symbol);
        if ((valueFlow & 2) !== 0) add(behaviors, symbol);
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        const valueFlow = flow(node.right);
        const symbol = checker.getSymbolAtLocation(node.left);
        if ((valueFlow & 1) !== 0) add(instances, symbol);
        if ((valueFlow & 2) !== 0) add(behaviors, symbol);
      }
      if (ts.isCallExpression(node)) {
        const runtimeSymbol = resolvedSymbol(checker, node.expression);
        if (functionAuthorities.has(runtimeSymbol)) {
          for (const argument of node.arguments) {
            if (ts.isIdentifier(argument)) {
              add(behaviors, checker.getSymbolAtLocation(argument));
            }
          }
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          (flow(node.expression.expression) & 1) !== 0
        ) {
          add(
            behaviors,
            checker.getSymbolAtLocation(node.expression.expression),
          );
        }
        const declaration = callableDeclaration(
          checker.getSymbolAtLocation(node.expression),
        );
        if (declaration) {
          node.arguments.forEach((argument, index) => {
            const parameter = declaration.parameters[index];
            if (!parameter || !ts.isIdentifier(parameter.name)) return;
            const valueFlow = flow(argument);
            const symbol = checker.getSymbolAtLocation(parameter.name);
            if ((valueFlow & 1) !== 0) add(instances, symbol);
            if ((valueFlow & 2) !== 0) add(behaviors, symbol);
          });
        }
      }
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node)) &&
        node.body
      ) {
        const symbol =
          ts.isFunctionDeclaration(node) && node.name
            ? checker.getSymbolAtLocation(node.name)
            : ts.isVariableDeclaration(node.parent) &&
                ts.isIdentifier(node.parent.name)
              ? checker.getSymbolAtLocation(node.parent.name)
              : undefined;
        const bodyFlow = flow(node.body);
        if ((bodyFlow & 1) !== 0) add(instanceCallables, symbol);
        if ((bodyFlow & 2) !== 0) add(behaviorCallables, symbol);
      }
      ts.forEachChild(node, visit);
    };
    for (const root of reachable) visit(root);
  }

  const weakMatchers = new Set([
    "toBeDefined",
    "toBeUndefined",
    "toBeTruthy",
    "toBeFalsy",
    "toBeTypeOf",
  ]);
  let asserted = false;
  const inspect = (node) => {
    if (asserted || !insideReachable(node)) return;
    if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "expect" &&
        !assertionMatcherNames(node).some((name) => weakMatchers.has(name)) &&
        node.arguments.some((argument) => (flow(argument) & 2) !== 0)
      ) {
        asserted = true;
        return;
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "assert" &&
        node.expression.name.text !== "ok" &&
        node.arguments.some((argument) => (flow(argument) & 2) !== 0)
      ) {
        asserted = true;
        return;
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "assert" &&
        node.arguments.some((argument) => (flow(argument) & 2) !== 0)
      ) {
        asserted = true;
        return;
      }
    }
    ts.forEachChild(node, inspect);
  };
  for (const root of reachable) inspect(root);
  return asserted;
};

const testBindsExport = ({
  testPath,
  activePaths,
  exportName,
  errors,
  program,
  checker,
}) => {
  const source =
    program.getSourceFile(testPath) ??
    typescriptSource(testPath, testPath, errors);
  if (!source) return false;
  const classAuthorities = new Set();
  const functionAuthorities = new Set();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    if (statement.importClause.isTypeOnly) continue;
    const target = resolveStaticModule(
      testPath,
      statement.moduleSpecifier.text,
    );
    if (!target) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      if (element.isTypeOnly) continue;
      const importedName = element.propertyName?.text ?? element.name.text;
      if (importedName !== exportName) continue;
      const targets = valueExportTargets({
        absolute: target,
        exportName: importedName,
        program,
        checker,
      });
      if ([...targets].some((candidate) => activePaths.has(candidate))) {
        const symbol = checker.getSymbolAtLocation(element.name);
        const targetSymbol = symbol
          ? resolvedSymbol(checker, element.name)
          : undefined;
        if (symbol && targetSymbol) {
          const targetSet =
            authorityRuntimeKind(checker, symbol) === "class"
              ? classAuthorities
              : functionAuthorities;
          targetSet.add(targetSymbol);
        }
      }
    }
  }
  if (classAuthorities.size === 0 && functionAuthorities.size === 0)
    return false;
  const testCallbacks = [];
  const hookCallbacks = [];
  const discover = (node) => {
    if (ts.isCallExpression(node)) {
      const family = callFamilyName(node);
      const callback = functionArgument(node);
      if (callback && new Set(["it", "test"]).has(family))
        testCallbacks.push(callback);
      if (
        callback &&
        new Set(["beforeEach", "beforeAll", "afterEach", "afterAll"]).has(
          family,
        )
      ) {
        hookCallbacks.push(callback);
      }
    }
    ts.forEachChild(node, discover);
  };
  discover(source);
  for (const callback of testCallbacks) {
    if (
      hasCausalBehaviorAssertion({
        roots: [callback, ...hookCallbacks],
        checker,
        classAuthorities,
        functionAuthorities,
      })
    )
      return true;
  }
  return false;
};

export const verifySourceAuthorities = ({
  repositoryRoot,
  manifestPath = DEFAULT_MANIFEST_PATH,
}) => {
  const errors = [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return [`unable to read source authorities: ${stableErrorMessage(error)}`];
  }
  const rootIndexPath = "index.ts";
  const trackedEntries = trackedRepositoryEntries(repositoryRoot);
  const rootIndexError = trackedRegularFileError(
    repositoryRoot,
    rootIndexPath,
    "root export authority",
    trackedEntries,
  );
  if (rootIndexError) errors.push(rootIndexError);
  const rootIndex = resolve(repositoryRoot, rootIndexPath);
  const rootNames = [
    rootIndex,
    ...(manifest.source_authorities ?? []).flatMap((authority) => {
      const endpoint =
        authority.root?.state === "active"
          ? authority.root
          : authority.workspace;
      return [...(endpoint.paths ?? []), ...(endpoint.tests ?? [])].flatMap(
        (path) => {
          const absolute = sourcePathInside(repositoryRoot, path);
          return absolute ? [absolute] : [];
        },
      );
    }),
  ];
  const program = ts.createProgram({
    rootNames: [...new Set(rootNames)],
    options: {
      allowJs: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
    },
  });
  const checker = program.getTypeChecker();
  for (const authority of manifest.source_authorities ?? []) {
    const endpoint =
      authority.root?.state === "active" ? authority.root : authority.workspace;
    const label = `active source authority ${String(authority.id)}`;
    for (const path of [...(endpoint.paths ?? []), ...(endpoint.tests ?? [])]) {
      const error = trackedRegularFileError(
        repositoryRoot,
        path,
        label,
        trackedEntries,
      );
      if (error) errors.push(error);
    }
    const activePaths = new Set(
      (endpoint.paths ?? []).flatMap((path) => {
        const absolute = sourcePathInside(repositoryRoot, path);
        return absolute ? [absolute] : [];
      }),
    );
    for (const name of endpoint.exports ?? []) {
      const sourceTargets = new Set();
      for (const path of activePaths) {
        for (const target of valueExportTargets({
          absolute: path,
          exportName: name,
          program,
          checker,
        })) {
          sourceTargets.add(target);
        }
      }
      if (
        sourceTargets.size !== 1 ||
        [...sourceTargets].some((target) => !activePaths.has(target))
      ) {
        errors.push(
          `${label} ${name} is not a unique runtime value export of its bound paths`,
        );
      }
      if (!PHASE1_INTERNAL_AUTHORITY_EXPORTS.has(name)) {
        const rootTargets = valueExportTargets({
          absolute: rootIndex,
          exportName: name,
          program,
          checker,
        });
        if (
          rootTargets.size !== 1 ||
          [...rootTargets].some((target) => !activePaths.has(target))
        ) {
          errors.push(
            `${label} ${name} does not resolve as a runtime value from root index to its active owner path`,
          );
        }
      }
      const tests = (endpoint.tests ?? []).flatMap((path) => {
        const absolute = sourcePathInside(repositoryRoot, path);
        return absolute ? [absolute] : [];
      });
      if (
        !tests.some((testPath) =>
          testBindsExport({
            testPath,
            activePaths,
            exportName: name,
            errors,
            program,
            checker,
          }),
        )
      ) {
        errors.push(
          `${label} ${name} has no observable test assertion over a runtime value import`,
        );
      }
    }
  }
  return errors;
};

export const validatePhase2ManifestSnapshotFile = (filePath) => {
  let authorityBytes;
  let snapshotBytes;
  try {
    authorityBytes = readFileSync(DEFAULT_MANIFEST_PATH, "utf8");
    snapshotBytes = readFileSync(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`unable to read Phase 2 frozen snapshot ${filePath}: ${message}`];
  }
  if (snapshotBytes !== authorityBytes) {
    return ["frozen snapshot bytes differ from the Phase 2 authority"];
  }
  return validatePhase2ManifestFile(filePath);
};

const isDirectExecution =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  const manifestPath = process.argv[2]
    ? resolve(process.argv[2])
    : DEFAULT_MANIFEST_PATH;
  const errors = [...validatePhase2ManifestFile(manifestPath)];
  if (resolve(manifestPath) === resolve(DEFAULT_MANIFEST_PATH)) {
    errors.push(
      ...verifyPhase1PrerequisiteHistory({
        repositoryRoot: resolve(scriptDirectory, "../.."),
      }),
      ...verifySourceAuthorities({
        repositoryRoot: resolve(scriptDirectory, "../.."),
        manifestPath,
      }),
      ...verifyAtomicAuthorityMigrations({
        repositoryRoot: resolve(scriptDirectory, "../.."),
      }),
    );
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`phase2-manifest: ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`phase2-manifest: valid (${manifestPath})`);
  }
}
