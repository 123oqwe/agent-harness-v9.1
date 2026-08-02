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
