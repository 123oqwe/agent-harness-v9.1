import { describe, it, expect, afterEach } from 'vitest';
import { EvalRunner, EvalRunnerError, type EvalManifest } from '../../verification/eval-runner.js';
import { generateEvidence, writeEvidence, validateEvidence, runCommand, EvidenceError, type EvidencePackage } from '../../verification/evidence.js';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCHEMA_PATH = process.env.HARNESS_SPEC_ROOT
  ? join(process.env.HARNESS_SPEC_ROOT, 'contracts', 'evidence-package.schema.json')
  : join(import.meta.dirname, '..', '..', '..', 'spec', 'contracts', 'evidence-package.schema.json');

describe('EvalRunner mutation-killing tests', () => {
  const runner = new EvalRunner();

  it('marks case as failed when exit code mismatches', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-FAIL',
      suites: [{ id: 'f1', kind: 'unit', command: 'exit 1', expected_exit: 0 }],
    };
    const report = runner.run(manifest);
    expect(report.results[0]!.passed).toBe(false);
    expect(report.all_passed).toBe(false);
    expect(report.results[0]!.reason).toContain('expected exit 0, got 1');
  });

  it('marks case as passed when expected non-zero exit matches', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-EXIT',
      suites: [{ id: 'e1', kind: 'unit', command: 'exit 3', expected_exit: 3 }],
    };
    const report = runner.run(manifest);
    expect(report.results[0]!.passed).toBe(true);
  });

  it('captures stderr hash when command fails', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-STDERR',
      suites: [{ id: 's1', kind: 'unit', command: 'sh -c "echo err 1>&2; exit 1"', expected_exit: 0 }],
    };
    const report = runner.run(manifest);
    expect(report.results[0]!.stderr_hash).not.toBeNull();
  });

  it('captures stdout hash when command succeeds', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-STDOUT',
      suites: [{ id: 's2', kind: 'unit', command: 'echo out', expected_exit: 0 }],
    };
    const report = runner.run(manifest);
    expect(report.results[0]!.stdout_hash).not.toBeNull();
  });

  it('records fixture_version in results', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-FV',
      suites: [{ id: 'fv1', kind: 'unit', command: 'echo ok', expected_exit: 0, fixture_version: 'v2.0' }],
    };
    const report = runner.run(manifest);
    expect(report.results[0]!.fixture_version).toBe('v2.0');
  });

  it('e2e strategy consistency is false when any e2e case fails', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-E2E',
      suites: [
        { id: 'e2e-1', kind: 'e2e', command: 'echo ok', expected_exit: 0, expected_strategy: 'direct' },
        { id: 'e2e-2', kind: 'e2e', command: 'exit 1', expected_exit: 0, expected_strategy: 'react' },
      ],
    };
    const report = runner.run(manifest);
    expect(report.reasoning_strategy_consistent).toBe(false);
  });

  it('e2e strategy consistency is true when all e2e cases pass', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-E2E2',
      suites: [{ id: 'e2e-3', kind: 'e2e', command: 'echo ok', expected_exit: 0, expected_strategy: 'direct' }],
    };
    const report = runner.run(manifest);
    expect(report.reasoning_strategy_consistent).toBe(true);
  });

  it('strategy consistency is true when no e2e cases exist', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-NOE2E',
      suites: [{ id: 'u2', kind: 'unit', command: 'echo ok', expected_exit: 0 }],
    };
    const report = runner.run(manifest);
    expect(report.reasoning_strategy_consistent).toBe(true);
  });

  it('strategy consistency is false when a non-e2e case fails', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-FAIL2',
      suites: [{ id: 'u3', kind: 'unit', command: 'exit 1', expected_exit: 0 }],
    };
    const report = runner.run(manifest);
    expect(report.reasoning_strategy_consistent).toBe(false);
  });

  it('validateManifest rejects invalid manifest_version', () => {
    expect(() => EvalRunner.validateManifest({ manifest_version: 'wrong', requirement_id: 'x', suites: [] })).toThrow(EvalRunnerError);
  });

  it('validateManifest rejects missing requirement_id', () => {
    expect(() => EvalRunner.validateManifest({ manifest_version: 'eval-manifest.v1', suites: [] })).toThrow(EvalRunnerError);
  });

  it('validateManifest rejects empty suites', () => {
    expect(() => EvalRunner.validateManifest({ manifest_version: 'eval-manifest.v1', requirement_id: 'x', suites: [] })).toThrow(EvalRunnerError);
  });

  it('validateManifest rejects case missing id', () => {
    expect(() => EvalRunner.validateManifest({ manifest_version: 'eval-manifest.v1', requirement_id: 'x', suites: [{ id: '', command: 'echo', expected_exit: 0 }] })).toThrow(EvalRunnerError);
  });

  it('validateManifest rejects case missing command', () => {
    expect(() => EvalRunner.validateManifest({ manifest_version: 'eval-manifest.v1', requirement_id: 'x', suites: [{ id: 'c', command: '', expected_exit: 0 }] })).toThrow(EvalRunnerError);
  });

  it('report includes commit_sha and manifest_version and timestamp', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-SHA',
      suites: [{ id: 's3', kind: 'unit', command: 'echo ok', expected_exit: 0 }],
    };
    const report = runner.run(manifest);
    expect(report.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(report.manifest_version).toBe('eval-manifest.v1');
    expect(() => new Date(report.timestamp)).not.toThrow();
  });
});

describe('Evidence mutation-killing tests', () => {
  let dir: string;
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('runCommand captures exit code 0 on success', () => {
    const result = runCommand('echo hello');
    expect(result.exit_code).toBe(0);
    expect(result.stdout_hash).not.toBeNull();
  });

  it('runCommand captures non-zero exit code on failure', () => {
    const result = runCommand('exit 5');
    expect(result.exit_code).toBe(5);
  });

  it('runCommand captures stderr on failure', () => {
    const result = runCommand('sh -c "echo err 1>&2; exit 1"');
    expect(result.stderr_hash).not.toBeNull();
  });

  it('generateEvidence throws when commands is empty', () => {
    dir = mkdtempSync(join(tmpdir(), 'ev-mut-'));
    expect(() => generateEvidence({
      requirement_id: 'AH-EMPTY', source_files: ['package.json'], tests_added: [],
      commands: [], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    })).toThrow(EvidenceError);
  });

  it('generateEvidence throws when source_file does not exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'ev-mut-'));
    expect(() => generateEvidence({
      requirement_id: 'AH-MISSING', source_files: ['nonexistent.ts'], tests_added: [],
      commands: ['echo ok'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    })).toThrow(EvidenceError);
  });

  it('generateEvidence throws when tests_added file does not exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'ev-mut-'));
    expect(() => generateEvidence({
      requirement_id: 'AH-MISSING2', source_files: ['package.json'], tests_added: ['nonexistent-test.ts'],
      commands: ['echo ok'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    })).toThrow(EvidenceError);
  });

  it('generateEvidence sets verifier_result to fail when any command fails', () => {
    dir = mkdtempSync(join(tmpdir(), 'ev-mut-'));
    const ev = generateEvidence({
      requirement_id: 'AH-FAIL-EV', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok', 'exit 1'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    expect(ev.verifier_result).toBe('fail');
  });

  it('generateEvidence sets verifier_result to pass when all commands succeed', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-PASS-EV', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    expect(ev.verifier_result).toBe('pass');
  });

  it('generateEvidence includes verifier_model when provided', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-VM', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
      verifier_model: 'glm-5.2',
    });
    expect(ev.verifier_model).toBe('glm-5.2');
  });

  it('generateEvidence uses default verifier_model when not provided', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-VM2', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    expect(ev.verifier_model).toContain('independent rerun');
  });

  it('writeEvidence writes to disk', () => {
    dir = mkdtempSync(join(tmpdir(), 'ev-mut-'));
    const ev = generateEvidence({
      requirement_id: 'AH-WRITE', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    const path = join(dir, 'evidence.json');
    writeEvidence(ev, path);
    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.requirement_id).toBe('AH-WRITE');
  });

  it('writeEvidence allows overwrite when existing is fail and new is pass', () => {
    dir = mkdtempSync(join(tmpdir(), 'ev-mut-'));
    const path = join(dir, 'evidence.json');
    const failEv: EvidencePackage = {
      requirement_id: 'AH-OW', commit_sha: 'a'.repeat(40), source_files: [], tests_added: [],
      commands_run: [{ command: 'exit 1', exit_code: 1, stdout_hash: null }],
      exit_codes: [1], test_results: {}, coverage: {}, security_checks: {}, verifier_result: 'fail',
    };
    writeEvidence(failEv, path);
    const passEv = generateEvidence({
      requirement_id: 'AH-OW', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    expect(() => writeEvidence(passEv, path)).not.toThrow();
  });

  it('writeEvidence rejects overwrite when existing is pass and new is fail', () => {
    dir = mkdtempSync(join(tmpdir(), 'ev-mut-'));
    const path = join(dir, 'evidence.json');
    const passEv = generateEvidence({
      requirement_id: 'AH-OW2', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    writeEvidence(passEv, path);
    const failEv: EvidencePackage = {
      requirement_id: 'AH-OW2', commit_sha: 'b'.repeat(40), source_files: [], tests_added: [],
      commands_run: [{ command: 'exit 1', exit_code: 1, stdout_hash: null }],
      exit_codes: [1], test_results: {}, coverage: {}, security_checks: {}, verifier_result: 'fail',
    };
    expect(() => writeEvidence(failEv, path)).toThrow(EvidenceError);
  });

  it('validateEvidence rejects invalid commit_sha', () => {
    expect(() => validateEvidence({
      requirement_id: 'x', commit_sha: 'short', source_files: [], tests_added: [],
      commands_run: [], exit_codes: [], test_results: {}, coverage: {}, security_checks: {},
      verifier_result: 'fail',
    }, SCHEMA_PATH)).toThrow();
  });

  it('validateEvidence rejects pass without commands', () => {
    expect(() => validateEvidence({
      requirement_id: 'x', commit_sha: 'a'.repeat(40), source_files: [], tests_added: [],
      commands_run: [], exit_codes: [], test_results: {}, coverage: {}, security_checks: {},
      verifier_result: 'pass',
    }, SCHEMA_PATH)).toThrow();
  });

  it('validateEvidence rejects pass with pending commit_sha', () => {
    expect(() => validateEvidence({
      requirement_id: 'x', commit_sha: 'pending', source_files: [], tests_added: [],
      commands_run: [{ command: 'echo', exit_code: 0, stdout_hash: 'abc' }], exit_codes: [0],
      test_results: {}, coverage: {}, security_checks: {}, verifier_result: 'pass',
    }, SCHEMA_PATH)).toThrow();
  });

  it('generateEvidence includes exit_codes array', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-EC', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok', 'echo ok2'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    expect(ev.exit_codes).toEqual([0, 0]);
  });

  it('generateEvidence includes test_output as null', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-TO', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    expect(ev.test_output).toBeNull();
    expect(ev.test_output_hash).toBeNull();
  });
});
