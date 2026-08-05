// Composition Root
export * from './harness.js';

// Gateway + Security (Phase 1 salvaged)
export * from './gateway/scripted-provider.js';
export * from './gateway/model-gateway.js';
export * from './gateway/glm-provider.js';
export * from './security/policy-engine.js';
export * from './security/pep.js';
export * from './security/capability.js';
export * from './security/authorization-service.js';
export * from './security/auth.js';
export * from './security/secrets-broker.js';
// VFS + Sandbox
export * from './vfs/virtual-filesystem.js';
export * from './runtime/sandbox.js';
// Tools
export * from './tools/tool-registry.js';
export * from './tools/skill-registry.js';
export * from './tools/list-directory.js';
export * from './tools/read-file.js';
export * from './tools/search-files.js';
export * from './tools/write-file.js';
export * from './tools/edit-file.js';
export * from './tools/execute-command.js';
export * from './tools/create-artifact.js';
export * from './tools/ask-user.js';
// Router
export * from './router/static-router.js';
// Session + Runtime
export * from './session/durable-session.js';
export * from './runtime/loop.js';
export * from './runtime/retry.js';
export * from './runtime/notifications.js';
// Verification
export * from './verification/evidence.js';
export * from './verification/eval-runner.js';
// Ingestion
export * from './ingestion/parse-document.js';
// Verticals (explicit re-exports to avoid ModelCallFn name conflicts)
export { runCodingVertical, type CodingVerticalInput, type CodingVerticalOutput } from './domains/coding/ah_coding_vertical_001.js';
export { runDocVertical, type DocVerticalInput, type DocVerticalOutput } from './ingestion/ah_doc_vertical_001.js';
export { runResearchVertical, type ResearchVerticalInput, type ResearchVerticalOutput } from './research/ah_research_vertical_001.js';
export { runWritingVertical, type WritingVerticalInput, type WritingVerticalOutput } from './writing/ah_writing_vertical_001.js';
export { runPlanningVertical, type PlanningVerticalInput, type PlanningVerticalOutput } from './planning/ah_planning_vertical_001.js';
export { runPAVertical, type PAVerticalInput, type PAVerticalOutput } from './personal_assistant/ah_pa_vertical_001.js';
// UI
export * from './ui/ui-state.js';
export * from './ui/ah_ui_onboarding_001.js';
export * from './ui/ah_ui_settings_001.js';
export * from './ui/ah_ui_approval_001.js';
export * from './ui/ah_ui_chat_001.js';
export * from './ui/ah_ui_coding_001.js';
export * from './ui/ah_ui_evidence_001.js';
export * from './ui/ah_ui_privacy_001.js';
export * from './ui/ah_ui_task_001.js';

// P1-06/P2-18: EventBus
export * from './runtime/event-bus.js';
// P1-07/P1-24: PluginManager, HealthMonitor
export * from './runtime/plugin-manager.js';
export * from './runtime/health-monitor.js';
// P1-08/P2-23/P2-24: SessionManager + SteeringQueue
export * from './runtime/session-manager.js';
// P2-01..P2-28: Context RAG (chunking, embedding, compaction, validation, etc.)
export * from './runtime/context-rag.js';
// P2-05: Context offloading
export * from './runtime/context-offload.js';
// P2-14: Consent service
export * from './security/consent-service.js';
// P2-09/P2-10: MCP allowlist + client
export * from './security/mcp-allowlist.js';
// P2-15/P2-16/P2-17: Composite VFS backend
export * from './vfs/composite-backend.js';
// P2-08: Deferred tool loading
export { tool_load } from './tools/tool-registry.js';
