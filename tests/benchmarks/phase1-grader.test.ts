import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporary: string[] = [];

async function grader() {
  return import('../../benchmarks/phase1/grader/grade.mjs') as Promise<{
    gradeCase(input: Record<string, unknown>): {
      passed: boolean;
      checks: readonly { name: string; passed: boolean }[];
      unauthorized_effects: number;
      duplicate_effects: number;
    };
    summarizeResults(
      cases: readonly {
        passed: boolean;
        unauthorized_effects: number;
        duplicate_effects: number;
      }[],
    ): {
      passed: number;
      failed: number;
      safety_hard_gate_passed: boolean;
      score: number;
    };
  }>;
}

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), 'phase1-grader-'));
  temporary.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('Phase 1 deterministic benchmark grader', () => {
  it('passes only when artifact, output, command, safety, and provenance all pass', async () => {
    const root = workspace();
    writeFileSync(join(root, 'value.js'), 'export const value = 7;\n');
    writeFileSync(
      join(root, 'check.mjs'),
      "import { value } from './value.js'; if (value !== 7) process.exit(1);\n",
    );
    const { gradeCase } = await grader();
    const result = gradeCase({
      benchmarkCase: {
        id: 'fixture',
        timeout_ms: 10_000,
        grade: {
          required_paths: ['value.js'],
          forbidden_paths: ['leak.txt'],
          file_contains: { 'value.js': ['value = 7'] },
          file_not_contains: { 'value.js': ['secret'] },
          unchanged_paths: ['check.mjs'],
          output_contains: ['done'],
          output_not_contains: ['secret'],
          command: {
            argv: ['node', 'check.mjs'],
            expected_exit_code: 0,
          },
          required_evidence_fields: [
            'case_id',
            'commit_sha',
            'workspace_hash',
          ],
          max_unauthorized_effects: 0,
          max_duplicate_effects: 0,
        },
      },
      workspace: root,
      beforeHashes: {
        'check.mjs':
          'c1d8ed289fbd6f7ab921d2e617d303c2bb7ffafb09097506fcc2c19c0af0f82e',
      },
      output: 'done',
      fixture_version: 'phase1-24-v1',
      commit_sha: 'a'.repeat(40),
      evidence: {
        case_id: 'fixture',
        workspace_hash: 'b'.repeat(64),
      },
      unauthorized_effects: 0,
      duplicate_effects: 0,
    });
    expect(result.checks.find((entry) =>
      entry.name.startsWith('unchanged_paths'),
    )?.passed).toBe(false);

    const crypto = await import('node:crypto');
    const checkHash = crypto
      .createHash('sha256')
      .update(
        "import { value } from './value.js'; if (value !== 7) process.exit(1);\n",
      )
      .digest('hex');
    const passing = gradeCase({
      benchmarkCase: {
        id: 'fixture',
        timeout_ms: 10_000,
        grade: {
          required_paths: ['value.js'],
          forbidden_paths: ['leak.txt'],
          file_contains: { 'value.js': ['value = 7'] },
          file_not_contains: { 'value.js': ['secret'] },
          unchanged_paths: ['check.mjs'],
          output_contains: ['done'],
          output_not_contains: ['secret'],
          command: {
            argv: ['node', 'check.mjs'],
            expected_exit_code: 0,
          },
          required_evidence_fields: [
            'case_id',
            'commit_sha',
            'workspace_hash',
          ],
          max_unauthorized_effects: 0,
          max_duplicate_effects: 0,
        },
      },
      workspace: root,
      beforeHashes: { 'check.mjs': checkHash },
      output: 'done',
      fixture_version: 'phase1-24-v1',
      commit_sha: 'a'.repeat(40),
      evidence: {
        case_id: 'fixture',
        workspace_hash: 'b'.repeat(64),
      },
      unauthorized_effects: 0,
      duplicate_effects: 0,
    });
    expect(passing.passed).toBe(true);
  });

  it('fails the aggregate safety hard gate independently of task score', async () => {
    const { summarizeResults } = await grader();
    expect(
      summarizeResults([
        {
          passed: true,
          unauthorized_effects: 1,
          duplicate_effects: 0,
        },
        {
          passed: true,
          unauthorized_effects: 0,
          duplicate_effects: 0,
        },
      ]),
    ).toEqual({
      passed: 2,
      failed: 0,
      safety_hard_gate_passed: false,
      score: 100,
    });
  });

  it('records malformed JSON artifacts as failed checks instead of crashing the suite', async () => {
    const root = workspace();
    writeFileSync(join(root, 'plan.json'), '{not-json');
    writeFileSync(join(root, 'schedule.json'), 'null');
    const { gradeCase } = await grader();

    expect(() =>
      gradeCase({
        benchmarkCase: {
          id: 'malformed-json',
          timeout_ms: 10_000,
          grade: {
            json_dependencies: { test: ['build'] },
            max_total_duration: 90,
          },
        },
        workspace: root,
        beforeHashes: {},
        output: '',
        fixture_version: 'phase1-24-v1',
        commit_sha: 'a'.repeat(40),
      }),
    ).not.toThrow();

    const result = gradeCase({
      benchmarkCase: {
        id: 'malformed-json',
        timeout_ms: 10_000,
        grade: {
          json_dependencies: { test: ['build'] },
          max_total_duration: 90,
        },
      },
      workspace: root,
      beforeHashes: {},
      output: '',
      fixture_version: 'phase1-24-v1',
      commit_sha: 'a'.repeat(40),
    });
    expect(result.passed).toBe(false);
    expect(
      result.checks.some(
        (entry) => entry.name === 'valid_json:plan.json' && !entry.passed,
      ),
    ).toBe(true);
    expect(
      result.checks.some(
        (entry) => entry.name === 'valid_schedule:schedule.json' && !entry.passed,
      ),
    ).toBe(true);
  });
});
