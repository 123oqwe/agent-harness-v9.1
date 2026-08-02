export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/tools",
  path: "packages/tools",
} as const);

export interface ToolsPackagePort {
  readonly workspace: typeof workspaceIdentity.name;
}
