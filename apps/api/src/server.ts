/**
 * AH-UX-API-001: Minimal backend API server using node:http (zero new dependencies).
 * Provides real HTTP endpoints for Phase 2 UI.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type ApiEndpoint, PHASE2_API_ENDPOINTS, loadingState, errorState, offlineState, successState } from './index.js';

export interface ApiServerConfig {
  port?: number;
  hostname?: string;
}

interface SessionRecord {
  id: string;
  task: string;
  status: 'running' | 'completed' | 'failed';
  created_at: string;
}

const sessionStore = new Map<string, SessionRecord>();

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, successState({ status: 'ok', uptime: process.uptime() }));
}

function handleListSessions(_req: IncomingMessage, res: ServerResponse): void {
 sendJson(res, 200, successState([...sessionStore.values()]));
}

function handleCreateSession(req: IncomingMessage, res: ServerResponse): void {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body) as { task: string };
      if (!parsed.task) {
        sendJson(res, 400, errorState('task is required'));
        return;
      }
      const id = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const record: SessionRecord = {
        id,
        task: parsed.task,
        status: 'running',
        created_at: new Date().toISOString(),
      };
      sessionStore.set(id, record);
      sendJson(res, 201, successState(record));
    } catch {
      sendJson(res, 400, errorState('invalid JSON body'));
    }
  });
}

function handleGetSession(_req: IncomingMessage, res: ServerResponse, id: string): void {
  const session = sessionStore.get(id);
  if (!session) {
    sendJson(res, 404, errorState('session not found'));
    return;
  }
  sendJson(res, 200, successState(session));
}

function handleDeleteSession(_req: IncomingMessage, res: ServerResponse, id: string): void {
  if (!sessionStore.has(id)) {
    sendJson(res, 404, errorState('session not found'));
    return;
  }
  sessionStore.delete(id);
  sendJson(res, 200, successState({ deleted: true }));
}

function handleListEndpoints(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, successState(PHASE2_API_ENDPOINTS));
}

export function createApiServer(config: ApiServerConfig = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Route matching
    if (path === '/api/health' && method === 'GET') return handleHealth(req, res);
    if (path === '/api/sessions' && method === 'GET') return handleListSessions(req, res);
    if (path === '/api/sessions' && method === 'POST') return handleCreateSession(req, res);
    if (path === '/api/endpoints' && method === 'GET') return handleListEndpoints(req, res);

    const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      const id = sessionMatch[1]!;
      if (method === 'GET') return handleGetSession(req, res, id);
      if (method === 'DELETE') return handleDeleteSession(req, res, id);
    }

    sendJson(res, 404, errorState(`route not found: ${method} ${path}`));
  });

  const port = config.port ?? 0;
  const hostname = config.hostname ?? '127.0.0.1';
  return {
    server,
    listen: () => new Promise<{ port: number; hostname: string }>((resolve) => {
      server.listen(port, hostname, () => {
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        resolve({ port: actualPort, hostname });
      });
    }),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    }),
  };
}
