// Module manifest — the single source of truth for mutation testing scope.
// Each module maps to an explicit list of production source files to mutate
// and a minimum mutation score (plus optional per-file floor).
//
// IMPORTANT: every file listed MUST exist on disk. The runner validates this
// and will fail if a file is missing.
// Every executable Phase 1 TypeScript file belongs to exactly one module.

export const mutationModules = {
  gateway: {
    mutate: [
      'gateway/glm-gateway-bridge.ts',
      'gateway/glm-provider.ts',
      'gateway/model-gateway.ts',
      'gateway/scripted-provider.ts',
      'gateway/cache-manager.ts',
      'gateway/capability-registry.ts',
      'gateway/circuit-breaker.ts',
      'gateway/dag-executor.ts',
      'gateway/economic-kernel.ts',
      'gateway/key-vault.ts',
      'gateway/managed-gateway.ts',
      'gateway/provider-adapters.ts',
      'gateway/rate-limiter.ts',
      'gateway/server.ts',
      'gateway/tool-mask.ts',
      'gateway/ws-server.ts',
      'gateway/async-task-adapter.ts',
    ],
    minimum: 85,
    chunkTimeoutMs: 60 * 60 * 1000,
  },
  router: {
    mutate: ['router/static-router.ts', 'router/task-normalizer.ts'],
    minimum: 90,
    chunkTimeoutMs: 30 * 60 * 1000,
  },
  toolsRegistry: {
    mutate: [
      'tools/tool-registry.ts',
      'tools/tool-dispatcher.ts',
      'tools/tool-definitions.ts',
      'tools/tool-executor.ts',
    ],
    minimum: 90,
    chunkTimeoutMs: 30 * 60 * 1000,
  },
  toolsLeaf: {
    mutate: [
      'tools/read-file.ts',
      'tools/write-file.ts',
      'tools/edit-file.ts',
      'tools/list-directory.ts',
      'tools/search-files.ts',
      'tools/execute-command.ts',
      'tools/create-artifact.ts',
      'tools/ask-user.ts',
      'tools/local-tool-host.ts',
      'tools/apply-patch.ts',
      'tools/screenshot.ts',
      'tools/undo.ts',
      'ingestion/parse-document.ts',
    ],
    minimum: 85,
    perFileMinimum: 80,
  },
  skills: {
    mutate: ['skills/skill-loader.ts', 'skills/skill-registry.ts'],
    minimum: 85,
  },
  strategies: {
    mutate: [
      'runtime/direct.ts',
      'runtime/react.ts',
      'runtime/plan-execute.ts',
    ],
    minimum: 85,
  },
  actionControl: {
    mutate: [
      'security/policy-engine.ts',
      'security/authorization-service.ts',
      'security/capability.ts',
      'security/pep.ts',
      'security/consent.ts',
      'security/action-executor.ts',
      'security/audit-sink.ts',
    ],
    minimum: 90,
  },
  identitySecrets: {
    mutate: ['security/auth.ts', 'security/secrets-broker.ts'],
    minimum: 90,
  },
  vfs: {
    mutate: [
      'vfs/virtual-filesystem.ts',
      'vfs/workspace-transaction.ts',
      'vfs/transactional-workspace.ts',
    ],
    minimum: 90,
  },
  sandbox: {
    mutate: ['sandbox/process-sandbox.ts'],
    minimum: 90,
  },
  session: {
    mutate: [
      'session/durable-session.ts',
      'session/sqlite-session-store.ts',
      'session/progress-store.ts',
      'session/run-session.ts',
    ],
    minimum: 90,
    chunkTimeoutMs: 60 * 60 * 1000,
  },
  runtime: {
    mutate: [
      'harness.ts',
      'runtime/errors.ts',
      'runtime/harness-support.ts',
      'runtime/hook-port.ts',
      'runtime/loop.ts',
      'runtime/steering-port.ts',
      'runtime/retry.ts',
      'runtime/notifications.ts',
      'runtime/event-bus.ts',
      'runtime/pause-resume-port.ts',
      'runtime/session-tree-port.ts',
    ],
    minimum: 90,
    chunkTimeoutMs: 60 * 60 * 1000,
  },
  verification: {
    mutate: [
      'verification/evidence.ts',
      'verification/eval-runner.ts',
      'verification/verification-engine.ts',
    ],
    minimum: 85,
  },
  verticals: {
    mutate: [
      'domains/coding/ah_coding_vertical_001.ts',
      'domains/documents/ah_doc_vertical_001.ts',
      'domains/research/ah_research_vertical_001.ts',
      'domains/writing/ah_writing_vertical_001.ts',
      'domains/planning/ah_planning_vertical_001.ts',
      'domains/personal-assistant/ah_pa_vertical_001.ts',
    ],
    minimum: 85,
    perFileMinimum: 80,
  },
  uiAdapters: {
    mutate: [
      'ui/ah_ui_onboarding_001.ts',
      'ui/ah_ui_settings_001.ts',
      'ui/ah_ui_approval_001.ts',
      'ui/ah_ui_chat_001.ts',
      'ui/ah_ui_coding_001.ts',
      'ui/ah_ui_evidence_001.ts',
      'ui/ah_ui_privacy_001.ts',
      'ui/ah_ui_task_001.ts',
    ],
    minimum: 85,
  },
};

// Aggregate Phase 1 acceptance floor
export const phase1Minimum = 85;
