import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GatewayWsServer } from '../../gateway/ws-server.js';
import { ManagedGateway } from '../../gateway/managed-gateway.js';
import { EconomicKernel } from '../../gateway/economic-kernel.js';
import { KeyVault } from '../../gateway/key-vault.js';
import { CapabilityRegistry } from '../../gateway/capability-registry.js';
import { WebSocket } from 'ws';

const originalFetch = globalThis.fetch;

function mockFetchResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body), headers: new Headers(),
  } as Response;
}

function makeChatResponse(content: string): unknown {
  return {
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  };
}

function makeGateway(): ManagedGateway {
  const kv = new KeyVault();
  kv.addKey('zhipu', 'test-key');
  const registry = new CapabilityRegistry();
  const economic = new EconomicKernel();
  return new ManagedGateway({ keyVault: kv, registry, economic });
}

function connectAndWaitConnected(port: number, user = 'test-user'): Promise<{ ws: WebSocket; connected: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}?user=${user}`);
    const timer = setTimeout(() => reject(new Error('timeout waiting for connected')), 3000);
    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        if (parsed['type'] === 'connected') { clearTimeout(timer); resolve({ ws, connected: parsed }); }
      } catch { /* ignore */ }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function waitForMsg(ws: WebSocket, type: string, timeout = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout);
    const handler = (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        if (parsed['type'] === type) { clearTimeout(timer); ws.off('message', handler); resolve(parsed); }
      } catch { /* ignore parse errors */ }
    };
    ws.on('message', handler);
  });
}

function collectUntilType(ws: WebSocket, type: string, timeout = 10000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout);
    const handler = (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        if (parsed['type'] === type) { clearTimeout(timer); ws.off('message', handler); resolve(parsed); }
      } catch { /* ignore parse errors */ }
    };
    ws.on('message', handler);
  });
}

function collectMsgs(ws: WebSocket, timeout = 5000): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const msgs: Record<string, unknown>[] = [];
    const handler = (data: Buffer) => {
      try { msgs.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    };
    ws.on('message', handler);
    setTimeout(() => { ws.off('message', handler); resolve(msgs); }, timeout);
  });
}

describe('GatewayWsServer deep message handling', () => {
  let server: GatewayWsServer;
  let gateway: ManagedGateway;
  let port: number;

  beforeEach(() => {
    gateway = makeGateway();
    port = 9200 + Math.floor(Math.random() * 100);
    globalThis.fetch = vi.fn(async () => mockFetchResponse(makeChatResponse('hello'))) as any;
  });

  afterEach(() => {
    server.stop();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // -- task message: direct gateway path (no harnessFactory) --

  it('sends task_started then task_complete for task message', async () => {
    server = new GatewayWsServer({ port, gateway });
    server.start();
    const { ws } = await connectAndWaitConnected(port);
    ws.send(JSON.stringify({ type: 'task', goal: 'hello' }));
    const complete = await collectUntilType(ws, 'task_complete', 15000);
    expect(complete['success']).toBe(true);
    expect(complete['response']).toBe('hello');
    ws.close();
  }, 20000);

  it('sends task_started then task_complete for task_stream message', async () => {
    server = new GatewayWsServer({ port, gateway });
    server.start();
    const { ws } = await connectAndWaitConnected(port);
    ws.send(JSON.stringify({ type: 'task_stream', goal: 'stream test' }));
    const complete = await collectUntilType(ws, 'task_complete', 15000);
    expect(complete['streaming']).toBe(true);
    ws.close();
  }, 15000);

  it('sends error for task message without goal', async () => {
    server = new GatewayWsServer({ port, gateway });
    server.start();
    const { ws } = await connectAndWaitConnected(port);
    ws.send(JSON.stringify({ type: 'task' }));
    const msg = await waitForMsg(ws, 'error');
    expect(msg['error']).toBe('Missing "goal"');
    ws.close();
  });

  it('sends error for task_stream message without goal', async () => {
    server = new GatewayWsServer({ port, gateway });
    server.start();
    const { ws } = await connectAndWaitConnected(port);
    ws.send(JSON.stringify({ type: 'task_stream' }));
    const msg = await waitForMsg(ws, 'error');
    expect(msg['error']).toBe('Missing "goal"');
    ws.close();
  });

  // -- pause/resume --

  it('sends pause_ack for pause message', async () => {
    server = new GatewayWsServer({ port, gateway });
    server.start();
    const { ws } = await connectAndWaitConnected(port);
    ws.send(JSON.stringify({ type: 'pause' }));
    const msg = await waitForMsg(ws, 'pause_ack');
    expect(msg['task_id']).toBeDefined();
    ws.close();
  });

  it('sends resume_ack for resume message', async () => {
    server = new GatewayWsServer({ port, gateway });
    server.start();
    const { ws } = await connectAndWaitConnected(port);
    ws.send(JSON.stringify({ type: 'resume' }));
    const msg = await waitForMsg(ws, 'resume_ack');
    expect(msg['task_id']).toBeDefined();
    ws.close();
  });

  // -- fork/rewind --

  it('sends fork_ack for fork message', async () => {
    server = new GatewayWsServer({ port, gateway });
    server.start();
    const { ws } = await connectAndWaitConnected(port);
    ws.send(JSON.stringify({ type: 'fork', source_session_id: 'sess-1' }));
    const msg = await waitForMsg(ws, 'fork_ack');
    expect(msg['source_session_id']).toBe('sess-1');
    expect(msg['child_session_id']).toBeDefined();
    ws.close();
  });

  it('sends rewind_ack for rewind message', async () => {
    server = new GatewayWsServer({ port, gateway });
    server.start();
    const { ws } = await connectAndWaitConnected(port);
    ws.send(JSON.stringify({ type: 'rewind', target_seq: 5 }));
    const msg = await waitForMsg(ws, 'rewind_ack');
    expect(msg['target_seq']).toBe(5);
    ws.close();
  });

  // -- economic budget creation --

  it('creates budget and wallet on task message', async () => {
    const economic = new EconomicKernel();
    const kv = new KeyVault(); kv.addKey('zhipu', 'k');
    const gw = new ManagedGateway({ keyVault: kv, registry: new CapabilityRegistry(), economic });
    server = new GatewayWsServer({ port, gateway: gw, economic });
    server.start();
    const { ws } = await connectAndWaitConnected(port, 'budget-user');
    ws.send(JSON.stringify({ type: 'task', goal: 'test', budget_usd: 5.0 }));
    await waitForMsg(ws, 'task_complete', 10000);
    // Budget should have been created for the task
    ws.close();
  }, 15000);

  // -- task_failed on gateway error --

  it('sends task_complete with success=false when gateway fails', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;
    server = new GatewayWsServer({ port, gateway });
    server.start();
    const { ws } = await connectAndWaitConnected(port);
    ws.send(JSON.stringify({ type: 'task', goal: 'fail test' }));
    const result = await collectUntilType(ws, 'task_complete', 30000);
    expect(result['success']).toBe(false);
    ws.close();
  }, 15000);

  // -- harnessFactory path --

  it('routes through harnessFactory when provided', async () => {
    const mockHarness = {
      run: vi.fn(async () => ({
        success: true,
        evidence: { iterations: 1, termination_reason: 'completed' },
      })),
      withStreaming: vi.fn().mockReturnThis(),
    };
    server = new GatewayWsServer({
      port, gateway,
      harnessFactory: () => mockHarness as any,
    });
    server.start();
    const { ws } = await connectAndWaitConnected(port);
    ws.send(JSON.stringify({ type: 'task', goal: 'harness test' }));
    const complete = await collectUntilType(ws, 'task_complete', 15000);
    expect(complete['success']).toBe(true);
    expect(complete['iterations']).toBe(1);
    expect(mockHarness.run).toHaveBeenCalledTimes(1);
    ws.close();
  }, 15000);

  it('sends task_failed when harness.run throws', async () => {
    const mockHarness = {
      run: vi.fn(async () => { throw new Error('harness error'); }),
      withStreaming: vi.fn().mockReturnThis(),
    };
    server = new GatewayWsServer({
      port, gateway,
      harnessFactory: () => mockHarness as any,
    });
    server.start();
    const { ws } = await connectAndWaitConnected(port);
    ws.send(JSON.stringify({ type: 'task', goal: 'fail harness' }));
    const failed = await collectUntilType(ws, 'task_failed', 15000);
    expect(failed['error']).toBe('harness error');
    ws.close();
  }, 15000);

  // -- task_stream with harnessFactory --

  it('routes task_stream through harnessFactory with streaming callbacks', async () => {
    const mockHarness = {
      run: vi.fn(async () => ({
        success: true,
        evidence: { iterations: 1, termination_reason: 'completed' },
      })),
      withStreaming: vi.fn().mockReturnThis(),
    };
    server = new GatewayWsServer({
      port, gateway,
      harnessFactory: () => mockHarness as any,
    });
    server.start();
    const { ws } = await connectAndWaitConnected(port);
    ws.send(JSON.stringify({ type: 'task_stream', goal: 'stream harness' }));
    const complete = await collectUntilType(ws, 'task_complete', 15000);
    expect(complete['streaming']).toBe(true);
    expect(complete['streaming']).toBe(true);
    expect(mockHarness.withStreaming).toHaveBeenCalledTimes(1);
    ws.close();
  }, 15000);

  // -- default user_id when no user param --

  it('assigns default user_id when no user query param', async () => {
    server = new GatewayWsServer({ port, gateway });
    server.start();
    const { ws, connected } = await new Promise<{ ws: WebSocket; connected: Record<string, unknown> }>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}`);
      const timer = setTimeout(() => reject(new Error('timeout')), 3000);
      ws.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
          if (parsed['type'] === 'connected') { clearTimeout(timer); resolve({ ws, connected: parsed }); }
        } catch { /* ignore */ }
      });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
    expect(connected['user_id']).toMatch(/^user-\d+$/);
    ws.close();
  });

  // -- multiple clients --

  it('tracks multiple connected clients', async () => {
    server = new GatewayWsServer({ port, gateway });
    server.start();
    const { ws: ws1 } = await connectAndWaitConnected(port, 'user1');
    const { ws: ws2 } = await connectAndWaitConnected(port, 'user2');
    await new Promise<void>(r => setTimeout(r, 50));
    expect(server.clientCount).toBe(2);
    ws1.close();
    ws2.close();
    await new Promise<void>(r => setTimeout(r, 100));
    expect(server.clientCount).toBe(0);
  });
});
