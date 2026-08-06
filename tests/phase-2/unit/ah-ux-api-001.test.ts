import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { PHASE2_API_ENDPOINTS, loadingState, errorState, offlineState, successState } from '../../../apps/api/src/index.js';
import { createApiServer } from '../../../apps/api/src/server.js';

describe('AH-UX-API-001: Minimal backend API for Phase 2 UI', () => {
  it('defines all required endpoints with method, path, and description', () => {
    expect(PHASE2_API_ENDPOINTS.length).toBeGreaterThanOrEqual(13);
    const paths = PHASE2_API_ENDPOINTS.map(e => e.path);
    expect(paths).toContain('/api/health');
    expect(paths).toContain('/api/sessions');
    expect(paths).toContain('/api/documents/ingest');
    expect(paths).toContain('/api/rag/query');
    for (const ep of PHASE2_API_ENDPOINTS) {
      expect(ep.method).toMatch(/^(GET|POST|PUT|DELETE)$/);
      expect(ep.path).toMatch(/^\/api\//);
      expect(ep.description.length).toBeGreaterThan(0);
    }
  });

  it('provides state responses with correct shapes', () => {
    expect(loadingState()).toMatchObject({ loading: true, error: null, offline: false, data: null });
    expect(errorState('err')).toMatchObject({ loading: false, error: 'err', offline: false, data: null });
    expect(offlineState()).toMatchObject({ loading: false, error: 'offline', offline: true, data: null });
    expect(successState({ x: 1 })).toMatchObject({ loading: false, error: null, offline: false, data: { x: 1 } });
  });

  describe('HTTP server', () => {
    let server: ReturnType<typeof createApiServer>;
    let baseUrl: string;

    beforeAll(async () => {
      server = createApiServer({ port: 0 });
      const { port } = await server.listen();
      baseUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      await server.close();
    });

    it('responds to health check', async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.loading).toBe(false);
      expect(body.data.status).toBe('ok');
    });

    it('creates and lists sessions', async () => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'Test task' }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      expect(created.data.id).toMatch(/^sess-/);
      expect(created.data.task).toBe('Test task');
      expect(created.data.status).toBe('running');

      const listRes = await fetch(`${baseUrl}/api/sessions`);
      expect(listRes.status).toBe(200);
      const list = await listRes.json();
      expect(Array.isArray(list.data)).toBe(true);
      expect(list.data.some((s: { id: string }) => s.id === created.data.id)).toBe(true);
    });

    it('returns 400 for missing task in session creation', async () => {
      const res = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('task is required');
    });

    it('returns 400 for invalid JSON body', async () => {
      const res = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 for unknown session', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/nonexistent`);
      expect(res.status).toBe(404);
    });

    it('returns 404 for unknown routes', async () => {
      const res = await fetch(`${baseUrl}/api/unknown`);
      expect(res.status).toBe(404);
    });

    it('lists API endpoints via /api/endpoints', async () => {
      const res = await fetch(`${baseUrl}/api/endpoints`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(13);
    });

    it('sets CORS headers', async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('handles OPTIONS preflight', async () => {
      const res = await fetch(`${baseUrl}/api/health`, { method: 'OPTIONS' });
      expect(res.status).toBe(204);
    });
  });
});
