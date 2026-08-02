// Phase 2 mutation scope authority.
//
// This registry is deliberately source-owned and independent from the Phase 2
// release manifest. The gate compares both authorities byte-for-byte at the
// semantic field level so manifest drift cannot silently lower mutation scope.
// `sources` are requirement-owned files mutated by the Phase 2 requirement.
// `integrationSources` are shared consumers bound to the same commit/tree but
// mutated by their existing Phase 1 module; they never enter Phase 2 chunks.

export const phase2MutationThresholds = Object.freeze({
  critical: 90,
  core: 85,
});

const requirement = (
  id,
  mutationClass,
  tests,
  { sources = [], integrationSources = [], status = "not_started" } = {},
) =>
  Object.freeze({
    id,
    mutationClass,
    status,
    sources: Object.freeze([...sources]),
    integrationSources: Object.freeze([...integrationSources]),
    tests: Object.freeze([...tests]),
  });

export const phase2MutationRequirements = Object.freeze([
  requirement("AH-CONTEXT-COMPILER-001", "critical", [
    "tests/phase-2/unit/ah-context-compiler-001.test.ts",
  ]),
  requirement("AH-DOC-INGEST-DOCX-001", "core", [
    "tests/phase-2/unit/ah-doc-ingest-docx-001.test.ts",
  ]),
  requirement("AH-DOC-INGEST-ENC-001", "core", [
    "tests/phase-2/unit/ah-doc-ingest-enc-001.test.ts",
  ]),
  requirement("AH-DOC-INGEST-IMG-001", "core", [
    "tests/phase-2/unit/ah-doc-ingest-img-001.test.ts",
  ]),
  requirement("AH-DOC-INGEST-MD-001", "core", [
    "tests/phase-2/unit/ah-doc-ingest-md-001.test.ts",
  ]),
  requirement("AH-DOC-INGEST-PDF-001", "core", [
    "tests/phase-2/unit/ah-doc-ingest-pdf-001.test.ts",
  ]),
  requirement("AH-DOC-INGEST-PPTX-001", "core", [
    "tests/phase-2/unit/ah-doc-ingest-pptx-001.test.ts",
  ]),
  requirement("AH-DOC-INGEST-UNSUPPORTED-001", "core", [
    "tests/phase-2/unit/ah-doc-ingest-unsupported-001.test.ts",
  ]),
  requirement("AH-DOC-INGEST-WEB-001", "critical", [
    "tests/phase-2/unit/ah-doc-ingest-web-001.test.ts",
  ]),
  requirement("AH-DOC-INGEST-XLSX-001", "core", [
    "tests/phase-2/unit/ah-doc-ingest-xlsx-001.test.ts",
  ]),
  requirement("AH-DOC-PARSE-HEAD-001", "core", [
    "tests/phase-2/unit/ah-doc-parse-head-001.test.ts",
  ]),
  requirement("AH-DOC-PARSE-IMGREF-001", "core", [
    "tests/phase-2/unit/ah-doc-parse-imgref-001.test.ts",
  ]),
  requirement("AH-DOC-PARSE-PROVENANCE-001", "core", [
    "tests/phase-2/unit/ah-doc-parse-provenance-001.test.ts",
  ]),
  requirement("AH-DOC-PARSE-TABLE-001", "core", [
    "tests/phase-2/unit/ah-doc-parse-table-001.test.ts",
  ]),
  requirement("AH-HOOK-001", "critical", [
    "tests/phase-2/unit/ah-hook-001.test.ts",
    "tests/phase-2/integration/ah-hook-001-pipeline.test.ts",
    "tests/phase-2/security/ah-hook-001-injection.test.ts",
  ]),
  requirement("AH-MCP-STDIO-001", "critical", [
    "tests/phase-2/unit/ah-mcp-stdio-001.test.ts",
  ]),
  requirement("AH-MM-ARTIFACT-001", "core", [
    "tests/phase-2/unit/ah-mm-artifact-001.test.ts",
  ]),
  requirement("AH-MM-DOC-VISION-001", "critical", [
    "tests/phase-2/unit/ah-mm-doc-vision-001.test.ts",
  ]),
  requirement("AH-MM-IMAGE-EDIT-001", "critical", [
    "tests/phase-2/unit/ah-mm-image-edit-001.test.ts",
  ]),
  requirement("AH-MM-IMAGE-GEN-001", "critical", [
    "tests/phase-2/unit/ah-mm-image-gen-001.test.ts",
  ]),
  requirement("AH-MM-IMAGE-IN-001", "core", [
    "tests/phase-2/unit/ah-mm-image-in-001.test.ts",
  ]),
  requirement("AH-MM-VISION-VERIFY-001", "critical", [
    "tests/phase-2/unit/ah-mm-vision-verify-001.test.ts",
  ]),
  requirement("AH-PAUSE-RESUME-001", "critical", [
    "tests/phase-2/unit/ah-pause-resume-001.test.ts",
  ]),
  requirement("AH-SANDBOX-OCI-001", "critical", [
    "tests/phase-2/security/ah-sandbox-oci-001.test.ts",
  ]),
  requirement("AH-RAG-CHUNK-001", "core", [
    "tests/phase-2/unit/ah-rag-chunk-001.test.ts",
  ]),
  requirement("AH-RAG-CITE-001", "core", [
    "tests/phase-2/unit/ah-rag-cite-001.test.ts",
  ]),
  requirement("AH-RAG-DELETE-001", "critical", [
    "tests/phase-2/unit/ah-rag-delete-001.test.ts",
  ]),
  requirement("AH-RAG-EMBED-001", "core", [
    "tests/phase-2/unit/ah-rag-embed-001.test.ts",
  ]),
  requirement("AH-RAG-EMBED-MIG-001", "core", [
    "tests/phase-2/unit/ah-rag-embed-mig-001.test.ts",
  ]),
  requirement("AH-RAG-FTS-001", "core", [
    "tests/phase-2/unit/ah-rag-fts-001.test.ts",
  ]),
  requirement("AH-RAG-GRAPH-001", "core", [
    "tests/phase-2/unit/ah-rag-graph-001.test.ts",
  ]),
  requirement("AH-RAG-INJECTION-001", "critical", [
    "tests/phase-2/security/ah-rag-injection-001.test.ts",
  ]),
  requirement("AH-RAG-META-001", "core", [
    "tests/phase-2/unit/ah-rag-meta-001.test.ts",
  ]),
  requirement("AH-RAG-QUERY-001", "critical", [
    "tests/phase-2/unit/ah-rag-query-001.test.ts",
  ]),
  requirement("AH-RAG-RERANK-001", "core", [
    "tests/phase-2/unit/ah-rag-rerank-001.test.ts",
  ]),
  requirement("AH-RUNTIME-BUDGET-002", "core", [
    "tests/phase-2/unit/ah-runtime-budget-002.test.ts",
  ]),
  requirement("AH-RUNTIME-COMPACTION-001", "critical", [
    "tests/phase-2/unit/ah-runtime-compaction-001.test.ts",
  ]),
  requirement("AH-RUNTIME-MODELFALLBACK-001", "critical", [
    "tests/phase-2/unit/ah-runtime-modelfallback-001.test.ts",
  ]),
  requirement("AH-RUNTIME-SESSIONTREE-001", "critical", [
    "tests/phase-2/unit/ah-runtime-sessiontree-001.test.ts",
    "tests/phase-2/integration/ah-runtime-sessiontree-001.sqlite-lock.test.ts",
    "tests/phase-2/security/ah-runtime-sessiontree-001-security.test.ts",
  ]),
  requirement("AH-RUNTIME-STEERING-001", "critical", [
    "tests/phase-2/unit/ah-runtime-steering-001.test.ts",
  ]),
  requirement("AH-TOOL-BEHAVIOR-VERIFY-001", "critical", [
    "tests/phase-2/unit/ah-tool-behavior-verify-001.test.ts",
  ]),
  requirement("AH-TOOL-IMAGE-GEN-001", "critical", [
    "tests/phase-2/unit/ah-tool-image-gen-001.test.ts",
  ]),
  requirement("AH-TOOL-SPEECH-GEN-001", "critical", [
    "tests/phase-2/unit/ah-tool-speech-gen-001.test.ts",
  ]),
  requirement("AH-TOOL-TRANSCRIBE-001", "critical", [
    "tests/phase-2/unit/ah-tool-transcribe-001.test.ts",
  ]),
  requirement("AH-TOOL-SPREADSHEET-001", "core", [
    "tests/phase-2/unit/ah-tool-spreadsheet-001.test.ts",
  ]),
  requirement("AH-TOOL-PRESENTATION-001", "core", [
    "tests/phase-2/unit/ah-tool-presentation-001.test.ts",
  ]),
  requirement("AH-TOOL-DOCUMENT-001", "core", [
    "tests/phase-2/unit/ah-tool-document-001.test.ts",
  ]),
  requirement("AH-TOOL-OCR-001", "core", [
    "tests/phase-2/unit/ah-tool-ocr-001.test.ts",
  ]),
  requirement("AH-TOOL-ESCALATE-001", "critical", [
    "tests/phase-2/unit/ah-tool-escalate-001.test.ts",
  ]),
  requirement("AH-TOOL-WEB-FETCH-001", "critical", [
    "tests/phase-2/unit/ah-tool-web-fetch-001.test.ts",
  ]),
  requirement("AH-TOOL-WEB-SEARCH-001", "critical", [
    "tests/phase-2/unit/ah-tool-web-search-001.test.ts",
  ]),
  requirement("AH-UI-DOC-001", "core", [
    "tests/phase-2/e2e/ah-ui-doc-001.test.ts",
  ]),
  requirement("AH-UI-MM-001", "core", [
    "tests/phase-2/e2e/ah-ui-mm-001.test.ts",
  ]),
  requirement("AH-UI-NOTIFY-001", "core", [
    "tests/phase-2/e2e/ah-ui-notify-001.test.ts",
  ]),
  requirement("AH-UI-PLANNING-001", "core", [
    "tests/phase-2/e2e/ah-ui-planning-001.test.ts",
  ]),
  requirement("AH-UI-RECONCILE-001", "core", [
    "tests/phase-2/e2e/ah-ui-reconcile-001.test.ts",
  ]),
  requirement("AH-UI-RESEARCH-001", "core", [
    "tests/phase-2/e2e/ah-ui-research-001.test.ts",
  ]),
  requirement("AH-UI-TUI-001", "core", [
    "tests/phase-2/e2e/ah-ui-tui-001.test.ts",
  ]),
  requirement("AH-UI-WRITING-001", "core", [
    "tests/phase-2/e2e/ah-ui-writing-001.test.ts",
  ]),
  requirement("AH-UX-API-001", "core", [
    "tests/phase-2/e2e/ah-ux-api-001.test.ts",
  ]),
  requirement("AH-UX-CONTRACT-001", "core", [
    "tests/phase-2/e2e/ah-ux-contract-001.test.ts",
  ]),
  requirement("AH-UX-DESKTOP-001", "core", [
    "tests/phase-2/e2e/ah-ux-desktop-001.test.ts",
  ]),
  requirement("AH-UX-STATES-001", "core", [
    "tests/phase-2/e2e/ah-ux-states-001.test.ts",
  ]),
  requirement("AH-UX-WEB-001", "core", [
    "tests/phase-2/e2e/ah-ux-web-001.test.ts",
  ]),
]);
