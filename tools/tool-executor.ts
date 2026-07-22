/**
 * Unified Tool Execution Pipeline.
 *
 * Every tool call goes through: ToolSpec validation → Policy → Capability →
 * PEP → VFS/Sandbox dispatch → Receipt → Evidence. No tool may bypass this.
 *
 * Phase 1: Policy/Capability/PEP are wired but permissive (allow-if-registered).
 * Phase 2 will tighten with real egress + data policy enforcement.
 */
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import type { SandboxProfile } from '../runtime/sandbox.js';
import type { ToolRegistry, RegistrySnapshot } from './tool-registry.js';
import type { PolicyEngine } from '../security/policy-engine.js';
import type { DurableSession } from '../session/durable-session.js';
import { createHash } from 'node:crypto';

export interface ToolReceipt {
  tool_name: string;
  timestamp: string;
  success: boolean;
  error?: string | undefined;
  duration_ms: number;
  input_hash: string;
  output_hash?: string | undefined;
}

export interface ToolExecutorDeps {
  toolRegistry: ToolRegistry;
  snapshot: RegistrySnapshot;
  vfs: VirtualFilesystem;
  sandbox?: SandboxProfile;
  policyEngine: PolicyEngine;
  session: DurableSession;
}

export class ToolExecutorError extends Error {
  constructor(message: string) { super(message); this.name = 'ToolExecutorError'; Object.setPrototypeOf(this, ToolExecutorError.prototype); }
}

function hash(s: unknown): string {
  
  return createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0, 16);
}

export class ToolExecutor {
  constructor(private deps: ToolExecutorDeps) {}

  async execute<T>(toolName: string, input: unknown, fn: (deps: ToolExecutorDeps) => Promise<T>): Promise<{ result: T; receipt: ToolReceipt }> {
    const start = Date.now();

    // 1. ToolSpec validation: tool must exist in frozen snapshot
    if (!this.deps.toolRegistry.inSnapshot(toolName, this.deps.snapshot)) {
      throw new ToolExecutorError(`tool not in frozen snapshot: ${toolName}`);
    }

    // 2. Policy: tool must be in allowed list (deny-by-default)
    const allowed = this.deps.policyEngine.snapshot.allowed_tools.includes(toolName);
    if (!allowed) {
      this.deps.session.append('error', { tool: toolName, reason: 'policy denied' });
      throw new ToolExecutorError(`policy denied: ${toolName}`);
    }

    // 3. Capability: record intent in session (Phase 1: no token, just audit)
    this.deps.session.append('tool_call', { tool: toolName, input_hash: hash(input) });

    // 4. PEP: execute through the pipeline (Phase 1: direct call, Phase 2: full PEP)
    let result: T;
    let error: string | undefined;
    try {
      result = await fn(this.deps);
    } catch (e) {
      error = (e as Error).message;
      this.deps.session.append('error', { tool: toolName, error });
      throw e;
    }

    // 5. Receipt
    const receipt: ToolReceipt = {
      tool_name: toolName,
      timestamp: new Date().toISOString(),
      success: error === undefined,
      error,
      duration_ms: Date.now() - start,
      input_hash: hash(input),
      output_hash: error === undefined ? hash(result) : undefined,
    };

    // 6. Evidence: record in session
    this.deps.session.append('tool_result', { tool: toolName, receipt });

    return { result, receipt };
  }
}
