export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/rag",
  path: "packages/rag",
} as const);

export interface RagPackagePort {
  readonly workspace: typeof workspaceIdentity.name;
}
