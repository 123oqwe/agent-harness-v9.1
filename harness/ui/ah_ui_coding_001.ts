/** AH-UI-CODING-001: Coding workspace screen (connected to coding vertical). */
import type { UiResult } from './ui-state.js';
import { runCodingVertical, type CodingVerticalInput, type CodingVerticalOutput } from '../domains/coding/ah_coding_vertical_001.js';
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import type { SandboxProfile } from '../runtime/sandbox.js';

export class CodingWorkspaceController {
  constructor(private vfs: VirtualFilesystem, private sandbox: SandboxProfile) {}
  async runFix(input: CodingVerticalInput): Promise<UiResult<CodingVerticalOutput>> {
    try {
      const result = await runCodingVertical(this.vfs, this.sandbox, input);
      return { state: 'success', data: result };
    } catch (e) { return { state: 'error', error: (e as Error).message }; }
  }
}
