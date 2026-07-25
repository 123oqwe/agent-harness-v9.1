import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EvalRunner,
  EvalRunnerError,
  type EvalManifest,
} from '../../verification/eval-runner.js';

const node = process.execPath;

function manifest(
  suites: EvalManifest['suites'],
): EvalManifest {
  return {
    manifest_version: 'eval-manifest.v1',
    requirement_id: 'AH-EVAL-TEST',
    suites,
  };
}

describe('AH-EVAL-RUNNER-001 argv-only evaluation runner', () => {
  let scratch: string | undefined;
  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it('executes every suite kind and binds the exact git revision', () => {
    const kinds = ['unit', 'integration', 'adversarial', 'vertical', 'e2e'] as const;
    const report = new EvalRunner().run(
      manifest(
        kinds.map((kind) => ({
          id: kind,
          kind,
          argv: [node, '-e', 'process.stdout.write("ok")'],
          expected_exit: 0,
          ...(kind === 'e2e' ? { expected_strategy: 'direct' as const } : {}),
        })),
      ),
    );
    expect(report.results).toHaveLength(5);
    expect(report.results.every((result) => result.passed)).toBe(true);
    expect(report.all_passed).toBe(true);
    expect(report.reasoning_strategy_consistent).toBe(true);
    expect(report.commit_sha).toMatch(/^[0-9a-f]{40}$/u);
  });

  it('checks the declared exit code and hashes both output streams', () => {
    const report = new EvalRunner().run(
      manifest([
        {
          id: 'exit-two',
          kind: 'unit',
          argv: [
            node,
            '-e',
            'process.stdout.write("out");process.stderr.write("err");process.exit(2)',
          ],
          expected_exit: 2,
          fixture_version: 'fixture-v1',
        },
      ]),
    );
    expect(report.results[0]).toMatchObject({
      passed: true,
      exit_code: 2,
      fixture_version: 'fixture-v1',
    });
    expect(report.results[0]!.stdout_hash).toMatch(/^[0-9a-f]{16}$/u);
    expect(report.results[0]!.stderr_hash).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('cannot represent an unexpected exit as pass', () => {
    const report = new EvalRunner().run(
      manifest([
        {
          id: 'wrong-exit',
          kind: 'adversarial',
          argv: [node, '-e', 'process.exit(3)'],
          expected_exit: 0,
        },
      ]),
    );
    expect(report.results[0]!.passed).toBe(false);
    expect(report.results[0]!.reason).toBe('expected exit 0, got 3');
    expect(report.all_passed).toBe(false);
  });

  it('marks e2e strategy consistency false when its executable fails', () => {
    const report = new EvalRunner().run(
      manifest([
        {
          id: 'react',
          kind: 'e2e',
          argv: [node, '-e', 'process.exit(1)'],
          expected_exit: 0,
          expected_strategy: 'react',
        },
      ]),
    );
    expect(report.reasoning_strategy_consistent).toBe(false);
  });

  it('keeps strategy consistency independent from non-e2e suite failures', () => {
    const report = new EvalRunner().run(
      manifest([
        {
          id: 'unit-failure',
          kind: 'unit',
          argv: [node, '-e', 'process.exit(4)'],
          expected_exit: 0,
        },
        {
          id: 'direct',
          kind: 'e2e',
          argv: [node, '-e', 'process.exit(0)'],
          expected_exit: 0,
          expected_strategy: 'direct',
        },
      ]),
    );
    expect(report.all_passed).toBe(false);
    expect(report.reasoning_strategy_consistent).toBe(true);
  });

  it('passes arguments literally and never interprets shell syntax', () => {
    scratch = mkdtempSync(join(tmpdir(), 'eval-argv-'));
    const target = join(scratch, 'must-not-exist');
    const report = new EvalRunner().run(
      manifest([
        {
          id: 'literal',
          kind: 'adversarial',
          argv: ['/bin/echo', `$(touch ${target})`],
          expected_exit: 0,
        },
      ]),
    );
    expect(report.all_passed).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it('honours per-case cwd and timeout without a shell', () => {
    scratch = mkdtempSync(join(tmpdir(), 'eval-cwd-'));
    const report = new EvalRunner().run(
      manifest([
        {
          id: 'cwd',
          kind: 'unit',
          argv: [
            node,
            '-e',
            'process.exit(process.cwd()===process.argv[1]?0:7)',
            realpathSync(scratch),
          ],
          cwd: scratch,
          expected_exit: 0,
        },
        {
          id: 'timeout',
          kind: 'unit',
          argv: [node, '-e', 'setTimeout(()=>{}, 5000)'],
          timeout_ms: 20,
          expected_exit: 1,
        },
      ]),
    );
    expect(report.results.map((result) => result.passed)).toEqual([true, true]);
  });

  it('fails closed when the executable does not exist', () => {
    const report = new EvalRunner().run(
      manifest([
        {
          id: 'missing',
          kind: 'unit',
          argv: ['/definitely/not/an/executable'],
          expected_exit: 0,
        },
      ]),
    );
    expect(report.results[0]!.exit_code).toBe(1);
    expect(report.results[0]!.passed).toBe(false);
    expect(report.results[0]!.stderr_hash).toMatch(/^[0-9a-f]{16}$/u);
  });

  it.each([
    null,
    undefined,
    {},
    { manifest_version: 'wrong', requirement_id: 'x', suites: [] },
    { manifest_version: 'eval-manifest.v1', requirement_id: '', suites: [] },
    { manifest_version: 'eval-manifest.v1', requirement_id: 'x', suites: [] },
    {
      manifest_version: 'eval-manifest.v1',
      requirement_id: 'x',
      suites: [{ id: '', kind: 'unit', argv: [node], expected_exit: 0 }],
    },
    {
      manifest_version: 'eval-manifest.v1',
      requirement_id: 'x',
      suites: [{ id: 'x', kind: 'unit', argv: [], expected_exit: 0 }],
    },
    {
      manifest_version: 'eval-manifest.v1',
      requirement_id: 'x',
      suites: [{ id: 'x', kind: 'unit', argv: [node], expected_exit: 0.5 }],
    },
    {
      manifest_version: 'eval-manifest.v1',
      requirement_id: 'x',
      suites: [{ id: 'x', kind: 'unit', argv: [node], expected_exit: 0, timeout_ms: 0 }],
    },
    {
      manifest_version: 'eval-manifest.v1',
      requirement_id: 'x',
      suites: [
        { id: 'x', kind: 'unit', argv: [node], expected_exit: 0 },
        { id: 'x', kind: 'unit', argv: [node], expected_exit: 0 },
      ],
    },
    {
      manifest_version: 'eval-manifest.v1',
      requirement_id: 'x',
      suites: [
        { id: 'x', kind: 'unknown', argv: [node], expected_exit: 0 },
      ],
    },
    {
      manifest_version: 'eval-manifest.v1',
      requirement_id: 'x',
      suites: [
        { id: 'x', kind: 'e2e', argv: [node], expected_exit: 0 },
      ],
    },
    {
      manifest_version: 'eval-manifest.v1',
      requirement_id: 'x',
      suites: [
        {
          id: 'x',
          kind: 'e2e',
          argv: [node],
          expected_exit: 0,
          expected_strategy: 'unknown',
        },
      ],
    },
    {
      manifest_version: 'eval-manifest.v1',
      requirement_id: 'x',
      suites: [
        {
          id: 'x',
          kind: 'unit',
          argv: [node],
          expected_exit: 0,
          expected_strategy: 'direct',
        },
      ],
    },
  ])('rejects malformed manifest %#', (candidate) => {
    expect(() => EvalRunner.validateManifest(candidate)).toThrow(EvalRunnerError);
  });

  it('preserves EvalRunnerError identity and exact validation messages', () => {
    const error = new EvalRunnerError('boundary');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('EvalRunnerError');
    expect(error.message).toBe('boundary');
    expect(() =>
      EvalRunner.validateManifest({
        manifest_version: 'eval-manifest.v1',
        requirement_id: 'x',
        suites: [
          {
            id: 'x',
            kind: 'e2e',
            argv: [node],
            expected_exit: 0,
          },
        ],
      }),
    ).toThrow('e2e eval requires a valid expected_strategy');
  });
});
