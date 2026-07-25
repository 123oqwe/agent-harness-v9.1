/** AH-UI-CODING-001: Coding workspace screen (connected to Harness). */
import type { UiResult } from './ui-state.js';
import type { Harness } from '../harness.js';
import { runCodingVertical, type CodingVerticalInput, type CodingVerticalOutput } from '../domains/coding/ah_coding_vertical_001.js';

export class CodingWorkspaceController {
  constructor(private harness: Harness) {}
  async runFix(input: CodingVerticalInput): Promise<UiResult<CodingVerticalOutput>> {
    try {
      const result = await runCodingVertical(this.harness, input);
      return result.outcome.success
        ? { state: 'success', data: result }
        : {
            state: 'error',
            data: result,
            error: `Harness run failed: ${result.outcome.loop_result.termination_reason}`,
          };
    } catch (e) {
      return {
        state: 'error',
        error:
          e instanceof Error ? e.message : 'coding workspace unavailable',
      };
    }
  }
}
