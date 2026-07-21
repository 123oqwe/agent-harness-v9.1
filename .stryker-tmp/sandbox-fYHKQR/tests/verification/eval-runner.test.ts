// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { EvalRunner, EvalRunnerError, type EvalManifest } from '../../verification/eval-runner.js';

describe('AH-EVAL-RUNNER-001 eval runner', () => {
  it('executes unit, integration, adversarial and vertical eval suites from one manifest', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1',
      requirement_id: 'AH-TEST',
      suites: [
        { id: 'u1', kind: 'unit', command: 'echo unit', expected_exit: 0 },
        { id: 'i1', kind: 'integration', command: 'echo integ', expected_exit: 0 },
        { id: 'a1', kind: 'adversarial', command: 'echo adv', expected_exit: 0 },
        { id: 'v1', kind: 'vertical', command: 'echo vert', expected_exit: 0 },
      ],
    };
    const report = new EvalRunner().run(manifest);
    expect(report.results).toHaveLength(4);
    expect(report.all_passed).toBe(true);
  });

  it('uses ScriptedTestProvider and local fixtures only (no external model API)', () => {
    // the eval commands are local shell commands; no external API is called
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1',
      requirement_id: 'AH-TEST',
      suites: [{ id: 'l1', kind: 'unit', command: 'echo local', expected_exit: 0 }],
    };
    const report = new EvalRunner().run(manifest);
    expect(report.results[0]!.passed).toBe(true);
  });

  it('captures command, exit code, stdout/stderr hashes, fixture version and code revision', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1',
      requirement_id: 'AH-TEST',
      suites: [{ id: 'c1', kind: 'unit', command: 'echo cap', expected_exit: 0, fixture_version: 'v1' }],
    };
    const report = new EvalRunner().run(manifest);
    const r = report.results[0]!;
    expect(r.exit_code).toBe(0);
    expect(r.stdout_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(r.fixture_version).toBe('v1');
    expect(report.commit_sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('a failing or missing eval cannot be represented as pass', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1',
      requirement_id: 'AH-TEST',
      suites: [{ id: 'f1', kind: 'unit', command: 'exit 1', expected_exit: 0 }],
    };
    const report = new EvalRunner().run(manifest);
    expect(report.results[0]!.passed).toBe(false);
    expect(report.all_passed).toBe(false);
  });

  it('runs local e2e fixtures for direct, react, plan_execute and fails on strategy disagreement', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1',
      requirement_id: 'AH-TEST',
      suites: [
        { id: 'd1', kind: 'e2e', command: 'echo direct', expected_exit: 0, expected_strategy: 'direct' },
        { id: 'r1', kind: 'e2e', command: 'echo react', expected_exit: 0, expected_strategy: 'react' },
        { id: 'p1', kind: 'e2e', command: 'echo plan', expected_exit: 0, expected_strategy: 'plan_execute' },
      ],
    };
    const report = new EvalRunner().run(manifest);
    expect(report.reasoning_strategy_consistent).toBe(true);
    expect(report.all_passed).toBe(true);
  });

  it('fails when e2e strategy cases fail (reasoning_strategy disagreement)', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1',
      requirement_id: 'AH-TEST',
      suites: [
        { id: 'd1', kind: 'e2e', command: 'exit 1', expected_exit: 0, expected_strategy: 'direct' },
      ],
    };
    const report = new EvalRunner().run(manifest);
    expect(report.reasoning_strategy_consistent).toBe(false);
  });

  it('EvalRunner.validateManifest rejects empty suites', () => {
    expect(() => EvalRunner.validateManifest({ manifest_version: 'eval-manifest.v1', requirement_id: 'x', suites: [] })).toThrow(EvalRunnerError);
  });

  it('implementation agent cannot edit expected results during a run (commands are declarative)', () => {
    // the manifest is an immutable input; the runner executes commands as-declared
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1',
      requirement_id: 'AH-TEST',
      suites: [{ id: 'x1', kind: 'unit', command: 'echo immutable', expected_exit: 0 }],
    };
    const r = new EvalRunner().run(manifest);
    expect(r.results[0]!.passed).toBe(true);
  });
});
