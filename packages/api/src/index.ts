export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/api",
  path: "packages/api",
} as const);

export interface HarnessKernelPublicPort {
  readonly Harness: {
    readonly name: string;
    readonly prototype: {
      readonly run: (...arguments_: never[]) => Promise<unknown>;
    };
  };
  readonly createDefaultExecutionContext: (...arguments_: never[]) => unknown;
}

export interface ApiContractClientPort {
  readonly workspace: typeof workspaceIdentity.name;
}
