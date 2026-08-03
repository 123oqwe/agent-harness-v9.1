import { createHash } from "node:crypto";

import {
  dispatchHookBoundary,
  type HookRuntimePort,
} from "./hook-port.js";

export interface RuntimeBeforeCompactInput {
  readonly event: "session_before_compact";
  readonly tenant_id: string;
  readonly run_id: string;
  readonly session_id: string;
  readonly action: "compact" | "context_reset";
  readonly pressure: number;
}

export interface RuntimeBeforeCompactPort {
  dispatch(input: RuntimeBeforeCompactInput): Promise<{
    readonly action: "continue" | "deny" | "skip" | "force_prompt";
    readonly reason_code?: string;
  }>;
}

export interface CompactionHookRuntimeAdapterOptions {
  readonly hooks?: HookRuntimePort;
  readonly timeout_ms?: number;
  readonly signal?: AbortSignal;
}

/** Routes the runtime-core compactor through the existing Hook boundary. */
export class CompactionHookRuntimeAdapter implements RuntimeBeforeCompactPort {
  readonly #options: CompactionHookRuntimeAdapterOptions;

  constructor(options: CompactionHookRuntimeAdapterOptions) {
    this.#options = options;
  }

  async dispatch(input: RuntimeBeforeCompactInput) {
    const identity = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const result = await dispatchHookBoundary(
      this.#options.hooks,
      {
        event: "session_before_compact",
        invocation_id: `hook-${identity}`,
        idempotency_key: `hook-idempotency-${identity}`,
        scope: {
          tenant_id: input.tenant_id,
          run_id: input.run_id,
          session_id: input.session_id,
        },
        payload: {
          action: input.action,
          pressure: input.pressure,
        },
        ...(this.#options.signal === undefined
          ? {}
          : { signal: this.#options.signal }),
      },
      {
        mode: "decision",
        ...(this.#options.timeout_ms === undefined
          ? {}
          : { timeout_ms: this.#options.timeout_ms }),
      },
    );
    return Object.freeze({
      action: result.action,
      ...(result.reason_code === undefined
        ? {}
        : { reason_code: result.reason_code }),
    });
  }
}

export interface RuntimeSessionTreeBranchPort {
  branch(command: {
    readonly command_id: string;
    readonly source_session_id: string;
    readonly child_session_id: string;
  }): Promise<unknown>;
}

export interface ContextResetSessionAdapterOptions {
  readonly tenant_id: string;
  readonly root_session_id: string;
  readonly tree: RuntimeSessionTreeBranchPort;
}

/** Creates reset sessions through the existing append-only SessionTree. */
export class ContextResetSessionAdapter {
  readonly #tenantId: string;
  readonly #rootSessionId: string;
  readonly #tree: RuntimeSessionTreeBranchPort;

  constructor(options: ContextResetSessionAdapterOptions) {
    this.#tenantId = options.tenant_id;
    this.#rootSessionId = options.root_session_id;
    this.#tree = options.tree;
  }

  prepare(input: {
    readonly tenant_id: string;
    readonly run_id: string;
    readonly previous_session_id: string;
    readonly context_generation: number;
  }): { readonly session_id: string; commit(): Promise<void> } {
    if (
      input.tenant_id !== this.#tenantId ||
      input.run_id !== this.#rootSessionId
    ) {
      throw new Error("context reset SessionTree scope mismatch");
    }
    if (!Number.isSafeInteger(input.context_generation) || input.context_generation < 0) {
      throw new TypeError("context_generation must be a non-negative safe integer");
    }
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          tenant_id: input.tenant_id,
          run_id: input.run_id,
          previous_session_id: input.previous_session_id,
          context_generation: input.context_generation,
        }),
      )
      .digest("hex")
      .slice(0, 32);
    const childSessionId = `context-reset-${fingerprint}`;
    return Object.freeze({
      session_id: childSessionId,
      commit: async () => {
        await this.#tree.branch({
          command_id: `context-reset-command-${fingerprint}`,
          source_session_id: input.previous_session_id,
          child_session_id: childSessionId,
        });
      },
    });
  }
}
