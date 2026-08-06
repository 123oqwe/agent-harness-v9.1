import { parseDocument } from '../ingestion/parse-document.js';
import { applyPatch } from './apply-patch.js';
import { undo } from './undo.js';
import { screenshot } from './screenshot.js';
import type { SandboxProfile } from '../sandbox/process-sandbox.js';
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import type { WorkspaceTransaction } from '../vfs/workspace-transaction.js';
import { createArtifact } from './create-artifact.js';
import { editFile } from './edit-file.js';
import {
  executeCommand,
  type ExecCommandInput,
  type ExecCommandOutput,
} from './execute-command.js';
import { listDirectory } from './list-directory.js';
import { readFile } from './read-file.js';
import { searchFiles } from './search-files.js';
import type { ToolImplementation } from './tool-dispatcher.js';
import { writeFile } from './write-file.js';

export interface LocalToolWorkspace {
  transaction: WorkspaceTransaction | null;
  sandbox: SandboxProfile | null;
}

interface LocalToolHostDependencies {
  executeCommand?: (
    profile: SandboxProfile,
    input: ExecCommandInput,
  ) => Promise<ExecCommandOutput>;
}

export class LocalToolHost {
  private readonly commandRunner: NonNullable<
    LocalToolHostDependencies['executeCommand']
  >;

  constructor(
    private readonly workspace: () => LocalToolWorkspace,
    dependencies: LocalToolHostDependencies = {},
  ) {
    this.commandRunner = dependencies.executeCommand ?? executeCommand;
  }

  implementations(toolNames: readonly string[]): ReadonlyMap<
    string,
    ToolImplementation
  > {
    return new Map(
      toolNames.map((toolName) => [
        toolName,
        async (dependencies, input) =>
          this.execute(
            toolName,
            input as Record<string, unknown>,
            dependencies.vfs,
          ),
      ]),
    );
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    vfs: VirtualFilesystem,
  ): Promise<unknown> {
    switch (name) {
      case 'read_file':
        return readFile(vfs, args as never);
      case 'write_file':
        return writeFile(vfs, args as never);
      case 'edit_file':
        return editFile(vfs, args as never);
      case 'list_directory':
        return listDirectory(vfs, args as never);
      case 'search_files':
        return searchFiles(vfs, args as never);
      case 'execute_command':
        return this.executeWorkspaceCommand(args);
     case 'create_artifact':
       return createArtifact(vfs, args as never);
     case 'apply_patch':
       return applyPatch(vfs, args as never);
      case 'undo': {
        const ws = this.workspace();
        if (!ws.transaction) throw new Error('workspace transaction is not active');
        return undo((id) => ws.transaction!.restore(id), args as never);
      }
     case 'parse_document':
       return parseDocument(vfs, args as never);
      case 'screenshot':
        return screenshot(vfs, args as never);
     case 'ask_user':
        throw new Error(
          'ask_user must be handled by the caller, not dispatched',
        );
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  private async executeWorkspaceCommand(
    args: Record<string, unknown>,
  ): Promise<ExecCommandOutput> {
    const workspace = this.workspace();
    if (workspace.transaction === null || workspace.sandbox === null) {
      throw new Error('workspace transaction is not active');
    }
    const command = args as unknown as ExecCommandInput;
    const executable =
      workspace.sandbox.commandAllowlist?.[command.argv[0]!] ??
      command.argv[0]!;
    return this.commandRunner(workspace.sandbox, {
      ...command,
      argv: [executable, ...command.argv.slice(1)],
      cwd: workspace.transaction.mapCwd(command.cwd),
    });
  }
}
