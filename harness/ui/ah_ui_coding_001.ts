/** AH-UI-CODING-001: Coding workspace screen (connected to coding vertical). */
import type { UiResult } from './ui-state.js';
import { runCodingVertical, type CodingVerticalInput, type CodingVerticalOutput } from '../domains/coding/ah_coding_vertical_001.js';
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import type { SandboxProfile } from '../runtime/sandbox.js';

export type ModelCallFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

export class CodingWorkspaceController {
  constructor(private vfs: VirtualFilesystem, private sandbox: SandboxProfile, private modelCall?: ModelCallFn) {}
  async runFix(input: CodingVerticalInput, modelCall?: ModelCallFn): Promise<UiResult<CodingVerticalOutput>> {
    try {
      const mc = modelCall ?? this.modelCall;
      if (!mc) return { state: 'error', error: 'no model call function provided' };
      const result = await runCodingVertical(this.vfs, this.sandbox, input, mc);
      return { state: 'success', data: result };
    } catch (e) { return { state: 'error', error: (e as Error).message }; }
  }
}
