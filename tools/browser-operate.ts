/**
 * AH-TOOL-BROWSER-001: browser_operate model-callable tool.
 *
 * Typed action schema (navigate / click / fill / extract / screenshot) over a
 * Playwright/CDP wrapper. The handler enforces, at the tool boundary:
 *   - origin allowlist: navigate is refused unless the URL origin is approved,
 *     and the navigate URL must match the requested per-origin scope;
 *   - private/internal IPs are denied (fail-closed DNS resolution);
 *   - unapproved downloads are denied (the adapter gates binary responses);
 *   - every session uses an ISOLATED browser profile — never the user's real
 *     profile, so unrelated logged-in sessions are never reused;
 *   - all page/screenshot content is tagged untrusted web_content before it
 *     can reach context (privacy: content is minimized and never persisted,
 *     never used for training by default).
 *
 * Per-origin capability + exact preview for T3 writes are enforced by the PEP
 * BEFORE this handler runs: dispatch only happens inside an authorized effect
 * whose token carries the browser:operate grant for the requested origin. The
 * handler never self-issues capabilities; it only executes inside that PEP
 * scope. The adapter receives an AbortSignal (global interrupt) and closes the
 * session immediately on abort. Before/after evidence is captured for mutating
 * actions (click/fill).
 */
import { lookup } from 'node:dns/promises';

import WebSocket from 'ws';
import { isPrivateOrLocalAddress } from '../security/policy-engine.js';
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import { MediaToolError } from './media-errors.js';

export type BrowserAction =
  | { type: 'navigate'; url: string }
  | { type: 'click'; selector: string }
  | { type: 'fill'; selector: string; value: string }
  | { type: 'extract'; selector: string }
  | { type: 'screenshot' };

/** The tool input: a per-origin scope plus one typed action. */
export interface BrowserOperateInput {
  origin: string;
  action: BrowserAction;
}

/** Every result is tagged untrusted web/screen content before it can be used. */
export interface BrowserOperateResult {
  kind: 'web_content';
  untrusted: true;
  origin: string;
  action: BrowserAction['type'];
  url?: string;
  text?: string;
  /** VFS path of the page screenshot (bytes stay out of the result). */
  screenshot_path?: string;
  /** Before/after evidence VFS paths for mutating actions. */
  evidence: {
    before_path?: string;
    after_path?: string;
  };
}

export interface BrowserSession {
  readonly origin: string;
  navigate(url: string): Promise<{ url: string; title?: string }>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  extract(selector: string): Promise<string>;
  screenshot(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface BrowserOpenConfig {
  /** Allowlisted origin (scheme://host) the session is scoped to. */
  origin: string;
  /** Isolated profile directory; never a real user profile. */
  profileDir: string;
  /** Origins allowed to serve binary/download responses. */
  downloadAllowlist: readonly string[];
  /** Start page for non-navigate actions (usually the origin root). */
  initialUrl?: string;
  /** Global interrupt: abort closes the session immediately. */
  signal?: AbortSignal;
}

export interface BrowserSessionAdapter {
  open(config: BrowserOpenConfig): Promise<BrowserSession>;
}

export interface BrowserOperateOptions {
  originAllowlist: readonly string[];
  downloadAllowlist?: readonly string[];
  profileDir?: string;
  /** VFS dir for page screenshots / evidence (default: /workspace/.screenshots). */
  screenshotsDir?: string;
  /** Injectable DNS resolver for the private-IP gate (default: node dns). */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

export const DEFAULT_BROWSER_SCREENSHOTS_DIR = '/workspace/.screenshots';

export type BrowserOperateHandler = (
  vfs: VirtualFilesystem,
  input: BrowserOperateInput,
  signal?: AbortSignal,
) => Promise<BrowserOperateResult>;

function parseOrigin(raw: string): { origin: string; host: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MediaToolError(`invalid url: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MediaToolError(`unsupported scheme: ${url.protocol} (only http/https)`);
  }
  return { origin: url.origin, host: url.hostname };
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  if (hostname === 'localhost') return ['127.0.0.1'];
  try {
    const records = await lookup(hostname, { all: true });
    return records.map((r) => r.address);
  } catch {
    return [];
  }
}

async function assertPublicOrigin(
  originHost: string,
  resolveHost: (hostname: string) => Promise<string[]>,
): Promise<void> {
  // Fail closed: unresolved hosts are denied.
  const addresses = await resolveHost(originHost);
  if (addresses.length === 0) {
    throw new MediaToolError(`cannot resolve origin host: ${originHost}`);
  }
  for (const address of addresses) {
    if (isPrivateOrLocalAddress(address)) {
      throw new MediaToolError(
        `private/internal address denied: ${originHost} -> ${address}`,
      );
    }
  }
}

function assertOriginAllowed(origin: string, allowlist: readonly string[]): void {
  if (!allowlist.includes(origin)) {
    throw new MediaToolError(`origin denied: ${origin} not in browser origin allowlist`);
  }
}

/** Build a browser_operate handler around a session adapter. */
export function createBrowserOperate(
  adapter: BrowserSessionAdapter,
  options: BrowserOperateOptions,
): BrowserOperateHandler {
  const { originAllowlist, downloadAllowlist = originAllowlist } = options;
  const profileDir = options.profileDir ?? '';
  const screenshotsDir = options.screenshotsDir ?? DEFAULT_BROWSER_SCREENSHOTS_DIR;
  const resolveHost = options.resolveHost ?? defaultResolveHost;

  const writeScreenshot = (vfs: VirtualFilesystem, bytes: Uint8Array, kind: string): string => {
    const path = `${screenshotsDir}/browser-${Date.now()}-${kind}.png`;
    vfs.write(path, Buffer.from(bytes));
    return path;
  };

  return async (vfs, input, signal) => {
    if (signal?.aborted) {
      throw new MediaToolError('browser operation interrupted by global interrupt');
    }
    const { origin, action } = input;
    let host: string;
    if (action.type === 'navigate') {
      const parsed = parseOrigin(action.url);
      if (parsed.origin !== origin) {
        throw new MediaToolError(
          `navigate url origin ${parsed.origin} does not match requested origin ${origin}`,
        );
      }
      host = parsed.host;
    } else {
      host = parseOrigin(origin).host;
    }
    assertOriginAllowed(origin, originAllowlist);
    await assertPublicOrigin(host, resolveHost);

    const dir = profileDir.length > 0
      ? profileDir
      : `/tmp/browser-profile-${Date.now()}-${action.type}`;
    const session = await adapter.open({
      origin,
      profileDir: dir,
      downloadAllowlist,
      ...(action.type !== 'navigate' ? { initialUrl: origin } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    try {
      const result: BrowserOperateResult = {
        kind: 'web_content',
        untrusted: true,
        origin,
        action: action.type,
        evidence: {},
      };
      if (action.type === 'navigate') {
        const page = await session.navigate(action.url);
        result.url = page.url;
        if (page.title !== undefined && page.title.length > 0) result.text = page.title;
        return result;
      }
      if (action.type === 'click' || action.type === 'fill') {
        const before = await session.screenshot();
        result.evidence.before_path = writeScreenshot(vfs, before, 'before');
        if (action.type === 'click') await session.click(action.selector);
        else await session.fill(action.selector, action.value);
        const after = await session.screenshot();
        result.evidence.after_path = writeScreenshot(vfs, after, 'after');
        result.screenshot_path = result.evidence.after_path;
        return result;
      }
      if (action.type === 'extract') {
        result.text = await session.extract(action.selector);
        return result;
      }
      result.screenshot_path = writeScreenshot(vfs, await session.screenshot(), 'page');
      return result;
    } finally {
      await session.close();
    }
  };
}

/** Minimal CDP client transport over a WebSocket. */
export interface CdpTransport {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  onEvent(cb: (method: string, params: Record<string, unknown>, sessionId?: string) => void): void;
  close(): void;
}

export interface CdpBrowserAdapterOptions {
  browserWsUrl: string;
  /** Injectable transport factory (tests substitute a fake). */
  connect?: (url: string) => Promise<CdpTransport>;
  navigateTimeoutMs?: number;
}

const NAVIGATE_TIMEOUT_MS = 30_000;

/** Reference CDP adapter: isolated target + download gate + global interrupt. */
export function createCdpBrowserSessionAdapter(
  options: CdpBrowserAdapterOptions,
): BrowserSessionAdapter {
  const connect = options.connect ?? wsConnect;
  const navigateTimeoutMs = options.navigateTimeoutMs ?? NAVIGATE_TIMEOUT_MS;

  return {
    async open(config) {
      const transport = await connect(options.browserWsUrl);
      const targetId = (await transport.send('Target.createTarget', { url: 'about:blank' }))
        .targetId as string;
      const attached = await transport.send('Target.attachToTarget', { targetId, flatten: true });
      const sessionId = attached.sessionId as string;
      await transport.send('Page.enable', {}, sessionId);
      await transport.send('Network.enable', {}, sessionId);
      // Deny downloads at the browser level by default.
      await transport.send('Browser.setDownloadBehavior', { behavior: 'deny' });

      let lastDocument: { contentType: string; url: string } | undefined;
      let loadWaiter: { resolve: () => void; timer: ReturnType<typeof setTimeout> } | undefined;

      transport.onEvent((method, params, sid) => {
        if (method === 'Network.responseReceived') {
          const resp = params.response as
            | { url?: string; headers?: Record<string, string>; type?: string }
            | undefined;
          const isDocument = (params.type as string | undefined) === 'Document' || resp?.type === 'Document';
          if (resp && isDocument && resp.url !== undefined) {
            lastDocument = {
              contentType: (resp.headers?.['content-type'] ?? '').toLowerCase(),
              url: resp.url,
            };
          }
        }
        if (method === 'Page.loadEventFired' && (sid ?? undefined) === sessionId && loadWaiter) {
          clearTimeout(loadWaiter.timer);
          loadWaiter.resolve();
          loadWaiter = undefined;
        }
      });

      const waitForLoad = (): Promise<void> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new MediaToolError(`navigate timed out after ${navigateTimeoutMs}ms`)),
            navigateTimeoutMs,
          );
          loadWaiter = {
            resolve: () => {
              clearTimeout(timer);
              resolve();
            },
            timer,
          };
          if (config.signal?.aborted) {
            clearTimeout(timer);
            loadWaiter = undefined;
            reject(new MediaToolError('browser operation interrupted by global interrupt'));
            return;
          }
          config.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            loadWaiter = undefined;
            transport.close();
            reject(new MediaToolError('browser operation interrupted by global interrupt'));
          });
        });

      const assertNoDownload = (): void => {
        if (!lastDocument) return;
        const ct = lastDocument.contentType;
        const isHtmlText = ct.startsWith('text/') || ct.includes('json') || ct.includes('xml') || ct.length === 0;
        if (isHtmlText) return;
        let responseOrigin: string;
        try {
          responseOrigin = new URL(lastDocument.url).origin;
        } catch {
          responseOrigin = lastDocument.url;
        }
        if (config.downloadAllowlist.includes(responseOrigin)) return;
        throw new MediaToolError(
          `download denied: ${lastDocument.url} (content-type ${ct || 'unknown'})`,
        );
      };

      const evalValue = async (expression: string): Promise<unknown> => {
        const r = await transport.send(
          'Runtime.evaluate',
          { expression, returnByValue: true },
          sessionId,
        );
        return (r.result as { value?: unknown } | undefined)?.value;
      };

      const assertActionOk = (value: unknown, what: string): void => {
        if (value !== null && typeof value === 'object' && !(value as { ok?: boolean }).ok) {
          throw new MediaToolError(
            `${what} failed: ${String((value as { error?: unknown }).error ?? 'unknown')}`,
          );
        }
      };

      const session: BrowserSession = {
        origin: config.origin,
        async navigate(url) {
          await transport.send('Page.navigate', { url }, sessionId);
          await waitForLoad();
          assertNoDownload();
          const title = (await evalValue('document.title')) ?? '';
          const href = (await evalValue('location.href')) ?? url;
          return { url: String(href), title: String(title) };
        },
        async click(selector) {
          const expr = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return {ok:false,error:'selector not found'}; el.click(); return {ok:true}; })()`;
          assertActionOk(await evalValue(expr), `click(${JSON.stringify(selector)})`);
        },
        async fill(selector, value) {
          const expr = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return {ok:false,error:'selector not found'}; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return {ok:true}; })()`;
          assertActionOk(await evalValue(expr), `fill(${JSON.stringify(selector)})`);
        },
        async extract(selector) {
          const expr = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.innerText : ''; })()`;
          const value = await evalValue(expr);
          return value === null || value === undefined ? '' : String(value);
        },
        async screenshot() {
          const r = await transport.send('Page.captureScreenshot', { format: 'png' }, sessionId);
          const data = r.data as string | undefined;
          if (!data) throw new MediaToolError('screenshot returned no data');
          return Uint8Array.from(Buffer.from(data, 'base64'));
        },
        async close() {
          transport.close();
        },
      };

      if (config.initialUrl !== undefined) {
        await session.navigate(config.initialUrl);
      }
      return session;
    },
  };
}

interface PendingCdpRequest {
  resolve: (r: Record<string, unknown>) => void;
  reject: (e: unknown) => void;
}

/** Real WebSocket transport factory (integration path; tests inject a fake). */
export function wsConnect(url: string): Promise<CdpTransport> {
  return new Promise((resolve, _reject) => {
    const ws = new WebSocket(url);
    let nextId = 1;
    const pending = new Map<number, PendingCdpRequest>();
    const events: Array<(method: string, params: Record<string, unknown>, sessionId?: string) => void> = [];
    const emit = (method: string, params: Record<string, unknown>, sessionId?: string): void => {
      for (const cb of events) cb(method, params, sessionId);
    };
    const failAll = (err: Error): void => {
      for (const req of pending.values()) req.reject(err);
      pending.clear();
    };

    ws.on('open', () => {
      resolve({
        send(method, params = {}, sessionId) {
          const id = nextId++;
          return new Promise((resolveP, rejectP) => {
            pending.set(id, { resolve: resolveP, reject: rejectP });
            const payload: Record<string, unknown> = {
              id,
              method,
              ...params,
              ...(sessionId !== undefined ? { sessionId } : {}),
            };
            ws.send(JSON.stringify(payload));
            setTimeout(() => {
              if (pending.delete(id)) rejectP(new MediaToolError('cdp request timed out'));
            }, 30_000);
          });
        },
        onEvent(cb) {
          events.push(cb);
        },
        close() {
          try {
            ws.close();
          } catch {
            // already closed
          }
        },
      });
    });
    ws.on('message', (data) => {
      let msg: {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
        error?: { message?: string };
        result?: Record<string, unknown>;
      };
      try {
        msg = JSON.parse(data.toString('utf8')) as typeof msg;
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const req = pending.get(msg.id);
        if (req) {
          pending.delete(msg.id);
          if (msg.error) req.reject(new MediaToolError(`cdp error: ${msg.error.message ?? 'unknown'}`));
          else req.resolve(msg.result ?? {});
        }
      } else if (msg.method) {
        emit(msg.method, msg.params ?? {}, msg.sessionId);
      }
    });
    ws.on('error', (err) => {
      failAll(err instanceof Error ? err : new Error(String(err)));
      _reject(err instanceof Error ? err : new Error(String(err)));
    });
    ws.on('close', () => failAll(new MediaToolError('cdp connection closed')));
  });
}
