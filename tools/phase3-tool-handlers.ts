/**
 * Phase 3 tool wiring: wraps the AH-TOOL-* handlers as ToolImplementations so
 * the ToolDispatcher can execute them. Credentials, VFS and the sandbox flow in
 * through ToolExecutorDeps (the executor leases broker credentials for tools
 * with credential_requirements, then calls fn({ ...deps, credentials })).
 *
 *   video_edit   builds its sandboxed runner from the dispatch sandbox at call
 *                time — no external infrastructure required.
 *   video_gen / music_gen / browser_operate / computer_operate delegate to
 *                injectable adapters (provider HTTP adapter / CDP session
 *                adapter / platform controller adapter). A missing adapter
 *                yields a clean ToolUnavailableError at call time: the tool
 *                stays registered, policy-gated and dispatchable, but is honest
 *                about unconfigured infrastructure. The gateway composition
 *                root supplies adapters when the infrastructure is configured.
 *
 * The browser/computer handlers also accept an AbortSignal (global interrupt);
 * ToolExecutorDeps carries no signal, so through the dispatcher the signal is
 * absent — the handler-level tests exercise the interrupt paths directly.
 */
import type { ToolImplementation } from './tool-dispatcher.js';
import { ToolUnavailableError } from './media-errors.js';
import { createGenerateVideo, type GenerateVideoInput, type VideoGenerationAdapter } from './generate-video.js';
import { createGenerateMusic, type GenerateMusicInput, type MusicGenerationAdapter } from './generate-music.js';
import { createEditVideo, createSandboxEditVideoRunner, type EditVideoInput } from './edit-video.js';
import { createBrowserOperate, type BrowserOperateInput, type BrowserSessionAdapter } from './browser-operate.js';
import { createComputerOperate, type ComputerOperateInput, type ComputerControllerAdapter } from './computer-operate.js';

export interface Phase3ToolHandlersOptions {
  /** video_gen provider adapter. Absent => ToolUnavailableError at call time. */
  videoAdapter?: VideoGenerationAdapter;
  /** music_gen provider adapter. Absent => ToolUnavailableError at call time. */
  musicAdapter?: MusicGenerationAdapter;
  /** browser_operate session adapter. Absent => ToolUnavailableError at call time. */
  browserAdapter?: BrowserSessionAdapter;
  /** Static origin allowlist for browser_operate (empty = fail-closed). */
  browserOriginAllowlist?: readonly string[];
  /** computer_operate controller adapter. Absent => ToolUnavailableError at call time. */
  computerAdapter?: ComputerControllerAdapter;
  /** Per-app capability for computer_operate (empty = fail-closed). */
  computerAppAllowlist?: readonly string[];
  /** DNS resolver for browser_operate origin verification (tests inject a mock). */
  browserResolveHost?: (hostname: string) => Promise<string[]>;
}

/** A ToolImplementation that reports unconfigured infrastructure honestly. */
function unavailable(toolName: string, detail: string): ToolImplementation {
  return async () => {
    throw new ToolUnavailableError(`${toolName} is not configured: ${detail}`);
  };
}

/**
 * Build the ToolImplementation map for the five Phase 3 tools. The returned
 * record is frozen and contains exactly PHASE3_TOOL_NAMES keys.
 */
export function createPhase3ToolHandlers(
  options: Phase3ToolHandlersOptions = {},
): Readonly<Record<string, ToolImplementation>> {
  const {
    videoAdapter,
    musicAdapter,
    browserAdapter,
    browserOriginAllowlist = [],
    computerAdapter,
    computerAppAllowlist = [],
    browserResolveHost,
  } = options;

  const videoHandler = videoAdapter !== undefined
    ? createGenerateVideo(videoAdapter)
    : undefined;
  const musicHandler = musicAdapter !== undefined
    ? createGenerateMusic(musicAdapter)
    : undefined;
  const browserHandler = browserAdapter !== undefined
    ? createBrowserOperate(browserAdapter, { originAllowlist: browserOriginAllowlist, ...(browserResolveHost !== undefined ? { resolveHost: browserResolveHost } : {}) })
    : undefined;
  const computerHandler = computerAdapter !== undefined
    ? createComputerOperate(computerAdapter, { appAllowlist: computerAppAllowlist })
    : undefined;

  return Object.freeze({
    video_gen: videoHandler !== undefined
      ? (deps, input) => videoHandler(deps.vfs, input as GenerateVideoInput, deps.credentials)
      : unavailable('video_gen', 'no VideoGenerationAdapter supplied'),
    music_gen: musicHandler !== undefined
      ? (deps, input) => musicHandler(deps.vfs, input as GenerateMusicInput, deps.credentials)
      : unavailable('music_gen', 'no MusicGenerationAdapter supplied'),
    video_edit: async (deps, input) => {
      if (deps.sandbox === undefined) {
        throw new ToolUnavailableError(
          'video_edit requires a sandbox profile for the ffmpeg toolchain',
        );
      }
      const handler = createEditVideo(createSandboxEditVideoRunner(deps.sandbox));
      return handler(deps.vfs, input as EditVideoInput);
    },
    browser_operate: browserHandler !== undefined
      ? (deps, input) => browserHandler(deps.vfs, input as BrowserOperateInput)
      : unavailable('browser_operate', 'no BrowserSessionAdapter supplied'),
    computer_operate: computerHandler !== undefined
      ? (deps, input) => computerHandler(deps.vfs, input as ComputerOperateInput)
      : unavailable('computer_operate', 'no ComputerControllerAdapter supplied'),
  });
}
