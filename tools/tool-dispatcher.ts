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
import type { ToolExecutor, ToolReceipt } from './tool-executor.js';

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

export class ToolDispatcher {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly snapshot: RegistrySnapshot,
    private readonly executor: ToolExecutor,
  ) {}

  async dispatch<T = unknown>(req: DispatchRequest, executeFn: (deps: unknown) => Promise<T>): Promise<DispatchResult<T>> {
    // 1. Resolve tool from frozen snapshot
    if (!this.registry.inSnapshot(req.tool_name, this.snapshot)) {
      throw new ToolDispatcherError(`tool not in frozen snapshot: ${req.tool_name}`);
    }

    const spec = this.registry.get(req.tool_name);
    if (!spec) {
      throw new ToolDispatcherError(`tool not found in registry: ${req.tool_name}`);
    }

    // 2. Validate input is not undefined/null
    if (req.input === undefined || req.input === null) {
      throw new ToolDispatcherError(`invalid input for tool ${req.tool_name}: input is ${req.input}`);
    }

    // 3. Call executor (which runs the full 12-step action control pipeline)
    try {
      const { result, receipt } = await this.executor.execute<T>(
        req.tool_name,
        req.input,
        executeFn as (deps: unknown) => Promise<T>,
      );

      // 4. Validate output exists
      if (result === undefined) {
        return { success: false, receipt, error: 'tool returned undefined result' };
      }

      return { success: true, result, receipt };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        receipt: {
          tool_name: req.tool_name,
          timestamp: new Date().toISOString(),
          success: false,
          error,
          duration_ms: 0,
          input_hash: '',
        },
        error,
      };
    }
  }
}
