import { describe, expect, it } from 'vitest';
import { PHASE2_API_ENDPOINTS, loadingState, errorState, offlineState, successState } from '../../../apps/api/src/index.js';

describe('AH-UX-API-001: Minimal backend API for Phase 2 UI', () => {
  it('defines all required endpoints', () => {
    expect(PHASE2_API_ENDPOINTS.length).toBeGreaterThanOrEqual(13);
    const paths = PHASE2_API_ENDPOINTS.map(e => e.path);
    expect(paths).toContain('/api/health');
    expect(paths).toContain('/api/sessions');
    expect(paths).toContain('/api/documents/ingest');
    expect(paths).toContain('/api/rag/query');
  });

  it('provides state responses', () => {
    expect(loadingState().loading).toBe(true);
    expect(errorState('err').error).toBe('err');
    expect(offlineState().offline).toBe(true);
    expect(successState({ x: 1 }).data).toEqual({ x: 1 });
  });
});
