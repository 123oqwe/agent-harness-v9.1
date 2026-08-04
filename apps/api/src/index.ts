import type { HarnessKernelPublicPort } from "@agent-harness/api";

export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/app-api",
  path: "apps/api",
} as const);

export interface ApiCompositionBinding {
  readonly workspace: typeof workspaceIdentity.name;
  readonly kernel: HarnessKernelPublicPort;
}

export const composeApiApp = (candidate: unknown): ApiCompositionBinding => {
  try {
    if (candidate === null || typeof candidate !== "object") {
      throw new TypeError("kernel object required");
    }
    const module = candidate as Record<string, unknown>;
    if (typeof module.createDefaultExecutionContext !== "function")
      throw new TypeError("missing createDefaultExecutionContext");
    const Harness = module.Harness as {
      name?: unknown;
      prototype?: { run?: unknown };
    };
    if (
      Harness.name !== "Harness" ||
      typeof Harness.prototype?.run !== "function"
    )
      throw new TypeError("missing Harness class");
  } catch (cause) {
    throw new TypeError("invalid API composition binding", { cause });
  }
  return {
    workspace: workspaceIdentity.name,
    kernel: candidate as HarnessKernelPublicPort,
  };
};

// AH-UX-API-001: Minimal backend API endpoints
export interface ApiEndpoint {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly description: string;
}

export const PHASE2_API_ENDPOINTS: readonly ApiEndpoint[] = Object.freeze([
  { method: 'GET', path: '/api/health', description: 'Health check' },
  { method: 'GET', path: '/api/sessions', description: 'List sessions' },
  { method: 'POST', path: '/api/sessions', description: 'Create session' },
  { method: 'GET', path: '/api/sessions/:id', description: 'Get session' },
  { method: 'DELETE', path: '/api/sessions/:id', description: 'Delete session' },
  { method: 'GET', path: '/api/documents', description: 'List documents' },
  { method: 'POST', path: '/api/documents/ingest', description: 'Ingest document' },
  { method: 'GET', path: '/api/rag/query', description: 'RAG query' },
  { method: 'GET', path: '/api/tools', description: 'List available tools' },
  { method: 'POST', path: '/api/tools/:name/execute', description: 'Execute tool' },
  { method: 'GET', path: '/api/artifacts', description: 'List artifacts' },
  { method: 'GET', path: '/api/artifacts/:id', description: 'Get artifact' },
  { method: 'POST', path: '/api/escalate', description: 'Escalate to human' },
]);

// AH-UX-STATES-001: API state responses
export interface ApiStateResponse {
  readonly loading: boolean;
  readonly error: string | null;
  readonly offline: boolean;
  readonly data: unknown;
}

export function loadingState(): ApiStateResponse {
  return { loading: true, error: null, offline: false, data: null };
}

export function errorState(error: string): ApiStateResponse {
  return { loading: false, error, offline: false, data: null };
}

export function offlineState(): ApiStateResponse {
  return { loading: false, error: 'offline', offline: true, data: null };
}

export function successState(data: unknown): ApiStateResponse {
  return { loading: false, error: null, offline: false, data };
}
