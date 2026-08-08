import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GatewayWsServer } from '../../gateway/ws-server.js';
import { ManagedGateway } from '../../gateway/managed-gateway.js';
import { KeyVault } from '../../gateway/key-vault.js';
import { CapabilityRegistry } from '../../gateway/capability-registry.js';
import { EconomicKernel } from '../../gateway/economic-kernel.js';
import { RateLimiter } from '../../gateway/rate-limiter.js';
import { WebSocket } from 'ws';

function makeGw(): ManagedGateway {
  const keyVault = new KeyVault();
  keyVault.addKey('zhipu', 'test-key');
  const registry = new CapabilityRegistry();
  const economic = new EconomicKernel();
  const rateLimiter = new RateLimiter({ rpmLimit: 100, tpmLimit: 1_000_000, concurrentLimit: 10 });
  return new ManagedGateway({ keyVault, registry, economic, rateLimiter });
}

function waitForMessage(ws: WebSocket, timeout = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeout);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

describe('GatewayWsServer message handling coverage', () => {
  let server: GatewayWsServer;
  let port: number;

  beforeEach(() => {
    delete process.env.GLM_API_KEY;
    delete process.env.ZHIPU_API_KEY;
    const gw = makeGw();
    server = new GatewayWsServer({ port: 0, gateway: gw, economic: gw.economicRef });
    server.start();
    const addr = (server as any).wss.address();
    port = addr.port;
  });

  afterEach(() => {
    server?.stop();
    vi.restoreAllMocks();
  });

  it('sends connected message with models on connection', async () => {
    const ws = new WebSocket(`ws://localhost:${port}?user=testuser`);
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('connected');
    expect(msg.user_id).toBe('testuser');
    expect(Array.isArray(msg.models)).toBe(true);
    ws.close();
  });

  it('assigns default user ID when not provided', async () => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('connected');
    expect(msg.user_id).toMatch(/^user-\d+/);
    ws.close();
  });

  it('responds to usage query', async () => {
    const ws = new WebSocket(`ws://localhost:${port}?user=u1`);
    await waitForMessage(ws); // connected
    ws.send(JSON.stringify({ type: 'usage' }));
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('usage');
    expect(msg.summary).toBeDefined();
    expect(msg.cache).toBeDefined();
    ws.close();
  });

  it('responds to models query', async () => {
    const ws = new WebSocket(`ws://localhost:${port}?user=u1`);
    await waitForMessage(ws); // connected
    ws.send(JSON.stringify({ type: 'models' }));
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('models');
    expect(Array.isArray(msg.models)).toBe(true);
    ws.close();
  });

  it('responds to economic query', async () => {
    const ws = new WebSocket(`ws://localhost:${port}?user=u1`);
    await waitForMessage(ws); // connected
    ws.send(JSON.stringify({ type: 'economic' }));
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('economic');
    expect(msg.summary).toBeDefined();
    ws.close();
  });

  it('responds to pause command', async () => {
    const ws = new WebSocket(`ws://localhost:${port}?user=u1`);
    await waitForMessage(ws); // connected
    ws.send(JSON.stringify({ type: 'pause' }));
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('pause_ack');
    expect(msg.task_id).toBeDefined();
    ws.close();
  });

  it('responds to resume command', async () => {
    const ws = new WebSocket(`ws://localhost:${port}?user=u1`);
    await waitForMessage(ws); // connected
    ws.send(JSON.stringify({ type: 'resume' }));
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('resume_ack');
    ws.close();
  });

  it('responds to fork command', async () => {
    const ws = new WebSocket(`ws://localhost:${port}?user=u1`);
    await waitForMessage(ws); // connected
    ws.send(JSON.stringify({ type: 'fork', source_session_id: 'sess-1' }));
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('fork_ack');
    expect(msg.source_session_id).toBe('sess-1');
    expect(msg.child_session_id).toMatch(/^fork-\d+/);
    ws.close();
  });

  it('responds to rewind command', async () => {
    const ws = new WebSocket(`ws://localhost:${port}?user=u1`);
    await waitForMessage(ws); // connected
    ws.send(JSON.stringify({ type: 'rewind', target_seq: 5 }));
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('rewind_ack');
    expect(msg.target_seq).toBe(5);
    ws.close();
  });

  it('returns error for unknown message type', async () => {
    const ws = new WebSocket(`ws://localhost:${port}?user=u1`);
    await waitForMessage(ws); // connected
    ws.send(JSON.stringify({ type: 'unknown_type' }));
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('error');
    expect(msg.error).toContain('Unknown type');
    ws.close();
  });

  it('returns error for invalid JSON', async () => {
    const ws = new WebSocket(`ws://localhost:${port}?user=u1`);
    await waitForMessage(ws); // connected
    ws.send('not valid json');
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('error');
    expect(msg.error).toBe('Invalid JSON');
    ws.close();
  });

  it('returns error for task without goal', async () => {
    const ws = new WebSocket(`ws://localhost:${port}?user=u1`);
    await waitForMessage(ws); // connected
    ws.send(JSON.stringify({ type: 'task' }));
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('error');
    expect(msg.error).toContain('Missing "goal"');
    ws.close();
  });

  it('returns error for task_stream without goal', async () => {
    const ws = new WebSocket(`ws://localhost:${port}?user=u1`);
    await waitForMessage(ws); // connected
    ws.send(JSON.stringify({ type: 'task_stream' }));
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('error');
    expect(msg.error).toContain('Missing "goal"');
    ws.close();
  });

  it('handles task with goal through direct gateway', async () => {
    // Task handling through the full gateway pipeline is covered by
    // ws-server-deep.test.ts which uses proper mocking and fake timers
    // Here we just verify the server accepts task messages
    const ws = new WebSocket(`ws://localhost:${port}?user=u1`);
    await waitForMessage(ws); // connected
    ws.send(JSON.stringify({ type: 'task', goal: 'test', budget_usd: 0.5 }));
    const started = await waitForMessage(ws);
    expect(started.type).toBe('task_started');
    ws.close();
  }, 10000);
});

describe('GatewayWsServer lifecycle coverage', () => {
  beforeEach(() => { delete process.env.GLM_API_KEY; delete process.env.ZHIPU_API_KEY; });
  afterEach(() => { vi.restoreAllMocks(); });

  it('stop closes all connections', () => {
    const gw = makeGw();
    const server = new GatewayWsServer({ port: 0, gateway: gw });
    server.start();
    expect(server.isRunning).toBe(true);
    expect(server.clientCount).toBe(0);
    server.stop();
    expect(server.isRunning).toBe(false);
  });

  it('can get clientCount', () => {
    const gw = makeGw();
    const server = new GatewayWsServer({ port: 0, gateway: gw });
    server.start();
    expect(server.clientCount).toBe(0);
    server.stop();
  });
});
