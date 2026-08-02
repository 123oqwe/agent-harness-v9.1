export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/app-web",
  path: "apps/web",
} as const);

export interface WebCompositionPort {
  readonly workspace: typeof workspaceIdentity.name;
}
