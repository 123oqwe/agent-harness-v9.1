import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { StoreBackend, VirtualFilesystem } from '../../vfs/virtual-filesystem.js';
import { ToolUnavailableError } from '../../tools/media-errors.js';
import {
  createEditVideo,
  DEFAULT_EDIT_STDERR_MAX_CHARS,
  DEFAULT_EDIT_VIDEO_TIMEOUT_MS,
  DEFAULT_TOOLCHAIN_CHECK_TIMEOUT_MS,
  type EditProcessResult,
  type EditVideoProcessRunner,
} from '../../tools/edit-video.js';

function memVfs(): VirtualFilesystem {
  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
  vfs.mount(new StoreBackend('/workspace'));
  return vfs;
}

const OK_RESULT: EditProcessResult = {
  exitCode: 0,
  stdout: JSON.stringify({ status: 'ok', output_path: '/host/workspace/out.mp4' }),
  stderr: '',
  timedOut: false,
};

interface FakeRunner {
  runner: EditVideoProcessRunner;
  calls: Array<{ argv: readonly string[]; stdin: string; timeoutMs?: number }>;
}

function makeRunner(
  onRun?: (argv: readonly string[], stdin: string, timeoutMs?: number) => EditProcessResult,
): FakeRunner {
  const calls: FakeRunner['calls'] = [];
  return {
    calls,
    runner: {
      async run(argv, stdin, timeoutMs) {
        calls.push({ argv, stdin, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
        return onRun ? onRun(argv, stdin, timeoutMs) : OK_RESULT;
      },
    },
  };
}

function okResult(stdout: object): EditProcessResult {
  return { exitCode: 0, stdout: JSON.stringify(stdout), stderr: '', timedOut: false };
}

function parseStdin(call: { stdin: string }): Record<string, unknown> {
  return JSON.parse(call.stdin) as Record<string, unknown>;
}

const mapHostPath = (p: string): string => `/host${p}`;

describe('AH-TOOL-VIDEO-EDIT-001 handler', () => {
  it('checks ffmpeg, spawns the python helper with JSON stdin, returns ok', async () => {
    const vfs = memVfs();
    vfs.write('/workspace/in.mp4', 'x');
    const fake = makeRunner();
    const handler = createEditVideo(fake.runner, {
      ffmpegBinary: 'fake-ffmpeg',
      mapHostPath,
    });

    const out = await handler(vfs, { command: 'trim', input: '/workspace/in.mp4', output: '/workspace/out.mp4', start: '00:00:01', end: '00:00:03' });

    expect(out.status).toBe('ok');
    expect(out.output_path).toBe('/workspace/out.mp4');
    expect(fake.calls).toHaveLength(2);
    // toolchain check first: fake-ffmpeg -version
    expect(fake.calls[0]!.argv).toEqual(['fake-ffmpeg', '-version']);
    expect(fake.calls[0]!.timeoutMs).toBe(DEFAULT_TOOLCHAIN_CHECK_TIMEOUT_MS);
    // helper spawn: python3 + cli/video_editor.py
    expect(fake.calls[1]!.argv[0]).toBe('python3');
    expect(fake.calls[1]!.argv[1]).toMatch(/cli\/video_editor\.py$/);
    expect(fake.calls[1]!.timeoutMs).toBe(DEFAULT_EDIT_VIDEO_TIMEOUT_MS);
    const payload = parseStdin(fake.calls[1]!);
    expect(payload.command).toBe('trim');
    expect(payload.input).toBe('/host/workspace/in.mp4');
    expect(payload.output).toBe('/host/workspace/out.mp4');
    expect(payload.start).toBe('00:00:01');
    expect(payload.end).toBe('00:00:03');
  });

  it('rejects an invalid command and a missing input path', async () => {
    const vfs = memVfs();
    vfs.write('/workspace/in.mp4', 'x');
    const fake = makeRunner();
    const handler = createEditVideo(fake.runner, { ffmpegBinary: 'fake-ffmpeg', mapHostPath });

    await expect(handler(vfs, { command: 'explode' as unknown as 'trim', input: '/workspace/in.mp4', output: '/workspace/o.mp4' })).rejects.toThrow('invalid command');
    await expect(handler(vfs, { command: 'trim', input: '', output: '/workspace/o.mp4' })).rejects.toThrow('input (VFS path) is required');
    expect(fake.calls).toHaveLength(0);
  });

  it('fails when the input file is missing — no process spawned', async () => {
    const vfs = memVfs();
    const fake = makeRunner();
    const handler = createEditVideo(fake.runner, { ffmpegBinary: 'fake-ffmpeg', mapHostPath });

    await expect(handler(vfs, { command: 'trim', input: '/workspace/nope.mp4', output: '/workspace/o.mp4', start: '0' })).rejects.toThrow('input file not found');
    expect(fake.calls).toHaveLength(0);
  });

  it('checks VFS write permission for the output path before spawning', async () => {
    const vfs = new VirtualFilesystem([
      { prefix: '/workspace', read: true, write: true },
      { prefix: '/readonly', read: true, write: false },
    ]);
    vfs.mount(new StoreBackend('/workspace'));
    vfs.mount(new StoreBackend('/readonly'));
    vfs.write('/workspace/in.mp4', 'x');
    const fake = makeRunner();
    const handler = createEditVideo(fake.runner, { ffmpegBinary: 'fake-ffmpeg', mapHostPath });

    await expect(handler(vfs, { command: 'trim', input: '/workspace/in.mp4', output: '/readonly/out.mp4', start: '0' })).rejects.toThrow('cannot write output');
    expect(fake.calls).toHaveLength(0);
  });

  it('reports tool_unavailable when ffmpeg -version fails and never spawns the helper', async () => {
    const vfs = memVfs();
    vfs.write('/workspace/in.mp4', 'x');
    const fake = makeRunner((argv) =>
      argv.includes('-version')
        ? { exitCode: 127, stdout: '', stderr: 'not found', timedOut: false }
        : OK_RESULT,
    );
    const handler = createEditVideo(fake.runner, { ffmpegBinary: 'fake-ffmpeg', mapHostPath });

    await expect(handler(vfs, { command: 'trim', input: '/workspace/in.mp4', output: '/workspace/out.mp4', start: '0' })).rejects.toBeInstanceOf(ToolUnavailableError);
    expect(fake.calls).toHaveLength(1);
  });

  it('truncates stderr to 2000 chars in the output', async () => {
    const vfs = memVfs();
    vfs.write('/workspace/in.mp4', 'x');
    const noise = 'e'.repeat(5000);
    const fake = makeRunner((argv) =>
      argv.includes('-version')
        ? OK_RESULT
        : { ...okResult({ status: 'ok', output_path: '/host/workspace/out.mp4' }), stderr: noise },
    );
    const handler = createEditVideo(fake.runner, { ffmpegBinary: 'fake-ffmpeg', mapHostPath });

    const out = await handler(vfs, { command: 'trim', input: '/workspace/in.mp4', output: '/workspace/out.mp4', start: '0' });
    expect(out.stderr.startsWith('e'.repeat(DEFAULT_EDIT_STDERR_MAX_CHARS))).toBe(true);
    expect(out.stderr).toContain('[truncated]');
    expect(out.stderr.length).toBeLessThan(noise.length);
  });

  it('propagates the optional duration from the helper', async () => {
    const vfs = memVfs();
    vfs.write('/workspace/in.mp4', 'x');
    const fake = makeRunner((argv) =>
      argv.includes('-version') ? OK_RESULT : okResult({ status: 'ok', output_path: '/host/workspace/out.mp4', duration: 4.5 }),
    );
    const handler = createEditVideo(fake.runner, { ffmpegBinary: 'fake-ffmpeg', mapHostPath });

    const out = await handler(vfs, { command: 'trim', input: '/workspace/in.mp4', output: '/workspace/out.mp4', start: '0' });
    expect(out.duration).toBe(4.5);
  });

  it('maps concat inputs to host paths in the payload', async () => {
    const vfs = memVfs();
    vfs.write('/workspace/a.mp4', 'a');
    vfs.write('/workspace/b.mp4', 'b');
    const fake = makeRunner();
    const handler = createEditVideo(fake.runner, { ffmpegBinary: 'fake-ffmpeg', mapHostPath });

    await handler(vfs, { command: 'concat', input: '/workspace/a.mp4', output: '/workspace/joined.mp4', inputs: ['/workspace/a.mp4', '/workspace/b.mp4'] });

    const payload = parseStdin(fake.calls[1]!);
    expect(payload.inputs).toEqual(['/host/workspace/a.mp4', '/host/workspace/b.mp4']);
  });

  it('rejects invalid JSON stdout with the truncated stderr', async () => {
    const vfs = memVfs();
    vfs.write('/workspace/in.mp4', 'x');
    const fake = makeRunner((argv) =>
      argv.includes('-version') ? OK_RESULT : { exitCode: 0, stdout: 'not json', stderr: 'boom', timedOut: false },
    );
    const handler = createEditVideo(fake.runner, { ffmpegBinary: 'fake-ffmpeg', mapHostPath });

    await expect(handler(vfs, { command: 'trim', input: '/workspace/in.mp4', output: '/workspace/out.mp4', start: '0' })).rejects.toThrow('invalid JSON');
  });

  it('propagates a helper error status', async () => {
    const vfs = memVfs();
    vfs.write('/workspace/in.mp4', 'x');
    const fake = makeRunner((argv) =>
      argv.includes('-version') ? OK_RESULT : okResult({ status: 'error', error: 'no video stream' }),
    );
    const handler = createEditVideo(fake.runner, { ffmpegBinary: 'fake-ffmpeg', mapHostPath });

    await expect(handler(vfs, { command: 'trim', input: '/workspace/in.mp4', output: '/workspace/out.mp4', start: '0' })).rejects.toThrow('no video stream');
  });

  it('enforces the edit timeout as tool_unavailable', async () => {
    const vfs = memVfs();
    vfs.write('/workspace/in.mp4', 'x');
    const fake = makeRunner((argv) =>
      argv.includes('-version')
        ? OK_RESULT
        : { exitCode: null, stdout: '', stderr: '', timedOut: true },
    );
    const handler = createEditVideo(fake.runner, { ffmpegBinary: 'fake-ffmpeg', mapHostPath, timeoutMs: 42 });

    await expect(handler(vfs, { command: 'trim', input: '/workspace/in.mp4', output: '/workspace/out.mp4', start: '0' })).rejects.toThrow('timed out');
    expect(fake.calls[1]!.timeoutMs).toBe(42);
  });
});

describe('AH-TOOL-VIDEO-EDIT-001 cli/video_editor.py (dry-run, real python3)', () => {
  const helperPath = new URL('../../cli/video_editor.py', import.meta.url).pathname;

  function dryRun(spec: object): { argv: string[] } {
    const out = execFileSync('python3', [helperPath, '--dry-run'], {
      input: JSON.stringify(spec),
      encoding: 'utf8',
    });
    return JSON.parse(out) as { argv: string[] };
  }

  it('builds argv arrays only — injection text stays a literal filter value', () => {
    const evil = "foo'; touch /tmp/pwned; echo 'bar";
    const { argv } = dryRun({ command: 'overlay_text', input: '/workspace/in.mp4', output: '/workspace/o.mp4', text: evil, x: '0', y: '0' });

    // single argv element (no shell string); the text survives as a quoted filter value
    const draw = argv.find((a) => a.startsWith('drawtext='));
    expect(draw).toBeDefined();
    expect(argv).toHaveLength(7); // ffmpeg -i in -vf <filter> -y out
    expect(draw!.includes('; touch /tmp/pwned')).toBe(true);
    // the only quotes are the ffmpeg filter quote; the text is never a standalone shell token
    expect(argv.some((a) => a.includes('$((') || a.includes('`'))).toBe(false);
  });

  it('builds the exact trim argv: -ss START -to END -i INPUT -c copy OUTPUT', () => {
    const { argv } = dryRun({ command: 'trim', input: '/v/a.mp4', output: '/v/o.mp4', start: '00:00:01', end: '00:00:03' });
    expect(argv).toEqual(['ffmpeg', '-ss', '00:00:01', '-to', '00:00:03', '-i', '/v/a.mp4', '-c', 'copy', '-y', '/v/o.mp4']);
  });

  it('rejects unknown commands and missing params with structured errors', () => {
    const bad = JSON.parse(execFileSync('python3', [helperPath, '--dry-run'], { input: JSON.stringify({ command: 'nope' }), encoding: 'utf8' })) as { status: string; error: string };
    expect(bad.status).toBe('error');
    expect(bad.error).toMatch(/command must be one of/);
  });
});
