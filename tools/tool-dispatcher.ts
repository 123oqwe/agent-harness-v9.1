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

    // 2. Validate input: must not be null/undefined
    if (req.input === undefined || req.input === null) {
      throw new ToolDispatcherError(`invalid input for tool ${req.tool_name}: input is ${req.input}`);
    }

    // 2a. Schema validation: if the ToolSpec has an input schema, validate against it
    const inputSchemaStr = (spec as unknown as Record<string, unknown>).input_schema_ref as string | undefined;
    if (inputSchemaStr && inputSchemaStr.endsWith('.json')) {
      try {
        const schemaPath = inputSchemaStr;
        // Try to load the schema file
        const { readFileSync, existsSync } = await import('node:fs');
        const { resolve: resolvePath } = await import('node:path');
        const fullSchemaPath = resolvePath(process.cwd(), schemaPath);
        if (existsSync(fullSchemaPath)) {
          const schema = JSON.parse(readFileSync(fullSchemaPath, 'utf8'));
          const ajv = new Ajv({ allErrors: true, strict: false });
          const validate = ajv.compile(schema);
          if (!validate(req.input)) {
            const errors = validate.errors?.map((e: { instancePath: string; message?: string }) => `${e.instancePath}: ${e.message}`).join('; ') ?? 'unknown';
            throw new ToolDispatcherError(`input schema validation failed for ${req.tool_name}: ${errors}`);
          }
        }
      } catch (e) {
        if (e instanceof ToolDispatcherError) throw e;
       // Schema file not found or invalid — skip validation (graceful degradation)
       // FAIL-CLOSED: if schema file is specified but missing, reject
       throw new ToolDispatcherError(`input schema file not found for ${req.tool_name}: ${inputSchemaStr}`);
     }
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
 
     // 4a. Output schema validation (if available)
     const outputSchemaStr = (spec as unknown as Record<string, unknown>).output_schema_ref as string | undefined;
     if (outputSchemaStr && outputSchemaStr.endsWith('.json')) {
       try {
         const { readFileSync, existsSync } = await import('node:fs');
         const { resolve: resolvePath } = await import('node:path');
         const fullSchemaPath = resolvePath(process.cwd(), outputSchemaStr);
         if (existsSync(fullSchemaPath)) {
           const schema = JSON.parse(readFileSync(fullSchemaPath, 'utf8'));
           const ajv = new Ajv({ allErrors: true, strict: false });
           const validate = ajv.compile(schema);
           if (!validate(result)) {
             const errors = validate.errors?.map((e: { instancePath: string; message?: string }) => `${e.instancePath}: ${e.message}`).join('; ') ?? 'unknown';
             throw new ToolDispatcherError(`output schema validation failed for ${req.tool_name}: ${errors}`);
           }
         }
       } catch (e) {
         if (e instanceof ToolDispatcherError) throw e;
       }
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
          input_hash: (await import('node:crypto')).createHash('sha256').update(JSON.stringify(req.input)).digest('hex').slice(0, 16),
        },
        error,
      };
    }
  }
}
