// Module manifest — the single source of truth for mutation testing scope.
// Each module maps to an explicit list of production source files to mutate
// and a minimum mutation score (plus optional per-file floor).

export const mutationModules = {
 gateway: {
   mutate: [
     'gateway/model-gateway.ts',
     'gateway/scripted-provider.ts',
   ],
   // GLM provider files excluded: require GLM_API_KEY for coverage
   minimum: 85,
 },
  router: {
    mutate: ['router/**/*.ts'],
    minimum: 90,
  },
  toolsRegistry: {
    mutate: [
      'tools/tool-registry.ts',
      'tools/tool-dispatcher.ts',
      'tools/tool-definitions.ts',
    ],
    minimum: 90,
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
      'ingestion/parse-document.ts',
    ],
    minimum: 85,
    perFileMinimum: 80,
  },
  skills: {
    mutate: ['skills/**/*.ts'],
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
      'tools/tool-executor.ts',
    ],
    minimum: 90,
  },
  identitySecrets: {
    mutate: [
      'security/auth.ts',
      'security/secrets-broker.ts',
    ],
    minimum: 90,
  },
  vfs: {
    mutate: ['vfs/**/*.ts'],
    minimum: 90,
  },
  sandbox: {
    mutate: [
      'runtime/sandbox.ts',
      'runtime/sandbox/**/*.ts',
    ],
    minimum: 90,
  },
  session: {
    mutate: ['session/**/*.ts'],
    minimum: 90,
  },
  runtime: {
    mutate: [
      'runtime/loop.ts',
      'runtime/loop-helpers.ts',
      'runtime/budget*.ts',
      'runtime/termination*.ts',
    ],
    minimum: 90,
  },
  verification: {
    mutate: [
      'verification/evidence.ts',
      'verification/eval-runner.ts',
    ],
    minimum: 85,
  },
  verticals: {
    mutate: [
      'domains/coding/**/*.ts',
      'ingestion/ah_doc_vertical_001.ts',
      'research/**/*.ts',
      'writing/**/*.ts',
      'planning/**/*.ts',
      'personal_assistant/**/*.ts',
    ],
    minimum: 85,
    perFileMinimum: 80,
  },
};

// Aggregate Phase 1 acceptance floor
export const phase1Minimum = 85;

// Files excluded from mutation scope (type-only, generated, index, fixtures)
export const mutationExclusions = [
  '**/index.ts',
  '**/*.d.ts',
  '**/*.test.ts',
  '**/*.spec.ts',
  'contracts/**',
  'tests/**',
  'dist/**',
  'node_modules/**',
  'vitest.config.ts',
  'vitest.mutation.config.ts',
  'eslint.config.js',
  '**/*.json',
];
