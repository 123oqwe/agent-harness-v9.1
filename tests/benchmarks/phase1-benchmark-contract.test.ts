import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

interface BenchmarkCase {
  id: string;
  category: string;
  prompt: string;
  timeout_ms: number;
  setup: readonly { path: string; content: string }[];
  grade: {
    required_paths?: readonly string[];
    forbidden_paths?: readonly string[];
    file_contains?: Readonly<Record<string, readonly string[]>>;
    file_not_contains?: Readonly<Record<string, readonly string[]>>;
    unchanged_paths?: readonly string[];
    output_contains?: readonly string[];
    output_not_contains?: readonly string[];
    command?: {
      argv: readonly string[];
      expected_exit_code: number;
    };
  };
}

interface BenchmarkManifest {
  schema_version: 1;
  fixture_version: string;
  cases: readonly BenchmarkCase[];
}

const root = resolve(import.meta.dirname, '../..');
const manifestPath = resolve(
  root,
  'benchmarks/phase1/cases/cases.json',
);

function source(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('Phase 1 live acceptance and comparison contract', () => {
  it('freezes exactly 24 unique, deterministically gradable cases', () => {
    const manifest = JSON.parse(
      readFileSync(manifestPath, 'utf8'),
    ) as BenchmarkManifest;
    expect(manifest.schema_version).toBe(1);
    expect(manifest.fixture_version).toMatch(/^phase1-24-v\d+$/u);
    expect(manifest.cases).toHaveLength(24);
    expect(new Set(manifest.cases.map((entry) => entry.id)).size).toBe(24);

    const categories = new Set(manifest.cases.map((entry) => entry.category));
    for (const required of [
      'direct',
      'react',
      'plan_execute',
      'coding',
      'documents',
      'research',
      'writing',
      'planning',
      'personal_assistant',
      'security',
      'recovery',
      'transaction',
    ]) {
      expect(categories).toContain(required);
    }

    for (const entry of manifest.cases) {
      expect(entry.id).toMatch(/^[a-z0-9][a-z0-9_-]+$/u);
      expect(entry.prompt.trim().length).toBeGreaterThan(20);
      expect(entry.timeout_ms).toBeGreaterThanOrEqual(10_000);
      expect(entry.timeout_ms).toBeLessThanOrEqual(300_000);
      expect(entry.setup.every((file) => !file.path.startsWith('/'))).toBe(
        true,
      );
      expect(Object.keys(entry.grade).length).toBeGreaterThan(0);
    }
  });

  it('uses one manifest for Harness, Codex, Claude Code, pi, and Manus', () => {
    const runner = source('benchmarks/phase1/runner/run-agent.mjs');
    for (const adapter of ['harness', 'codex', 'claude', 'pi', 'manus']) {
      expect(runner).toContain(`'${adapter}'`);
    }
    expect(runner).toContain('cases/cases.json');
    expect(runner).toContain("parsed.authenticated !== true");
    expect(runner).toContain('raw_output_sha256');
    expect(runner).toContain('entry.execution_id');
    expect(runner).not.toMatch(/score\s*=\s*(?:100|1(?:\.0+)?)\b/u);
  });

  it('grades filesystem, command, output, safety, and provenance deterministically', () => {
    const grader = source('benchmarks/phase1/grader/grade.mjs');
    for (const proof of [
      'required_paths',
      'forbidden_paths',
      'file_contains',
      'file_not_contains',
      'unchanged_paths',
      'output_contains',
      'output_not_contains',
      'expected_exit_code',
      'unauthorized_effects',
      'fixture_version',
      'commit_sha',
    ]) {
      expect(grader).toContain(proof);
    }
    expect(grader).not.toContain('Math.random');
    expect(grader).not.toContain('Date.now() > 0');
  });

  it('requires explicit live mode and key instead of silently skipping', () => {
    const liveRunner = source('scripts/run-glm-acceptance.mjs');
    expect(liveRunner).toContain('GLM_API_KEY');
    expect(liveRunner).toContain('glm-5.2');
    expect(liveRunner).toContain('xhigh');
    expect(liveRunner).toContain('GLM_ALLOW_REMOTE');
    expect(liveRunner).toContain('process.exitCode = 1');
    expect(liveRunner).not.toContain('describe.skipIf');
    expect(liveRunner).not.toContain('fetch(');
  });

  it('contains no fabricated live result or direct provider bypass', () => {
    const legacyAcceptance = source(
      'tests/glm-acceptance/glm-acceptance.test.ts',
    );
    const gatewayAcceptance = source(
      'tests/glm-acceptance/glm-gateway.test.ts',
    );
    const combined = `${legacyAcceptance}\n${gatewayAcceptance}`;
    expect(combined).not.toContain('describe.skipIf');
    expect(combined).not.toContain('await fetch(');
    expect(combined).not.toContain('bug_located_by_llm: true');
    expect(combined).not.toContain('tests_passed: true');
    expect(combined).toContain('run-glm-acceptance.mjs');
  });

  it('rejects a Manus import whose claimed raw-output hash is not authentic', () => {
    const temporary = mkdtempSync(
      resolve(tmpdir(), 'phase1-manus-provenance-'),
    );
    try {
      const manifest = JSON.parse(
        readFileSync(manifestPath, 'utf8'),
      ) as BenchmarkManifest;
      const importPath = resolve(temporary, 'manus.json');
      writeFileSync(
        importPath,
        JSON.stringify({
          schema_version: 1,
          provider: 'manus',
          authenticated: true,
          fixture_version: manifest.fixture_version,
          captured_at: new Date().toISOString(),
          raw_output_sha256: '0'.repeat(64),
          cases: manifest.cases.map((entry, index) => ({
            case_id: entry.id,
            execution_id: `execution-${index}`,
            output: '',
          })),
        }),
      );
      const result = spawnSync(
        process.execPath,
        [
          resolve(root, 'benchmarks/phase1/runner/run-agent.mjs'),
          '--agent',
          'manus',
          '--commit-sha',
          'a'.repeat(40),
          '--manus-import',
          importPath,
          '--case',
          manifest.cases[0]!.id,
        ],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('raw_output_sha256 mismatch');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
