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
