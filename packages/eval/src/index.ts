export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/eval",
  path: "packages/eval",
} as const);

export interface EvaluationPackagePort {
  readonly workspace: typeof workspaceIdentity.name;
}
