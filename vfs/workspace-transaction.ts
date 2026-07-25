/**
 * A durable per-RunPlan filesystem transaction.
 *
 * File tools and execute_command work against the same on-disk staged tree.
 * The real workspace is changed only after capture() produces an OverlayBackend
 * diff and VirtualFilesystem.commitOverlay() accepts it.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  LocalBackend,
  VfsError,
} from './virtual-filesystem.js';
import type {
  OverlayBackend,
  VirtualFilesystem,
} from './virtual-filesystem.js';
import type { SandboxProfile } from '../runtime/sandbox.js';

type ManifestEntry =
  | { kind: 'file'; sha256: string; mode: number }
  | { kind: 'symlink'; target: string };

interface TransactionMetadata {
  version: 1;
  run_id: string;
  base_root: string;
  initial: Record<string, ManifestEntry>;
  protected_links: Record<string, string>;
  excluded_base_paths: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeMetadataPath(value: string): boolean {
  return value.length > 0 &&
    !isAbsolute(value) &&
    !value.includes('\0') &&
    !value.split('/').includes('..');
}

function isManifestEntry(value: unknown): value is ManifestEntry {
  if (!isRecord(value)) return false;
  if (value.kind === 'file') {
    return typeof value.sha256 === 'string' &&
      /^[0-9a-f]{64}$/u.test(value.sha256) &&
      Number.isInteger(value.mode) &&
      (value.mode as number) >= 0 &&
      (value.mode as number) <= 0o777;
  }
  return value.kind === 'symlink' && typeof value.target === 'string';
}

function isTransactionMetadata(
  value: unknown,
  runId: string,
  baseRoot: string,
  workspaceRoot: string,
): value is TransactionMetadata {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.run_id !== runId ||
    value.base_root !== baseRoot ||
    !isRecord(value.initial) ||
    !isRecord(value.protected_links) ||
    !Array.isArray(value.excluded_base_paths)
  ) {
    return false;
  }
  if (
    !existsSync(workspaceRoot) ||
    lstatSync(workspaceRoot).isSymbolicLink() ||
    !lstatSync(workspaceRoot).isDirectory()
  ) {
    return false;
  }
  for (const [path, entry] of Object.entries(value.initial)) {
    if (!isSafeMetadataPath(path) || !isManifestEntry(entry)) return false;
  }
  for (const [path, target] of Object.entries(value.protected_links)) {
    if (
      !PROTECTED_TOP_LEVEL.has(path) ||
      target !== join(baseRoot, path)
    ) {
      return false;
    }
  }
  const excluded = value.excluded_base_paths;
  if (!excluded.every((path): path is string => {
    if (typeof path !== 'string' || !isAbsolute(path)) return false;
    const rel = relative(baseRoot, path);
    return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
  })) {
    return false;
  }
  return new Set(excluded).size === excluded.length;
}

export interface WorkspaceTransactionOptions {
  runId: string;
  baseRoot: string;
  /** Durable state parent. Omit for an ephemeral transaction. */
  stateRoot?: string | undefined;
}

export interface WorkspaceChange {
  path: string;
  kind: 'created' | 'deleted' | 'modified';
  before_sha256: string | null;
  after_sha256: string | null;
  before_mode: number | null;
  after_mode: number | null;
}

const PROTECTED_TOP_LEVEL = new Set([
  '.git',
  'node_modules',
  '.pnpm-store',
]);

function hashBuffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeRelative(root: string, candidate: string): string {
  const rel = relative(root, candidate);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new VfsError(`path outside workspace transaction: ${candidate}`);
  }
  return rel;
}

function normalizeRelative(path: string): string {
  return path.split(sep).join('/');
}

function scanEntry(path: string): ManifestEntry | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    return { kind: 'symlink', target: readlinkSync(path) };
  }
  if (stat.isFile()) {
    return {
      kind: 'file',
      sha256: hashBuffer(readFileSync(path)),
      mode: stat.mode & 0o777,
    };
  }
  return null;
}

function equalEntry(
  left: ManifestEntry | null | undefined,
  right: ManifestEntry | null | undefined,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  if (left.kind !== right.kind) return false;
  if (left.kind === 'file') {
    return left.sha256 === (right as Extract<ManifestEntry, { kind: 'file' }>).sha256 &&
      left.mode === (right as Extract<ManifestEntry, { kind: 'file' }>).mode;
  }
  return left.target === (right as Extract<ManifestEntry, { kind: 'symlink' }>).target;
}

function copyWorkspace(
  baseRoot: string,
  workspaceRoot: string,
  excludedBasePaths: ReadonlySet<string>,
): {
  initial: Record<string, ManifestEntry>;
  protectedLinks: Record<string, string>;
} {
  const initial: Record<string, ManifestEntry> = {};
  const protectedLinks: Record<string, string> = {};

  const walk = (sourceDir: string, targetDir: string, relDir: string): void => {
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      const rel = join(relDir, entry.name);
      const normalized = normalizeRelative(rel);
      const source = join(sourceDir, entry.name);
      const target = join(targetDir, entry.name);
      if (excludedBasePaths.has(resolve(source))) continue;
      if (relDir === '' && PROTECTED_TOP_LEVEL.has(entry.name)) {
        symlinkSync(source, target);
        protectedLinks[normalized] = source;
        continue;
      }
      const stat = lstatSync(source);
      if (stat.isDirectory()) {
        walk(source, target, rel);
      } else if (stat.isSymbolicLink()) {
        const linkTarget = readlinkSync(source);
        symlinkSync(linkTarget, target);
        initial[normalized] = { kind: 'symlink', target: linkTarget };
      } else if (stat.isFile()) {
        copyFileSync(source, target, constants.COPYFILE_FICLONE);
        chmodSync(target, stat.mode & 0o777);
        initial[normalized] = {
          kind: 'file',
          sha256: hashBuffer(readFileSync(source)),
          mode: stat.mode & 0o777,
        };
      }
    }
  };

  walk(baseRoot, workspaceRoot, '');
  return { initial, protectedLinks };
}

function scanWorkspace(
  workspaceRoot: string,
  protectedLinks: Readonly<Record<string, string>>,
): Record<string, ManifestEntry> {
  const manifest: Record<string, ManifestEntry> = {};
  const walk = (dir: string, relDir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = join(relDir, entry.name);
      const normalized = normalizeRelative(rel);
      const path = join(dir, entry.name);
      if (Object.hasOwn(protectedLinks, normalized)) {
        const expected = protectedLinks[normalized]!;
        if (!entry.isSymbolicLink() || readlinkSync(path) !== expected) {
          throw new VfsError(`protected workspace path modified: ${normalized}`);
        }
        continue;
      }
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        walk(path, rel);
      } else if (stat.isSymbolicLink()) {
        manifest[normalized] = {
          kind: 'symlink',
          target: readlinkSync(path),
        };
      } else if (stat.isFile()) {
        manifest[normalized] = {
          kind: 'file',
          sha256: hashBuffer(readFileSync(path)),
          mode: stat.mode & 0o777,
        };
      }
    }
  };
  walk(workspaceRoot, '');
  return manifest;
}

export class WorkspaceTransaction {
  readonly workspaceRoot: string;
  readonly resumed: boolean;
  private finalized = false;

  private constructor(
    private readonly containerRoot: string,
    private readonly metadata: TransactionMetadata,
    resumed: boolean,
  ) {
    this.workspaceRoot = join(containerRoot, 'workspace');
    this.resumed = resumed;
  }

  static open(options: WorkspaceTransactionOptions): WorkspaceTransaction {
    if (options.runId.trim() === '') throw new VfsError('runId required');
    const baseRoot = realpathSync(resolve(options.baseRoot));
    const durable = options.stateRoot !== undefined;
    let stateRoot: string | undefined;
    if (durable) {
      mkdirSync(resolve(options.stateRoot!), { recursive: true, mode: 0o700 });
      stateRoot = realpathSync(resolve(options.stateRoot!));
      if (stateRoot === baseRoot) {
        throw new VfsError('stateRoot cannot be the workspace root');
      }
    }
    const rawContainerRoot = durable
      ? join(
          stateRoot!,
          'workspace-transactions',
          createHash('sha256').update(options.runId).digest('hex').slice(0, 24),
        )
      : mkdtempSync(join(tmpdir(), 'ah-workspace-tx-'));
    mkdirSync(rawContainerRoot, { recursive: true, mode: 0o700 });
    const containerRoot = realpathSync(rawContainerRoot);
    const workspaceRoot = join(containerRoot, 'workspace');
    const metadataPath = join(containerRoot, 'metadata.json');

    if (existsSync(metadataPath)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(metadataPath, 'utf8'));
      } catch {
        throw new VfsError('workspace transaction metadata mismatch');
      }
      if (!isTransactionMetadata(
        parsed,
        options.runId,
        baseRoot,
        workspaceRoot,
      )) {
        throw new VfsError('workspace transaction metadata mismatch');
      }
      return new WorkspaceTransaction(containerRoot, parsed, true);
    }

    // No metadata means initialization never became authoritative. Remove only
    // this transaction-owned partial workspace and rebuild it deterministically.
    if (existsSync(workspaceRoot)) {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
    mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
    const excludedBasePaths = new Set<string>();
    if (stateRoot !== undefined) {
      const rel = relative(baseRoot, stateRoot);
      if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
        excludedBasePaths.add(stateRoot);
      }
    }
    const copied = copyWorkspace(
      baseRoot,
      workspaceRoot,
      excludedBasePaths,
    );
    const metadata: TransactionMetadata = {
      version: 1,
      run_id: options.runId,
      base_root: baseRoot,
      initial: copied.initial,
      protected_links: copied.protectedLinks,
      excluded_base_paths: [...excludedBasePaths],
    };
    writeFileSync(metadataPath, JSON.stringify(metadata), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    return new WorkspaceTransaction(containerRoot, metadata, false);
  }

  createVfs(base: VirtualFilesystem): VirtualFilesystem {
    this.checkActive();
    const baseBackend = base.route('/workspace');
    if (
      !(baseBackend instanceof LocalBackend) ||
      realpathSync(resolve(baseBackend.rootPath)) !== this.metadata.base_root
    ) {
      throw new VfsError('VFS and sandbox workspace roots do not match');
    }
    return base.forkReplacing(
      '/workspace',
      new LocalBackend('/workspace', this.workspaceRoot),
    );
  }

  sandboxProfile(base: SandboxProfile): SandboxProfile {
    this.checkActive();
    if (realpathSync(resolve(base.workspaceRoot)) !== this.metadata.base_root) {
      throw new VfsError('sandbox and VFS workspace roots do not match');
    }
    return {
      ...base,
      workspaceRoot: this.workspaceRoot,
      allowRead: [...new Set([...base.allowRead, this.metadata.base_root])],
    };
  }

  mapCwd(cwd: string): string {
    this.checkActive();
    let rel: string;
    if (cwd === '/workspace' || cwd.startsWith('/workspace/')) {
      rel = cwd === '/workspace' ? '' : cwd.slice('/workspace/'.length);
    } else {
      const unresolved = isAbsolute(cwd)
        ? resolve(cwd)
        : resolve(this.metadata.base_root, cwd);
      const absolute = realpathSync(unresolved);
      rel = safeRelative(this.metadata.base_root, absolute);
    }
    const mapped = resolve(this.workspaceRoot, rel);
    safeRelative(this.workspaceRoot, mapped);
    return mapped;
  }

  describeChanges(): readonly WorkspaceChange[] {
    this.checkActive();
    const current = scanWorkspace(
      this.workspaceRoot,
      this.metadata.protected_links,
    );
    const paths = new Set([
      ...Object.keys(this.metadata.initial),
      ...Object.keys(current),
    ]);
    return Object.freeze(
      [...paths]
        .sort()
        .flatMap((rel): WorkspaceChange[] => {
          const before = this.metadata.initial[rel] ?? null;
          const after = current[rel] ?? null;
          if (equalEntry(before, after)) return [];
          return [{
            path: `/workspace/${normalizeRelative(rel)}`,
            kind:
              before === null
                ? 'created'
                : after === null
                  ? 'deleted'
                  : 'modified',
            before_sha256:
              before?.kind === 'file' ? before.sha256 : null,
            after_sha256: after?.kind === 'file' ? after.sha256 : null,
            before_mode: before?.kind === 'file' ? before.mode : null,
            after_mode: after?.kind === 'file' ? after.mode : null,
          }];
        }),
    );
  }

  capture(overlay: OverlayBackend): void {
    this.checkActive();
    if (overlay.prefix !== '/workspace') {
      throw new VfsError('workspace transaction requires /workspace overlay');
    }
    const current = scanWorkspace(
      this.workspaceRoot,
      this.metadata.protected_links,
    );
    const paths = new Set([
      ...Object.keys(this.metadata.initial),
      ...Object.keys(current),
    ]);
    for (const rel of [...paths].sort()) {
      const before = this.metadata.initial[rel] ?? null;
      const after = current[rel] ?? null;
      if (equalEntry(before, after)) continue;
      const currentBase = scanEntry(join(this.metadata.base_root, rel));
      if (!equalEntry(before, currentBase)) {
        throw new VfsError(`workspace changed concurrently: ${rel}`);
      }
      const vfsPath = `/workspace/${normalizeRelative(rel)}`;
      if (after === null) {
        overlay.delete(vfsPath);
      } else if (after.kind === 'symlink') {
        throw new VfsError(`new or modified symlink cannot be committed: ${rel}`);
      } else {
        overlay.write(
          vfsPath,
          readFileSync(join(this.workspaceRoot, rel)),
          after.mode,
        );
      }
    }
  }

  complete(): void {
    this.checkActive();
    this.finalized = true;
    rmSync(this.containerRoot, { recursive: true, force: true });
  }

  discard(): void {
    this.checkActive();
    this.finalized = true;
    rmSync(this.containerRoot, { recursive: true, force: true });
  }

  private checkActive(): void {
    if (this.finalized) throw new VfsError('workspace transaction finalized');
  }
}
