import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  computePhase2CanonicalSha256,
  DEFAULT_MANIFEST_PATH,
  validatePhase2Manifest,
  validatePhase2ManifestFile,
  // @ts-expect-error The production checker intentionally ships as plain Node ESM.
} from "../../../scripts/gates/check-phase2-manifest.mjs";

type Manifest = {
  schema_version: string;
  phase: number;
  baseline: { repository: string; sha: string };
  evidence_root: string;
  mutation_thresholds: { critical: number; core: number };
  phase1_prerequisites: string[];
  requirements: Array<{
    id: string;
    priority: string;
    dependencies: string[];
    owner: string;
    test_suites: string[];
    eval_suites: string[];
    evidence_path: string;
    mutation_class: string;
  }>;
};

const fixturePath = (kind: "valid" | "invalid", name: string) =>
  resolve(process.cwd(), "fixtures", "phase-2", kind, name);

const checkerPath = resolve(
  process.cwd(),
  "scripts/gates/check-phase2-manifest.mjs",
);

const runCheckerCli = (args: string[] = []) =>
  spawnSync(process.execPath, [checkerPath, ...args], {
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
  });

const loadFixture = (kind: "valid" | "invalid", name: string): Manifest =>
  JSON.parse(readFileSync(fixturePath(kind, name), "utf8")) as Manifest;

const clone = (manifest: Manifest): Manifest => structuredClone(manifest);

const requirement = (manifest: Manifest, id: string) => {
  const result = manifest.requirements.find((entry) => entry.id === id);
  if (!result) throw new Error(`test fixture is missing ${id}`);
  return result;
};

const expectCanonicalHashMismatch = (errors: string[]) => {
  expect(
    errors.some((error) =>
      error.startsWith(
        "manifest canonical SHA-256 does not match frozen authority; expected ",
      ),
    ),
  ).toBe(true);
};

describe("Phase 2 release-gate manifest", () => {
  it("accepts the valid fixture and the source-release authority manifest", () => {
    expect(
      validatePhase2Manifest(loadFixture("valid", "phase2-gate.json")),
    ).toEqual([]);
    expect(validatePhase2ManifestFile(DEFAULT_MANIFEST_PATH)).toEqual([]);
  });

  it("keeps the authority and fixtures intentionally synchronized", () => {
    const validBytes = readFileSync(
      fixturePath("valid", "phase2-gate.json"),
      "utf8",
    );
    expect(readFileSync(DEFAULT_MANIFEST_PATH, "utf8")).toBe(validBytes);

    const valid = JSON.parse(validBytes) as Manifest;
    const invalid = loadFixture("invalid", "phase2-gate-cycle.json");
    expect(requirement(invalid, "AH-HOOK-001").dependencies.pop()).toBe(
      "AH-CONTEXT-COMPILER-001",
    );
    expect(invalid).toEqual(valid);
  });

  it("never throws when canonical JSON input contains a cycle", () => {
    const circular = loadFixture("valid", "phase2-gate.json") as Manifest & {
      self?: unknown;
    };
    circular.self = circular;
    let errors: string[] = [];
    expect(() => {
      errors = validatePhase2Manifest(circular);
    }).not.toThrow();
    expect(errors).toContain(
      "manifest canonicalization failed: circular reference at $.self",
    );
  });

  it.each([
    ["bigint", 2n, "unsupported bigint at $.phase"],
    ["undefined", undefined, "unsupported undefined at $.phase"],
    ["function", () => undefined, "unsupported function at $.phase"],
    ["symbol", Symbol("phase"), "unsupported symbol at $.phase"],
    ["NaN", Number.NaN, "non-finite number NaN at $.phase"],
    [
      "Infinity",
      Number.POSITIVE_INFINITY,
      "non-finite number Infinity at $.phase",
    ],
  ])(
    "returns a stable error instead of throwing for %s",
    (_label, value, message) => {
      const manifest = loadFixture("valid", "phase2-gate.json");
      (manifest as unknown as Record<string, unknown>).phase = value;
      let errors: string[] = [];
      expect(() => {
        errors = validatePhase2Manifest(manifest);
      }).not.toThrow();
      expect(errors).toContain(`manifest canonicalization failed: ${message}`);
    },
  );

  it("rejects non-plain objects without throwing", () => {
    const manifest = loadFixture("valid", "phase2-gate.json");
    (manifest as unknown as Record<string, unknown>).baseline = new Date(0);
    let errors: string[] = [];
    expect(() => {
      errors = validatePhase2Manifest(manifest);
    }).not.toThrow();
    expect(errors).toContain(
      "manifest canonicalization failed: non-plain object Date at $.baseline",
    );
  });

  it("throws a typed error only from the low-level canonical hash API", () => {
    let thrown: unknown;
    try {
      computePhase2CanonicalSha256({ value: 2n });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      name: "CanonicalJsonError",
      code: "ERR_INVALID_CANONICAL_JSON",
      message: "unsupported bigint at $.value",
    });
  });

  it("exercises the real CLI without a shell", () => {
    const valid = runCheckerCli();
    expect(valid.error).toBeUndefined();
    expect(valid.status).toBe(0);
    expect(valid.stdout).toContain("phase2-manifest: valid");
    expect(valid.stderr).toBe("");

    const cycle = runCheckerCli([
      fixturePath("invalid", "phase2-gate-cycle.json"),
    ]);
    expect(cycle.error).toBeUndefined();
    expect(cycle.status).toBe(1);
    expect(cycle.stderr).toContain("dependency cycle detected");

    const missing = runCheckerCli([
      fixturePath("invalid", "missing-phase2-gate.json"),
    ]);
    expect(missing.error).toBeUndefined();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("unable to read Phase 2 manifest");

    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), "phase2-gate-manifest-"),
    );
    const malformedPath = join(temporaryDirectory, "malformed.json");
    try {
      writeFileSync(malformedPath, "{not-json", "utf8");
      const malformed = runCheckerCli([malformedPath]);
      expect(malformed.error).toBeUndefined();
      expect(malformed.status).toBe(1);
      expect(malformed.stderr).toContain("unable to read Phase 2 manifest");
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("requires exactly 64 unique requirement IDs", () => {
    const tooShort = loadFixture("valid", "phase2-gate.json");
    tooShort.requirements.pop();
    expect(validatePhase2Manifest(tooShort)).toContain(
      "manifest.requirements must contain exactly 64 entries; received 63",
    );

    const duplicate = loadFixture("valid", "phase2-gate.json");
    duplicate.requirements[1]!.id = duplicate.requirements[0]!.id;
    expect(validatePhase2Manifest(duplicate)).toContain(
      "duplicate requirement id: AH-CONTEXT-COMPILER-001",
    );

    const substituted = loadFixture("valid", "phase2-gate.json");
    requirement(substituted, "AH-DOC-INGEST-DOCX-001").id = "AH-FAKE-001";
    expect(validatePhase2Manifest(substituted)).toContain(
      "manifest requirement set contains unknown id: AH-FAKE-001",
    );
    expect(validatePhase2Manifest(substituted)).toContain(
      "manifest requirement set is missing required id: AH-DOC-INGEST-DOCX-001",
    );
  });

  it("rejects undeclared external prerequisites and malformed dependency graphs", () => {
    const unknown = loadFixture("valid", "phase2-gate.json");
    requirement(unknown, "AH-CONTEXT-COMPILER-001").dependencies.push(
      "AH-UNKNOWN-001",
    );
    expect(validatePhase2Manifest(unknown)).toContain(
      "requirement AH-CONTEXT-COMPILER-001 depends on unknown requirement AH-UNKNOWN-001; add it to phase1_prerequisites if it is an external prerequisite",
    );

    const undeclared = loadFixture("valid", "phase2-gate.json");
    undeclared.phase1_prerequisites = undeclared.phase1_prerequisites.filter(
      (id) => id !== "AH-RUNTIME-SESSION-001",
    );
    expect(validatePhase2Manifest(undeclared)).toContain(
      "requirement AH-PAUSE-RESUME-001 depends on unknown requirement AH-RUNTIME-SESSION-001; add it to phase1_prerequisites if it is an external prerequisite",
    );

    expect(
      validatePhase2ManifestFile(
        fixturePath("invalid", "phase2-gate-cycle.json"),
      ),
    ).toContain(
      "dependency cycle detected: AH-CONTEXT-COMPILER-001 -> AH-RUNTIME-COMPACTION-001 -> AH-HOOK-001 -> AH-CONTEXT-COMPILER-001",
    );
  });

  it("rejects unexpected fields at every manifest object boundary", () => {
    const rootExtra = loadFixture("valid", "phase2-gate.json");
    (rootExtra as unknown as Record<string, unknown>).status = "PASS";
    const rootErrors = validatePhase2Manifest(rootExtra);
    expect(rootErrors).toContain("manifest contains unexpected field status");
    expectCanonicalHashMismatch(rootErrors);

    const baselineExtra = loadFixture("valid", "phase2-gate.json");
    (baselineExtra.baseline as unknown as Record<string, unknown>).branch =
      "main";
    const baselineErrors = validatePhase2Manifest(baselineExtra);
    expect(baselineErrors).toContain(
      "manifest.baseline contains unexpected field branch",
    );
    expectCanonicalHashMismatch(baselineErrors);

    const thresholdExtra = loadFixture("valid", "phase2-gate.json");
    (
      thresholdExtra.mutation_thresholds as unknown as Record<string, unknown>
    ).egress = 0;
    const thresholdErrors = validatePhase2Manifest(thresholdExtra);
    expect(thresholdErrors).toContain(
      "manifest.mutation_thresholds contains unexpected field egress",
    );
    expectCanonicalHashMismatch(thresholdErrors);

    const requirementExtra = loadFixture("valid", "phase2-gate.json");
    (
      requirement(requirementExtra, "AH-RAG-QUERY-001") as unknown as Record<
        string,
        unknown
      >
    ).implementation_status = "verified";
    const requirementErrors = validatePhase2Manifest(requirementExtra);
    expect(requirementErrors).toContain(
      "requirement AH-RAG-QUERY-001 contains unexpected field implementation_status",
    );
    expectCanonicalHashMismatch(requirementErrors);
  });

  it("treats array order as part of the frozen authority", () => {
    const reordered = loadFixture("valid", "phase2-gate.json");
    requirement(reordered, "AH-UI-TUI-001").dependencies.reverse();
    expectCanonicalHashMismatch(validatePhase2Manifest(reordered));
  });

  it("freezes every requirement's complete dependency set", () => {
    const missingOriginal = loadFixture("valid", "phase2-gate.json");
    requirement(missingOriginal, "AH-DOC-INGEST-DOCX-001").dependencies = [];
    expect(validatePhase2Manifest(missingOriginal)).toContain(
      'requirement AH-DOC-INGEST-DOCX-001 dependencies must exactly match frozen authority; expected ["AH-TOOL-READ-001"], received []',
    );

    const extraAcyclic = loadFixture("valid", "phase2-gate.json");
    requirement(extraAcyclic, "AH-DOC-INGEST-DOCX-001").dependencies.push(
      "AH-HOOK-001",
    );
    expect(validatePhase2Manifest(extraAcyclic)).toContain(
      'requirement AH-DOC-INGEST-DOCX-001 dependencies must exactly match frozen authority; expected ["AH-TOOL-READ-001"], received ["AH-TOOL-READ-001","AH-HOOK-001"]',
    );
  });

  it("requires the canonical evidence root and per-requirement evidence paths", () => {
    const wrongRoot = loadFixture("valid", "phase2-gate.json");
    wrongRoot.evidence_root = "artifacts/phase2";
    expect(validatePhase2Manifest(wrongRoot)).toContain(
      'manifest.evidence_root must be "artifacts/phase-2"; received "artifacts/phase2"',
    );

    const wrongPath = loadFixture("valid", "phase2-gate.json");
    requirement(wrongPath, "AH-RAG-QUERY-001").evidence_path =
      "artifacts/phase2/AH-RAG-QUERY-001.json";
    expect(validatePhase2Manifest(wrongPath)).toContain(
      'requirement AH-RAG-QUERY-001 evidence_path must be "artifacts/phase-2/AH-RAG-QUERY-001.json"; received "artifacts/phase2/AH-RAG-QUERY-001.json"',
    );
  });

  it("requires ownership, test suites, mutation classes, and minimum thresholds", () => {
    const missingOwner = loadFixture("valid", "phase2-gate.json");
    requirement(missingOwner, "AH-RAG-QUERY-001").owner = "";
    expect(validatePhase2Manifest(missingOwner)).toContain(
      "requirement AH-RAG-QUERY-001 owner must be a non-empty string",
    );

    const missingSuite = loadFixture("valid", "phase2-gate.json");
    requirement(missingSuite, "AH-RAG-QUERY-001").test_suites = [];
    expect(validatePhase2Manifest(missingSuite)).toContain(
      "requirement AH-RAG-QUERY-001 test_suites must be a non-empty array",
    );

    const badSuite = loadFixture("valid", "phase2-gate.json");
    requirement(badSuite, "AH-RAG-QUERY-001").test_suites = ["banana"];
    expect(validatePhase2Manifest(badSuite)).toContain(
      'requirement AH-RAG-QUERY-001 test_suites entry must be a concrete Phase 2 test path without traversal; received "banana"',
    );

    const missingEval = loadFixture("valid", "phase2-gate.json");
    requirement(missingEval, "AH-RAG-QUERY-001").eval_suites = [];
    expect(validatePhase2Manifest(missingEval)).toContain(
      "requirement AH-RAG-QUERY-001 eval_suites must be a non-empty array",
    );

    const badEval = loadFixture("valid", "phase2-gate.json");
    requirement(badEval, "AH-RAG-QUERY-001").eval_suites = [
      "evals/../phase-2.yaml",
    ];
    expect(validatePhase2Manifest(badEval)).toContain(
      'requirement AH-RAG-QUERY-001 eval_suites entry must be one of the seven Phase 2 eval paths; received "evals/../phase-2.yaml"',
    );

    const badClass = loadFixture("valid", "phase2-gate.json");
    requirement(badClass, "AH-RAG-QUERY-001").mutation_class = "optional";
    expect(validatePhase2Manifest(badClass)).toContain(
      'requirement AH-RAG-QUERY-001 mutation_class must be "critical" or "core"; received "optional"',
    );

    const lowCritical = loadFixture("valid", "phase2-gate.json");
    lowCritical.mutation_thresholds.critical = 89;
    expect(validatePhase2Manifest(lowCritical)).toContain(
      "mutation_thresholds.critical must be at least 90; received 89",
    );

    const lowCore = loadFixture("valid", "phase2-gate.json");
    lowCore.mutation_thresholds.core = 84;
    expect(validatePhase2Manifest(lowCore)).toContain(
      "mutation_thresholds.core must be at least 85; received 84",
    );
  });

  it("locks valid-looking priorities, owners, and suites to each requirement", () => {
    const wrongPriority = loadFixture("valid", "phase2-gate.json");
    requirement(wrongPriority, "AH-RAG-QUERY-001").priority = "P1";
    expect(validatePhase2Manifest(wrongPriority)).toContain(
      'requirement AH-RAG-QUERY-001 priority must exactly match frozen authority; expected "P0", received "P1"',
    );

    const swappedOwner = loadFixture("valid", "phase2-gate.json");
    requirement(swappedOwner, "AH-RAG-QUERY-001").owner = "apps/web";
    expect(validatePhase2Manifest(swappedOwner)).toContain(
      'requirement AH-RAG-QUERY-001 owner must exactly match frozen authority; expected "packages/rag", received "apps/web"',
    );

    const borrowedSuite = loadFixture("valid", "phase2-gate.json");
    requirement(borrowedSuite, "AH-RAG-QUERY-001").test_suites = [
      "tests/phase-2/unit/ah-rag-meta-001.test.ts",
    ];
    expect(validatePhase2Manifest(borrowedSuite)).toContain(
      'requirement AH-RAG-QUERY-001 test_suites must exactly match frozen authority; expected ["tests/phase-2/unit/ah-rag-query-001.test.ts"], received ["tests/phase-2/unit/ah-rag-meta-001.test.ts"]',
    );

    const borrowedEval = loadFixture("valid", "phase2-gate.json");
    requirement(borrowedEval, "AH-RAG-QUERY-001").eval_suites = [
      "evals/research/phase-2.yaml",
    ];
    expect(validatePhase2Manifest(borrowedEval)).toContain(
      'requirement AH-RAG-QUERY-001 eval_suites must exactly match frozen authority; expected ["evals/documents/phase-2.yaml"], received ["evals/research/phase-2.yaml"]',
    );
  });

  it.each([
    "AH-TOOL-BEHAVIOR-VERIFY-001",
    "AH-TOOL-WEB-FETCH-001",
    "AH-TOOL-WEB-SEARCH-001",
    "AH-UI-TUI-001",
  ])("keeps risk-critical requirement %s at the 90 mutation gate", (id) => {
    const downgraded = loadFixture("valid", "phase2-gate.json");
    requirement(downgraded, id).mutation_class = "core";
    expect(validatePhase2Manifest(downgraded)).toContain(
      `requirement ${id} mutation_class must exactly match frozen authority; expected "critical", received "core"`,
    );
  });

  it("rejects any canonical authority hash drift", () => {
    const tampered = loadFixture("valid", "phase2-gate.json");
    tampered.mutation_thresholds.critical = 91;
    expectCanonicalHashMismatch(validatePhase2Manifest(tampered));
  });

  it("cannot bypass frozen authority by passing a second API argument", () => {
    const drifted = loadFixture("valid", "phase2-gate.json");
    requirement(drifted, "AH-RAG-QUERY-001").priority = "P1";
    requirement(drifted, "AH-RAG-QUERY-001").owner = "apps/web";
    requirement(drifted, "AH-RAG-QUERY-001").mutation_class = "core";
    const errors = validatePhase2Manifest(drifted, {
      enforceAuthority: false,
    });
    expect(errors).toContain(
      'requirement AH-RAG-QUERY-001 priority must exactly match frozen authority; expected "P0", received "P1"',
    );
    expect(errors).toContain(
      'requirement AH-RAG-QUERY-001 owner must exactly match frozen authority; expected "packages/rag", received "apps/web"',
    );
    expect(errors).toContain(
      'requirement AH-RAG-QUERY-001 mutation_class must exactly match frozen authority; expected "critical", received "core"',
    );
    expectCanonicalHashMismatch(errors);
  });

  it("pins Phase 2 to the source-release baseline", () => {
    const wrongPhase = loadFixture("valid", "phase2-gate.json");
    wrongPhase.phase = 3;
    expect(validatePhase2Manifest(wrongPhase)).toContain(
      "manifest.phase must be 2; received 3",
    );

    const wrongSha = loadFixture("valid", "phase2-gate.json");
    wrongSha.baseline.sha = "deadbeef";
    expect(validatePhase2Manifest(wrongSha)).toContain(
      'manifest.baseline.sha must be "bf5eac648527205603de7d26278276ad78819850"; received "deadbeef"',
    );

    const wrongRepository = loadFixture("valid", "phase2-gate.json");
    wrongRepository.baseline.repository = "internal-factory";
    expect(validatePhase2Manifest(wrongRepository)).toContain(
      'manifest.baseline.repository must be "https://github.com/123oqwe/agentharness91.git"; received "internal-factory"',
    );
  });

  it("enforces every release-critical dependency edge", () => {
    const valid = loadFixture("valid", "phase2-gate.json");
    const requiredEdges: Array<[string, string]> = [
      ["AH-DOC-INGEST-WEB-001", "AH-TOOL-WEB-FETCH-001"],
      ["AH-RAG-QUERY-001", "AH-RAG-EMBED-001"],
      ["AH-RAG-QUERY-001", "AH-RAG-META-001"],
      ["AH-RAG-QUERY-001", "AH-RAG-FTS-001"],
      ["AH-RAG-DELETE-001", "AH-RAG-EMBED-001"],
      ["AH-RAG-DELETE-001", "AH-RAG-META-001"],
      ["AH-RAG-DELETE-001", "AH-RAG-GRAPH-001"],
      ["AH-RAG-DELETE-001", "AH-RAG-FTS-001"],
      ["AH-RUNTIME-COMPACTION-001", "AH-HOOK-001"],
      ["AH-TOOL-ESCALATE-001", "AH-CONTRACT-TOOLSPEC-001"],
      ["AH-TOOL-ESCALATE-001", "AH-POLICY-ENGINE-001"],
      ["AH-TOOL-ESCALATE-001", "AH-CAPMAP-020"],
      ["AH-TOOL-ESCALATE-001", "AH-PAUSE-RESUME-001"],
      ["AH-UI-PLANNING-001", "AH-PA-VERTICAL-001"],
      ["AH-UI-NOTIFY-001", "AH-TOOL-ESCALATE-001"],
      ["AH-UI-TUI-001", "AH-UI-CHAT-001"],
      ["AH-UI-TUI-001", "AH-UX-API-001"],
      ["AH-UI-TUI-001", "AH-UX-CONTRACT-001"],
      ["AH-UI-TUI-001", "AH-RUNTIME-STEERING-001"],
    ];

    const webBackends: Record<string, string> = {
      "AH-UI-DOC-001": "AH-DOC-VERTICAL-001",
      "AH-UI-MM-001": "AH-MM-ARTIFACT-001",
      "AH-UI-NOTIFY-001": "AH-CAPMAP-020",
      "AH-UI-PLANNING-001": "AH-PLANNING-VERTICAL-001",
      "AH-UI-RECONCILE-001": "AH-PAUSE-RESUME-001",
      "AH-UI-RESEARCH-001": "AH-RESEARCH-VERTICAL-001",
      "AH-UI-WRITING-001": "AH-WRITING-VERTICAL-001",
    };
    for (const [id, backend] of Object.entries(webBackends)) {
      requiredEdges.push(
        [id, "AH-UX-WEB-001"],
        [id, "AH-UX-CONTRACT-001"],
        [id, backend],
        ["AH-UX-STATES-001", id],
      );
    }
    requiredEdges.push(
      ["AH-UX-STATES-001", "AH-UI-TUI-001"],
      ["AH-UX-STATES-001", "AH-UX-WEB-001"],
    );

    for (const [id, dependency] of requiredEdges) {
      const missingEdge = clone(valid);
      requirement(missingEdge, id).dependencies = requirement(
        missingEdge,
        id,
      ).dependencies.filter((candidate) => candidate !== dependency);
      expect(
        validatePhase2Manifest(missingEdge),
        `${id} -> ${dependency}`,
      ).toContain(
        `requirement ${id} is missing required dependency ${dependency}`,
      );
    }
  });
});
