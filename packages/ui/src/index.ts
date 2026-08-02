export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/ui",
  path: "packages/ui",
} as const);

export interface SharedUiPort {
  readonly workspace: typeof workspaceIdentity.name;
}
