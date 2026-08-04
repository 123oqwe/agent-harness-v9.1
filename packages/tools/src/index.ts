export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/tools",
  path: "packages/tools",
} as const);

export interface ToolsPackagePort {
  readonly workspace: typeof workspaceIdentity.name;
}

export type { ToolResult, ToolContext, TypedTool } from './types.js';
export { ToolUnavailableError } from './types.js';

export { webFetch } from './web-fetch.js';
export { webSearch } from './web-search.js';
export { escalateToHuman, getAuditTrail } from './escalate.js';
export { connectMcpStdio, disconnectMcpStdio, getConnection } from './mcp-stdio.js';
export { behaviorVerify } from './behavior-verify.js';
export { runInOciSandbox } from './oci-sandbox.js';
export {
  manipulateSpreadsheet,
  generatePresentation,
  generateDocument,
  ocrDocument,
} from './cli-tools.js';
