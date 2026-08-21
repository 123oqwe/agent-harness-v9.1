import { describe, expect, it, vi } from 'vitest';

import { StoreBackend, VirtualFilesystem } from '../../vfs/virtual-filesystem.js';
import {
  computeBoundedRegion,
  createComputerOperate,
  createPlatformComputerControllerAdapter,
  type ComputerController,
  type ComputerControllerAdapter,
  type ComputerOpenConfig,
  type ComputerOperateOptions,
  type PlatformDriver,
  type WindowRegion,
} from '../../tools/computer-operate.js';

function memVfs(): VirtualFilesystem {
  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
  vfs.mount(new StoreBackend('/workspace'));
  return vfs;
}

const NOTES = 'notes.app';

interface FakeControllerCalls {
  screenshots: number;
  clicks: Array<{ x: number; y: number }>;
  types: string[];
  keys: string[];
  clipboardReads: number;
  clipboardWrites: string[];
  closed: boolean;
}

function fakeController(
  window: WindowRegion = { x: 0, y: 0, width: 100, height: 100 },
): ComputerController & { calls: FakeControllerCalls } {
  const calls: FakeControllerCalls = {
    screenshots: 0,
    clicks: [],
    types: [],
    keys: [],
    clipboardReads: 0,
    clipboardWrites: [],
    closed: false,
  };
  const controller: ComputerController = {
    app: NOTES,
    window,
    screenshot: vi.fn(async () => { calls.screenshots += 1; return new Uint8Array([1, 2, 3]); }),
    click: vi.fn(async (x, y) => { calls.clicks.push({ x, y }); }),
    type: vi.fn(async (text) => { calls.types.push(text); }),
    key: vi.fn(async (key) => { calls.keys.push(key); }),
    clipboardRead: vi.fn(async () => { calls.clipboardReads += 1; return 'untrusted text'; }),
    clipboardWrite: vi.fn(async (text) => { calls.clipboardWrites.push(text); }),
    close: vi.fn(async () => { calls.closed = true; }),
  };
  return { ...controller, calls };
}

interface FakeControllerAdapter {
  adapter: ComputerControllerAdapter;
  opens: ComputerOpenConfig[];
  lastController: ComputerController & { calls: FakeControllerCalls };
}

function fakeAdapter(controller?: ComputerController & { calls: FakeControllerCalls }): FakeControllerAdapter {
  const opens: ComputerOpenConfig[] = [];
  const c = controller ?? fakeController();
  return {
    opens,
    lastController: c,
    adapter: {
      open: vi.fn(async (config) => {
        opens.push(config);
        return c;
      }),
    },
  };
}

function handlerFor(
  adapter: ComputerControllerAdapter,
  allowlist: string[],
  opts: Partial<ComputerOperateOptions> = {},
) {
  return createComputerOperate(adapter, { appAllowlist: allowlist, ...opts });
}

describe('AH-TOOL-COMPUTER-001 handler', () => {
  it('screenshots an approved app and tags the result untrusted', async () => {
    const vfs = memVfs();
    const fake = fakeAdapter(fakeController({ x: 100, y: 100, width: 800, height: 600 }));
    const handler = handlerFor(fake.adapter, [NOTES]);

    const result = await handler(vfs, { app: NOTES, action: { type: 'screenshot' } });

    expect(fake.opens[0]!.app).toBe(NOTES);
    expect(fake.opens[0]!.signal).toBeUndefined();
    expect(fake.lastController.calls.screenshots).toBe(1);
    expect(result).toMatchObject({ kind: 'screen_content', untrusted: true, app: NOTES, action: 'screenshot' });
    expect(result.window).toEqual({ x: 100, y: 100, width: 800, height: 600 });
    expect(result.screenshot_path).toBeDefined();
    expect(vfs.exists(result.screenshot_path!)).toBe(true);
    expect(fake.lastController.calls.closed).toBe(true);
  });

  it('captures bounded before/after evidence for a click', async () => {
    const vfs = memVfs();
    const fake = fakeAdapter();
    const handler = handlerFor(fake.adapter, [NOTES]);

    const result = await handler(vfs, { app: NOTES, action: { type: 'click', x: 42, y: 21 } });

    expect(fake.lastController.calls.clicks).toEqual([{ x: 42, y: 21 }]);
    expect(fake.lastController.calls.screenshots).toBe(2); // before + after
    expect(result.evidence.before_path).toBeDefined();
    expect(result.evidence.after_path).toBeDefined();
    expect(result.screenshot_path).toBe(result.evidence.after_path);
    expect(vfs.exists(result.evidence.before_path!)).toBe(true);
    expect(vfs.exists(result.evidence.after_path!)).toBe(true);
  });

  it('dispatches type and key to the controller with evidence', async () => {
    const vfs = memVfs();
    const fake = fakeAdapter();
    const handler = handlerFor(fake.adapter, [NOTES]);

    const typed = await handler(vfs, { app: NOTES, action: { type: 'type', text: 'hello' } });
    expect(fake.lastController.calls.types).toEqual(['hello']);
    expect(typed.evidence.before_path).toBeDefined();

    const keyed = await handler(vfs, { app: NOTES, action: { type: 'key', key: 'cmd+a' } });
    expect(fake.lastController.calls.keys).toEqual(['cmd+a']);
    expect(keyed.evidence.after_path).toBeDefined();
  });

  it('reads the clipboard as untrusted text without mutating evidence', async () => {
    const vfs = memVfs();
    const fake = fakeAdapter();
    const handler = handlerFor(fake.adapter, [NOTES]);

    const result = await handler(vfs, { app: NOTES, action: { type: 'clipboard', operation: 'read' } });

    expect(fake.lastController.calls.clipboardReads).toBe(1);
    expect(result.text).toBe('untrusted text');
    expect(result.screenshot_path).toBeUndefined();
    expect(fake.lastController.calls.screenshots).toBe(0);
  });

  it('writes the clipboard with bounded evidence', async () => {
    const vfs = memVfs();
    const fake = fakeAdapter();
    const handler = handlerFor(fake.adapter, [NOTES]);

    const result = await handler(vfs, { app: NOTES, action: { type: 'clipboard', operation: 'write', text: 'secret' } });

    expect(fake.lastController.calls.clipboardWrites).toEqual(['secret']);
    expect(result.evidence.before_path).toBeDefined();
    expect(result.evidence.after_path).toBeDefined();
  });

  it('denies an app outside the per-app capability before opening', async () => {
    const vfs = memVfs();
    const fake = fakeAdapter();
    const handler = handlerFor(fake.adapter, [NOTES]);

    await expect(handler(vfs, { app: 'evil.app', action: { type: 'screenshot' } })).rejects.toThrow('app denied');
    expect(fake.opens).toHaveLength(0);
  });

  it('requires escalated consent for sentinel surfaces', async () => {
    const vfs = memVfs();
    const fake = fakeAdapter();
    const handler = handlerFor(fake.adapter, [NOTES, 'terminal']);

    await expect(handler(vfs, { app: 'terminal', action: { type: 'key', key: 'enter' } })).rejects.toThrow('sentinel surface requires escalated consent');
    expect(fake.opens).toHaveLength(0);
  });

  it('proceeds on a sentinel surface with escalated consent', async () => {
    const vfs = memVfs();
    const fake = fakeAdapter();
    const handler = handlerFor(fake.adapter, ['terminal']);

    const result = await handler(vfs, {
      app: 'terminal',
      action: { type: 'key', key: 'enter' },
      escalatedConsent: true,
    });
    expect(fake.opens).toHaveLength(1);
    expect(result.action).toBe('key');
  });

  it('honors the global interrupt before opening', async () => {
    const vfs = memVfs();
    const fake = fakeAdapter();
    const controller = new AbortController();
    controller.abort();
    const handler = handlerFor(fake.adapter, [NOTES]);

    await expect(
      handler(vfs, { app: NOTES, action: { type: 'screenshot' } }, controller.signal),
    ).rejects.toThrow('interrupted');
    expect(fake.opens).toHaveLength(0);
  });

  it('respects an injected sentinel detector', async () => {
    const vfs = memVfs();
    const fake = fakeAdapter();
    const handler = handlerFor(fake.adapter, ['secret.app'], {
      isSentinelApp: (app: string) => app === 'secret.app',
    });

    await expect(handler(vfs, { app: 'secret.app', action: { type: 'screenshot' } })).rejects.toThrow('sentinel surface');
    expect(fake.opens).toHaveLength(0);
  });
});

describe('computeBoundedRegion', () => {
  const window: WindowRegion = { x: 0, y: 0, width: 100, height: 100 };

  it('keeps the window when nothing overlaps', () => {
    expect(computeBoundedRegion(window, [{ x: 200, y: 200, width: 10, height: 10 }])).toEqual(window);
  });

  it('shrinks to the free left half when the right half is covered', () => {
    expect(computeBoundedRegion(window, [{ x: 50, y: 0, width: 50, height: 100 }])).toEqual({
      x: 0, y: 0, width: 50, height: 100,
    });
  });

  it('picks the largest free rectangle for a centered band', () => {
    expect(computeBoundedRegion(window, [{ x: 0, y: 40, width: 100, height: 20 }])).toEqual({
      x: 0, y: 0, width: 100, height: 40,
    });
  });

  it('composes multiple exclusions into the remaining free region', () => {
    const region = computeBoundedRegion(window, [
      { x: 50, y: 0, width: 50, height: 100 }, // right half
      { x: 0, y: 50, width: 100, height: 50 }, // bottom half
    ]);
    expect(region).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });

  it('refuses when the window is fully covered', () => {
    expect(computeBoundedRegion(window, [{ x: 0, y: 0, width: 100, height: 100 }])).toBeNull();
  });
});

describe('AH-TOOL-COMPUTER-001 reference platform adapter', () => {
  interface FakeDriver extends PlatformDriver {
    closes: number;
    windows: Record<string, WindowRegion>;
    excluded: WindowRegion[];
    capture: Uint8Array;
    clipboard: string;
    windowCalls: string[];
    sent: Array<Record<string, unknown>>;
  }

  function fakeDriver(overrides: Partial<PlatformDriver> = {}): FakeDriver {
    const d: FakeDriver = {
      closes: 0,
      windows: { [NOTES]: { x: 100, y: 100, width: 800, height: 600 } },
      excluded: [],
      capture: new Uint8Array([9, 8, 7]),
      clipboard: 'untrusted text',
      windowCalls: [],
      sent: [],
      async getWindowBounds(app) {
        d.windowCalls.push(app);
        return d.windows[app] ?? { x: 0, y: 0, width: 100, height: 100 };
      },
      async listExcludedRegions() { return d.excluded; },
      async captureRegion() { return d.capture; },
      async sendClick(x, y) { d.sent.push({ kind: 'click', x, y }); },
      async sendType(text) { d.sent.push({ kind: 'type', text }); },
      async sendKey(key) { d.sent.push({ kind: 'key', key }); },
      async readClipboard() { return d.clipboard; },
      async writeClipboard(text) { d.sent.push({ kind: 'clipboardWrite', text }); },
      async close() { d.closes += 1; },
      ...overrides,
    };
    return d;
  }

  it('resolves the app window and bounds the capture region', async () => {
    const driver = fakeDriver();
    const adapter = createPlatformComputerControllerAdapter(driver);

    const session = await adapter.open({ app: NOTES });

    expect(driver.windowCalls).toEqual([NOTES]);
    expect(session.window).toEqual({ x: 100, y: 100, width: 800, height: 600 });
    const bytes = await session.screenshot();
    expect(Array.from(bytes)).toEqual([9, 8, 7]);
    await session.close();
    expect(driver.closes).toBe(1);
  });

  it('excludes overlapping surfaces (own terminal / approval UI) from the region', async () => {
    const driver = fakeDriver();
    // A private overlay covers the left half of the notes window.
    driver.excluded = [{ x: 100, y: 100, width: 400, height: 600 }];
    const adapter = createPlatformComputerControllerAdapter(driver);

    const session = await adapter.open({ app: NOTES });

    expect(session.window).toEqual({ x: 500, y: 100, width: 400, height: 600 });
    await session.close();
  });

  it('refuses to open when the window is fully covered by exclusions', async () => {
    const driver = fakeDriver();
    driver.excluded = [{ x: 100, y: 100, width: 800, height: 600 }];
    const adapter = createPlatformComputerControllerAdapter(driver);

    await expect(adapter.open({ app: NOTES })).rejects.toThrow('fully covered');
  });

  it('enforces a single controller lock until the session closes', async () => {
    const adapter = createPlatformComputerControllerAdapter(fakeDriver());

    const a = await adapter.open({ app: NOTES });
    await expect(adapter.open({ app: 'calc.app' })).rejects.toThrow('controller lock held');
    await a.close();

    const b = await adapter.open({ app: 'calc.app' });
    await b.close();
  });

  it('consumes the global interrupt: the session dies and the lock is freed', async () => {
    const driver = fakeDriver();
    const adapter = createPlatformComputerControllerAdapter(driver);
    const controller = new AbortController();

    const session = await adapter.open({ app: NOTES, signal: controller.signal });
    controller.abort();

    await expect(session.screenshot()).rejects.toThrow('consumed by global interrupt');
    await session.close();

    // The consumed interrupt freed the lock: a new session can open.
    const next = await adapter.open({ app: NOTES });
    await next.close();
  });

  it('rejects open when the signal is already aborted', async () => {
    const driver = fakeDriver();
    const adapter = createPlatformComputerControllerAdapter(driver);
    const controller = new AbortController();
    controller.abort();

    await expect(adapter.open({ app: NOTES, signal: controller.signal })).rejects.toThrow('interrupted');
  });
});
