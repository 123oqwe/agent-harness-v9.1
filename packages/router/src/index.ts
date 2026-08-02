export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/router",
  path: "packages/router",
} as const);

export interface RouterPackagePort {
  readonly workspace: typeof workspaceIdentity.name;
}
