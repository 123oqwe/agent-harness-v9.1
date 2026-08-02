import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface SecureIoModule {
  secureReleaseIo: (request: {
    authority: { repositoryRoot: string; commitSha: string };
    ioRoot: string;
    operation:
      | 'write_file_exclusive'
      | 'read_tree'
      | 'publish_tree'
      | 'remove_tree';
    path?: string;
    contentBase64?: string;
    testAfterRootOpen?: () => void;
    testShortWriteMax?: number;
    testFailAfterRenameFsync?: boolean;
    temporary?: string;
    final?: string;
    files?: Array<{ path: string; contentBase64: string; mode: number }>;
    expected?: { dev: string; ino: string };
  }) => {
    ok: true;
    dev?: string;
    ino?: string;
    writeCalls?: number;
    files?: Array<{ path: string; contentBase64: string; sha256: string }>;
  };
}

const root = resolve(import.meta.dirname, '../..');
const moduleUrl = pathToFileURL(resolve(root, 'scripts/secure-release-io.mjs')).href;
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'phase1-secure-io-'));
  temporaryRoots.push(directory);
  return directory;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' }).trim();
}

function authorityRepository(): { repositoryRoot: string; commitSha: string } {
  const repositoryRoot = temporaryRoot();
  git(repositoryRoot, ['init', '-q']);
  mkdirSync(join(repositoryRoot, 'scripts'));
  writeFileSync(
    join(repositoryRoot, 'scripts/secure-release-io.py'),
    readFileSync(resolve(root, 'scripts/secure-release-io.py')),
  );
  git(repositoryRoot, ['add', 'scripts/secure-release-io.py']);
  git(repositoryRoot, [
    '-c',
    'user.name=Phase One',
    '-c',
    'user.email=phase1@example.test',
    'commit',
    '-qm',
    'secure helper',
  ]);
  return { repositoryRoot, commitSha: git(repositoryRoot, ['rev-parse', 'HEAD']) };
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('descriptor-relative Phase 1 release I/O', () => {
  it('writes exclusively and reads the same bytes without following symlinks', async () => {
    const secure = (await import(`${moduleUrl}?test=${Date.now()}`)) as SecureIoModule;
    const authority = authorityRepository();
    const ioRoot = temporaryRoot();
    const payload = '{"evidence":true}\n';
    secure.secureReleaseIo({
      authority,
      ioRoot,
      operation: 'write_file_exclusive',
      path: 'acceptance/evidence.json',
      contentBase64: Buffer.from(payload).toString('base64'),
    });
    expect(readFileSync(join(ioRoot, 'acceptance/evidence.json'), 'utf8')).toBe(
      payload,
    );
    expect(() =>
      secure.secureReleaseIo({
        authority,
        ioRoot,
        operation: 'write_file_exclusive',
        path: 'acceptance/evidence.json',
        contentBase64: Buffer.from('overwrite').toString('base64'),
      }),
    ).toThrow(/exist|exclusive/u);
    const read = secure.secureReleaseIo({
      authority,
      ioRoot,
      operation: 'read_tree',
      path: 'acceptance',
    });
    expect(read.files).toEqual([
      expect.objectContaining({
        path: 'evidence.json',
        contentBase64: Buffer.from(payload).toString('base64'),
      }),
    ]);
  });

  it('keeps zero external effects when a child is swapped after root open', async () => {
    const secure = (await import(`${moduleUrl}?test=${Date.now()}`)) as SecureIoModule;
    const authority = authorityRepository();
    const ioRoot = temporaryRoot();
    const external = temporaryRoot();
    mkdirSync(join(ioRoot, 'acceptance'));
    expect(() =>
      secure.secureReleaseIo({
        authority,
        ioRoot,
        operation: 'write_file_exclusive',
        path: 'acceptance/evidence.json',
        contentBase64: Buffer.from('forbidden\n').toString('base64'),
        testAfterRootOpen: () => {
          renameSync(join(ioRoot, 'acceptance'), join(ioRoot, 'acceptance-owned'));
          symlinkSync(external, join(ioRoot, 'acceptance'));
        },
      }),
    ).toThrow(/symlink|directory/u);
    expect(readdirSync(external)).toEqual([]);
  });

  it('rejects traversal, NUL, and unencodable paths before mutation', async () => {
    const secure = (await import(`${moduleUrl}?test=${Date.now()}`)) as SecureIoModule;
    const authority = authorityRepository();
    for (const path of ['../escape', 'bad\0name', 'bad\ud800name']) {
      const ioRoot = temporaryRoot();
      expect(() =>
        secure.secureReleaseIo({
          authority,
          ioRoot,
          operation: 'write_file_exclusive',
          path,
          contentBase64: 'e30=',
        }),
      ).toThrow(/unsafe|encoding|component|surrogate/u);
      expect(readdirSync(ioRoot)).toEqual([]);
    }
  });

  it('anchors writes to the opened root and executes helper bytes from Git objects', async () => {
    const secure = (await import(`${moduleUrl}?test=${Date.now()}`)) as SecureIoModule;
    const authority = authorityRepository();
    const ioRoot = temporaryRoot();
    const moved = `${ioRoot}.owned`;
    const attacker = temporaryRoot();
    writeFileSync(
      join(authority.repositoryRoot, 'scripts/secure-release-io.py'),
      `open(${JSON.stringify(join(attacker, 'helper-ran'))}, 'w').write('bad')\n`,
    );
    secure.secureReleaseIo({
      authority,
      ioRoot,
      operation: 'write_file_exclusive',
      path: 'anchored.json',
      contentBase64: 'e30=',
      testAfterRootOpen: () => {
        renameSync(ioRoot, moved);
        symlinkSync(attacker, ioRoot);
      },
    });
    expect(readFileSync(join(moved, 'anchored.json'), 'utf8')).toBe('{}');
    expect(readdirSync(attacker)).toEqual([]);
    rmSync(ioRoot);
    renameSync(moved, ioRoot);
  });

  it('handles short writes and never replaces an existing final tree', async () => {
    const secure = (await import(`${moduleUrl}?test=${Date.now()}`)) as SecureIoModule;
    const authority = authorityRepository();
    const ioRoot = temporaryRoot();
    mkdirSync(join(ioRoot, 'existing'));
    writeFileSync(join(ioRoot, 'existing/sentinel'), 'keep');
    const before = statSync(join(ioRoot, 'existing'));
    expect(() =>
      secure.secureReleaseIo({
        authority,
        ioRoot,
        operation: 'publish_tree',
        temporary: '.tree.tmp',
        final: 'existing',
        files: [
          {
            path: 'nested/value.txt',
            contentBase64: Buffer.from('short-write-payload').toString('base64'),
            mode: 0o600,
          },
        ],
        testShortWriteMax: 1,
      }),
    ).toThrow(/exist|replace/u);
    const after = statSync(join(ioRoot, 'existing'));
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    expect(readFileSync(join(ioRoot, 'existing/sentinel'), 'utf8')).toBe('keep');
    expect(readdirSync(ioRoot).sort()).toEqual(['existing']);

    const receipt = secure.secureReleaseIo({
      authority,
      ioRoot,
      operation: 'publish_tree',
      temporary: '.short.tmp',
      final: 'short',
      files: [
        {
          path: 'nested/value.txt',
          contentBase64: Buffer.from('short-write-payload').toString('base64'),
          mode: 0o600,
        },
      ],
      testShortWriteMax: 1,
    });
    expect(readFileSync(join(ioRoot, 'short/nested/value.txt'), 'utf8')).toBe(
      'short-write-payload',
    );
    expect(receipt).toMatchObject({ dev: expect.any(String), ino: expect.any(String) });
    expect(receipt.writeCalls).toBe('short-write-payload'.length);
  });

  it('cleans an owned final tree after an injected post-rename fsync failure', async () => {
    const secure = (await import(`${moduleUrl}?test=${Date.now()}`)) as SecureIoModule;
    const authority = authorityRepository();
    const ioRoot = temporaryRoot();
    expect(() =>
      secure.secureReleaseIo({
        authority,
        ioRoot,
        operation: 'publish_tree',
        temporary: '.failure.tmp',
        final: 'failure',
        files: [{ path: 'a', contentBase64: 'e30=', mode: 0o600 }],
        testFailAfterRenameFsync: true,
      }),
    ).toThrow(/fsync/u);
    expect(readdirSync(ioRoot)).toEqual([]);
  });

  it('requires the exact dev/ino receipt to remove a published tree', async () => {
    const secure = (await import(`${moduleUrl}?test=${Date.now()}`)) as SecureIoModule;
    const authority = authorityRepository();
    const ioRoot = temporaryRoot();
    const receipt = secure.secureReleaseIo({
      authority,
      ioRoot,
      operation: 'publish_tree',
      temporary: '.owned.tmp',
      final: 'owned',
      files: [{ path: 'a', contentBase64: 'e30=', mode: 0o600 }],
    });
    expect(() =>
      secure.secureReleaseIo({
        authority,
        ioRoot,
        operation: 'remove_tree',
        path: 'owned',
        expected: { dev: receipt.dev!, ino: String(BigInt(receipt.ino!) + 1n) },
      }),
    ).toThrow(/identity/u);
    expect(readFileSync(join(ioRoot, 'owned/a'), 'utf8')).toBe('{}');
    secure.secureReleaseIo({
      authority,
      ioRoot,
      operation: 'remove_tree',
      path: 'owned',
      expected: { dev: receipt.dev!, ino: receipt.ino! },
    });
    expect(readdirSync(ioRoot)).toEqual([]);
  });

  it('rejects symlinks and non-regular entries while reading trees', async () => {
    const secure = (await import(`${moduleUrl}?test=${Date.now()}`)) as SecureIoModule;
    const authority = authorityRepository();
    const ioRoot = temporaryRoot();
    const external = temporaryRoot();
    mkdirSync(join(ioRoot, 'artifact'));
    writeFileSync(join(external, 'secret'), 'external');
    symlinkSync(join(external, 'secret'), join(ioRoot, 'artifact/link'));
    expect(() =>
      secure.secureReleaseIo({
        authority,
        ioRoot,
        operation: 'read_tree',
        path: 'artifact',
      }),
    ).toThrow(/symlink|symbolic|file|loop/u);
  });
});
