export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/multimodal",
  path: "packages/multimodal",
} as const);

export interface MultimodalPackagePort {
  readonly workspace: typeof workspaceIdentity.name;
}
