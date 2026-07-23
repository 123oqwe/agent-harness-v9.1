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
  CapabilityToken,
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
