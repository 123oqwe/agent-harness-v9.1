import { describe, expect, it } from 'vitest';
import { EvidenceViewerController } from '../../ui/ah_ui_evidence_001.js';

describe('AH-UI-EVIDENCE-001 typed evidence port', () => {
  it('returns empty and success projections without reading node:fs', () => {
    expect(
      new EvidenceViewerController({ listSummaries: () => [] }).list().state,
    ).toBe('empty');
    const result = new EvidenceViewerController({
      listSummaries: () => [
        {
          requirement_id: 'AH-X-001',
          verifier_result: 'pass',
          commit_sha: 'a'.repeat(40),
        },
      ],
    }).list();
    expect(result).toMatchObject({
      state: 'success',
      data: [{ requirement_id: 'AH-X-001' }],
    });
  });

  it('returns an error when the evidence authority fails', () => {
    const result = new EvidenceViewerController({
      listSummaries: () => {
        throw new Error('store unavailable');
      },
    }).list();
    expect(result).toMatchObject({
      state: 'error',
      error: 'store unavailable',
    });
  });
});
