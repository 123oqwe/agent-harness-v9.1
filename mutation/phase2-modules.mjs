// Phase 2 mutation execution view.
//
// The frozen gate owns priority, dependency, owner, test, eval, Evidence, and
// mutation-class metadata. This file independently records only the requirement
// identity, exact owned mutation sources, Phase 1 integration sources, and the
// execution status needed by the mutation runner.

const requirement = (
  id,
  { sources = [], integrationSources = [], status = "not_started" } = {},
) =>
  Object.freeze({
    id,
    status,
    sources: Object.freeze([...sources]),
    integrationSources: Object.freeze([...integrationSources]),
  });

export const phase2MutationRequirements = Object.freeze([
  requirement("AH-CONTEXT-COMPILER-001", {
    status: "ready",
    sources: ["packages/runtime-core/src/context-compiler.ts"],
    integrationSources: ["vfs/virtual-filesystem.ts"],
  }),
  requirement("AH-DOC-INGEST-DOCX-001", {
    status: "ready",
    sources: ["packages/documents/src/parsers/docx-parser.ts"],
    integrationSources: [],
  }),
  requirement("AH-DOC-INGEST-ENC-001", {
    status: "ready",
    sources: ["packages/documents/src/ingestor.ts"],
    integrationSources: [],
  }),
  requirement("AH-DOC-INGEST-IMG-001", {
    status: "ready",
    sources: ["packages/documents/src/parsers/image-parser.ts"],
    integrationSources: [],
  }),
  requirement("AH-DOC-INGEST-MD-001", {
    status: "ready",
    sources: ["packages/documents/src/parsers/markdown-parser.ts"],
    integrationSources: [],
  }),
  requirement("AH-DOC-INGEST-PDF-001", {
    status: "ready",
    sources: ["packages/documents/src/parsers/pdf-parser.ts"],
    integrationSources: [],
  }),
  requirement("AH-DOC-INGEST-PPTX-001", {
    status: "ready",
    sources: ["packages/documents/src/parsers/pptx-parser.ts"],
    integrationSources: [],
  }),
  requirement("AH-DOC-INGEST-UNSUPPORTED-001", {
    status: "ready",
    sources: ["packages/documents/src/parsers/unsupported-parser.ts"],
    integrationSources: [],
  }),
  requirement("AH-DOC-INGEST-WEB-001", {
    status: "ready",
    sources: ["packages/documents/src/parsers/html-parser.ts"],
    integrationSources: [],
  }),
  requirement("AH-DOC-INGEST-XLSX-001", {
    status: "ready",
    sources: ["packages/documents/src/parsers/xlsx-parser.ts"],
    integrationSources: [],
  }),
  requirement("AH-DOC-PARSE-HEAD-001", {
    status: "ready",
    sources: ["packages/documents/src/parsers/markdown-parser.ts"],
    integrationSources: [],
  }),
  requirement("AH-DOC-PARSE-IMGREF-001", {
    status: "ready",
    sources: ["packages/documents/src/parsers/image-parser.ts"],
    integrationSources: [],
  }),
  requirement("AH-DOC-PARSE-PROVENANCE-001", {
    status: "ready",
    sources: ["packages/documents/src/parsers/markdown-parser.ts"],
    integrationSources: [],
  }),
  requirement("AH-DOC-PARSE-TABLE-001", {
    status: "ready",
    sources: ["packages/documents/src/parsers/markdown-parser.ts"],
    integrationSources: [],
  }),
  requirement("AH-HOOK-001", {
    status: "ready",
    sources: ["packages/runtime-core/src/hook-system.ts", "packages/runtime-core/src/sqlite-hook-journal.ts", "runtime/sandboxed-hook-execution-port.ts"],
    integrationSources: ["harness.ts", "router/static-router.ts", "runtime/hook-port.ts", "runtime/loop.ts", "runtime/plan-execute.ts", "runtime/react.ts", "tools/tool-dispatcher.ts"],
  }),
  requirement("AH-MCP-STDIO-001", {
    status: "ready",
    sources: ["packages/tools/src/mcp-stdio.ts"],
    integrationSources: [],
  }),
  requirement("AH-MM-ARTIFACT-001", {
    status: "ready",
    sources: ["packages/multimodal/src/artifact-store.ts"],
    integrationSources: [],
  }),
  requirement("AH-MM-DOC-VISION-001", {
    status: "ready",
    sources: ["packages/multimodal/src/vision.ts"],
    integrationSources: [],
  }),
  requirement("AH-MM-IMAGE-EDIT-001", {
    status: "ready",
    sources: ["packages/multimodal/src/image-edit.ts"],
    integrationSources: [],
  }),
  requirement("AH-MM-IMAGE-GEN-001", {
    status: "ready",
    sources: ["packages/multimodal/src/image-gen.ts"],
    integrationSources: [],
  }),
  requirement("AH-MM-IMAGE-IN-001", {
    status: "ready",
    sources: ["packages/multimodal/src/vision.ts"],
    integrationSources: [],
  }),
  requirement("AH-MM-VISION-VERIFY-001", {
    status: "ready",
    sources: ["packages/multimodal/src/vision.ts"],
    integrationSources: [],
  }),
  requirement("AH-PAUSE-RESUME-001", {
    status: "ready",
    sources: ["packages/runtime-core/src/pause-resume.ts"],
    integrationSources: ["session/sqlite-session-store.ts", "tools/tool-executor.ts"],
  }),
  requirement("AH-SANDBOX-OCI-001", {
    status: "ready",
    sources: ["packages/tools/src/oci-sandbox.ts"],
    integrationSources: [],
  }),
  requirement("AH-RAG-CHUNK-001", {
    status: "ready",
    sources: ["packages/rag/src/chunker.ts"],
    integrationSources: [],
  }),
  requirement("AH-RAG-CITE-001", {
    status: "ready",
    sources: ["packages/rag/src/citation.ts"],
    integrationSources: [],
  }),
  requirement("AH-RAG-DELETE-001", {
    status: "ready",
    sources: ["packages/rag/src/chunker.ts"],
    integrationSources: [],
  }),
  requirement("AH-RAG-EMBED-001", {
    status: "ready",
    sources: ["packages/rag/src/vector-index.ts"],
    integrationSources: [],
  }),
  requirement("AH-RAG-EMBED-MIG-001", {
    status: "ready",
    sources: ["packages/rag/src/embedding-migrator.ts"],
    integrationSources: [],
  }),
  requirement("AH-RAG-FTS-001", {
    status: "ready",
    sources: ["packages/rag/src/fts-index.ts"],
    integrationSources: [],
  }),
  requirement("AH-RAG-GRAPH-001", {
    status: "ready",
    sources: ["packages/rag/src/graph-index.ts"],
    integrationSources: [],
  }),
  requirement("AH-RAG-INJECTION-001", {
    status: "ready",
    sources: ["packages/rag/src/injection-guard.ts"],
    integrationSources: [],
  }),
  requirement("AH-RAG-META-001", {
    status: "ready",
    sources: ["packages/rag/src/metadata-index.ts"],
    integrationSources: [],
  }),
  requirement("AH-RAG-QUERY-001", {
    status: "ready",
    sources: ["packages/rag/src/query-engine.ts"],
    integrationSources: [],
  }),
  requirement("AH-RAG-RERANK-001", {
    status: "ready",
    sources: ["packages/rag/src/reranker.ts"],
    integrationSources: [],
  }),
  requirement("AH-RUNTIME-BUDGET-002", {
    status: "ready",
    sources: ["packages/runtime-core/src/budget-ledger.ts", "packages/runtime-core/src/sqlite-budget-journal.ts", "runtime/budget-port.ts"],
    integrationSources: ["harness.ts", "runtime/loop.ts"],
  }),
  requirement("AH-RUNTIME-COMPACTION-001", {
    status: "ready",
    sources: ["packages/runtime-core/src/compaction.ts", "runtime/compaction-port.ts"],
    integrationSources: ["runtime/hook-port.ts"],
  }),
  requirement("AH-RUNTIME-MODELFALLBACK-001", {
    status: "ready",
    sources: ["packages/runtime-core/src/model-fallback.ts", "runtime/model-fallback-port.ts"],
    integrationSources: ["gateway/model-gateway.ts"],
  }),
  requirement("AH-RUNTIME-SESSIONTREE-001", {
    status: "ready",
    sources: ["packages/runtime-core/src/session-tree.ts", "session/session-event-codec.ts", "session/session-state-root.ts", "session/session-tree-checkpoint.ts", "session/sqlite-authority-internals.ts", "session/sqlite-session-tree-authority.ts", "session/trusted-python-host.ts"],
    integrationSources: ["session/durable-session.ts", "session/run-session.ts", "session/sqlite-session-store.ts"],
  }),
  requirement("AH-RUNTIME-STEERING-001", {
    status: "ready",
    sources: ["packages/runtime-core/src/steering.ts", "runtime/session-steering-journal.ts"],
    integrationSources: ["harness.ts", "runtime/loop.ts", "runtime/steering-port.ts"],
  }),
  requirement("AH-TOOL-BEHAVIOR-VERIFY-001", {
    status: "ready",
    sources: ["packages/tools/src/behavior-verify.ts"],
    integrationSources: [],
  }),
  requirement("AH-TOOL-IMAGE-GEN-001", {
    status: "ready",
    sources: ["packages/multimodal/src/image-gen.ts"],
    integrationSources: [],
  }),
  requirement("AH-TOOL-SPEECH-GEN-001", {
    status: "ready",
    sources: ["packages/multimodal/src/speech.ts"],
    integrationSources: [],
  }),
  requirement("AH-TOOL-TRANSCRIBE-001", {
    status: "ready",
    sources: ["packages/multimodal/src/speech.ts"],
    integrationSources: [],
  }),
  requirement("AH-TOOL-SPREADSHEET-001", {
    status: "ready",
    sources: ["packages/tools/src/cli-tools.ts"],
    integrationSources: [],
  }),
  requirement("AH-TOOL-PRESENTATION-001", {
    status: "ready",
    sources: ["packages/tools/src/cli-tools.ts"],
    integrationSources: [],
  }),
  requirement("AH-TOOL-DOCUMENT-001", {
    status: "ready",
    sources: ["packages/tools/src/cli-tools.ts"],
    integrationSources: [],
  }),
  requirement("AH-TOOL-OCR-001", {
    status: "ready",
    sources: ["packages/tools/src/cli-tools.ts"],
    integrationSources: [],
  }),
  requirement("AH-TOOL-ESCALATE-001", {
    status: "ready",
    sources: ["packages/tools/src/escalate.ts"],
    integrationSources: [],
  }),
  requirement("AH-TOOL-WEB-FETCH-001", {
    status: "ready",
    sources: ["packages/tools/src/web-fetch.ts"],
    integrationSources: [],
  }),
  requirement("AH-TOOL-WEB-SEARCH-001", {
    status: "ready",
    sources: ["packages/tools/src/web-search.ts"],
    integrationSources: [],
  }),
  requirement("AH-UI-DOC-001", {
    status: "ready",
    sources: ["packages/ui/src/index.ts"],
    integrationSources: [],
  }),
  requirement("AH-UI-MM-001", {
    status: "ready",
    sources: ["packages/ui/src/index.ts"],
    integrationSources: [],
  }),
  requirement("AH-UI-NOTIFY-001", {
    status: "ready",
    sources: ["packages/ui/src/index.ts"],
    integrationSources: [],
  }),
  requirement("AH-UI-PLANNING-001", {
    status: "ready",
    sources: ["packages/ui/src/index.ts"],
    integrationSources: [],
  }),
  requirement("AH-UI-RECONCILE-001", {
    status: "ready",
    sources: ["packages/ui/src/index.ts"],
    integrationSources: [],
  }),
  requirement("AH-UI-RESEARCH-001", {
    status: "ready",
    sources: ["packages/ui/src/index.ts"],
    integrationSources: [],
  }),
  requirement("AH-UI-TUI-001", {
    status: "ready",
    sources: ["packages/ui/src/index.ts"],
    integrationSources: [],
  }),
  requirement("AH-UI-WRITING-001", {
    status: "ready",
    sources: ["packages/ui/src/index.ts"],
    integrationSources: [],
  }),
  requirement("AH-UX-API-001", {
    status: "ready",
    sources: ["apps/api/src/index.ts"],
    integrationSources: [],
  }),
  requirement("AH-UX-CONTRACT-001", {
    status: "ready",
    sources: ["packages/ui/src/index.ts"],
    integrationSources: [],
  }),
  requirement("AH-UX-DESKTOP-001", {
    status: "ready",
    sources: ["packages/ui/src/index.ts"],
    integrationSources: [],
  }),
  requirement("AH-UX-STATES-001", {
    status: "ready",
    sources: ["packages/ui/src/index.ts"],
    integrationSources: [],
  }),
  requirement("AH-UX-WEB-001", {
    status: "ready",
    sources: ["packages/ui/src/index.ts"],
    integrationSources: [],
  })
]);
