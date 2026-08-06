import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SandboxProfile } from '../../sandbox/process-sandbox.js';
import { LocalToolHost } from '../../tools/local-tool-host.js';
import {
  LocalBackend,
  VirtualFilesystem,
} from '../../vfs/virtual-filesystem.js';
import type { WorkspaceTransaction } from '../../vfs/workspace-transaction.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'local-tool-host-'));
  roots.push(root);
  const vfs = new VirtualFilesystem([
    { prefix: '/workspace', read: true, write: true },
    { prefix: '/evidence', read: true, write: true },
  ]);
  vfs.mount(new LocalBackend('/workspace', root));
  vfs.mount(new LocalBackend('/evidence', root));
  const commandRunner = vi.fn(async () => ({
    exit_code: 0,
    stdout: 'ok',
    stderr: '',
    timed_out: false,
    truncated: false,
    duration_ms: 1,
  }));
  const sandbox: SandboxProfile = {
    workspaceRoot: root,
    allowNetwork: false,
    allowUnixSockets: false,
    allowRead: [],
  };
  const transaction = {
    mapCwd(path: string) {
      return join(root, path.replace(/^\/workspace\/?/u, ''));
    },
  } as unknown as WorkspaceTransaction;
  let workspace = { transaction, sandbox };
  const host = new LocalToolHost(() => workspace, { executeCommand: commandRunner });
  return {
    root,
    vfs,
    host,
    commandRunner,
    sandbox,
    setWorkspace(
      value: {
        transaction: WorkspaceTransaction | null;
        sandbox: SandboxProfile | null;
      },
    ) {
      workspace = value as typeof workspace;
    },
  };
}

describe('LocalToolHost', () => {
  it('creates implementations only for the requested frozen names', async () => {
    const setup = fixture();
    writeFileSync(join(setup.root, 'a.txt'), 'hello');
    const implementations = setup.host.implementations([
      'read_file',
      'list_directory',
    ]);
    expect([...implementations.keys()]).toEqual([
      'read_file',
      'list_directory',
    ]);
    const read = implementations.get('read_file')!;
    await expect(
      read({ vfs: setup.vfs, sandbox: setup.sandbox } as never, {
        path: '/workspace/a.txt',
      }),
   ).resolves.toEqual({
     path: '/workspace/a.txt',
     content: 'hello',
     bytes: 5,
     truncated: false,
     encoding: 'utf8',
   });
  });

  it('routes read, write, edit, list, search, artifact, and document parsing through VFS', async () => {
    const setup = fixture();
    writeFileSync(join(setup.root, 'source.txt'), 'alpha beta\fpage two');
    await expect(
      setup.host.execute('read_file', {
        path: '/workspace/source.txt',
        max_bytes: 5,
      }, setup.vfs),
    ).resolves.toMatchObject({
      content: 'alpha',
      bytes: 19,
      truncated: true,
    });
    await expect(
      setup.host.execute('write_file', {
        path: '/workspace/new.txt',
        content: 'before',
      }, setup.vfs),
    ).resolves.toMatchObject({ path: '/workspace/new.txt', bytes: 6 });
    await expect(
      setup.host.execute('edit_file', {
        path: '/workspace/new.txt',
        find: 'before',
        replace: 'after',
      }, setup.vfs),
    ).resolves.toMatchObject({ replacements: 1, bytes: 5 });
    expect(readFileSync(join(setup.root, 'new.txt'), 'utf8')).toBe('after');
    await expect(
      setup.host.execute('list_directory', {
        path: '/workspace',
      }, setup.vfs),
    ).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ path: '/workspace/new.txt' }),
      ]),
    });
    await expect(
      setup.host.execute('search_files', {
        root: '/workspace',
        needle: 'after',
        max_results: 1,
      }, setup.vfs),
    ).resolves.toMatchObject({
      matches: [expect.objectContaining({ path: '/workspace/new.txt' })],
      truncated: false,
    });
    const artifact = await setup.host.execute('create_artifact', {
      path: '/evidence/result.txt',
      content: 'proof',
    }, setup.vfs);
    expect(artifact).toMatchObject({
      path: '/evidence/result.txt',
      bytes: 5,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(existsSync(join(setup.root, 'result.txt'))).toBe(true);
    await expect(
      setup.host.execute('parse_document', {
        path: '/workspace/source.txt',
        max_pages: 1,
      }, setup.vfs),
    ).resolves.toEqual({
      path: '/workspace/source.txt',
      pages: [{ page: 1, text: 'alpha beta' }],
      total_chars: 19,
    });
  });

  it('maps execute_command cwd into the active transaction and preserves arguments', async () => {
    const setup = fixture();
    await expect(
      setup.host.execute('execute_command', {
        argv: ['tool', '--flag'],
        cwd: '/workspace/sub',
        stdin: 'input',
        timeout_ms: 321,
      }, setup.vfs),
    ).resolves.toMatchObject({
      exit_code: 0,
      stdout: 'ok',
    });
    expect(setup.commandRunner).toHaveBeenCalledTimes(1);
    expect(setup.commandRunner).toHaveBeenCalledWith(setup.sandbox, {
      argv: ['tool', '--flag'],
      cwd: join(setup.root, 'sub'),
      stdin: 'input',
      timeout_ms: 321,
    });
  });

  it('resolves only an explicitly allowlisted command name', async () => {
    const setup = fixture();
    setup.sandbox.commandAllowlist = {
      node: '/trusted/bin/node',
    };
    await setup.host.execute(
      'execute_command',
      {
        argv: ['node', 'test.mjs'],
        cwd: '/workspace',
      },
      setup.vfs,
    );
    expect(setup.commandRunner).toHaveBeenCalledWith(setup.sandbox, {
      argv: ['/trusted/bin/node', 'test.mjs'],
      cwd: setup.root,
    });
  });

  it.each([
    { transaction: null, sandbox: {} as SandboxProfile },
    { transaction: {} as WorkspaceTransaction, sandbox: null },
    { transaction: null, sandbox: null },
  ])('rejects command execution without both workspace authorities: %j', async (workspace) => {
    const setup = fixture();
    setup.setWorkspace(workspace);
    await expect(
      setup.host.execute('execute_command', {
        argv: ['tool'],
        cwd: '/workspace',
      }, setup.vfs),
    ).rejects.toThrow('workspace transaction is not active');
    expect(setup.commandRunner).not.toHaveBeenCalled();
  });

  it('keeps caller interaction outside model-dispatched local tools', async () => {
    const setup = fixture();
    await expect(
      setup.host.execute('ask_user', {}, setup.vfs),
    ).rejects.toThrow(
      'ask_user must be handled by the caller, not dispatched',
    );
  });

  it('fails closed for an unknown tool name', async () => {
    const setup = fixture();
    await expect(
      setup.host.execute('unknown', {}, setup.vfs),
    ).rejects.toThrow('unknown tool: unknown');
  });
});
