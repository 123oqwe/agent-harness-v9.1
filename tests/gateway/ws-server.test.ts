import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GatewayWsServer } from '../../gateway/ws-server.js';
import { ManagedGateway } from '../../gateway/managed-gateway.js';
import { EconomicKernel } from '../../gateway/economic-kernel.js';
import { WebSocket } from 'ws';

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

function waitForMsg(ws: WebSocket, type: string, timeout = 3000): Promise<Record<string, unknown>> {
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

describe('GatewayWsServer', () => {
  let server: GatewayWsServer;
  let gateway: ManagedGateway;
  let port: number;

  beforeEach(() => {
    gateway = new ManagedGateway({ economic: new EconomicKernel() });
    port = 9100 + Math.floor(Math.random() * 100);
    server = new GatewayWsServer({ port, gateway });
    server.start();
  });

  afterEach(() => { server.stop(); });

  it('starts and accepts connections', async () => {
    const { ws } = await connectAndWaitConnected(port);
    ws.close();
  });

  it('sends connected message on connect', async () => {
    const { ws, connected } = await connectAndWaitConnected(port);
    expect(connected['user_id']).toBe('test-user');
    ws.close();
  });

  it('returns models on models request', async () => {
    const { ws } = await connectAndWaitConnected(port);
    ws.send(JSON.stringify({ type: 'models' }));
    const msg = await waitForMsg(ws, 'models');
    expect(Array.isArray(msg['models'])).toBe(true);
    ws.close();
  });

  it('returns usage on usage request', async () => {
    const { ws } = await connectAndWaitConnected(port);
    ws.send(JSON.stringify({ type: 'usage' }));
    const msg = await waitForMsg(ws, 'usage');
    expect(msg['summary']).toBeDefined();
    ws.close();
  });

  it('returns error for missing goal', async () => {
    const { ws } = await connectAndWaitConnected(port);
    ws.send(JSON.stringify({ type: 'task' }));
    const msg = await waitForMsg(ws, 'error');
    expect(msg['error']).toContain('goal');
    ws.close();
  });

  it('returns error for unknown message type', async () => {
    const { ws } = await connectAndWaitConnected(port);
    ws.send(JSON.stringify({ type: 'unknown_type' }));
    const msg = await waitForMsg(ws, 'error');
    expect(msg['error']).toContain('Unknown type');
    ws.close();
  });

  it('returns error for invalid JSON', async () => {
    const { ws } = await connectAndWaitConnected(port);
    ws.send('not valid json');
    const msg = await waitForMsg(ws, 'error');
    expect(msg['error']).toContain('Invalid JSON');
    ws.close();
  });

  it('tracks client count', async () => {
    expect(server.clientCount).toBe(0);
    const { ws } = await connectAndWaitConnected(port);
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(server.clientCount).toBe(1);
    ws.close();
    await new Promise<void>((r) => setTimeout(r, 100));
    expect(server.clientCount).toBe(0);
  });

  it('isRunning returns true after start', () => {
    expect(server.isRunning).toBe(true);
  });

  it('isRunning returns false after stop', () => {
    server.stop();
    expect(server.isRunning).toBe(false);
  });

  it('returns economic summary on economic request', async () => {
    const { ws } = await connectAndWaitConnected(port);
    ws.send(JSON.stringify({ type: 'economic' }));
    const msg = await waitForMsg(ws, 'economic');
    expect(msg['summary']).toBeDefined();
    ws.close();
  });
});
