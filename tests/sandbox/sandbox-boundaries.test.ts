import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertWithinWorkspace,
  buildSandboxArgv,
  buildSandboxSpawnOptions,
  compileSeatbeltProfile,
  classifyResourceLimit,
  detectMechanism,
  execSandboxed,
  inspectProcessResourceLimit,
  isValidEgressHost,
  killSandboxProcessTree,
  limitOutputChunk,
  measureProcessTree,
  parseProcessTable,
  runSandboxedText,
  SandboxError,
} from '../../runtime/sandbox.js';
import type {
  SandboxExecOptions,
  SandboxProfile,
} from '../../runtime/sandbox.js';

const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH;

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'ah-sandbox-boundary-'));
  temporaryDirectories.push(path);
  return path;
}

function profile(workspaceRoot: string): SandboxProfile {
  return {
    workspaceRoot,
    allowNetwork: false,
    allowUnixSockets: false,
    allowRead: [],
  };
}

function options(root: string): SandboxExecOptions {
  return {
    argv: ['/bin/echo', 'ok'],
    cwd: root,
    profile: profile(root),
  };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

describe('Sandbox mechanism detection boundaries', () => {
  it('selects only a mechanism actually available for the requested platform', () => {
    let probes = 0;
    const probe = (): boolean => {
      probes += 1;
      return true;
    };

    expect(detectMechanism({
      platform: 'darwin',
      hasBubblewrap: probe,
    })).toBe('seatbelt');
    expect(probes).toBe(0);
    expect(detectMechanism({
      platform: 'linux',
      hasBubblewrap: probe,
    })).toBe('bubblewrap');
    expect(probes).toBe(1);
    expect(detectMechanism({
      platform: 'linux',
      hasBubblewrap: () => false,
    })).toBe('none');
    expect(detectMechanism({
      platform: 'linux',
      hasBubblewrap: () => {
        throw new Error('probe failed');
      },
    })).toBe('none');
    expect(detectMechanism({
      platform: 'win32',
      hasBubblewrap: probe,
    })).toBe('none');
    expect(probes).toBe(1);
  });

  it('probes the explicit PATH for an executable bubblewrap without a shell', () => {
    const bin = temporaryDirectory();
    const bubblewrap = join(bin, 'bwrap');
    writeFileSync(bubblewrap, '#!/bin/sh\nexit 0\n');
    chmodSync(bubblewrap, 0o755);

    process.env.PATH = `${delimiter}${bin}`;
    expect(detectMechanism({ platform: 'linux' })).toBe('bubblewrap');
    chmodSync(bubblewrap, 0o600);
    expect(detectMechanism({ platform: 'linux' })).toBe('none');
    delete process.env.PATH;
    expect(detectMechanism({ platform: 'linux' })).toBe('none');
  });
});

describe('Sandbox path authority boundaries', () => {
  it('accepts only the canonical workspace root or its descendants', () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    mkdirSync(join(root, 'nested'));
    symlinkSync(outside, join(root, 'escape'));

    expect(() => assertWithinWorkspace(root, root)).not.toThrow();
    expect(() => assertWithinWorkspace(join(root, 'nested'), root)).not.toThrow();
    expect(() => assertWithinWorkspace(join(root, '..safe'), root)).not.toThrow();
    expect(() => assertWithinWorkspace(join(root, '..'), root)).toThrow(
      expect.objectContaining({
        name: 'SandboxError',
        message: `cwd outside workspace root: ${join(root, '..')}`,
      }),
    );
    expect(() => assertWithinWorkspace(outside, root)).toThrow(
      expect.objectContaining({
        name: 'SandboxError',
        message: `cwd outside workspace root: ${outside}`,
      }),
    );
    expect(() => assertWithinWorkspace(join(root, 'escape'), root)).toThrow(
      expect.objectContaining({
        name: 'SandboxError',
        message: `cwd outside workspace root: ${join(root, 'escape')}`,
      }),
    );
  });
});

describe('Sandbox public input boundaries', () => {
  it('rejects every malformed argv shape before mechanism detection or spawn', async () => {
    const root = temporaryDirectory();
    const cases: ReadonlyArray<{
      argv: unknown;
      message: string;
    }> = [
      { argv: null, message: 'argv must be a non-empty array of safe strings' },
      { argv: [], message: 'argv must be a non-empty array of safe strings' },
      { argv: [1], message: 'argv must be a non-empty array of safe strings' },
      { argv: [''], message: 'argv must be a non-empty array of safe strings' },
      {
        argv: ['/bin/echo', 'bad\0argument'],
        message: 'argv must be a non-empty array of safe strings',
      },
      {
        argv: ['bin/echo'],
        message: 'argv[0] must be an absolute executable path',
      },
    ];

    for (const testCase of cases) {
      await expect(execSandboxed({
        ...options(root),
        argv: testCase.argv,
      } as SandboxExecOptions)).rejects.toEqual(
        expect.objectContaining({
          name: 'SandboxError',
          message: testCase.message,
        }),
      );
    }
    await expect(execSandboxed(null as unknown as SandboxExecOptions)).rejects.toEqual(
      expect.objectContaining({
        name: 'SandboxError',
        message: 'sandbox options and profile are required',
      }),
    );
    await expect(execSandboxed({
      ...options(root),
      profile: null,
    } as unknown as SandboxExecOptions)).rejects.toEqual(
      expect.objectContaining({
        name: 'SandboxError',
        message: 'sandbox options and profile are required',
      }),
    );
  });

  it('rejects each invalid limit independently with its exact authority name', async () => {
    const root = temporaryDirectory();
    for (const name of [
      'timeoutMs',
      'memoryMb',
      'outputBytes',
      'processLimit',
    ] as const) {
      for (const value of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(execSandboxed({
          ...options(root),
          limits: { [name]: value },
        })).rejects.toEqual(
          expect.objectContaining({
            name: 'SandboxError',
            message: `${name} must be a positive safe integer`,
          }),
        );
      }
    }
    for (const limits of [null, 'invalid', []]) {
      await expect(execSandboxed({
        ...options(root),
        limits,
      } as unknown as SandboxExecOptions)).rejects.toEqual(
        expect.objectContaining({
          name: 'SandboxError',
          message: 'limits must be an object',
        }),
      );
    }
  });

  it('requires real directory authorities for workspace, cwd, and reads', async () => {
    const root = temporaryDirectory();
    const file = join(root, 'file.txt');
    writeFileSync(file, 'not a directory');
    const missing = join(root, 'missing');
    const invalidCases: ReadonlyArray<{
      value: SandboxExecOptions;
      message: string;
    }> = [
      {
        value: { ...options(root), profile: profile(missing) },
        message: 'workspaceRoot must be an existing directory',
      },
      {
        value: { ...options(root), profile: profile(file), cwd: file },
        message: 'workspaceRoot must be an existing directory',
      },
      {
        value: {
          ...options(root),
          profile: { ...profile(root), workspaceRoot: 1 },
        } as unknown as SandboxExecOptions,
        message: 'workspaceRoot must be an existing directory',
      },
      {
        value: {
          ...options(root),
          profile: { ...profile(root), workspaceRoot: '/bad\0root' },
        },
        message: 'workspaceRoot must be an existing directory',
      },
      {
        value: { ...options(root), cwd: missing },
        message: 'cwd must be an existing directory',
      },
      {
        value: { ...options(root), cwd: file },
        message: 'cwd must be an existing directory',
      },
      {
        value: { ...options(root), cwd: 1 } as unknown as SandboxExecOptions,
        message: 'cwd must be an existing directory',
      },
      {
        value: { ...options(root), cwd: '/bad\ncwd' },
        message: 'cwd must be an existing directory',
      },
    ];
    for (const testCase of invalidCases) {
      await expect(execSandboxed(testCase.value)).rejects.toEqual(
        expect.objectContaining({
          name: 'SandboxError',
          message: testCase.message,
        }),
      );
    }

    const invalidReads: ReadonlyArray<unknown> = [
      null,
      ['relative'],
      ['/bad\0path'],
      ['/bad\npath'],
      [missing],
      [file, 1],
    ];
    for (const allowRead of invalidReads) {
      await expect(execSandboxed({
        ...options(root),
        profile: {
          ...profile(root),
          allowRead,
        },
      } as SandboxExecOptions)).rejects.toEqual(
        expect.objectContaining({
          name: 'SandboxError',
          message: expect.stringMatching(
            /allowRead must be an array|invalid allowRead path/u,
          ),
        }),
      );
    }
  });

  it('rejects malformed environment and network policy independently', async () => {
    const root = temporaryDirectory();
    const profileCases: ReadonlyArray<{
      patch: Record<string, unknown>;
      message: string | RegExp;
    }> = [
      {
        patch: { allowNetwork: 'false' },
        message: 'network and Unix socket policy must be boolean',
      },
      {
        patch: { allowUnixSockets: 0 },
        message: 'network and Unix socket policy must be boolean',
      },
      { patch: { environment: null }, message: 'environment must be an object' },
      { patch: { environment: [] }, message: 'environment must be an object' },
      {
        patch: { environment: { '1INVALID': 'value' } },
        message: 'invalid environment variable: 1INVALID',
      },
      {
        patch: { environment: { SAFE: 1 } },
        message: 'invalid environment variable: SAFE',
      },
      {
        patch: { environment: { SAFE: 'bad\0value' } },
        message: 'invalid environment variable: SAFE',
      },
      {
        patch: { environment: { SAFE: 'bad\nvalue' } },
        message: 'invalid environment variable: SAFE',
      },
      ...['TOKEN', 'API_KEY', 'SECRET', 'PASSWORD', 'CREDENTIAL'].map((key) => ({
        patch: { environment: { [key]: 'value' } },
        message: `credential-like environment variable rejected: ${key}`,
      })),
      {
        patch: { egressAllowlist: null },
        message: 'egressAllowlist must be an array',
      },
      {
        patch: { egressAllowlist: {} },
        message: 'egressAllowlist must be an array',
      },
      {
        patch: { egressAllowlist: [null] },
        message: 'invalid egress host: null',
      },
      {
        patch: { egressAllowlist: [{}] },
        message: 'invalid egress host: undefined',
      },
      ...[
        '',
        '-bad.example',
        'bad-.example',
        'bad..example',
        'bad host',
        '256.1.1.1',
        '1.2.3.999',
        '_bad.example',
        'bad_underscore.example',
        `${'a'.repeat(64)}.example`,
        `${'a'.repeat(254)}`,
      ].map((host) => ({
        patch: { egressAllowlist: [{ host }] },
        message: `invalid egress host: ${host}`,
      })),
    ];

    for (const testCase of profileCases) {
      await expect(execSandboxed({
        ...options(root),
        profile: {
          ...profile(root),
          ...testCase.patch,
        },
      } as SandboxExecOptions)).rejects.toEqual(
        expect.objectContaining({
          name: 'SandboxError',
          message: testCase.message,
        }),
      );
    }
  });

  it('accepts a complete network-denied profile without dropping authorities', async () => {
    const root = temporaryDirectory();
    const readable = temporaryDirectory();
    const result = await execSandboxed({
      argv: ['/bin/echo', 'valid-profile'],
      cwd: root,
      profile: {
        workspaceRoot: root,
        allowNetwork: false,
        allowUnixSockets: false,
        allowRead: [readable],
        environment: {
          SAFE_VALUE: 'visible',
          lower_case_9: 'also-visible',
        },
        egressAllowlist: [],
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('valid-profile\n');
    expect(result).toMatchObject({
      timedOut: false,
      canceled: false,
      truncated: false,
      mechanism: detectMechanism(),
    });
    expect(result).not.toHaveProperty('limitExceeded');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('validates exact future-proxy host syntax and fails closed on network enablement', async () => {
    const validHosts = [
      'a',
      'api.example.com',
      'hyphen-name.example',
      '127.0.0.1x',
      '0.0.0.0',
      '255.255.255.255',
      `${'a'.repeat(63)}.example`,
      [
        'a'.repeat(63),
        'b'.repeat(63),
        'c'.repeat(63),
        'd'.repeat(61),
      ].join('.'),
    ];
    for (const host of validHosts) expect(isValidEgressHost(host), host).toBe(true);
    for (const host of [
      null,
      '',
      '-bad.example',
      'bad-.example',
      'bad..example',
      'bad host',
      '_bad.example',
      'bad_underscore.example',
      '256.1.1.1',
      '1.2.3.999',
      `${'a'.repeat(64)}.example`,
      'a'.repeat(254),
    ]) {
      expect(isValidEgressHost(host), String(host)).toBe(false);
    }

    const root = temporaryDirectory();
    const mechanism = detectMechanism();
    await expect(execSandboxed({
      ...options(root),
      profile: {
        ...profile(root),
        allowNetwork: true,
        egressAllowlist: [{ host: 'api.example.com' }],
      },
    })).rejects.toEqual(
      expect.objectContaining({
        name: 'SandboxError',
        message: mechanism === 'none'
          ? expect.stringContaining('no OS sandbox mechanism available')
          : `network egress is not supported by the ${mechanism} sandbox authority`,
      }),
    );
  });

  it('refuses execution when the selected runtime has no OS authority', async () => {
    const root = temporaryDirectory();
    await expect(execSandboxed(
      options(root),
      { detectMechanism: () => 'none' },
    )).rejects.toEqual(
      expect.objectContaining({
        name: 'SandboxError',
        message:
          'no OS sandbox mechanism available on this platform — refusing to execute unsandboxed. ' +
          'Install bubblewrap on Linux or use macOS Seatbelt; Windows is unsupported.',
      }),
    );
  });

  it('reports profile compilation failure and never spawns a raw command', async () => {
    const root = temporaryDirectory();
    await expect(execSandboxed(options(root), {
      detectMechanism: () => 'seatbelt',
      compileSeatbeltProfile: () => {
        throw new Error('compiler failed');
      },
    })).rejects.toEqual(
      expect.objectContaining({
        name: 'SandboxError',
        message: 'failed to build sandbox profile: compiler failed',
      }),
    );
  });

  it('honors a signal that was already aborted before listener registration', async () => {
    const root = temporaryDirectory();
    const controller = new AbortController();
    controller.abort();
    const result = await execSandboxed({
      ...options(root),
      argv: ['/bin/sh', '-c', 'sleep 5'],
      signal: controller.signal,
      limits: { timeoutMs: 5_000 },
    });

    expect(result.canceled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeLessThan(2_000);
  });

  it('enforces an injected process-tree sample and records the exact limit', async () => {
    const root = temporaryDirectory();
    let samples = 0;
    const result = await execSandboxed({
      ...options(root),
      argv: ['/bin/sh', '-c', 'sleep 5'],
      limits: { timeoutMs: 5_000 },
    }, {
      inspectResourceLimit: () => {
        samples += 1;
        return 'process';
      },
    });

    expect(samples).toBeGreaterThan(0);
    expect(result.limitExceeded).toBe('process');
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeLessThan(2_000);
  });

  it('owns and removes its temporary authority on success and profile failure', async () => {
    const parent = temporaryDirectory();
    const successContainer = join(parent, 'success-container');
    mkdirSync(successContainer);
    const root = temporaryDirectory();
    const result = await execSandboxed(options(root), {
      makeTempDirectory: () => successContainer,
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(successContainer)).toBe(false);

    const failureContainer = join(parent, 'failure-container');
    mkdirSync(failureContainer);
    await expect(execSandboxed(options(root), {
      detectMechanism: () => 'seatbelt',
      makeTempDirectory: () => failureContainer,
      compileSeatbeltProfile: () => {
        throw new Error('expected failure');
      },
    })).rejects.toThrow(/failed to build sandbox profile: expected failure/u);
    expect(existsSync(failureContainer)).toBe(false);
  });

  it('normalizes a child spawn error and removes its temporary authority', async () => {
    const root = temporaryDirectory();
    const emptyPath = temporaryDirectory();
    process.env.PATH = emptyPath;
    await expect(execSandboxed(options(root), {
      detectMechanism: () => 'bubblewrap',
    })).rejects.toEqual(
      expect.objectContaining({
        name: 'SandboxError',
        message: expect.stringMatching(/^spawn failed: .*ENOENT$/u),
      }),
    );
  });
});

describe('macOS Seatbelt profile compiler', () => {
  it('emits exact escaped filesystem authorities and deny-by-default network', () => {
    const compiled = compileSeatbeltProfile({
      workspaceRoot: '/workspace/"quoted',
      allowNetwork: false,
      allowUnixSockets: false,
      allowRead: ['/read\\root'],
    }, '/tmp/"sandbox');
    const lines = compiled.trimEnd().split('\n');

    expect(lines).toEqual([
      '(version 1)',
      '(deny default)',
      '(allow process-info* (target self))',
      '(allow signal (target self))',
      '(allow sysctl-read)',
      '(allow file-read*)',
      '(deny file-read* (subpath "/Users"))',
      '(deny file-read* (subpath "/Volumes"))',
      '(deny file-read* (subpath "/private/var/folders"))',
      '(deny file-read* (subpath "/etc/ssh"))',
      '(deny file-read* (subpath "/etc/ssl/private"))',
      '(deny file-read* (literal "/etc/passwd"))',
      '(deny file-read* (literal "/etc/master.passwd"))',
      '(deny file-read* (literal "/etc/shadow"))',
      '(deny file-read* (literal "/private/etc/passwd"))',
      '(deny file-read* (literal "/private/etc/master.passwd"))',
      '(deny file-read* (literal "/private/etc/shadow"))',
      '(allow file-read* (subpath "/workspace/\\"quoted"))',
      '(allow file-write* (subpath "/workspace/\\"quoted"))',
      '(allow file-write* (subpath "/tmp/\\"sandbox"))',
      '(allow file-write* (literal "/dev/null"))',
      '(allow file-write* (literal "/dev/dtracehelper"))',
      '(allow file-read* (subpath "/tmp/\\"sandbox"))',
      '(allow file-read* (subpath "/read\\\\root"))',
      '(deny network*)',
      '(allow process-fork)',
      '(allow process-exec)',
    ]);
    expect(compiled.endsWith('\n')).toBe(true);
  });

  it('refuses to widen declared hosts into Seatbelt wildcard access', () => {
    const base = {
      workspaceRoot: '/workspace',
      allowNetwork: true,
      allowRead: [],
      egressAllowlist: [
        { host: 'api.example.com' },
        { host: '127.0.0.1' },
      ],
    };
    expect(() => compileSeatbeltProfile({
      ...base,
      allowUnixSockets: false,
    }, '/tmp/sandbox')).toThrow(
      expect.objectContaining({
        name: 'SandboxError',
        message: 'host-scoped network egress is not enforceable by macOS Seatbelt',
      }),
    );
    expect(() => compileSeatbeltProfile({
      ...base,
      allowUnixSockets: true,
      egressAllowlist: [],
    }, '/tmp/sandbox')).toThrow(SandboxError);
  });
});

describe('OS sandbox argv compiler', () => {
  it('builds exact Seatbelt and bubblewrap invocations without raw fallback', () => {
    const base = options('/workspace');
    expect(buildSandboxArgv(
      base,
      'seatbelt',
      '/tmp/profile.sb',
    )).toEqual([
      'sandbox-exec',
      '-f',
      '/tmp/profile.sb',
      '--',
      '/bin/echo',
      'ok',
    ]);
    expect(() => buildSandboxArgv(base, 'seatbelt')).toThrow(
      expect.objectContaining({
        name: 'SandboxError',
        message: 'Seatbelt profile file is required',
      }),
    );

    const systemRoots = ['/usr', '/bin', '/sbin', '/lib', '/lib64']
      .filter(existsSync);
    expect(buildSandboxArgv({
      ...base,
      profile: {
        ...base.profile,
        allowRead: ['/read-one', '/read-two'],
      },
    }, 'bubblewrap', undefined, {
      timeoutMs: 5_000,
      memoryMb: 64,
      outputBytes: 4_096,
      processLimit: 7,
    })).toEqual([
      'bwrap',
      '--unshare-all',
      '--new-session',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      ...systemRoots.flatMap((path) => ['--ro-bind', path, path]),
      '--ro-bind',
      '/read-one',
      '/read-one',
      '--ro-bind',
      '/read-two',
      '/read-two',
      '--bind',
      '/workspace',
      '/workspace',
      '--die-with-parent',
      '--hostname',
      'sandbox',
      '--',
      '/bin/sh',
      '-c',
      'ulimit -v "$1" && ulimit -u "$2" && shift 2 && exec "$@"',
      '--',
      String(64 * 1024),
      '7',
      '/bin/echo',
      'ok',
    ]);
    expect(() => buildSandboxArgv(base, 'none')).toThrow(
      expect.objectContaining({
        name: 'SandboxError',
        message: 'no wrapped argv exists for sandbox mechanism: none',
      }),
    );
    expect(() => buildSandboxArgv(base, 'appcontainer')).toThrow(
      expect.objectContaining({
        name: 'SandboxError',
        message: 'no wrapped argv exists for sandbox mechanism: appcontainer',
      }),
    );
  });

  it('builds an exact minimal spawn environment and process-group policy', () => {
    const configured = {
      ...options('/workspace'),
      profile: {
        ...profile('/workspace'),
        environment: { SAFE_VALUE: 'visible' },
      },
    };
    expect(buildSandboxSpawnOptions(
      configured,
      '/tmp/sandbox',
      { PATH: '/custom/bin', LANG: 'en_US.UTF-8', SECRET: 'must-not-leak' },
    )).toEqual({
      cwd: '/workspace',
      env: {
        PATH: '/custom/bin',
        HOME: '/tmp/sandbox',
        TMPDIR: '/tmp/sandbox',
        LANG: 'en_US.UTF-8',
        NPM_CONFIG_CACHE: '/tmp/sandbox/npm-cache',
        SAFE_VALUE: 'visible',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: true,
    });
    expect(buildSandboxSpawnOptions(
      options('/workspace'),
      '/tmp/fallback',
      {},
    )).toEqual({
      cwd: '/workspace',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/tmp/fallback',
        TMPDIR: '/tmp/fallback',
        LANG: 'C.UTF-8',
        NPM_CONFIG_CACHE: '/tmp/fallback/npm-cache',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: true,
    });
  });

  it('kills the negative process group and uses the direct-child fallback', () => {
    const groupCalls: Array<[number, NodeJS.Signals]> = [];
    const childCalls: NodeJS.Signals[] = [];
    killSandboxProcessTree(
      42,
      (pid, signal) => groupCalls.push([pid, signal]),
      (signal) => {
        childCalls.push(signal);
        return true;
      },
    );
    expect(groupCalls).toEqual([[-42, 'SIGKILL']]);
    expect(childCalls).toEqual([]);

    killSandboxProcessTree(
      43,
      () => {
        throw new Error('group unavailable');
      },
      (signal) => {
        childCalls.push(signal);
        return true;
      },
    );
    killSandboxProcessTree(
      undefined,
      () => {
        throw new Error('must not be called');
      },
      (signal) => {
        childCalls.push(signal);
        throw new Error('already exited');
      },
    );
    expect(childCalls).toEqual(['SIGKILL', 'SIGKILL']);
  });
});

describe('Sandbox deterministic resource accounting', () => {
  it('parses only finite process rows and measures transitive descendants', () => {
    const rows = parseProcessTable([
      '1 0 100',
      '3 2 300',
      '2 1 200',
      '4 99 400',
      '5 invalid 500',
      '6 1',
      '',
    ].join('\n'));
    expect(rows).toEqual([
      { pid: 1, ppid: 0, rssKb: 100 },
      { pid: 3, ppid: 2, rssKb: 300 },
      { pid: 2, ppid: 1, rssKb: 200 },
      { pid: 4, ppid: 99, rssKb: 400 },
    ]);
    expect(measureProcessTree(rows, 1)).toEqual({
      processCount: 3,
      rssKb: 600,
    });
    expect(measureProcessTree(rows, 99)).toEqual({
      processCount: 2,
      rssKb: 400,
    });
    expect(measureProcessTree(rows, 777)).toEqual({
      processCount: 1,
      rssKb: 0,
    });
    expect(parseProcessTable(' \n ')).toEqual([]);
  });

  it('classifies process limits before memory and preserves exact boundaries', () => {
    const limits = {
      timeoutMs: 1_000,
      memoryMb: 2,
      outputBytes: 1_000,
      processLimit: 3,
    };
    expect(classifyResourceLimit({
      processCount: 4,
      rssKb: 10_000,
    }, limits)).toBe('process');
    expect(classifyResourceLimit({
      processCount: 3,
      rssKb: 2_049,
    }, limits)).toBe('memory');
    expect(classifyResourceLimit({
      processCount: 3,
      rssKb: 2_048,
    }, limits)).toBeUndefined();
  });

  it('applies one exact output budget without marking an exact fill truncated', () => {
    expect(limitOutputChunk(Buffer.from('abc'), 0, 5)).toEqual({
      accepted: Buffer.from('abc'),
      totalBytes: 3,
      truncated: false,
    });
    expect(limitOutputChunk(Buffer.from('de'), 3, 5)).toEqual({
      accepted: Buffer.from('de'),
      totalBytes: 5,
      truncated: false,
    });
    expect(limitOutputChunk(Buffer.from('def'), 3, 5)).toEqual({
      accepted: Buffer.from('de'),
      totalBytes: 5,
      truncated: true,
    });
    expect(limitOutputChunk(Buffer.from('x'), 5, 5)).toEqual({
      accepted: Buffer.alloc(0),
      totalBytes: 5,
      truncated: true,
    });
  });

  it('reads one exact process table command and classifies its result', () => {
    const calls: unknown[][] = [];
    const limits = {
      timeoutMs: 1_000,
      memoryMb: 2,
      outputBytes: 1_000,
      processLimit: 1,
    };
    const exceeded = inspectProcessResourceLimit(
      10,
      limits,
      (executable, argv, options) => {
        calls.push([executable, argv, options]);
        return '10 1 100\n11 10 200\n';
      },
    );
    expect(calls).toEqual([[
      '/bin/ps',
      ['-axo', 'pid=,ppid=,rss='],
      { encoding: 'utf8', maxBuffer: 4_194_304 },
    ]]);
    expect(exceeded).toBe('process');
    expect(inspectProcessResourceLimit(
      10,
      { ...limits, processLimit: 3 },
      () => '10 1 100\n',
    )).toBeUndefined();
  });
});

describe('runSandboxedText result contract', () => {
  it('returns stdout, rejects normal non-zero exit, and honors ignoreExit', async () => {
    const root = temporaryDirectory();
    expect(await runSandboxedText({
      ...options(root),
      argv: ['/usr/bin/printf', 'plain-output'],
    })).toBe('plain-output');

    const longErrorCommand =
      'i=0; while [ "$i" -lt 600 ]; do printf x >&2; i=$((i + 1)); done; exit 7';
    await expect(runSandboxedText({
      ...options(root),
      argv: ['/bin/sh', '-c', longErrorCommand],
    })).rejects.toEqual(
      expect.objectContaining({
        name: 'SandboxError',
        message: `exit 7: ${'x'.repeat(500)}`,
      }),
    );
    expect(await runSandboxedText({
      ...options(root),
      argv: ['/bin/sh', '-c', 'printf kept; exit 3'],
    }, true)).toBe('kept');
  });
});
