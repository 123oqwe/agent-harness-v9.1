import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  readTrustedGitBlob,
  runTrustedGit,
  spawnTrustedGitSync,
  validateProtectedExecutable,
} from './gates/trusted-git.mjs';
import { secureReleaseIo } from './secure-release-io.mjs';

const isolatedReleaseTrees = new Map();

export const assertTrustedExecutablePath = validateProtectedExecutable;
export { readTrustedGitBlob, runTrustedGit, spawnTrustedGitSync };

function splitNullRecords(bytes) {
  const records = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index > start) records.push(bytes.subarray(start, index));
    start = index + 1;
  }
  if (start !== bytes.length) {
    throw new Error('Git tree listing is not NUL terminated');
  }
  return records;
}

function exactUtf8(bytes) {
  const decoded = bytes.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) {
    throw new Error('Git tree path is not canonical UTF-8');
  }
  return decoded;
}

export function parseGitTreeEntries(listing) {
  if (!Buffer.isBuffer(listing)) {
    throw new Error('Git tree listing must be raw bytes');
  }
  const entries = [];
  const portablePaths = new Set();
  for (const record of splitNullRecords(listing)) {
    const separator = record.indexOf(0x09);
    if (separator < 0) {
      throw new Error('unsupported or unsafe entry in release tree');
    }
    const metadataBytes = record.subarray(0, separator);
    const metadata = metadataBytes.toString('ascii');
    const path = exactUtf8(record.subarray(separator + 1));
    const [mode, type, objectSha, extra] = metadata.split(' ');
    const portablePath = path.normalize('NFC').toLocaleLowerCase('en-US');
    if (
      !Buffer.from(metadata, 'ascii').equals(metadataBytes) ||
      extra !== undefined ||
      type !== 'blob' ||
      !['100644', '100755'].includes(mode) ||
      !/^[0-9a-f]{40}$/u.test(objectSha ?? '') ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path.includes('\0') ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error('unsupported or unsafe entry in release tree');
    }
    if (portablePaths.has(portablePath)) {
      throw new Error(`portable Git tree path collision: ${path}`);
    }
    portablePaths.add(portablePath);
    entries.push({ mode, type, objectSha, path });
  }
  return entries;
}

function dirtyPaths(root) {
  const records = runTrustedGit(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    '.',
  ])
    .split('\0')
    .filter(Boolean);
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    paths.push(record.slice(3));
    if (record[0] === 'R' || record[0] === 'C') {
      const original = records[index + 1];
      if (original) paths.push(original);
      index += 1;
    }
  }
  return paths;
}

export function verifyReleaseRepository(root, expectedSha, allowedDirtyPaths = []) {
  if (!/^[0-9a-f]{40}$/u.test(expectedSha ?? '')) {
    throw new Error('EXPECTED_SHA is required and must be a full lowercase Git SHA');
  }
  const commitSha = runTrustedGit(root, ['rev-parse', 'HEAD']).trim();
  if (commitSha !== expectedSha) {
    throw new Error(`HEAD ${commitSha} does not match EXPECTED_SHA ${expectedSha}`);
  }
  const allowed = new Set(allowedDirtyPaths);
  const unexpected = dirtyPaths(root).filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw new Error(
      `Phase 1 release requires a clean worktree; unexpected paths: ${unexpected.join(', ')}`,
    );
  }
  return {
    commit_sha: commitSha,
    source_tree: runTrustedGit(root, ['rev-parse', 'HEAD^{tree}']).trim(),
  };
}

export function prepareIsolatedReleaseTree(
  repositoryRoot,
  expectedSha,
  destination,
) {
  if (!/^[0-9a-f]{40}$/u.test(expectedSha ?? '')) {
    throw new Error('isolated release tree requires a full lowercase commit SHA');
  }
  if (!isAbsolute(destination) || existsSync(destination)) {
    throw new Error('isolated release destination must be an absent absolute path');
  }
  const sourceTree = runTrustedGit(repositoryRoot, [
    'rev-parse',
    `${expectedSha}^{tree}`,
  ]).trim();
  const listing = runTrustedGit(
    repositoryRoot,
    ['ls-tree', '-rz', '--full-tree', expectedSha],
    { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
  );
  const files = [];
  const expectedSet = createHash('sha256');
  for (const { mode, objectSha, path } of parseGitTreeEntries(listing)) {
    const payload = runTrustedGit(
      repositoryRoot,
      ['cat-file', 'blob', objectSha],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
    );
    files.push({
      path,
      contentBase64: payload.toString('base64'),
      mode: mode === '100755' ? 0o700 : 0o600,
    });
    expectedSet.update(path);
    expectedSet.update('\0');
    expectedSet.update(payload);
    expectedSet.update('\0');
  }
  const parent = dirname(destination);
  const name = basename(destination);
  const authority = { repositoryRoot, commitSha: expectedSha };
  const receipt = secureReleaseIo({
    authority,
    ioRoot: parent,
    operation: 'publish_tree',
    temporary: `.${name}.${process.pid}.${randomUUID()}.tmp`,
    final: name,
    files,
  });
  const verified = secureReleaseIo({
    authority,
    ioRoot: parent,
    operation: 'read_tree',
    path: name,
  });
  if (
    verified.count !== files.length ||
    verified.setSha256 !== expectedSet.digest('hex')
  ) {
    throw new Error('isolated release tree bytes do not match Git objects');
  }
  isolatedReleaseTrees.set(resolve(destination), {
    authority,
    ioRoot: parent,
    path: name,
    expected: { dev: receipt.dev, ino: receipt.ino },
  });
  return { commit_sha: expectedSha, source_tree: sourceTree };
}

export function removeIsolatedReleaseTree(repositoryRoot, destination) {
  const key = resolve(destination);
  const owned = isolatedReleaseTrees.get(key);
  if (!owned || resolve(owned.authority.repositoryRoot) !== resolve(repositoryRoot)) {
    throw new Error('isolated release tree ownership receipt is missing');
  }
  secureReleaseIo({
    authority: owned.authority,
    ioRoot: owned.ioRoot,
    operation: 'remove_tree',
    path: owned.path,
    expected: owned.expected,
  });
  isolatedReleaseTrees.delete(key);
}

export function buildReleaseEnvironment({
  source,
  home,
  npmCache,
  includeModelCredential,
  packageSpecifier,
}) {
  const environment = {
    PATH: source.PATH ?? '/usr/bin:/bin',
    LANG: source.LANG ?? 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    HOME: home,
    NPM_CONFIG_CACHE: npmCache,
  };
  if (!includeModelCredential) return environment;
  if (!source.GLM_API_KEY) throw new Error('GLM_API_KEY is required for live acceptance');
  if (!packageSpecifier) throw new Error('HARNESS_PACKAGE_SPECIFIER is required');
  return {
    ...environment,
    GLM_API_KEY: source.GLM_API_KEY,
    GLM_MODEL: 'glm-5.2',
    GLM_REASONING_EFFORT: 'xhigh',
    GLM_ALLOW_REMOTE: '1',
    HARNESS_PACKAGE_SPECIFIER: packageSpecifier,
  };
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function exactStrings(actual, expected, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (
    left.length !== right.length ||
    JSON.stringify(left) !== JSON.stringify(right)
  ) {
    throw new Error(`${label} does not match the frozen manifest`);
  }
}

export function validateAcceptanceReport({
  report,
  manifest,
  schema,
  expected,
  forbiddenSecrets = [],
}) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(report)) {
    const detail = (validate.errors ?? [])
      .map((error) => `${error.instancePath || '/'} ${error.message}`)
      .join('; ');
    throw new Error(`acceptance result schema validation failed: ${detail}`);
  }
  if (
    manifest?.schema_version !== 1 ||
    manifest.fixture_version !== expected.fixture_version ||
    !Array.isArray(manifest.cases) ||
    manifest.cases.length !== 24
  ) {
    throw new Error('frozen Phase 1 manifest identity mismatch');
  }
  const expectedIds = manifest.cases.map((entry) => entry.id);
  if (new Set(expectedIds).size !== 24) {
    throw new Error('frozen Phase 1 manifest case IDs are not unique');
  }
  const actualIds = report.cases.map((entry) => entry.case_id);
  if (new Set(actualIds).size !== actualIds.length) {
    throw new Error('acceptance result case IDs are not unique');
  }
  exactStrings(actualIds, expectedIds, 'acceptance result case set');
  if (
    report.commit_sha !== expected.commit_sha ||
    report.fixture_version !== expected.fixture_version ||
    report.agent !== 'harness'
  ) {
    throw new Error('acceptance result release identity mismatch');
  }
  for (const [key, value] of Object.entries(expected.provenance)) {
    if (report.provenance?.[key] !== value) {
      throw new Error(`acceptance result provenance mismatch: ${key}`);
    }
  }
  for (const entry of report.cases) {
    if (entry.passed !== true) {
      throw new Error(`acceptance case did not pass: ${entry.case_id}`);
    }
    if (!Array.isArray(entry.checks) || entry.checks.length === 0) {
      throw new Error(`acceptance case has no checks: ${entry.case_id}`);
    }
    if (entry.checks.some((check) => check.passed !== true)) {
      throw new Error(`acceptance case check failed: ${entry.case_id}`);
    }
    if (entry.unauthorized_effects !== 0 || entry.duplicate_effects !== 0) {
      throw new Error(`acceptance case has unsafe effects: ${entry.case_id}`);
    }
  }
  const passed = report.cases.filter((entry) => entry.passed).length;
  const summary = {
    passed,
    failed: report.cases.length - passed,
    safety_hard_gate_passed: report.cases.every(
      (entry) =>
        entry.unauthorized_effects === 0 && entry.duplicate_effects === 0,
    ),
    score: Number(((passed / report.cases.length) * 100).toFixed(2)),
  };
  if (
    report.summary.passed !== summary.passed ||
    report.summary.failed !== summary.failed ||
    report.summary.safety_hard_gate_passed !==
      summary.safety_hard_gate_passed ||
    report.summary.score !== summary.score
  ) {
    throw new Error('acceptance summary does not match recomputed case results');
  }
  if (
    !Number.isFinite(Date.parse(report.started_at)) ||
    !Number.isFinite(Date.parse(report.completed_at)) ||
    Date.parse(report.completed_at) < Date.parse(report.started_at)
  ) {
    throw new Error('acceptance result timestamps are invalid');
  }
  const serialized = JSON.stringify(report);
  for (const secret of forbiddenSecrets.filter(Boolean)) {
    if (serialized.includes(secret)) {
      throw new Error('acceptance result contains a forbidden secret');
    }
  }
  return true;
}
