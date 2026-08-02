export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/app-tui",
  path: "apps/tui",
} as const);

export interface TuiCompositionPort {
  readonly workspace: typeof workspaceIdentity.name;
}
