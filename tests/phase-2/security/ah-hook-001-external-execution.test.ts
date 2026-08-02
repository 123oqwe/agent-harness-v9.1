import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HookSystem } from '../../../packages/runtime-core/src/index.js';
import {
  assertTrustedHookSandboxResult,
  SandboxedHookExecutionPort,
} from '../../../runtime/sandboxed-hook-execution-port.js';

const roots: string[] = [];

afterEach(() => {
  delete process.env.HOOK_HOST_SECRET;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const scope = Object.freeze({
  tenant_id: 'tenant-a',
  run_id: 'run-a',
  session_id: 'session-a',
  operation_id: 'operation-a',
  attempt_id: 'attempt-a',
});

const request = (
  payload: unknown,
  event: 'pre_tool_use' | 'post_tool_use' = 'pre_tool_use',
  signal?: AbortSignal,
) => ({
  event,
  invocation_id: 'invocation-a',
  idempotency_key: `idempotency-${createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')}`,
  scope,
  payload,
  ...(signal === undefined ? {} : { signal }),
});

const externalFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-hook-external-test-'));
  roots.push(root);
  const scriptPath = join(root, 'hook.mjs');
  writeFileSync(
    scriptPath,
    `import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const mode = input.payload.mode;
let follow_up;
if (mode === 'env') {
  follow_up = { leaked: process.env.HOOK_HOST_SECRET ?? null };
} else if (mode === 'fs') {
  try { follow_up = { read: readFileSync(input.payload.path, 'utf8') }; }
  catch { follow_up = { read: null }; }
} else if (mode === 'network') {
  follow_up = await new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: input.payload.port });
    socket.once('connect', () => { socket.destroy(); resolve({ connected: true }); });
    socket.once('error', () => resolve({ connected: false }));
    setTimeout(() => { socket.destroy(); resolve({ connected: false }); }, 100).unref();
  });
} else if (mode === 'late-effect') {
  process.on('SIGTERM', () => undefined);
  setTimeout(() => writeFileSync(input.payload.path, 'late'), 80);
  await new Promise((resolve) => setTimeout(resolve, 5_000));
} else if (mode === 'empty-output') {
  process.exit(0);
} else if (mode === 'invalid-json') {
  process.stdout.write('not-json');
  process.exit(0);
} else if (mode === 'large-output') {
  process.stdout.write('x'.repeat(300_000));
  process.exit(0);
} else if (mode === 'nonzero-exit') {
  process.exit(7);
}
process.stdout.write(JSON.stringify({ action: 'observe', follow_up }));
`,
    { mode: 0o700 },
  );
  return {
    root,
    scriptPath,
    contentHash: createHash('sha256')
      .update(readFileSync(scriptPath))
      .digest('hex'),
  };
};

const externalRegistration = (
  scriptPath: string,
  contentHash: string,
  timeoutMs = 1_000,
  event: 'pre_tool_use' | 'post_tool_use' = 'pre_tool_use',
) =>
  ({
    id: 'reviewed-external-hook',
    event,
    trust: 'hash_reviewed',
    priority: 1,
    timeout_ms: timeoutMs,
    content_hash: contentHash,
    execution: {
      executable_path: process.execPath,
      argv: [scriptPath],
      source_path: scriptPath,
    },
  }) as const;

describe('AH-HOOK-001 external Hook execution boundary', () => {
  it('rejects a simulated fallback or mechanism change after trusted detection', () => {
    expect(() => assertTrustedHookSandboxResult('seatbelt', 'none')).toThrow(
      'changed from seatbelt to none',
    );
    expect(() =>
      assertTrustedHookSandboxResult('bubblewrap', 'seatbelt'),
    ).toThrow('changed from bubblewrap to seatbelt');
    expect(() => assertTrustedHookSandboxResult('none', 'none')).toThrow(
      'changed from none to none',
    );
  });

  it.each(['user', 'hash_reviewed'] as const)(
    'forbids an in-process callback for trust:%s',
    (trust) => {
      expect(
        () =>
          new HookSystem([
            {
              id: `callback-${trust}`,
              event: 'pre_tool_use',
              trust,
              priority: 1,
              timeout_ms: 100,
              ...(trust === 'hash_reviewed'
                ? { content_hash: 'a'.repeat(64) }
                : {}),
              handler: { handle: vi.fn(async () => ({ action: 'continue' })) },
            } as never,
          ]),
      ).toThrow('untrusted hook callbacks are forbidden');
    },
  );

  it('fails closed when external execution is configured without a trusted execution port', async () => {
    const fixture = externalFixture();
    const system = new HookSystem([
      externalRegistration(fixture.scriptPath, fixture.contentHash),
    ]);

    await expect(
      system.dispatch(request({ mode: 'env' })),
    ).resolves.toMatchObject({
      action: 'deny',
      reason_code: 'untrusted_hook_execution_unavailable',
    });
  });

  it('rejects hashing an unrelated source while executing an interpreter argv payload', async () => {
    const fixture = externalFixture();
    const system = new HookSystem(
      [
        {
          ...externalRegistration(fixture.scriptPath, fixture.contentHash),
          execution: {
            executable_path: process.execPath,
            argv: ['-e', 'process.stdout.write("{}")'],
            source_path: fixture.scriptPath,
          },
        },
      ],
      { executionPort: new SandboxedHookExecutionPort() },
    );

    await expect(
      system.dispatch(request({ mode: 'env' })),
    ).resolves.toMatchObject({
      action: 'deny',
      reason_code: 'hook_error',
    });
  });

  it('clears host secrets and denies host filesystem and network access', async () => {
    const fixture = externalFixture();
    const secretPath = join(fixture.root, 'secret.txt');
    writeFileSync(secretPath, 'must-not-read');
    process.env.HOOK_HOST_SECRET = 'must-not-inherit';
    const executionPort = new SandboxedHookExecutionPort();
    const registration = externalRegistration(
      fixture.scriptPath,
      fixture.contentHash,
      10_000,
      'post_tool_use',
    );
    await expect(
      executionPort.execute(
        registration,
        {
          hook_id: registration.id,
          event: 'post_tool_use',
          trust: registration.trust,
          invocation_id: 'direct-isolation-check',
          scope,
          payload: { mode: 'env' },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ action: 'observe', follow_up: { leaked: null } });
    const system = new HookSystem(
      [registration],
      { executionPort },
    );

    await expect(
      system.dispatch(request({ mode: 'env' }, 'post_tool_use')),
    ).resolves.toMatchObject({
      action: 'continue',
      follow_ups: [{ leaked: null }],
    });
    await expect(
      system.dispatch(
        request({ mode: 'fs', path: secretPath }, 'post_tool_use'),
      ),
    ).resolves.toMatchObject({
      action: 'continue',
      follow_ups: [{ read: null }],
    });
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('port unavailable');
      await expect(
        system.dispatch(
          request({ mode: 'network', port: address.port }, 'post_tool_use'),
        ),
      ).resolves.toMatchObject({
        action: 'continue',
        follow_ups: [{ connected: false }],
      });
    } finally {
      server.close();
    }
  }, 30_000);

  it('kills an ignoring process tree and permits zero late effects', async () => {
    const fixture = externalFixture();
    const marker = join(fixture.root, 'late-effect.txt');
    const executionPort = new SandboxedHookExecutionPort();
    const system = new HookSystem(
      [externalRegistration(fixture.scriptPath, fixture.contentHash, 20)],
      { executionPort },
    );

    await expect(
      system.dispatch(request({ mode: 'late-effect', path: marker })),
    ).resolves.toMatchObject({ action: 'deny', reason_code: 'hook_timeout' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(() => readFileSync(marker, 'utf8')).toThrow();
  });

  it('rejects a row whose reviewed source bytes no longer match content_hash', async () => {
    const fixture = externalFixture();
    const executionPort = new SandboxedHookExecutionPort();
    writeFileSync(fixture.scriptPath, 'process.stdout.write("{}")');
    const system = new HookSystem(
      [externalRegistration(fixture.scriptPath, fixture.contentHash)],
      { executionPort },
    );

    await expect(
      system.dispatch(request({ mode: 'env' })),
    ).resolves.toMatchObject({
      action: 'deny',
      reason_code: 'hook_error',
    });
  });

  it('rejects every untrusted executable and source path shape directly', async () => {
    const fixture = externalFixture();
    const port = new SandboxedHookExecutionPort();
    const base = externalRegistration(fixture.scriptPath, fixture.contentHash);
    const input = {
      hook_id: base.id,
      event: base.event,
      trust: base.trust,
      invocation_id: 'invalid-path-shape',
      scope,
      payload: { mode: 'env' },
    } as const;
    for (const [execution, message] of [
      [
        { ...base.execution, executable_path: 'node' },
        'external hook executable must be absolute',
      ],
      [
        { ...base.execution, source_path: 'hook.mjs' },
        'external hook source must be absolute',
      ],
      [
        { ...base.execution, source_path: fixture.root },
        'external hook source must be a regular file',
      ],
      [
        { ...base.execution, executable_path: '/usr/bin/true' },
        'external Hook execution must use the trusted Node runtime',
      ],
      [
        { ...base.execution, argv: [] },
        'external Hook execution must use the trusted Node runtime',
      ],
      [
        { ...base.execution, argv: ['relative-hook.mjs'] },
        'external Hook execution must use the trusted Node runtime',
      ],
      [
        { ...base.execution, argv: [process.execPath] },
        'external Hook execution must use the trusted Node runtime',
      ],
    ] as const) {
      await expect(
        port.execute(
          { ...base, execution } as never,
          input,
          new AbortController().signal,
        ),
      ).rejects.toThrow(message);
    }
  }, 30_000);

  it.each([
    ['empty-output', 'external Hook returned an invalid JSON envelope size'],
    ['invalid-json', 'external Hook stdout must contain exactly one JSON value'],
    ['large-output', 'external Hook stdout must contain exactly one JSON value'],
    ['nonzero-exit', 'external Hook sandbox execution failed closed'],
  ] as const)(
    'fails closed on external result mode %s',
    async (mode, message) => {
      const fixture = externalFixture();
      const registration = externalRegistration(
        fixture.scriptPath,
        fixture.contentHash,
        10_000,
      );
      await expect(
        new SandboxedHookExecutionPort().execute(
          registration,
          {
            hook_id: registration.id,
            event: registration.event,
            trust: registration.trust,
            invocation_id: `invalid-result-${mode}`,
            scope,
            payload: { mode },
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(message);
    },
    30_000,
  );

  it('rejects oversized input before external execution', async () => {
    const fixture = externalFixture();
    const registration = externalRegistration(
      fixture.scriptPath,
      fixture.contentHash,
      10_000,
    );
    await expect(
      new SandboxedHookExecutionPort().execute(
        registration,
        {
          hook_id: registration.id,
          event: registration.event,
          trust: registration.trust,
          invocation_id: 'oversized-input',
          scope,
          payload: { value: 'x'.repeat(300_000) },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('external Hook input exceeds JSON limit');
  }, 30_000);
});
