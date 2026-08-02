import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const moduleUrl = pathToFileURL(
  resolve(root, 'scripts/release-evidence.mjs'),
).href;
const temporaryRoots: string[] = [];

interface ReleaseBoundary {
  assertTrustedExecutablePath: (
    executable: string,
    options?: { inspect: (path: string) => FakeMetadata },
  ) => string;
  verifyReleaseRepository: (
    root: string,
    expectedSha: string,
    allowedDirtyPaths?: string[],
  ) => { commit_sha: string; source_tree: string };
  buildReleaseEnvironment: (
    options: Record<string, unknown>,
  ) => Record<string, string>;
  validateAcceptanceReport: (options: Record<string, unknown>) => boolean;
  writeEvidenceAtomicExclusive: (
    destination: string,
    serialized: string,
    allowedRoot?: string,
  ) => void;
}

interface FakeMetadata {
  uid: number;
  mode: number;
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
}

async function loadBoundary(): Promise<ReleaseBoundary> {
  try {
    return (await import(
      `${moduleUrl}?test=${Date.now()}`
    )) as ReleaseBoundary;
  } catch {
    return {} as ReleaseBoundary;
  }
}

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'phase1-release-evidence-'));
  temporaryRoots.push(directory);
  return directory;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function validReport(manifest: { fixture_version: string; cases: Array<{ id: string }> }) {
  const provenance = {
    source_tree: 'b'.repeat(40),
    fixture_sha256: 'c'.repeat(64),
    result_schema_sha256: 'd'.repeat(64),
    package_tarball_sha256: 'e'.repeat(64),
    package_lock_sha256: 'f'.repeat(64),
    consumer_lock_sha256: '0'.repeat(64),
    model: 'glm-5.2',
    reasoning_effort: 'xhigh',
    temperature: 1,
    seed: null,
    seed_support: 'unsupported',
  };
  return {
    schema_version: 1,
    fixture_version: manifest.fixture_version,
    commit_sha: 'a'.repeat(40),
    agent: 'harness',
    agent_version: 'v24.18.0',
    started_at: '2026-08-02T00:00:00.000Z',
    completed_at: '2026-08-02T00:01:00.000Z',
    provenance,
    cases: manifest.cases.map(({ id }) => ({
      case_id: id,
      passed: true,
      duration_ms: 1,
      output_sha256: '1'.repeat(64),
      workspace_hash: '2'.repeat(64),
      checks: [{ name: 'deterministic', passed: true }],
      unauthorized_effects: 0,
      duplicate_effects: 0,
      termination_reason: 'completed',
    })),
    summary: {
      passed: 24,
      failed: 0,
      safety_hard_gate_passed: true,
      score: 100,
    },
  };
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Phase 1 release repository provenance', () => {
  it('accepts only a root-owned executable beneath root-protected parents', async () => {
    const boundary = await loadBoundary();
    const directory = (uid: number, mode: number): FakeMetadata => ({
      uid,
      mode,
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    });
    const file = (uid: number, mode: number): FakeMetadata => ({
      uid,
      mode,
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
    });
    const trusted = new Map<string, FakeMetadata>([
      ['/', directory(0, 0o755)],
      ['/trusted', directory(0, 0o755)],
      ['/trusted/bin', directory(0, 0o755)],
      ['/trusted/bin/git', file(0, 0o755)],
    ]);
    const inspect = (path: string): FakeMetadata => {
      const metadata = trusted.get(path);
      if (!metadata) throw new Error(`unexpected path: ${path}`);
      return metadata;
    };
    expect(
      boundary.assertTrustedExecutablePath('/trusted/bin/git', { inspect }),
    ).toBe('/trusted/bin/git');

    trusted.set('/trusted/bin/git', file(501, 0o755));
    expect(() =>
      boundary.assertTrustedExecutablePath('/trusted/bin/git', { inspect }),
    ).toThrow(/root-protected/u);
    trusted.set('/trusted/bin/git', file(0, 0o775));
    expect(() =>
      boundary.assertTrustedExecutablePath('/trusted/bin/git', { inspect }),
    ).toThrow(/root-protected/u);
    trusted.set('/trusted/bin/git', file(0, 0o755));
    trusted.set('/trusted', directory(0, 0o777));
    expect(() =>
      boundary.assertTrustedExecutablePath('/trusted/bin/git', { inspect }),
    ).toThrow(/parent/u);
  });

  it('requires the exact expected SHA and rejects tracked or untracked dirt', async () => {
    const boundary = await loadBoundary();
    expect(boundary.verifyReleaseRepository).toBeTypeOf('function');
    const directory = temporaryRoot();
    git(directory, ['init', '-q']);
    writeFileSync(join(directory, 'source.txt'), 'committed\n');
    git(directory, ['add', 'source.txt']);
    git(directory, [
      '-c',
      'user.name=Phase One',
      '-c',
      'user.email=phase1@example.test',
      'commit',
      '-qm',
      'fixture',
    ]);
    const head = git(directory, ['rev-parse', 'HEAD']);
    const tree = git(directory, ['rev-parse', 'HEAD^{tree}']);

    expect(() => boundary.verifyReleaseRepository(directory, '')).toThrow(
      /EXPECTED_SHA/u,
    );
    expect(() =>
      boundary.verifyReleaseRepository(directory, 'f'.repeat(40)),
    ).toThrow(/does not match/u);
    expect(boundary.verifyReleaseRepository(directory, head)).toEqual({
      commit_sha: head,
      source_tree: tree,
    });

    const fakeBin = join(temporaryRoot(), 'fake-bin');
    mkdirSync(fakeBin);
    writeFileSync(
      join(fakeBin, 'git'),
      '#!/bin/sh\nprintf "ffffffffffffffffffffffffffffffffffffffff\\n"\n',
    );
    chmodSync(join(fakeBin, 'git'), 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = fakeBin;
    try {
      expect(boundary.verifyReleaseRepository(directory, head)).toEqual({
        commit_sha: head,
        source_tree: tree,
      });
    } finally {
      process.env.PATH = originalPath;
    }

    writeFileSync(join(directory, 'untracked.txt'), 'dirty\n');
    expect(() => boundary.verifyReleaseRepository(directory, head)).toThrow(
      /clean worktree/u,
    );
    expect(
      boundary.verifyReleaseRepository(directory, head, ['untracked.txt']),
    ).toEqual({ commit_sha: head, source_tree: tree });
  });
});

describe('Phase 1 release subprocess environments', () => {
  it('keeps non-model commands secret-free and gives the model only its explicit key', async () => {
    const boundary = await loadBoundary();
    expect(boundary.buildReleaseEnvironment).toBeTypeOf('function');
    const source = {
      PATH: '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      GLM_API_KEY: 'glm-secret',
      OPENAI_API_KEY: 'openai-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      GITHUB_TOKEN: 'github-secret',
      NPM_TOKEN: 'npm-secret',
    };
    const nonModel = boundary.buildReleaseEnvironment({
      source,
      home: '/tmp/release-home',
      npmCache: '/tmp/release-cache',
      includeModelCredential: false,
    });
    expect(nonModel).toEqual({
      PATH: '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C.UTF-8',
      HOME: '/tmp/release-home',
      NPM_CONFIG_CACHE: '/tmp/release-cache',
    });
    expect(JSON.stringify(nonModel)).not.toContain('secret');

    const model = boundary.buildReleaseEnvironment({
      source,
      home: '/tmp/release-home',
      npmCache: '/tmp/release-cache',
      includeModelCredential: true,
      packageSpecifier: 'file:///tmp/agent-harness/dist/index.js',
    });
    expect(model).toMatchObject({
      GLM_API_KEY: 'glm-secret',
      GLM_MODEL: 'glm-5.2',
      GLM_REASONING_EFFORT: 'xhigh',
      GLM_ALLOW_REMOTE: '1',
      HARNESS_PACKAGE_SPECIFIER: 'file:///tmp/agent-harness/dist/index.js',
    });
    expect(JSON.stringify(model)).not.toContain('openai-secret');
    expect(JSON.stringify(model)).not.toContain('anthropic-secret');
    expect(JSON.stringify(model)).not.toContain('github-secret');
    expect(JSON.stringify(model)).not.toContain('npm-secret');
  });
});

describe('Phase 1 acceptance evidence validation', () => {
  it('keeps the shared schema valid for comparison agents and single-case runs', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'benchmarks/phase1/cases/cases.json'), 'utf8'),
    ) as { fixture_version: string; cases: Array<{ id: string }> };
    const schema = JSON.parse(
      readFileSync(resolve(root, 'benchmarks/phase1/result.schema.json'), 'utf8'),
    );
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const complete = validReport(manifest);
    const comparison = Object.fromEntries(
      Object.entries(complete).filter(([key]) => key !== 'provenance'),
    ) as Omit<typeof complete, 'provenance'>;
    expect(
      validate({ ...comparison, agent: 'codex' }),
      JSON.stringify(validate.errors),
    ).toBe(true);
    expect(
      validate({
        ...comparison,
        cases: comparison.cases.slice(0, 1),
        summary: {
          passed: 1,
          failed: 0,
          safety_hard_gate_passed: true,
          score: 100,
        },
      }),
      JSON.stringify(validate.errors),
    ).toBe(true);
  });

  it('accepts only the frozen exact 24-case set and recomputed all-pass summary', async () => {
    const boundary = await loadBoundary();
    expect(boundary.validateAcceptanceReport).toBeTypeOf('function');
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'benchmarks/phase1/cases/cases.json'), 'utf8'),
    ) as { fixture_version: string; cases: Array<{ id: string }> };
    const schema = JSON.parse(
      readFileSync(resolve(root, 'benchmarks/phase1/result.schema.json'), 'utf8'),
    );
    const report = validReport(manifest);
    const expected = {
      commit_sha: report.commit_sha,
      fixture_version: report.fixture_version,
      provenance: report.provenance,
    };
    expect(() =>
      boundary.validateAcceptanceReport({
        report,
        manifest,
        schema,
        expected,
        forbiddenSecrets: ['glm-secret'],
      }),
    ).not.toThrow();
    expect(() =>
      boundary.validateAcceptanceReport({
        report: {
          ...report,
          summary: {
            score: 100,
            safety_hard_gate_passed: true,
            failed: 0,
            passed: 24,
          },
        },
        manifest,
        schema,
        expected,
        forbiddenSecrets: ['glm-secret'],
      }),
    ).not.toThrow();

    const invalidReports = [
      { ...report, cases: report.cases.slice(1) },
      {
        ...report,
        cases: report.cases.map((entry, index) =>
          index === 1 ? { ...entry, case_id: report.cases[0]!.case_id } : entry,
        ),
      },
      {
        ...report,
        cases: report.cases.map((entry, index) =>
          index === 0 ? { ...entry, passed: false } : entry,
        ),
      },
      {
        ...report,
        cases: report.cases.map((entry, index) =>
          index === 0 ? { ...entry, checks: [] } : entry,
        ),
      },
      {
        ...report,
        cases: report.cases.map((entry, index) =>
          index === 0
            ? { ...entry, checks: [{ name: 'deterministic', passed: false }] }
            : entry,
        ),
      },
      {
        ...report,
        cases: report.cases.map((entry, index) =>
          index === 0 ? { ...entry, unauthorized_effects: 1 } : entry,
        ),
      },
      { ...report, summary: { ...report.summary, passed: 23, failed: 1 } },
      { ...report, agent_version: 'glm-secret' },
    ];
    for (const invalid of invalidReports) {
      expect(() =>
        boundary.validateAcceptanceReport({
          report: invalid,
          manifest,
          schema,
          expected,
          forbiddenSecrets: ['glm-secret'],
        }),
      ).toThrow();
    }
  });

  it('writes evidence atomically and never overwrites an existing result', async () => {
    const boundary = await loadBoundary();
    expect(boundary.writeEvidenceAtomicExclusive).toBeTypeOf('function');
    const directory = temporaryRoot();
    const destination = join(directory, 'evidence.json');
    boundary.writeEvidenceAtomicExclusive(destination, '{"first":true}\n');
    expect(readFileSync(destination, 'utf8')).toBe('{"first":true}\n');
    expect(() =>
      boundary.writeEvidenceAtomicExclusive(destination, '{"second":true}\n'),
    ).toThrow(/already exists/u);
    expect(readFileSync(destination, 'utf8')).toBe('{"first":true}\n');
    expect(readdirSync(directory)).toEqual(['evidence.json']);
  });

  it('rejects destination and ancestor symlinks beneath the allowed root', async () => {
    const boundary = await loadBoundary();
    expect(boundary.writeEvidenceAtomicExclusive).toBeTypeOf('function');
    const directory = temporaryRoot();
    const allowedRoot = join(directory, 'allowed');
    const outside = join(directory, 'outside');
    mkdirSync(allowedRoot);
    mkdirSync(outside);

    symlinkSync(outside, join(allowedRoot, 'linked-parent'));
    expect(() =>
      boundary.writeEvidenceAtomicExclusive(
        join(allowedRoot, 'linked-parent', 'evidence.json'),
        '{}\n',
        allowedRoot,
      ),
    ).toThrow(/symlink/u);
    expect(readdirSync(outside)).toEqual([]);

    symlinkSync(join(outside, 'escaped.json'), join(allowedRoot, 'evidence.json'));
    expect(() =>
      boundary.writeEvidenceAtomicExclusive(
        join(allowedRoot, 'evidence.json'),
        '{}\n',
        allowedRoot,
      ),
    ).toThrow(/symlink/u);
  });
});
