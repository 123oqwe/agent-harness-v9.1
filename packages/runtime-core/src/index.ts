export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/runtime-core",
  path: "packages/runtime-core",
} as const);

export interface RuntimeCorePackagePort {
  readonly workspace: typeof workspaceIdentity.name;
}

export {
  SessionTree,
  SessionTreeError,
  type SessionTreeAuthorityEvent,
  type SessionTreeAuthorityEventType,
  type SessionTreeAuthorityLog,
  type SessionTreeAuthorityPort,
  type SessionTreeBranchCommand,
  type SessionTreeCommandResult,
  type SessionTreeCommitRequest,
  type SessionTreeCommitResult,
  type SessionTreeErrorCode,
  type SessionTreeForkCommand,
  type SessionTreeLineageData,
  type SessionTreeNode,
  type SessionTreeOperation,
  type SessionTreeRewindCommand,
  type SessionTreeScope,
  type SessionTreeSecurityAnchor,
  type SessionTreeSessionPoint,
  type SessionTreeSnapshot,
  type SessionTreeSourceRef,
} from "./session-tree.js";

export {
  HOOK_EVENTS,
  HookSystem,
  type HookAuditEntry,
  type HookAuditPort,
  type HookAttenuationDecision,
  type HookAttenuationPolicy,
  type HookDispatchOutcome,
  type HookEvent,
  type HookHandler,
  type HookHandlerInput,
  type HookHandlerResult,
  type HookExecutionPort,
  type HookInvocationRequest,
  type HookJournalClaim,
  type HookJournalPort,
  type HookJournalRecord,
  type HookRegistration,
  type ManagedHookRegistration,
  type ExternalHookExecution,
  type ExternalHookRegistration,
  type HookScope,
  type HookSystemOptions,
  type HookTrust,
} from "./hook-system.js";

export {
  createDurableHookSystem,
  SqliteHookJournal,
  type DurableHookSystemOptions,
  type SqliteHookJournalOptions,
} from "./sqlite-hook-journal.js";

export {
  STEERING_PRIORITIES,
  STEERING_QUEUES,
  SteeringController,
  SteeringError,
  type SteeringCommand,
  type SteeringControllerOptions,
  type SteeringDisposition,
  type SteeringEffectState,
  type SteeringEnqueueResult,
  type SteeringEvent,
  type SteeringJournalPort,
  type SteeringListener,
  type SteeringPriority,
  type SteeringQueue,
  type SteeringRequest,
  type SteeringScope,
} from "./steering.js";

export {
  BudgetLedger,
  type BudgetAuthorization,
  type BudgetCeiling,
  type BudgetDegradationRule,
  type BudgetEvent,
  type BudgetJournalPort,
  type BudgetLedgerOptions,
  type BudgetPricing,
  type BudgetProjection,
  type BudgetRecordResult,
  type BudgetScope,
  type BudgetSnapshot,
  type ModelCallBudgetProjection,
} from "./budget-ledger.js";

export { SqliteBudgetJournal } from "./sqlite-budget-journal.js";

export {
  PauseResumeController,
  type EffectReadBackPort,
  type EffectReconciliationPort,
  type EffectResolution,
  type PauseResumeAction,
  type PauseResumeControllerOptions,
  type PauseResumeEffectRecord,
  type PauseResumeEffectState,
  type PauseResumeJournalPort,
} from "./pause-resume.js";

export {
  ContextCompactor,
  type BeforeCompactPort,
  type CompactionConversationItem,
  type CompactionInput,
  type CompactionOffloadItem,
  type CompactionResult,
  type CompactionSecurityState,
  type CompactionState,
  type CompactionVfsPort,
  type ContextCompactorOptions,
  type ContextHandoffHandle,
  type FreshSessionPort,
  type OffloadedContextHandle,
} from "./compaction.js";

export {
  ModelFallbackController,
  ModelFallbackError,
  type FallbackDispatchContext,
  type FallbackFailureClassification,
  type FallbackResolvedProvider,
  type ModelFallbackCachePort,
  type ModelFallbackContextPort,
  type ModelFallbackErrorCode,
  type ModelFallbackGatewayPort,
  type ModelFallbackInput,
  type ModelFallbackOptions,
  type ModelFallbackResult,
} from "./model-fallback.js";
