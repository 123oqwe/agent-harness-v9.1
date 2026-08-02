export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/runtime-core",
  path: "packages/runtime-core",
} as const);

export interface RuntimeCorePackagePort {
  readonly workspace: typeof workspaceIdentity.name;
}
