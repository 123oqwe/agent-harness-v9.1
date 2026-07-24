/** AH-UI-EVIDENCE-001: Evidence viewer with real API dependencies. */
import type { UiResult } from './ui-state.js';

export interface EvidenceSummary { requirement_id: string; verifier_result: string; commit_sha: string }
export interface EvidenceRepositoryPort {
  listSummaries(): readonly EvidenceSummary[];
}

export class EvidenceViewerController {
  constructor(private readonly repository: EvidenceRepositoryPort) {}

  list(): UiResult<EvidenceSummary[]> {
    try {
      const summaries = [...this.repository.listSummaries()];
      return {
        state: summaries.length === 0 ? 'empty' : 'success',
        data: summaries,
      };
    } catch (error) {
      return {
        state: 'error',
        error: error instanceof Error ? error.message : 'evidence unavailable',
      };
    }
  }
}
