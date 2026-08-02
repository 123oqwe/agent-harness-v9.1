export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/app-desktop",
  path: "apps/desktop",
} as const);

export interface DesktopCompositionPort {
  readonly workspace: typeof workspaceIdentity.name;
}
