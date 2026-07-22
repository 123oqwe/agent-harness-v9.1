/** AH-UI-CODING-001: Coding workspace screen (connected to Harness). */
import type { UiResult } from './ui-state.js';
import type { Harness } from '../harness.js';
import { runCodingVertical, type CodingVerticalInput, type CodingVerticalOutput } from '../domains/coding/ah_coding_vertical_001.js';

export class CodingWorkspaceController {
  constructor(private harness: Harness) {}
  async runFix(input: CodingVerticalInput): Promise<UiResult<CodingVerticalOutput>> {
    try {
      const result = await runCodingVertical(this.harness, input);
      return { state: 'success', data: result };
    } catch (e) { return { state: 'error', error: (e as Error).message }; }
  }
}
