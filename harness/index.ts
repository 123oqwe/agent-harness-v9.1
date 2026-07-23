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
  ModelGateway,
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
export { Sandbox } from './runtime/sandbox.js';

export type {
  SandboxConfig,
  SandboxExecuteRequest,
  SandboxResult,
} from './runtime/sandbox.js';

// Tools: tool registry and search
export { ToolRegistry, tool_search, ToolValidationError, ToolConflictError } from './tools/tool-registry.js';
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
  ModelGateway as EnhancedModelGateway,
  GatewayTimeoutError,
  GatewayRetryExhaustedError,
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
