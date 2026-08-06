import { describe, it, expect } from 'vitest';
import { createApiServer } from '../../../apps/api/src/server.js';
import { PHASE2_API_ENDPOINTS } from '../../../apps/api/src/index.js';

describe('AH-UX-API-001: Minimal backend API for Phase 2 UI', () => {
  it('exports API endpoints definition', () => {
    expect(PHASE2_API_ENDPOINTS.length).toBeGreaterThan(0);
    expect(PHASE2_API_ENDPOINTS).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/api/health' }),
    );
  });

  it('starts and responds to health check', async () => {
    const api = createApiServer({ port: 0 });
    const { port } = await api.listen();
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(resp.status).toBe(200);
      const body = await resp.json() as { data: { status: string } };
      expect(body.data.status).toBe('ok');
    } finally {
      await api.close();
    }
  });

  it('creates and retrieves a session', async () => {
    const api = createApiServer({ port: 0 });
    const { port } = await api.listen();
    try {
      const createResp = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'test task' }),
      });
      expect(createResp.status).toBe(201);
      const createBody = await createResp.json() as { data: { id: string } };
      const id = createBody.data.id;

      const getResp = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}`);
      expect(getResp.status).toBe(200);
      const getBody = await getResp.json() as { data: { task: string } };
      expect(getBody.data.task).toBe('test task');
    } finally {
      await api.close();
    }
  });

  it('returns 404 for unknown routes', async () => {
    const api = createApiServer({ port: 0 });
    const { port } = await api.listen();
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/unknown`);
      expect(resp.status).toBe(404);
    } finally {
      await api.close();
    }
  });

  it('lists sessions', async () => {
    const api = createApiServer({ port: 0 });
    const { port } = await api.listen();
    try {
      await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'task1' }),
      });
      const listResp = await fetch(`http://127.0.0.1:${port}/api/sessions`);
      expect(listResp.status).toBe(200);
      const body = await listResp.json() as { data: unknown[] };
      expect(body.data.length).toBeGreaterThan(0);
    } finally {
      await api.close();
    }
  });
});
