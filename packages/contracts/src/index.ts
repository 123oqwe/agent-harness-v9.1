export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/contracts",
  path: "packages/contracts",
} as const);

export interface Phase2ContractPort {
  readonly workspace: typeof workspaceIdentity.name;
}
