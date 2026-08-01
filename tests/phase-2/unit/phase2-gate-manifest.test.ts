import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
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
    evidence_path: string;
    mutation_class: string;
  }>;
};

const fixturePath = (kind: "valid" | "invalid", name: string) =>
  resolve(process.cwd(), "fixtures", "phase-2", kind, name);

const loadFixture = (kind: "valid" | "invalid", name: string): Manifest =>
  JSON.parse(readFileSync(fixturePath(kind, name), "utf8")) as Manifest;

const clone = (manifest: Manifest): Manifest => structuredClone(manifest);

const requirement = (manifest: Manifest, id: string) => {
  const result = manifest.requirements.find((entry) => entry.id === id);
  if (!result) throw new Error(`test fixture is missing ${id}`);
  return result;
};

describe("Phase 2 release-gate manifest", () => {
  it("accepts the valid fixture and the source-release authority manifest", () => {
    expect(
      validatePhase2Manifest(loadFixture("valid", "phase2-gate.json")),
    ).toEqual([]);
    expect(validatePhase2ManifestFile(DEFAULT_MANIFEST_PATH)).toEqual([]);
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
      ["AH-RAG-DELETE-001", "AH-RAG-EMBED-001"],
      ["AH-RAG-DELETE-001", "AH-RAG-META-001"],
      ["AH-RAG-DELETE-001", "AH-RAG-GRAPH-001"],
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
    requiredEdges.push(["AH-UX-STATES-001", "AH-UI-TUI-001"]);

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
