import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const trustedGitCandidates = ['/usr/bin/git', '/bin/git'];

export function assertTrustedExecutablePath(
  executable,
  { inspect = lstatSync } = {},
) {
  if (!isAbsolute(executable)) {
    throw new Error(`trusted executable path must be absolute: ${executable}`);
  }
  const target = resolve(executable);
  const ancestors = [];
  for (let cursor = dirname(target); ; cursor = dirname(cursor)) {
    ancestors.push(cursor);
    if (dirname(cursor) === cursor) break;
  }
  for (const path of ancestors.reverse()) {
    const metadata = inspect(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.uid !== 0 ||
      (metadata.mode & 0o022) !== 0
    ) {
      throw new Error(`trusted executable parent is not root-protected: ${path}`);
    }
  }
  const metadata = inspect(target);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.uid !== 0 ||
    (metadata.mode & 0o022) !== 0 ||
    (metadata.mode & 0o111) === 0
  ) {
    throw new Error(`trusted executable is not a root-protected real file: ${target}`);
  }
  return target;
}

function trustedGitExecutable() {
  for (const candidate of trustedGitCandidates) {
    try {
      return assertTrustedExecutablePath(candidate);
    } catch {
      // Continue only through the fixed absolute candidate set.
    }
  }
  throw new Error('trusted absolute Git executable is unavailable');
}

function git(root, args) {
  const executable = trustedGitExecutable();
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    env: {
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(' ')} failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function dirtyPaths(root) {
  const records = git(root, [
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
  const commitSha = git(root, ['rev-parse', 'HEAD']).trim();
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
    source_tree: git(root, ['rev-parse', 'HEAD^{tree}']).trim(),
  };
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

function verifiedEvidenceParent(destination, allowedRoot) {
  const root = resolve(allowedRoot);
  if (!existsSync(root)) {
    throw new Error(`evidence root does not exist: ${root}`);
  }
  const rootMetadata = lstatSync(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`evidence root must be a real directory, not a symlink: ${root}`);
  }
  const target = resolve(destination);
  const targetRelative = relative(root, target);
  if (
    targetRelative === '' ||
    targetRelative === '..' ||
    targetRelative.startsWith(`..${sep}`)
  ) {
    throw new Error(`evidence destination is outside its allowed root: ${target}`);
  }

  const parent = dirname(target);
  const parentRelative = relative(root, parent);
  let cursor = root;
  for (const component of parentRelative.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, component);
    let metadata;
    try {
      metadata = lstatSync(cursor);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (!metadata) {
      mkdirSync(cursor, { mode: 0o700 });
      continue;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`evidence path contains a symlink: ${cursor}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`evidence path component is not a directory: ${cursor}`);
    }
  }
  let targetMetadata;
  try {
    targetMetadata = lstatSync(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (targetMetadata?.isSymbolicLink()) {
    throw new Error(`evidence destination is a symlink: ${target}`);
  }
  return { parent, target };
}

export function writeEvidenceAtomicExclusive(
  destination,
  serialized,
  allowedRoot = dirname(resolve(destination)),
) {
  const { target } = verifiedEvidenceParent(destination, allowedRoot);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, serialized, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    try {
      linkSync(temporary, target);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error(`formal evidence already exists: ${target}`, {
          cause: error,
        });
      }
      throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}
