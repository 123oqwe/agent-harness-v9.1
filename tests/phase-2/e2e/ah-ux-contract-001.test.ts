import { describe, it, expect } from 'vitest';
import * as mod from '../../../apps/api/src/index.js';
import {
  PHASE2_API_ENDPOINTS,
  loadingState,
  errorState,
  offlineState,
  successState,
  workspaceIdentity,
} from '../../../packages/api/src/index.js';

describe('AH-UX-CONTRACT-001 e2e candidate', () => {
  it('module is importable', () => {
    expect(mod).toBeDefined();
  });

  it('exports expected interface', () => {
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });

  it('packages/api exports workspace identity', () => {
    expect(workspaceIdentity.name).toBe('@agent-harness/api');
    expect(workspaceIdentity.path).toBe('packages/api');
  });

  it('packages/api exports Phase 2 API endpoints', () => {
    expect(PHASE2_API_ENDPOINTS.length).toBeGreaterThan(0);
    expect(PHASE2_API_ENDPOINTS).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/api/health' }),
    );
  });

  it('packages/api state helpers produce correct shapes', () => {
    expect(loadingState()).toEqual({ loading: true, error: null, offline: false, data: null });
    expect(errorState('bad')).toEqual({ loading: false, error: 'bad', offline: false, data: null });
    expect(offlineState()).toEqual({ loading: false, error: 'offline', offline: true, data: null });
    expect(successState({ x: 1 })).toEqual({ loading: false, error: null, offline: false, data: { x: 1 } });
  });
});
