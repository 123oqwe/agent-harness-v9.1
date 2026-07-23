/** AH-TOOL-008: execute_command_sandboxed - structured executable through Sandbox */
import type { Sandbox, SandboxExecuteRequest, SandboxResult } from '../runtime/sandbox.js';

export interface ExecuteCommandInput {
  executable: string;
  args: string[];
  env?: Record<string, string>;
  requires_network?: boolean;
  timeout_ms?: number;
}

export type ExecuteCommandResult = SandboxResult;

export function executeCommand(sandbox: Sandbox, input: ExecuteCommandInput): ExecuteCommandResult {
  const req: SandboxExecuteRequest = {
    executable: input.executable,
    args: input.args,
    env: input.env,
    requiresNetwork: input.requires_network,
  };
  return sandbox.execute(req);
}
