export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/documents",
  path: "packages/documents",
} as const);

export interface DocumentPackagePort {
  readonly workspace: typeof workspaceIdentity.name;
}
