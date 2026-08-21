/**
 * AH-TOOL-VIDEO-EDIT-001: edit_video model-callable tool.
 *
 * ToolSpec: transport=cli_wrapper, tool_group=media_edit, effect=non_idempotent,
 * risk=T2, cli_toolchain_ref=ffmpeg. Requires a capability token whose tool
 * grant includes the video:edit scope (PEP-enforced before dispatch).
 *
 * The handler never interpolates a shell string: it validates the input, checks
 * VFS write permission for the output path, checks toolchain availability
 * (ffmpeg -version -> tool_unavailable on failure), then spawns
 * `python3 cli/video_editor.py` with a JSON command spec on stdin. The Python
 * helper builds ffmpeg ARG ARRAYS only (injection-proof) and returns JSON on
 * stdout. stderr is truncated (default 2000 chars). Timeout default 600s.
 *
 * The process runner is an injected port so tests can fake it; the default
 * runner goes through the OS sandbox (helper runs sandboxed — security
 * invariant). VFS logical paths are mapped to host paths via the local backend
 * mount (override with `mapHostPath`).
 */
import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import type { SandboxProfile } from '../sandbox/process-sandbox.js';
import { execSandboxed } from '../sandbox/process-sandbox.js';
import { MediaToolError, ToolUnavailableError } from './media-errors.js';

export type VideoEditCommand =
  | 'trim'
  | 'concat'
  | 'add_subtitle'
  | 'overlay_text'
  | 'mux'
  | 'transcode'
  | 'extract_frames';

export const VIDEO_EDIT_COMMANDS: readonly VideoEditCommand[] = [
  'trim',
  'concat',
  'add_subtitle',
  'overlay_text',
  'mux',
  'transcode',
  'extract_frames',
];

export interface EditVideoInput {
  command: VideoEditCommand;
  /** VFS input path (required). */
  input: string;
  /** VFS output path (required). */
  output: string;
  /** trim: start timestamp, e.g. "00:00:05". */
  start?: string;
  /** trim: end timestamp, e.g. "00:00:10". */
  end?: string;
  /** concat: ordered VFS input paths. */
  inputs?: string[];
  /** add_subtitle: VFS .srt/.vtt path. */
  subtitle?: string;
  /** overlay_text: literal text to draw. */
  text?: string;
  /** overlay_text: x coordinate. */
  x?: string;
  /** overlay_text: y coordinate. */
  y?: string;
  /** overlay_text: optional font file (host path). */
  fontfile?: string;
  /** mux: VFS audio track path. */
  audio?: string;
  /** transcode: target video codec, e.g. libx264. */
  codec?: string;
  /** extract_frames: output frame rate, e.g. 1. */
  frame_rate?: string;
}

export interface EditVideoOutput {
  status: 'ok';
  output_path: string;
  duration?: number;
  /** stderr from the helper run, truncated to stderrMaxChars. */
  stderr: string;
}

/** Result of a single spawned process. */
export interface EditProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Injected process runner port — tests substitute this. */
export interface EditVideoProcessRunner {
  run(
    argv: readonly string[],
    stdin: string,
    timeoutMs?: number,
  ): Promise<EditProcessResult>;
}

export interface EditVideoOptions {
  /** Path to cli/video_editor.py. Defaults to the sibling cli/ in this repo. */
  helperPath?: string;
  timeoutMs?: number;
  stderrMaxChars?: number;
  ffmpegBinary?: string;
  pythonBinary?: string;
  /** Map a VFS logical path to the host path the helper should pass to ffmpeg. */
  mapHostPath?: (p: string) => string;
}

export const DEFAULT_EDIT_VIDEO_TIMEOUT_MS = 600_000;
export const DEFAULT_EDIT_STDERR_MAX_CHARS = 2000;
export const DEFAULT_TOOLCHAIN_CHECK_TIMEOUT_MS = 15_000;

export type EditVideoHandler = (
  vfs: VirtualFilesystem,
  input: EditVideoInput,
) => Promise<EditVideoOutput>;

/** Resolve a tool binary to an absolute executable path. */
export function resolveToolBinary(
  name: string,
  profile?: SandboxProfile,
): string | undefined {
  const mapped = profile?.commandAllowlist?.[name];
  if (mapped) return mapped;
  if (isAbsolute(name)) return name;
  try {
    const out = execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Default runner: every process executes inside the OS sandbox. */
export function createSandboxEditVideoRunner(
  profile: SandboxProfile,
): EditVideoProcessRunner {
  return {
    async run(argv, stdin, timeoutMs) {
      const r = await execSandboxed({
        argv: [...argv],
        cwd: profile.workspaceRoot,
        profile,
        stdin,
        ...(timeoutMs !== undefined ? { limits: { timeoutMs } } : {}),
      });
      return {
        exitCode: r.exitCode,
        stdout: r.stdout.toString('utf8'),
        stderr: r.stderr.toString('utf8'),
        timedOut: r.timedOut,
      };
    },
  };
}

function truncateStderr(s: string, maxChars: number): string {
  return s.length > maxChars ? `${s.slice(0, maxChars)}…[truncated]` : s;
}

function mapVfsToHost(vfs: VirtualFilesystem, p: string): string {
  const backend = vfs.route(p);
  if (backend.kind !== 'local') {
    throw new MediaToolError(
      `edit_video needs host files: ${p} is not on a local mount`,
    );
  }
  const rootPath = (backend as { rootPath?: string }).rootPath;
  if (rootPath === undefined) {
    throw new MediaToolError(`edit_video needs host files: ${p} backend has no host root`);
  }
  const relative = p.slice(backend.prefix.length === 1 ? 0 : backend.prefix.length);
  return join(rootPath, relative);
}

/** JSON command spec passed to cli/video_editor.py on stdin. */
export interface EditVideoPayload {
  command: VideoEditCommand;
  input: string;
  output: string;
  inputs?: string[];
  start?: string;
  end?: string;
  subtitle?: string;
  text?: string;
  x?: string;
  y?: string;
  fontfile?: string;
  audio?: string;
  codec?: string;
  frame_rate?: string;
}

function buildPayload(
  input: EditVideoInput,
  mapHostPath: (p: string) => string,
): EditVideoPayload {
  const payload: EditVideoPayload = {
    command: input.command,
    input: mapHostPath(input.input),
    output: mapHostPath(input.output),
  };
  if (input.command === 'concat' && input.inputs !== undefined) {
    payload.inputs = input.inputs.map((p) => mapHostPath(p));
  }
  if (input.start !== undefined) payload.start = input.start;
  if (input.end !== undefined) payload.end = input.end;
  if (input.subtitle !== undefined) payload.subtitle = mapHostPath(input.subtitle);
  if (input.text !== undefined) payload.text = input.text;
  if (input.x !== undefined) payload.x = input.x;
  if (input.y !== undefined) payload.y = input.y;
  if (input.fontfile !== undefined) payload.fontfile = input.fontfile;
  if (input.audio !== undefined) payload.audio = mapHostPath(input.audio);
  if (input.codec !== undefined) payload.codec = input.codec;
  if (input.frame_rate !== undefined) payload.frame_rate = input.frame_rate;
  return payload;
}

/** Validate the tool input: command enum + required input/output paths. */
export function validateEditVideoInput(input: EditVideoInput): void {
  if (!VIDEO_EDIT_COMMANDS.includes(input.command)) {
    throw new MediaToolError(
      `invalid command: ${String(input.command)} (expected one of ${VIDEO_EDIT_COMMANDS.join(', ')})`,
    );
  }
  if (typeof input.input !== 'string' || input.input.length === 0) {
    throw new MediaToolError('input (VFS path) is required');
  }
  if (typeof input.output !== 'string' || input.output.length === 0) {
    throw new MediaToolError('output (VFS path) is required');
  }
}

/** Build an edit_video handler around a process runner. */
export function createEditVideo(
  runner: EditVideoProcessRunner,
  options: EditVideoOptions = {},
): EditVideoHandler {
  const helperPath = options.helperPath ?? defaultHelperPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_EDIT_VIDEO_TIMEOUT_MS;
  const stderrMaxChars = options.stderrMaxChars ?? DEFAULT_EDIT_STDERR_MAX_CHARS;
  const ffmpegBinary = options.ffmpegBinary ?? 'ffmpeg';
  const pythonBinary = options.pythonBinary ?? 'python3';

  return async (vfs, input) => {
    const mapHostPath = options.mapHostPath ?? ((p: string) => mapVfsToHost(vfs, p));
    validateEditVideoInput(input);
    if (!vfs.exists(input.input)) {
      throw new MediaToolError(`input file not found: ${input.input}`);
    }
    if (input.command === 'concat' && input.inputs !== undefined) {
      for (const p of input.inputs) {
        if (!vfs.exists(p)) throw new MediaToolError(`concat input not found: ${p}`);
      }
    }
    if (!vfs.canWrite(input.output)) {
      throw new MediaToolError(`cannot write output: ${input.output}`);
    }

    const ffmpeg = resolveToolBinary(ffmpegBinary);
    const toolCheck = await runner.run(
      [ffmpeg ?? ffmpegBinary, '-version'],
      '',
      DEFAULT_TOOLCHAIN_CHECK_TIMEOUT_MS,
    );
    if (toolCheck.timedOut || toolCheck.exitCode !== 0) {
      throw new ToolUnavailableError(
        `ffmpeg toolchain not available (${ffmpegBinary} -version exited ${String(toolCheck.exitCode)})`,
      );
    }

    const payload = buildPayload(input, mapHostPath);
    const run = await runner.run(
      [pythonBinary, helperPath],
      JSON.stringify(payload),
      timeoutMs,
    );
    if (run.timedOut) {
      throw new ToolUnavailableError(`video editing timed out after ${timeoutMs}ms`);
    }

    let parsed: { status?: string; duration?: number; error?: string };
    try {
      parsed = JSON.parse(run.stdout) as { status?: string; duration?: number; error?: string };
    } catch {
      throw new MediaToolError(
        `video_editor.py returned invalid JSON: ${truncateStderr(run.stderr, stderrMaxChars)}`,
      );
    }
    if (parsed.status !== 'ok') {
      throw new MediaToolError(
        `video_editor.py failed: ${parsed.error ?? 'unknown error'} (${truncateStderr(run.stderr, stderrMaxChars)})`,
      );
    }
    const output: EditVideoOutput = {
      status: 'ok',
      output_path: input.output,
      stderr: truncateStderr(run.stderr, stderrMaxChars),
    };
    if (typeof parsed.duration === 'number') output.duration = parsed.duration;
    return output;
  };
}

function defaultHelperPath(): string {
  // This repo's cli/video_editor.py, resolved relative to this module.
  return new URL('../cli/video_editor.py', import.meta.url).pathname;
}
