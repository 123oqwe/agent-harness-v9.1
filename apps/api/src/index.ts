import type { HarnessKernelPublicPort } from "@agent-harness/api";

export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/app-api",
  path: "apps/api",
} as const);

export interface ApiCompositionBinding {
  readonly workspace: typeof workspaceIdentity.name;
  readonly kernel: HarnessKernelPublicPort;
}

// The trusted launch host owns module provenance. This boundary validates only
// the structural completeness needed to compose the API with the root kernel.
export const composeApiApp = (candidate: unknown): ApiCompositionBinding => {
  try {
    if (candidate === null || typeof candidate !== "object") {
      throw new TypeError("kernel object required");
    }
    const module = candidate as Record<string, unknown>;
    if (typeof module.createDefaultExecutionContext !== "function")
      throw new TypeError("missing createDefaultExecutionContext");
    const Harness = module.Harness as {
      name?: unknown;
      prototype?: { run?: unknown };
    };
    if (
      Harness.name !== "Harness" ||
      typeof Harness.prototype?.run !== "function"
    )
      throw new TypeError("invalid Harness authority");

    return Object.freeze({
      workspace: workspaceIdentity.name,
      kernel: Object.freeze({
        Harness: module.Harness,
        createDefaultExecutionContext: module.createDefaultExecutionContext,
      }) as HarnessKernelPublicPort,
    });
  } catch (error) {
    throw new TypeError("invalid Harness kernel public port", { cause: error });
  }
};

export interface ApiCompositionPort {
  readonly workspace: typeof workspaceIdentity.name;
}
