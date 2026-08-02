export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/context",
  path: "packages/context",
} as const);

export interface ContextPackagePort {
  readonly workspace: typeof workspaceIdentity.name;
}
