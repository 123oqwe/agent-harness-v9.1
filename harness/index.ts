/**
 * Agent Harness - Public API entry point
 *
 * Exports stable Phase 1 public APIs. Internal modules may export more
 * types for testing, but only the symbols re-exported here are part of
 * the supported package surface.
 */

// Gateway: model abstraction and scripted test provider
export {
  ScriptedTestProvider,
  ScriptedResponseExhaustedError,
  ScriptedResponseMissingError,
} from './gateway/scripted-provider.js';

export type {
  ProviderAdapter,
  ProviderRequest,
  ParsedResponse,
  Message,
  ToolCall,
  Usage,
  ToolSpec,
  HealthStatus,
  DataPolicyResult,
  ProviderError,
  StreamEvent,
  CallMetadata,
  ScriptedTestProviderOptions,
} from './gateway/scripted-provider.js';

// Security: policy engine and PEP
export {
  PolicyEngine,
  PolicyEngineV1,
  deriveRiskTier,
  resolveEgress,
  isHostAllowed,
  hostMatches,
  hashDecision,
} from './security/policy-engine.js';

export type {
  EffectRisk,

  PolicyRule,
  Policy,
  PolicyContext,
  PolicyDecision,
  DerivedRiskTier,
  RiskLocality,
  RiskOperation,
  RiskReversibility,
  RiskDataEgress,
  RiskHumanImpact,
  RiskExternalVisibility,
  RiskRegulatorySensitivity,
  EgressPolicy,
  EgressDomainRule,
  AuditLogEntry,
} from './security/policy-engine.js';

export {
  PolicyEnforcementPoint,
  PEP,
  PepValidationError,
  ManifestTamperedError,
} from './security/pep.js';

export type {
  PepVerdict,
  PepLogEntry,
} from './security/pep.js';

// Package metadata
export const PACKAGE_NAME = 'agent-harness';
export const PACKAGE_VERSION = '0.1.0';

// Security: capability service
export {
  CapabilityService,
} from './security/capability.js';

export type {
  CapabilityToken,
  CapabilityContext,
  CapabilityIssueRequest,
  CapabilityServiceOptions,
} from './security/capability.js';

// Security: authorization service
export {
  AuthorizationService,
} from './security/authorization-service.js';

export type {
  AuthzSubject,
  AuthzResource,
  AuthzRequest,
  AuthzDecision,
  AuthzEffect,
} from './security/authorization-service.js';

// Security: auth service
export {
  AuthService,
} from './security/auth.js';

export type {
  AuthSession,
  AuthMethodAdapter,
  AuthServiceOptions,
} from './security/auth.js';

// Security: secrets broker
export {
  SecretsBroker,
} from './security/secrets-broker.js';

export type {
  SecretRecord,
  ExchangeCredential,
  SecretsBrokerOptions,
} from './security/secrets-broker.js';

// VFS: virtual filesystem
export { VirtualFilesystem } from './vfs/virtual-filesystem.js';

export type {
  VfsPermission,
  VfsOptions,
  VfsDiff,
  VfsCheckpoint,
  VfsWriteOptions,
  VfsCommitResult,
} from './vfs/virtual-filesystem.js';

// Runtime: sandbox

export {
  Sandbox,
  generateSandboxProfile,
  detectPlatform,
  isNativeSandboxAvailable,
} from './runtime/sandbox.js';

export type {
  SandboxConfig,
  SandboxExecuteRequest,
  SandboxResult,
  SandboxProfile,
  Platform,
} from './runtime/sandbox.js';

// Tools: tool registry and search
export { ToolRegistry, tool_search, tool_load, ToolValidationError, ToolConflictError } from './tools/tool-registry.js';
export type { ToolSpec as RegistryToolSpec, SearchResult, ToolSearchOptions } from './tools/tool-registry.js';

// Skills: skill registry and search
export {
  SkillRegistry,
  skill_search,
  createBaseSkills,
  SkillValidationError,
  SkillConflictError,
} from './tools/skill-registry.js';
export type { SkillSpec, SkillSearchResult, SkillSearchOptions } from './tools/skill-registry.js';

// Gateway: model gateway
export {
  ModelGateway,
  ModelGateway as EnhancedModelGateway,
  GatewayTimeoutError,
  GatewayRetryExhaustedError,
  GatewayTruncationError,
  GatewayRateLimitedError,
  isBackoffRetryable,
  CircuitBreaker,
  CircuitOpenError,
  type CircuitState,
  type CircuitBreakerOptions,
} from './gateway/model-gateway.js';
export type { ModelProfile, GatewayCallOptions, GatewayCallResult, GatewayTelemetry } from './gateway/model-gateway.js';

// Router: intent profiler and static router
export { profileIntent } from './router/intent-profiler.js';
export { staticRouter } from './router/static-router.js';
export type { TaskFeatures, ProfilerInput } from './router/intent-profiler.js';
export type { RouteDecision, RouteReasonCode, RoutingResult, RouterOptions } from './router/static-router.js';

// Runtime: reasoning strategies
export { DirectStrategy } from './runtime/direct.js';
export { ReactStrategy } from './runtime/react.js';
export { PlanExecuteStrategy } from './runtime/plan-execute.js';
export type { ReasoningStrategy, StrategyContext, StrategyResult, ToolExecutor, ModelCaller, ReasoningStrategyHandler } from './runtime/reasoning-strategy.js';
export type { PlanStep, RunPlan, PlanExecutorOptions } from './runtime/plan-execute.js';

// Session: durable session
export { DurableSession } from './session/durable-session.js';
export type { SessionEvent, SessionSnapshot, RestoreResult, EventType } from './session/durable-session.js';

// Runtime: loop, retry, notifications
export { RuntimeLoop } from './runtime/loop.js';
export type { RuntimeRequest, RuntimeResult, RuntimeLoopOptions, ProgressSnapshot, RunState } from './runtime/loop.js';

// Runtime: context offloading
export {
  offloadToolResult,
  contextPressure,
  shouldOffload,
  shouldCompact,
  shouldReset,
  DEFAULT_OFFLOAD_OPTIONS,
} from './runtime/context-offload.js';
export type { OffloadOptions, OffloadResult } from './runtime/context-offload.js';

export { withRetry, createRetryableError, isRetryable, calculateBackoff } from './runtime/retry.js';
export type { RetryOptions, RetryResult, RetryableError } from './runtime/retry.js';
export { NotificationQueue } from './runtime/notifications.js';
export type { Notification, NotificationLevel, NotificationCategory } from './runtime/notifications.js';

// Tools: nine local tools
export { createArtifact } from './tools/create-artifact.js';
export { createAskUserTool } from './tools/ask-user.js';
export { listDirectory } from './tools/list-directory.js';
export { readFile } from './tools/read-file.js';
export { writeFile } from './tools/write-file.js';
export { editFile } from './tools/edit-file.js';
export { searchFiles } from './tools/search-files.js';
export { executeCommand } from './tools/execute-command.js';
export { parseDocument } from './ingestion/parse-document.js';

// Verification: evidence and eval runner
export { createEvidence, verifyRecord, verifyChain, redactSecrets } from './verification/evidence.js';
export type { EvidenceRecord } from './verification/evidence.js';
export { EvalRunner } from './verification/eval-runner.js';
export type { EvalFixture, EvalSummary } from './verification/eval-runner.js';

// Verticals
export { runCodingVertical } from './domains/coding/ah_coding_vertical_001.js';
export { runDocVertical } from './ingestion/ah_doc_vertical_001.js';
export { runResearchVertical } from './research/ah_research_vertical_001.js';
export { runWritingVertical } from './writing/ah_writing_vertical_001.js';
export { runPlanningVertical } from './planning/ah_planning_vertical_001.js';
export { runPAVertical } from './personal_assistant/ah_pa_vertical_001.js';

// UI adapters
export { getOnboardingUIState } from './ui/ah_ui_onboarding_001.js';
export { getSettingsUIState } from './ui/ah_ui_settings_001.js';
export { getApprovalUIState } from './ui/ah_ui_approval_001.js';
export { getChatUIState } from './ui/ah_ui_chat_001.js';
export { getCodingUIState } from './ui/ah_ui_coding_001.js';
export { getEvidenceUIState } from './ui/ah_ui_evidence_001.js';
export { getPrivacyUIState } from './ui/ah_ui_privacy_001.js';
export { getTaskUIState } from './ui/ah_ui_task_001.js';

// Gateway: capability registry, usage meter, key vault, rate limiter, LLM cache, fallback chain
export {
  CapabilityRegistry,
  UsageMeter,
  KeyVault,
  RateLimiter,
  LLMCache,
  FallbackChain,
  DEFAULT_RATE_LIMITS,
} from './gateway/capability-registry.js';
export type {
  ModelCapabilityEntry,
  UsageEntry,
  RateLimitConfig,
  CacheEntry,
  FallbackChainOptions,
} from './gateway/capability-registry.js';

// Runtime: event bus, plugin manager, session manager, health monitor
export { EventBus, createEvent } from './runtime/event-bus.js';
export type { BusEvent, StreamEventType, StreamMode, EventBusOptions } from './runtime/event-bus.js';
export { PluginManager } from './runtime/plugin-manager.js';
export type { HookType, HookContext, HookResult, HookAction, HookHandler, HookRegistration } from './runtime/plugin-manager.js';
export { SessionManager, SteeringQueue, DEFAULT_STEERING_LIMITS } from './runtime/session-manager.js';
export type { SessionTaskResult, SessionRecord, SessionManagerOptions, SteeringQueueType, SteeringQueueLimits } from './runtime/session-manager.js';
export { HealthMonitor } from './runtime/health-monitor.js';
export type { HealthState, HealthCheck, HealthReport } from './runtime/health-monitor.js';

// Runtime: context RAG (chunking, embedding, compaction, validation, etc.)
export {
  semanticChunk,
  allocateContextBudget,
  DEFAULT_LAYER_PERCENTAGES,
  hybridSearch,
  cosineSimilarity,
  computeFingerprint,
  fingerprintsEqual,
  compactMessages,
  validateStructuredOutput,
  validationRetryPrompt,
  reduceState,
  sanitizeToolCall,
  redactCredentials,
  detectInjectionRegex,
  verifyDocumentOutput,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_CHUNK_OPTIONS,
} from './runtime/context-rag.js';
export type {
  TextChunk,
  ChunkingOptions,
  ContextLayerBudget,
  EmbeddingResult,
  EmbeddingProvider,
  FileFingerprint,
  CompactionConfig,
  CompactionResult,
  ValidationResult,
  ReducerStrategy,
  FewShotExample,
  ExampleSelector,
  SanitizationResult,
  InjectionCheckResult,
  DocVerificationResult,
} from './runtime/context-rag.js';

// Security: consent service, MCP allowlist
export { ConsentService } from './security/consent-service.js';
export type { ConsentRecord, ConsentRequest } from './security/consent-service.js';
export { McpAllowlist, McpClient } from './security/mcp-allowlist.js';
export type { McpAllowlistEntry, McpServerConfig, McpTool, McpTransportType } from './security/mcp-allowlist.js';

// VFS: composite backend
export { CompositeBackend } from './vfs/composite-backend.js';
export type { BackendType, BackendRoute } from './vfs/composite-backend.js';
