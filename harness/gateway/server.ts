import { ManagedGateway } from './managed-gateway.js';
import { GatewayWsServer } from './ws-server.js';
import { KeyVault } from './key-vault.js';
import { EconomicKernel } from './economic-kernel.js';
import { Harness, type HarnessConfig } from '../harness.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { SkillRegistry } from '../tools/skill-registry.js';
import { PolicyEngine } from '../security/policy-engine.js';
import { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import type { SandboxProfile } from '../runtime/sandbox.js';
import type { TaskContract } from '../../spec/types/task-contract.js';

export interface ServerOptions {
  port?: number;
  dataDir?: string;
}

export function createManagedGateway(): ManagedGateway {
  const keyVault = new KeyVault();
  const economic = new EconomicKernel();
  return new ManagedGateway({ keyVault, economic });
}

export function createHarnessForTask(gateway: ManagedGateway, userId: string, taskId: string, dataDir?: string): Harness {
  const toolRegistry = new ToolRegistry();
  const skillRegistry = new SkillRegistry();
  const policyEngine = new PolicyEngine({
    version: '1',
    default_decision: 'deny',
    allowed_tools: ['read_file', 'write_file', 'edit_file', 'list_directory', 'search_files', 'execute_command_sandboxed', 'create_artifact', 'parse_document'],
    allowed_resource_prefixes: [],
    rules: [],
  });
  const vfs = new VirtualFilesystem();
  const sandbox: SandboxProfile = {
    workspaceRoot: dataDir ?? '/tmp/agent-harness',
    allowNetwork: false,
    allowUnixSockets: false,
    allowRead: [],
  };

  const config: HarnessConfig = {
    toolRegistry,
    skillRegistry,
    policyEngine,
    vfs,
    sandbox,
    provider: gateway.toHarnessProvider(userId, taskId),
    dataDir: dataDir ?? `/tmp/agent-harness/${taskId}`,
    sessionLogPath: `${dataDir ?? '/tmp/agent-harness'}/${taskId}/session.jsonl`,
  };

  return new Harness(config);
}

export function startServer(opts: ServerOptions = {}): GatewayWsServer {
  const port = opts.port ?? 8080;
  const gateway = createManagedGateway();
  const economic = gateway.economicRef;

  const server = new GatewayWsServer({
    port,
    gateway,
    harnessFactory: (gw, userId, taskId) => createHarnessForTask(gw, userId, taskId, opts.dataDir),
    economic,
  });

  server.start();
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.argv[2] ?? '8080', 10);
  const server = startServer({ port });
  process.on('SIGINT', () => { server.stop(); process.exit(0); });
  process.on('SIGTERM', () => { server.stop(); process.exit(0); });
}
