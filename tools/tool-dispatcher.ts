/**
 * AH-TOOL-DISPATCHER-001: Tool Dispatcher
 *
 * Resolves selected tool from frozen snapshot, validates input schema,
 * calls ActionExecutor (ToolExecutor), validates output, returns ToolReceipt.
 *
 * The dispatcher is the single entry point for tool invocation. No strategy
 * or router may call a tool implementation directly.
 *
 * Pipeline:
 *   resolve selected tool from frozen snapshot
 *   -> validate input schema
 *   -> call ActionExecutor (ToolExecutor)
 *   -> validate output
 *   -> return structured ToolReceipt
 */
import type { ToolRegistry, RegistrySnapshot } from './tool-registry.js';
import Ajv from 'ajv/dist/2020.js';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
  ToolExecutor,
  ToolExecutorDeps,
  ToolReceipt,
} from './tool-executor.js';

export interface DispatchRequest {
  tool_name: string;
  input: unknown;
}

export interface DispatchResult<T = unknown> {
  success: boolean;
  result?: T;
  receipt: ToolReceipt;
  error?: string;
}

export class ToolDispatcherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolDispatcherError';
    Object.setPrototypeOf(this, ToolDispatcherError.prototype);
  }
}

export type ToolImplementation = (
  dependencies: ToolExecutorDeps,
  input: unknown,
) => Promise<unknown>;

export interface ToolDispatcherClock {
  monotonicNow(): number;
  isoNow(): string;
}

const SYSTEM_CLOCK: ToolDispatcherClock = Object.freeze({
  monotonicNow: () => performance.now(),
  isoNow: () => new Date().toISOString(),
});

export class ToolDispatcher {
  private readonly implementations: ReadonlyMap<string, ToolImplementation>;
  private readonly validators = new Map<
    string,
    {
      input: ReturnType<Ajv['compile']>;
      output: ReturnType<Ajv['compile']>;
    }
  >();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly snapshot: RegistrySnapshot,
    private readonly executor: ToolExecutor,
    implementations: ReadonlyMap<string, ToolImplementation>,
    private readonly clock: ToolDispatcherClock = SYSTEM_CLOCK,
  ) {
    const frozen = new Map(implementations);
    for (const name of snapshot.tool_names) {
      if (!frozen.has(name)) {
        throw new ToolDispatcherError(`tool implementation not registered: ${name}`);
      }
    }
    for (const name of frozen.keys()) {
      if (!registry.inSnapshot(name, snapshot)) {
        throw new ToolDispatcherError(`implementation not in frozen snapshot: ${name}`);
      }
    }
    this.implementations = frozen;
  }

  async dispatch<T = unknown>(req: DispatchRequest): Promise<DispatchResult<T>> {
    const started = this.clock.monotonicNow();
    // 1. Resolve tool from frozen snapshot
    if (!this.registry.inSnapshot(req.tool_name, this.snapshot)) {
      throw new ToolDispatcherError(`tool not in frozen snapshot: ${req.tool_name}`);
    }

    const spec = this.registry.loadFull(req.tool_name, this.snapshot);
    const implementation = this.implementations.get(req.tool_name)!;

    // 2. Validate model-originated, untrusted input against the packaged schema.
    if (req.input === undefined || req.input === null) {
      return this.failure(
        req,
        `invalid input for tool ${req.tool_name}: input is ${req.input}`,
        started,
      );
    }
    const validators = this.validatorsFor(
      req.tool_name,
      spec.input_schema_ref,
      spec.output_schema_ref,
    );
    if (!validators.input(req.input)) {
      const errors =
        validators.input.errors
          ?.map((error) => `${error.instancePath}: ${error.message ?? 'invalid'}`)
          .join('; ') ?? 'unknown';
      return this.failure(
        req,
        `input schema validation failed for ${req.tool_name}: ${errors}`,
        started,
      );
    }

    // 3. Call executor (which runs the full 12-step action control pipeline)
    try {
      const { result, receipt } = await this.executor.execute<T>(
        req.tool_name,
        req.input,
        async (dependencies) =>
          implementation(dependencies, req.input) as Promise<T>,
        (candidate) => {
          if (candidate === undefined) {
            throw new ToolDispatcherError('tool returned undefined result');
          }
          if (!validators.output(candidate)) {
            const errors =
              validators.output.errors
                ?.map(
                  (error) =>
                    `${error.instancePath}: ${error.message ?? 'invalid'}`,
                )
                .join('; ') ?? 'unknown';
            throw new ToolDispatcherError(
              `output schema validation failed for ${req.tool_name}: ${errors}`,
            );
          }
        },
      );

      return Object.freeze({ success: true, result, receipt });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return this.failure(req, error, started);
    }
  }

  private validatorsFor(
    toolName: string,
    inputReference: string,
    outputReference: string,
  ) {
    const cached = this.validators.get(toolName);
    if (cached) return cached;
    try {
      const ajv = new Ajv({ allErrors: true, strict: false });
      const compiled = {
        input: ajv.compile(this.registry.loadJsonResource(inputReference)),
        output: ajv.compile(this.registry.loadJsonResource(outputReference)),
      };
      this.validators.set(toolName, compiled);
      return compiled;
    } catch (error) {
      throw new ToolDispatcherError(
        `tool schema unavailable for ${toolName}: ${(error as Error).message}`,
      );
    }
  }

  private failure<T>(
    req: DispatchRequest,
    error: string,
    started: number,
  ): DispatchResult<T> {
    const receipt = Object.freeze({
      tool_name: req.tool_name,
      timestamp: this.clock.isoNow(),
      success: false,
      error,
      duration_ms: Math.max(1, Math.ceil(this.clock.monotonicNow() - started)),
      input_hash: createHash('sha256')
        .update(JSON.stringify(req.input) ?? 'undefined')
        .digest('hex')
        .slice(0, 16),
    } satisfies ToolReceipt);
    return Object.freeze({ success: false, receipt, error });
  }
}
