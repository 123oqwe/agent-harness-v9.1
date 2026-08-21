/**
 * AH-TOOL-COMPUTER-001: computer_operate model-callable tool.
 *
 * Typed action schema (screenshot / click / type / key / clipboard) over a
 * platform controller adapter. The tool enforces, at the tool boundary:
 *   - per-app capability: an operation is refused unless the target app is in
 *     the approved-app allowlist (the PEP grant carries the app names too);
 *   - sentinel surfaces: terminal, IDE, Finder and system settings require
 *     escalated consent before any operation (defaults are injectable);
 *   - a single controller lock: at most one controller session is active at a
 *     time, so concurrent sessions cannot race on the same screen/input;
 *   - a consumed global interrupt: the AbortSignal is one-shot — once it
 *     aborts the session is dead and every later operation fails;
 *   - bounded evidence: screenshots capture only the approved app window, with
 *     the agent's own terminal, the approval UI and private overlays excluded
 *     from the capture region; unrelated screen regions are never recorded.
 *
 * Every result is tagged untrusted screen_content. Screen text is untrusted
 * data and cannot issue instructions or grant permission (security
 * invariant), and sensitive screen content is minimized and never persisted
 * beyond bounded evidence (privacy invariant).
 */
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import { MediaToolError } from './media-errors.js';

/** An axis-aligned screen rectangle (screen coordinates, CSS pixels). */
export interface WindowRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ComputerAction =
  | { type: 'screenshot' }
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'clipboard'; operation: 'read' }
  | { type: 'clipboard'; operation: 'write'; text: string };

/** The tool input: an approved app plus one typed action. */
export interface ComputerOperateInput {
  app: string;
  action: ComputerAction;
  /** Explicit consent for sentinel surfaces (terminal/IDE/Finder/system settings). */
  escalatedConsent?: boolean;
}

/** Every result is tagged untrusted screen/surface content. */
export interface ComputerOperateResult {
  kind: 'screen_content';
  untrusted: true;
  app: string;
  action: ComputerAction['type'];
  /** VFS path of the bounded screenshot (bytes stay out of the result). */
  screenshot_path?: string;
  /** Clipboard read returns untrusted text, never instructions. */
  text?: string;
  /** The bounded region that was actually captured/acted on. */
  window: WindowRegion;
  /** Before/after evidence VFS paths for mutating actions. */
  evidence: {
    before_path?: string;
    after_path?: string;
  };
}

export interface ComputerController {
  readonly app: string;
  /** The bounded capture region (window minus excluded surfaces). */
  readonly window: WindowRegion;
  screenshot(): Promise<Uint8Array>;
  click(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  key(key: string): Promise<void>;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): Promise<void>;
  close(): Promise<void>;
}

export interface ComputerOpenConfig {
  /** Approved app the controller is scoped to. */
  app: string;
  /** Global interrupt — consumed: after abort the session is dead. */
  signal?: AbortSignal;
}

export interface ComputerControllerAdapter {
  open(config: ComputerOpenConfig): Promise<ComputerController>;
}

export interface ComputerOperateOptions {
  /** Per-app capability: approved app identifiers. */
  appAllowlist: readonly string[];
  /** Extra sentinel app names/identifiers (defaults cover terminal/IDE/Finder/system settings). */
  sentinelApps?: readonly string[];
  /** Injectable sentinel detector (default: lowercase match against known surfaces). */
  isSentinelApp?: (app: string) => boolean;
  /** VFS dir for bounded screenshots / evidence (default: /workspace/.screenshots). */
  screenshotsDir?: string;
}

export const DEFAULT_COMPUTER_SCREENSHOTS_DIR = '/workspace/.screenshots';

export type ComputerOperateHandler = (
  vfs: VirtualFilesystem,
  input: ComputerOperateInput,
  signal?: AbortSignal,
) => Promise<ComputerOperateResult>;

/** Sentinel surfaces that always require escalated consent. */
const DEFAULT_SENTINEL_APPS = [
  'terminal', 'iterm', 'iterm2', 'alacritty', 'kitty', 'wezterm', 'foot',
  'windows terminal', 'wt', 'tmux',
  'finder', 'files', 'nautilus', 'dolphin', 'explorer',
  'xcode', 'code', 'visual studio code', 'vscode', 'cursor', 'zed', 'sublime',
  'jetbrains', 'intellij', 'pycharm', 'webstorm', 'goland', 'vim', 'neovim', 'emacs',
  'system settings', 'systemsettings', 'settings', 'preferences', 'control panel',
];

function defaultIsSentinelApp(extra?: readonly string[]): (app: string) => boolean {
  const all = [...DEFAULT_SENTINEL_APPS, ...(extra ?? [])].map((a) => a.toLowerCase());
  return (app: string) => all.includes(app.toLowerCase().trim());
}

/** Build a computer_operate handler around a controller adapter. */
export function createComputerOperate(
  adapter: ComputerControllerAdapter,
  options: ComputerOperateOptions,
): ComputerOperateHandler {
  const { appAllowlist } = options;
  const isSentinel = options.isSentinelApp ?? defaultIsSentinelApp(options.sentinelApps);
  const screenshotsDir = options.screenshotsDir ?? DEFAULT_COMPUTER_SCREENSHOTS_DIR;

  const writeScreenshot = (vfs: VirtualFilesystem, bytes: Uint8Array, kind: string): string => {
    const path = `${screenshotsDir}/computer-${Date.now()}-${kind}.png`;
    vfs.write(path, Buffer.from(bytes));
    return path;
  };

  return async (vfs, input, signal) => {
    if (signal?.aborted) {
      throw new MediaToolError('computer operation interrupted by global interrupt');
    }
    const { app, action } = input;
    if (!appAllowlist.includes(app)) {
      throw new MediaToolError(`app denied: ${app} not in approved apps`);
    }
    if (isSentinel(app) && input.escalatedConsent !== true) {
      throw new MediaToolError(`sentinel surface requires escalated consent: ${app}`);
    }

    const session = await adapter.open({
      app,
      ...(signal !== undefined ? { signal } : {}),
    });
    try {
      const result: ComputerOperateResult = {
        kind: 'screen_content',
        untrusted: true,
        app,
        action: action.type,
        window: session.window,
        evidence: {},
      };
      if (action.type === 'screenshot') {
        result.screenshot_path = writeScreenshot(vfs, await session.screenshot(), 'page');
        return result;
      }
      if (action.type === 'clipboard' && action.operation === 'read') {
        result.text = await session.clipboardRead();
        return result;
      }
      // Mutating actions capture bounded before/after evidence.
      const before = await session.screenshot();
      result.evidence.before_path = writeScreenshot(vfs, before, 'before');
      if (action.type === 'click') {
        await session.click(action.x, action.y);
      } else if (action.type === 'type') {
        await session.type(action.text);
      } else if (action.type === 'key') {
        await session.key(action.key);
      } else {
        await session.clipboardWrite(action.text);
      }
      const after = await session.screenshot();
      result.evidence.after_path = writeScreenshot(vfs, after, 'after');
      result.screenshot_path = result.evidence.after_path;
      return result;
    } finally {
      await session.close();
    }
  };
}

/* ------------------------------------------------------------------ *
 * Single controller lock — at most one active controller session.
 * ------------------------------------------------------------------ */

export interface ControllerLock {
  acquire(key: string): Promise<ControllerHandle>;
}

export interface ControllerHandle {
  release(): void;
}

export function createControllerLock(): ControllerLock {
  let holder: string | null = null;
  return {
    async acquire(key: string) {
      if (holder !== null) {
        throw new MediaToolError(`controller lock held by ${holder}; one controller session at a time`);
      }
      holder = key;
      return {
        release() {
          if (holder === key) holder = null;
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * Bounded capture region — window minus excluded surfaces.
 * ------------------------------------------------------------------ */

function intersects(a: WindowRegion, b: WindowRegion): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Split `region` by `cut`, producing up to 4 non-overlapping free rectangles. */
function subtractRect(region: WindowRegion, cut: WindowRegion): WindowRegion[] {
  const result: WindowRegion[] = [];
  const topH = cut.y - region.y;
  if (topH > 0) result.push({ x: region.x, y: region.y, width: region.width, height: topH });
  const bottomY = cut.y + cut.height;
  const bottomH = region.y + region.height - bottomY;
  if (bottomH > 0) result.push({ x: region.x, y: bottomY, width: region.width, height: bottomH });
  const bandTop = Math.max(cut.y, region.y);
  const bandBottom = Math.min(cut.y + cut.height, region.y + region.height);
  if (bandBottom > bandTop) {
    const leftW = cut.x - region.x;
    if (leftW > 0) result.push({ x: region.x, y: bandTop, width: leftW, height: bandBottom - bandTop });
    const rightX = cut.x + cut.width;
    const rightW = region.x + region.width - rightX;
    if (rightW > 0) result.push({ x: rightX, y: bandTop, width: rightW, height: bandBottom - bandTop });
  }
  return result.filter((r) => r.width > 0 && r.height > 0);
}

function regionArea(r: WindowRegion): number {
  return r.width * r.height;
}

/**
 * Largest free rectangle of `window` not covered by any excluded surface.
 * Returns null when the window is fully covered (capture must be refused
 * rather than record unrelated regions).
 */
export function computeBoundedRegion(
  window: WindowRegion,
  excluded: readonly WindowRegion[],
): WindowRegion | null {
  let free: WindowRegion[] = [window];
  for (const cut of excluded) {
    if (!intersects(cut, window)) continue;
    const next: WindowRegion[] = [];
    for (const region of free) {
      if (!intersects(region, cut)) {
        next.push(region);
        continue;
      }
      next.push(...subtractRect(region, cut));
    }
    free = next;
  }
  if (free.length === 0) return null;
  return free.reduce((best, r) => (regionArea(r) > regionArea(best) ? r : best));
}

/* ------------------------------------------------------------------ *
 * Reference platform adapter — injectable driver behind a controller lock.
 * ------------------------------------------------------------------ */

/**
 * The platform seam a real integration fills in (CoreGraphics on macOS,
 * xdotool on Linux, Win32/UIA on Windows). Tests inject a fake.
 */
export interface PlatformDriver {
  getWindowBounds(app: string): Promise<WindowRegion>;
  /** Regions to exclude by default: the agent's own terminal, approval UI, private overlays. */
  listExcludedRegions(app: string): Promise<WindowRegion[]>;
  captureRegion(region: WindowRegion): Promise<Uint8Array>;
  sendClick(x: number, y: number): Promise<void>;
  sendType(text: string): Promise<void>;
  sendKey(key: string): Promise<void>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  close?(): Promise<void>;
}

export interface PlatformComputerAdapterOptions {
  lock?: ControllerLock;
}

/**
 * Reference adapter: acquires the single controller lock, resolves the app
 * window, computes the bounded region (excluding own terminal / approval UI /
 * private overlays), and exposes a controller whose operations fail once the
 * consumed global interrupt has fired.
 */
export function createPlatformComputerControllerAdapter(
  driver: PlatformDriver,
  options: PlatformComputerAdapterOptions = {},
): ComputerControllerAdapter {
  const lock = options.lock ?? createControllerLock();
  return {
    async open(config) {
      const handle = await lock.acquire(config.app);
      let closed = false;
      let consumed = false;
      const onAbort = (): void => {
        if (closed) return;
        consumed = true;
        handle.release();
      };
      if (config.signal?.aborted) {
        handle.release();
        throw new MediaToolError('computer operation interrupted by global interrupt');
      }
      config.signal?.addEventListener('abort', onAbort);
      try {
        const window = await driver.getWindowBounds(config.app);
        const excluded = await driver.listExcludedRegions(config.app);
        const region = computeBoundedRegion(window, excluded);
        if (region === null) {
          throw new MediaToolError(
            `screenshot region fully covered by excluded surfaces for ${config.app}`,
          );
        }
        const assertAlive = (): void => {
          if (consumed) throw new MediaToolError('computer operation consumed by global interrupt');
          if (closed) throw new MediaToolError('computer controller session closed');
        };
        const controller: ComputerController = {
          app: config.app,
          window: region,
          async screenshot() {
            assertAlive();
            return driver.captureRegion(region);
          },
          async click(x, y) {
            assertAlive();
            await driver.sendClick(x, y);
          },
          async type(text) {
            assertAlive();
            await driver.sendType(text);
          },
          async key(key) {
            assertAlive();
            await driver.sendKey(key);
          },
          async clipboardRead() {
            assertAlive();
            return driver.readClipboard();
          },
          async clipboardWrite(text) {
            assertAlive();
            await driver.writeClipboard(text);
          },
          async close() {
            if (closed) return;
            closed = true;
            config.signal?.removeEventListener('abort', onAbort);
            handle.release();
            await driver.close?.();
          },
        };
        return controller;
      } catch (err) {
        handle.release();
        throw err;
      }
    },
  };
}
