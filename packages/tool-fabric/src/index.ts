export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/tool-fabric",
  path: "packages/tool-fabric",
} as const);

export interface ToolFabricPackagePort {
  readonly workspace: typeof workspaceIdentity.name;
}
