export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/security",
  path: "packages/security",
} as const);

export interface SecurityPackagePort {
  readonly workspace: typeof workspaceIdentity.name;
}
