import { describe, expect, it, vi } from 'vitest';

import { StoreBackend, VirtualFilesystem } from '../../vfs/virtual-filesystem.js';
import {
  createBrowserOperate,
  createCdpBrowserSessionAdapter,
  type BrowserOpenConfig,
  type BrowserOperateInput,
  type BrowserSession,
  type BrowserSessionAdapter,
  type CdpTransport,
} from '../../tools/browser-operate.js';

function memVfs(): VirtualFilesystem {
  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
  vfs.mount(new StoreBackend('/workspace'));
  return vfs;
}

const ALLOWED = 'https://allowed.example';

interface FakeSessionCalls {
  navigated: string[];
  clicked: string[];
  filled: Array<{ selector: string; value: string }>;
  extracted: string[];
  screenshots: number;
  closed: boolean;
}

function fakeSession(overrides: Partial<BrowserSession> = {}): BrowserSession & FakeSessionCalls {
  const session: BrowserSession & FakeSessionCalls = {
    origin: ALLOWED,
    navigated: [] as string[],
    clicked: [] as string[],
    filled: [] as Array<{ selector: string; value: string }>,
    extracted: [] as string[],
    screenshots: 0,
    closed: false,
    navigate: vi.fn(async (url) => {
      session.navigated.push(url);
      return { url, title: 'Example' };
    }),
    click: vi.fn(async (selector) => { session.clicked.push(selector); }),
    fill: vi.fn(async (selector, value) => { session.filled.push({ selector, value }); }),
    extract: vi.fn(async (selector) => { session.extracted.push(selector); return 'hello world'; }),
    screenshot: vi.fn(async () => { session.screenshots += 1; return new Uint8Array([1, 2, 3]); }),
    close: vi.fn(async () => { session.closed = true; }),
    ...overrides,
  };
  return session;
}

interface FakeAdapter {
  adapter: BrowserSessionAdapter;
  opens: BrowserOpenConfig[];
  lastSession: BrowserSession & FakeSessionCalls;
}

function fakeAdapter(): FakeAdapter {
  const opens: BrowserOpenConfig[] = [];
  const session = fakeSession();
  return {
    opens,
    lastSession: session,
    adapter: {
      open: vi.fn(async (config) => {
        opens.push(config);
        return session;
      }),
    },
  };
}

function input(action: BrowserOperateInput['action'], origin = ALLOWED): BrowserOperateInput {
  return { origin, action };
}

describe('AH-TOOL-BROWSER-001 handler', () => {
  it('navigates an allowlisted origin with an isolated profile and tags the result untrusted', async () => {
    const vfs = memVfs();
    const fake = fakeAdapter();
    const handler = createBrowserOperate(fake.adapter, {
      originAllowlist: [ALLOWED],
      resolveHost: async () => ['93.184.216.34'],
    });

    const result = await handler(vfs, input({ type: 'navigate', url: 'https://allowed.example/page' }));

    expect(fake.opens).toHaveLength(1);
    expect(fake.opens[0]!.origin).toBe(ALLOWED);
    expect(fake.opens[0]!.profileDir).toMatch(/browser-profile/);
    expect(fake.opens[0]!.initialUrl).toBeUndefined();
    expect(fake.lastSession.navigated).toEqual(['https://allowed.example/page']);
    expect(result).toMatchObject({
      kind: 'web_content',
      untrusted: true,
      origin: ALLOWED,
      action: 'navigate',
      url: 'https://allowed.example/page',
      text: 'Example',
    });
    expect(fake.lastSession.closed).toBe(true);
  });

  it('denies a navigate whose url origin does not match the requested scope', async () => {
    const vfs = memVfs();
    const fake = fakeAdapter();
    const handler = createBrowserOperate(fake.adapter, {
      originAllowlist: [ALLOWED],
      resolveHost: async () => ['93.184.216.34'],
    });

    await expect(handler(vfs, input({ type: 'navigate', url: 'https://evil.example/x' }))).rejects.toThrow('does not match');
    expect(fake.opens).toHaveLength(0);
  });

  it('denies an origin outside the allowlist before opening any session', async () => {
    const vfs = memVfs();
    const fake = fakeAdapter();
    const handler = createBrowserOperate(fake.adapter, {
      originAllowlist: [ALLOWED],
      resolveHost: async () => ['93.184.216.34'],
    });

    await expect(handler(vfs, input({ type: 'navigate', url: 'https://other.example/x' }, 'https://other.example'))).rejects.toThrow('origin denied');
    expect(fake.opens).toHaveLength(0);
  });

  it('denies private/internal IPs (security invariant)', async () => {
    const vfs = memVfs();
    const fake = fakeAdapter();
    const handler = createBrowserOperate(fake.adapter, {
      originAllowlist: [ALLOWED],
      resolveHost: async () => ['192.168.1.10'],
    });

    await expect(handler(vfs, input({ type: 'navigate', url: 'https://allowed.example/page' }))).rejects.toThrow('private/internal address denied');
    expect(fake.opens).toHaveLength(0);
  });

  it('fails closed when the origin host cannot be resolved', async () => {
    const vfs = memVfs();
    const fake = fakeAdapter();
    const handler = createBrowserOperate(fake.adapter, {
      originAllowlist: [ALLOWED],
      resolveHost: async () => [],
    });

    await expect(handler(vfs, input({ type: 'navigate', url: 'https://allowed.example/page' }))).rejects.toThrow('cannot resolve');
    expect(fake.opens).toHaveLength(0);
  });

  it('extracts via an isolated session seeded to the origin root and tags untrusted', async () => {
    const vfs = memVfs();
    const fake = fakeAdapter();
    const handler = createBrowserOperate(fake.adapter, {
      originAllowlist: [ALLOWED],
      resolveHost: async () => ['93.184.216.34'],
    });

    const result = await handler(vfs, input({ type: 'extract', selector: '#main' }));

    expect(fake.opens[0]!.initialUrl).toBe(ALLOWED);
    expect(fake.lastSession.extracted).toEqual(['#main']);
    expect(result).toMatchObject({ kind: 'web_content', untrusted: true, action: 'extract', text: 'hello world' });
  });

  it('captures before/after evidence to VFS for a mutating click', async () => {
    const vfs = memVfs();
    const fake = fakeAdapter();
    const handler = createBrowserOperate(fake.adapter, {
      originAllowlist: [ALLOWED],
      resolveHost: async () => ['93.184.216.34'],
    });

    const result = await handler(vfs, input({ type: 'click', selector: '#btn' }));

    expect(fake.lastSession.screenshots).toBe(2); // before + after
    expect(fake.lastSession.clicked).toEqual(['#btn']);
    expect(result.evidence.before_path).toBeDefined();
    expect(result.evidence.after_path).toBeDefined();
    expect(result.screenshot_path).toBe(result.evidence.after_path);
    expect(vfs.exists(result.evidence.before_path!)).toBe(true);
    expect(vfs.exists(result.evidence.after_path!)).toBe(true);
  });

  it('honors the global interrupt before opening a session', async () => {
    const vfs = memVfs();
    const fake = fakeAdapter();
    const controller = new AbortController();
    controller.abort();
    const handler = createBrowserOperate(fake.adapter, {
      originAllowlist: [ALLOWED],
      resolveHost: async () => ['93.184.216.34'],
    });

    await expect(handler(vfs, input({ type: 'navigate', url: 'https://allowed.example/' }), controller.signal)).rejects.toThrow('interrupted');
    expect(fake.opens).toHaveLength(0);
  });
});

describe('AH-TOOL-BROWSER-001 reference CDP adapter', () => {
  interface FakeTransport extends CdpTransport {
    sent: Array<{ method: string; sessionId?: string }>;
    emit: (method: string, params: Record<string, unknown>, sessionId?: string) => void;
  }

  function fakeTransport(): FakeTransport {
    const sent: Array<{ method: string; sessionId?: string }> = [];
    const listeners: Array<(method: string, params: Record<string, unknown>, sessionId?: string) => void> = [];
    const emit = (method: string, params: Record<string, unknown>, sessionId?: string): void => {
      for (const cb of listeners) cb(method, params, sessionId);
    };
    return {
      sent,
      emit,
      async send(method, params = {}, sessionId) {
        sent.push({ method, ...(sessionId !== undefined ? { sessionId } : {}) });
        if (method === 'Target.createTarget') return { targetId: 't1' };
        if (method === 'Target.attachToTarget') return { sessionId: 's1' };
        if (method === 'Page.navigate') {
          const url = String(params.url);
          setTimeout(() => {
            emit('Network.responseReceived', {
              type: 'Document',
              response: { url, type: 'Document', headers: { 'content-type': 'text/html' } },
            }, 's1');
          }, 0);
          setTimeout(() => emit('Page.loadEventFired', {}, 's1'), 1);
          return {};
        }
        if (method === 'Runtime.evaluate') {
          if (String(params.expression).includes('document.title')) {
            return { result: { type: 'string', value: 'Example' } };
          }
          if (String(params.expression).includes('location.href')) {
            return { result: { type: 'string', value: 'https://allowed.example/page' } };
          }
          return { result: {} };
        }
        if (method === 'Page.captureScreenshot') {
          return { data: Buffer.from('pngbytes').toString('base64') };
        }
        return {};
      },
      onEvent(cb) {
        listeners.push(cb);
      },
      close() {},
    };
  }

  it('opens an isolated target, enables page/network, denies downloads by default', async () => {
    const transport = fakeTransport();
    const adapter = createCdpBrowserSessionAdapter({
      browserWsUrl: 'ws://localhost:9222/devtools/browser/1',
      connect: async () => transport,
      navigateTimeoutMs: 100,
    });

    const session = await adapter.open({
      origin: ALLOWED,
      profileDir: '/tmp/iso',
      downloadAllowlist: [ALLOWED],
      initialUrl: 'https://allowed.example/start',
    });

    const methods = transport.sent.map((s) => s.method);
    expect(methods).toEqual([
      'Target.createTarget',
      'Target.attachToTarget',
      'Page.enable',
      'Network.enable',
      'Browser.setDownloadBehavior',
      'Page.navigate',
      'Runtime.evaluate',
      'Runtime.evaluate',
    ]);
    expect(methods.filter((m) => m === 'Page.navigate')).toHaveLength(1);
    const page = await session.navigate('https://allowed.example/page');
    expect(page.url).toBe('https://allowed.example/page');
    expect(page.title).toBe('Example');
    await session.close();
  });

  it('denies unapproved binary responses as downloads', async () => {
    const transport = fakeTransport();
    const adapter = createCdpBrowserSessionAdapter({
      browserWsUrl: 'ws://localhost:9222/devtools/browser/1',
      connect: async () => transport,
      navigateTimeoutMs: 100,
    });
    const session = await adapter.open({
      origin: ALLOWED,
      profileDir: '/tmp/iso',
      downloadAllowlist: [ALLOWED],
      initialUrl: 'https://allowed.example/start',
    });

    // Next navigation serves a PDF from an unapproved origin -> must be gated.
    const originalSend = transport.send.bind(transport);
    transport.send = (method, params = {}, sessionId) => {
      if (method === 'Page.navigate') {
        setTimeout(() => {
          transport.emit('Network.responseReceived', {
            type: 'Document',
            response: { url: 'https://evil.example/file.pdf', type: 'Document', headers: { 'content-type': 'application/pdf' } },
          }, 's1');
        }, 0);
        setTimeout(() => transport.emit('Page.loadEventFired', {}, 's1'), 1);
        return Promise.resolve({});
      }
      return sessionId === undefined
        ? originalSend(method, params)
        : originalSend(method, params, sessionId);
    };

    await expect(session.navigate('https://allowed.example/page')).rejects.toThrow('download denied');
    await session.close();
  });

  it('selectors are JSON-escaped into the page context — no expression injection', async () => {
    const transport = fakeTransport();
    const adapter = createCdpBrowserSessionAdapter({
      browserWsUrl: 'ws://localhost:9222/devtools/browser/1',
      connect: async () => transport,
      navigateTimeoutMs: 100,
    });
    const session = await adapter.open({
      origin: ALLOWED,
      profileDir: '/tmp/iso',
      downloadAllowlist: [ALLOWED],
      initialUrl: 'https://allowed.example/start',
    });

    let lastExpression = '';
    const originalSend = transport.send.bind(transport);
    transport.send = (method, params = {}, sessionId) => {
      if (method === 'Runtime.evaluate') lastExpression = String(params?.expression);
      return sessionId === undefined
        ? originalSend(method, params)
        : originalSend(method, params, sessionId);
    };

    await session.click(`#x"); globalThis.pwned = true; //`);
    // The selector lands inside a JSON string literal: the embedded double quote
    // is escaped, so it can never close the selector string and run as code.
    // The selector is embedded as a JSON-escaped string literal inside the
    // expression; the double-quote inside the selector is backslash-escaped,
    // so it cannot close the string and break out into arbitrary JS.
    // The injected text survives as a literal value inside the quoted selector
    // string — the backslash before the double-quote prevents string breakout.
    expect(lastExpression).toContain('document.querySelector(');
    expect(lastExpression).toContain('globalThis.pwned = true');
    // The entire expression is wrapped in an IIFE — the injected code is
    // inside the querySelector string argument, not at the top level.
    expect(lastExpression).toMatch(/^\(\(\) => \{.*\}\)\(\)$/);
    await session.close();
  });
});
