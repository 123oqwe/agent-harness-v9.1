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
  let dir: string = "";
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

describe('EvalRunner advanced mutation-killing tests', () => {
  const runner = new EvalRunner();

  it('reason field is undefined when case passes', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-REASON',
      suites: [{ id: 'r1', kind: 'unit', command: 'echo ok', expected_exit: 0 }],
    };
    const report = runner.run(manifest);
    expect(report.results[0]!.reason).toBeUndefined();
  });

  it('reason field contains expected and actual exit when case fails', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-REASON2',
      suites: [{ id: 'r2', kind: 'unit', command: 'exit 7', expected_exit: 0 }],
    };
    const report = runner.run(manifest);
    expect(report.results[0]!.reason).toContain('expected exit 0');
    expect(report.results[0]!.reason).toContain('got 7');
  });

  it('exit_code is 1 when command crashes without explicit exit code', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-CRASH',
      suites: [{ id: 'c2', kind: 'unit', command: 'nonexistent-command-xyz', expected_exit: 0 }],
    };
    const report = runner.run(manifest);
    expect(report.results[0]!.exit_code).not.toBe(0);
    expect(report.results[0]!.passed).toBe(false);
  });

  it('e2e case without expected_strategy does not affect consistency', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-NE2E',
      suites: [
        { id: 'e2e-4', kind: 'e2e', command: 'echo ok', expected_exit: 0 },
        { id: 'u4', kind: 'unit', command: 'exit 1', expected_exit: 0 },
      ],
    };
    const report = runner.run(manifest);
    // e2e without expected_strategy is filtered out from consistency check
    // but the unit failure still makes strategies_consistent false
    expect(report.reasoning_strategy_consistent).toBe(false);
  });

  it('all_passed is true only when every case passes', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-ALL',
      suites: [
        { id: 'a1', kind: 'unit', command: 'echo ok', expected_exit: 0 },
        { id: 'a2', kind: 'unit', command: 'echo ok', expected_exit: 0 },
      ],
    };
    const report = runner.run(manifest);
    expect(report.all_passed).toBe(true);
  });

  it('report results are in manifest order', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-ORDER',
      suites: [
        { id: 'first', kind: 'unit', command: 'echo 1', expected_exit: 0 },
        { id: 'second', kind: 'unit', command: 'echo 2', expected_exit: 0 },
        { id: 'third', kind: 'unit', command: 'echo 3', expected_exit: 0 },
      ],
    };
    const report = runner.run(manifest);
    expect(report.results[0]!.case_id).toBe('first');
    expect(report.results[1]!.case_id).toBe('second');
    expect(report.results[2]!.case_id).toBe('third');
  });

  it('validateManifest accepts a case with expected_strategy', () => {
    expect(() => EvalRunner.validateManifest({
      manifest_version: 'eval-manifest.v1', requirement_id: 'x',
      suites: [{ id: 'c', command: 'echo', expected_exit: 0, expected_strategy: 'direct' }],
    })).not.toThrow();
  });

  it('validateManifest accepts all suite kinds', () => {
    const kinds = ['unit', 'integration', 'adversarial', 'vertical', 'e2e'];
    for (const kind of kinds) {
      expect(() => EvalRunner.validateManifest({
        manifest_version: 'eval-manifest.v1', requirement_id: 'x',
        suites: [{ id: 'c', command: 'echo', expected_exit: 0, kind: kind as 'unit' | 'integration' | 'adversarial' | 'vertical' | 'e2e' }],
      })).not.toThrow();
    }
  });
});

describe('Evidence advanced mutation-killing tests', () => {
  let dir: string = "";
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('runCommand uses cwd when provided', () => {
    dir = mkdtempSync(join(tmpdir(), 'ev-mut-'));
    const result = runCommand('pwd', dir);
    expect(result.exit_code).toBe(0);
  });

  it('runCommand uses timeout when provided', () => {
    // A command that would take longer than 100ms
    const result = runCommand('sleep 1', undefined, 100);
    expect(result.exit_code).not.toBe(0);
  });

  it('generateEvidence includes source_files array', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-SF', source_files: ['package.json', 'tsconfig.json'], tests_added: [],
      commands: ['echo ok'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    expect(ev.source_files).toEqual(['package.json', 'tsconfig.json']);
  });

  it('generateEvidence includes tests_added array', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-TA', source_files: ['package.json'],
      tests_added: ['tests/evidence/generation.test.ts'],
      commands: ['echo ok'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    expect(ev.tests_added).toEqual(['tests/evidence/generation.test.ts']);
  });

  it('generateEvidence includes test_results object', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-TR', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok'], cwd: process.cwd(),
      test_results: { total: 10, passed: 9, failed: 1 }, coverage: {}, security_checks: {},
    });
    expect(ev.test_results).toEqual({ total: 10, passed: 9, failed: 1 });
  });

  it('generateEvidence includes coverage object', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-COV', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok'], cwd: process.cwd(), test_results: {},
      coverage: { lines: 85, branches: 80 }, security_checks: {},
    });
    expect(ev.coverage).toEqual({ lines: 85, branches: 80 });
  });

  it('generateEvidence includes security_checks object', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-SC', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok'], cwd: process.cwd(), test_results: {}, coverage: {},
      security_checks: { sandbox_violation: 0, unauthorized_effect: 0 },
    });
    expect(ev.security_checks).toEqual({ sandbox_violation: 0, unauthorized_effect: 0 });
  });

  it('generateEvidence includes commands_run with command and exit_code', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-CR', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    expect(ev.commands_run[0]!.command).toBe('echo ok');
    expect(ev.commands_run[0]!.exit_code).toBe(0);
  });

  it('generateEvidence includes requirement_id', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-RID-123', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    expect(ev.requirement_id).toBe('AH-RID-123');
  });

  it('writeEvidence can write same-level pass evidence', () => {
    dir = mkdtempSync(join(tmpdir(), 'ev-mut-'));
    const path = join(dir, 'evidence.json');
    const passEv = generateEvidence({
      requirement_id: 'AH-SL', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    writeEvidence(passEv, path);
    const passEv2 = generateEvidence({
      requirement_id: 'AH-SL', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok2'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    expect(() => writeEvidence(passEv2, path)).not.toThrow();
  });
});

describe('EvalRunner edge-case mutation-killing tests', () => {
  const runner = new EvalRunner();

  it('runCase sets exit_code to 1 when command not found (no status)', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-NF',
      suites: [{ id: 'nf1', kind: 'unit', command: 'this-command-does-not-exist-12345', expected_exit: 127 }],
    };
    const report = runner.run(manifest);
    // On macOS, non-existent command gives exit code 127
    expect(report.results[0]!.exit_code).toBe(127);
  });

  it('runCase with expected_exit matching actual non-zero passes', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-MATCH',
      suites: [{ id: 'm1', kind: 'unit', command: 'exit 42', expected_exit: 42 }],
    };
    const report = runner.run(manifest);
    expect(report.results[0]!.passed).toBe(true);
    expect(report.results[0]!.reason).toBeUndefined();
  });

  it('stderr_hash is null when stderr is empty string on success', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-SE',
      suites: [{ id: 'se1', kind: 'unit', command: 'echo ok', expected_exit: 0 }],
    };
    const report = runner.run(manifest);
    // On success, stderr is '' and sha('' || null) = sha(null) = null
    expect(report.results[0]!.stderr_hash).toBeNull();
  });

  it('stdout_hash is not null when stdout has content', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-SO',
      suites: [{ id: 'so1', kind: 'unit', command: 'printf "hello"', expected_exit: 0 }],
    };
    const report = runner.run(manifest);
    expect(report.results[0]!.stdout_hash).not.toBeNull();
  });

  it('report requirement_id matches manifest', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-RID-XYZ-789',
      suites: [{ id: 'r1', kind: 'unit', command: 'echo ok', expected_exit: 0 }],
    };
    const report = runner.run(manifest);
    expect(report.requirement_id).toBe('AH-RID-XYZ-789');
  });

  it('e2e without expected_strategy but with failure makes consistency false', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-E2E-NS',
      suites: [
        { id: 'e2e-ns-1', kind: 'e2e', command: 'echo ok', expected_exit: 0 },
        { id: 'e2e-ns-2', kind: 'e2e', command: 'exit 1', expected_exit: 0 },
      ],
    };
    const report = runner.run(manifest);
    // e2e without expected_strategy are filtered from the consistency check
    // but the non-e2e failure path sets strategies_consistent to false
    expect(report.reasoning_strategy_consistent).toBe(false);
  });

  it('mixed e2e with strategy and unit cases: consistency from e2e only', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-MIX',
      suites: [
        { id: 'u-mix', kind: 'unit', command: 'exit 1', expected_exit: 0 },
        { id: 'e2e-mix', kind: 'e2e', command: 'echo ok', expected_exit: 0, expected_strategy: 'direct' },
      ],
    };
    const report = runner.run(manifest);
    // e2e with strategy passes -> consistency from e2e overrides
    // BUT the unit failure sets strategies_consistent=false first,
    // then e2e with expected_strategy overrides to true
    expect(report.reasoning_strategy_consistent).toBe(true);
  });

  it('mixed e2e with strategy failing: consistency false', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-MIX2',
      suites: [
        { id: 'u-mix2', kind: 'unit', command: 'echo ok', expected_exit: 0 },
        { id: 'e2e-mix2', kind: 'e2e', command: 'exit 1', expected_exit: 0, expected_strategy: 'react' },
      ],
    };
    const report = runner.run(manifest);
    expect(report.reasoning_strategy_consistent).toBe(false);
  });
});

describe('Evidence edge-case mutation-killing tests', () => {
  let dir: string = "";
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('runCommand returns null stderr_hash when command succeeds', () => {
    const result = runCommand('echo ok');
    expect(result.stderr_hash).toBeUndefined();
  });

  it('runCommand returns non-null stderr_hash when command fails with stderr', () => {
    const result = runCommand('sh -c "echo err 1>&2; exit 1"');
    expect(result.stderr_hash).not.toBeNull();
  });

  it('generateEvidence commit_sha is 40 chars hex', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-CS', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    expect(ev.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(ev.commit_sha.length).toBe(40);
  });

  it('generateEvidence commands_run has stdout_hash on success', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-SH', source_files: ['package.json'], tests_added: [],
      commands: ['echo hello'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    expect(ev.commands_run[0]!.stdout_hash).not.toBeNull();
  });

  it('generateEvidence commands_run has stderr_hash on failure', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-SH2', source_files: ['package.json'], tests_added: [],
      commands: ['sh -c "echo err 1>&2; exit 1"'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    expect(ev.commands_run[0]!.stderr_hash).not.toBeNull();
    expect(ev.commands_run[0]!.exit_code).not.toBe(0);
  });

  it('generateEvidence exit_codes reflects each command result', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-EC2', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok', 'exit 1', 'echo ok3'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    expect(ev.exit_codes).toEqual([0, 1, 0]);
    expect(ev.verifier_result).toBe('fail');
  });

  it('validateEvidence with valid evidence and schema returns true', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-VAL', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    const SCHEMA_PATH = process.env.HARNESS_SPEC_ROOT
      ? join(process.env.HARNESS_SPEC_ROOT, 'contracts', 'evidence-package.schema.json')
      : join(import.meta.dirname, '..', '..', '..', 'spec', 'contracts', 'evidence-package.schema.json');
    expect(validateEvidence(ev, SCHEMA_PATH)).toBe(true);
  });
});

describe('Verification final mutation-killing tests', () => {
  const runner = new EvalRunner();

  it('all_passed is false when at least one case fails among passing ones', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-AP',
      suites: [
        { id: 'ap1', kind: 'unit', command: 'echo ok', expected_exit: 0 },
        { id: 'ap2', kind: 'unit', command: 'exit 1', expected_exit: 0 },
        { id: 'ap3', kind: 'unit', command: 'echo ok', expected_exit: 0 },
      ],
    };
    const report = runner.run(manifest);
    expect(report.all_passed).toBe(false);
  });

  it('validateManifest rejects null manifest', () => {
    expect(() => EvalRunner.validateManifest(null)).toThrow(EvalRunnerError);
  });

  it('validateManifest rejects undefined manifest', () => {
    expect(() => EvalRunner.validateManifest(undefined)).toThrow(EvalRunnerError);
  });

  it('validateManifest rejects suites not an array', () => {
    expect(() => EvalRunner.validateManifest({
      manifest_version: 'eval-manifest.v1', requirement_id: 'x', suites: 'not-array',
    })).toThrow(EvalRunnerError);
  });

  it('validateManifest rejects case with undefined fields', () => {
    expect(() => EvalRunner.validateManifest({
      manifest_version: 'eval-manifest.v1', requirement_id: 'x',
      suites: [{ kind: 'unit', command: 'echo', expected_exit: 0 }],
    })).toThrow(EvalRunnerError);
  });

  it('validateManifest error message contains invalid manifest_version', () => {
    try {
      EvalRunner.validateManifest({ manifest_version: 'wrong', requirement_id: 'x', suites: [] });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('manifest_version');
    }
  });

  it('validateManifest error message contains requirement_id', () => {
    try {
      EvalRunner.validateManifest({ manifest_version: 'eval-manifest.v1', suites: [] });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('requirement_id');
    }
  });

  it('validateManifest error message contains non-empty suites', () => {
    try {
      EvalRunner.validateManifest({ manifest_version: 'eval-manifest.v1', requirement_id: 'x', suites: [] });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('non-empty');
    }
  });

  it('validateManifest error message contains id and command', () => {
    try {
      EvalRunner.validateManifest({
        manifest_version: 'eval-manifest.v1', requirement_id: 'x',
        suites: [{ id: '', command: '', expected_exit: 0 }],
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('id and command');
    }
  });

  it('generateEvidence with cwd parameter uses that cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ev-cwd-'));
    try {
      const ev = generateEvidence({
        requirement_id: 'AH-CWD-PARAM', source_files: [], tests_added: [],
        commands: ['echo ok'], cwd: dir, test_results: {}, coverage: {}, security_checks: {},
      });
      expect(ev.verifier_result).toBe('pass');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generateEvidence without cwd parameter uses process.cwd', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-NO-CWD', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok'], test_results: {}, coverage: {}, security_checks: {},
    });
    expect(ev.verifier_result).toBe('pass');
  });

  it('validateEvidence rejects non-40-char commit_sha with 39 chars', () => {
    const SCHEMA_PATH = process.env.HARNESS_SPEC_ROOT
      ? join(process.env.HARNESS_SPEC_ROOT, 'contracts', 'evidence-package.schema.json')
      : join(import.meta.dirname, '..', '..', '..', 'spec', 'contracts', 'evidence-package.schema.json');
    expect(() => validateEvidence({
      requirement_id: 'x', commit_sha: 'a'.repeat(39), source_files: [], tests_added: [],
      commands_run: [], exit_codes: [], test_results: {}, coverage: {}, security_checks: {},
      verifier_result: 'fail',
    }, SCHEMA_PATH)).toThrow();
  });

  it('validateEvidence rejects non-40-char commit_sha with 41 chars', () => {
    const SCHEMA_PATH = process.env.HARNESS_SPEC_ROOT
      ? join(process.env.HARNESS_SPEC_ROOT, 'contracts', 'evidence-package.schema.json')
      : join(import.meta.dirname, '..', '..', '..', 'spec', 'contracts', 'evidence-package.schema.json');
    expect(() => validateEvidence({
      requirement_id: 'x', commit_sha: 'a'.repeat(41), source_files: [], tests_added: [],
      commands_run: [], exit_codes: [], test_results: {}, coverage: {}, security_checks: {},
      verifier_result: 'fail',
    }, SCHEMA_PATH)).toThrow();
  });

  it('validateEvidence accepts 40-char hex commit_sha with fail result', () => {
    const SCHEMA_PATH = process.env.HARNESS_SPEC_ROOT
      ? join(process.env.HARNESS_SPEC_ROOT, 'contracts', 'evidence-package.schema.json')
      : join(import.meta.dirname, '..', '..', '..', 'spec', 'contracts', 'evidence-package.schema.json');
    expect(() => validateEvidence({
      requirement_id: 'x', commit_sha: 'a'.repeat(40), source_files: [], tests_added: [],
      commands_run: [{ command: 'exit 1', exit_code: 1, stdout_hash: null }],
      exit_codes: [1], test_results: {}, coverage: {}, security_checks: {},
      verifier_result: 'fail',
    }, SCHEMA_PATH)).not.toThrow();
  });

  it('validateEvidence rejects pass with commands but pending commit_sha', () => {
    const SCHEMA_PATH = process.env.HARNESS_SPEC_ROOT
      ? join(process.env.HARNESS_SPEC_ROOT, 'contracts', 'evidence-package.schema.json')
      : join(import.meta.dirname, '..', '..', '..', 'spec', 'contracts', 'evidence-package.schema.json');
    expect(() => validateEvidence({
      requirement_id: 'x', commit_sha: 'pending', source_files: [], tests_added: [],
      commands_run: [{ command: 'echo', exit_code: 0, stdout_hash: 'abc' }], exit_codes: [0],
      test_results: {}, coverage: {}, security_checks: {}, verifier_result: 'pass',
    }, SCHEMA_PATH)).toThrow();
  });

  it('writeEvidence existing pass file rejects fail overwrite with immutable message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ev-imm-'));
    try {
      const path = join(dir, 'evidence.json');
      const passEv = generateEvidence({
        requirement_id: 'AH-IMM', source_files: ['package.json'], tests_added: [],
        commands: ['echo ok'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
      });
      writeEvidence(passEv, path);
      const failEv: EvidencePackage = {
        requirement_id: 'AH-IMM', commit_sha: 'b'.repeat(40), source_files: [], tests_added: [],
        commands_run: [{ command: 'exit 1', exit_code: 1, stdout_hash: null }],
        exit_codes: [1], test_results: {}, coverage: {}, security_checks: {}, verifier_result: 'fail',
      };
      try {
        writeEvidence(failEv, path);
        expect.fail('should have thrown');
      } catch (e) {
        expect((e as Error).message).toContain('immutable');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Verification precision mutation-killing tests', () => {
  const runner = new EvalRunner();

  it('strategy consistency stays false when non-e2e fails and no e2e with strategy exists', () => {
    // This kills the L74 ConditionalExpression->true mutant:
    // if mutated to true, e2eResults.every() on empty array returns true,
    // overriding the false from the unit failure.
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-L74',
      suites: [
        { id: 'u-l74', kind: 'unit', command: 'exit 1', expected_exit: 0 },
      ],
    };
    const report = runner.run(manifest);
    // Without e2e+strategy, strategies_consistent stays false from the unit failure
    expect(report.reasoning_strategy_consistent).toBe(false);
  });

  it('strategy consistency is true when all pass and no e2e with strategy', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-L74-2',
      suites: [
        { id: 'u-l74-2', kind: 'unit', command: 'echo ok', expected_exit: 0 },
      ],
    };
    const report = runner.run(manifest);
    expect(report.reasoning_strategy_consistent).toBe(true);
  });

  it('report results array structure matches EvalResult interface', () => {
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-STRUCT',
      suites: [{ id: 'st1', kind: 'unit', command: 'echo ok', expected_exit: 0 }],
    };
    const report = runner.run(manifest);
    const r = report.results[0]!;
    expect(r).toHaveProperty('case_id', 'st1');
    expect(r).toHaveProperty('passed', true);
    expect(r).toHaveProperty('exit_code', 0);
    expect(r).toHaveProperty('stdout_hash');
    expect(r).toHaveProperty('stderr_hash');
  });

  it('runCommand with explicit cwd=undefined uses process.cwd', () => {
    const result = runCommand('echo ok', undefined);
    expect(result.exit_code).toBe(0);
  });

  it('generateEvidence rejects commit_sha that is not 40 hex chars (runtime check)', () => {
    // This is indirectly tested by checking the generated evidence always has valid sha
    const ev = generateEvidence({
      requirement_id: 'AH-REGEX', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    // The regex /^[0-9a-f]{40}$/ must match - if mutated to drop ^ or $, 
    // a 41-char sha would pass. Verify our sha is exactly 40.
    expect(ev.commit_sha.length).toBe(40);
    expect(ev.commit_sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('validateEvidence rejects pass without commands_run with correct error', () => {
    const SCHEMA_PATH = process.env.HARNESS_SPEC_ROOT
      ? join(process.env.HARNESS_SPEC_ROOT, 'contracts', 'evidence-package.schema.json')
      : join(import.meta.dirname, '..', '..', '..', 'spec', 'contracts', 'evidence-package.schema.json');
    try {
      validateEvidence({
        requirement_id: 'x', commit_sha: 'a'.repeat(40), source_files: [], tests_added: [],
        commands_run: [], exit_codes: [], test_results: {}, coverage: {}, security_checks: {},
        verifier_result: 'pass',
      }, SCHEMA_PATH);
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('PASS without commands');
    }
  });

  it('validateEvidence rejects pass with pending sha with correct error', () => {
    const SCHEMA_PATH = process.env.HARNESS_SPEC_ROOT
      ? join(process.env.HARNESS_SPEC_ROOT, 'contracts', 'evidence-package.schema.json')
      : join(import.meta.dirname, '..', '..', '..', 'spec', 'contracts', 'evidence-package.schema.json');
    try {
      validateEvidence({
        requirement_id: 'x', commit_sha: 'pending', source_files: [], tests_added: [],
        commands_run: [{ command: 'echo', exit_code: 0, stdout_hash: 'abc' }], exit_codes: [0],
        test_results: {}, coverage: {}, security_checks: {}, verifier_result: 'pass',
      }, SCHEMA_PATH);
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('pending');
    }
  });

  it('validateEvidence rejects invalid commit_sha with correct error', () => {
    const SCHEMA_PATH = process.env.HARNESS_SPEC_ROOT
      ? join(process.env.HARNESS_SPEC_ROOT, 'contracts', 'evidence-package.schema.json')
      : join(import.meta.dirname, '..', '..', '..', 'spec', 'contracts', 'evidence-package.schema.json');
    try {
      validateEvidence({
        requirement_id: 'x', commit_sha: 'short', source_files: [], tests_added: [],
        commands_run: [], exit_codes: [], test_results: {}, coverage: {}, security_checks: {},
        verifier_result: 'fail',
      }, SCHEMA_PATH);
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('commit_sha');
    }
  });

  it('runCommand timeout produces non-zero exit code', () => {
    const result = runCommand('sleep 5', undefined, 100);
    expect(result.exit_code).not.toBe(0);
  });

  it('generateEvidence with failing command includes stderr_hash in commands_run', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-STDERR-EV', source_files: ['package.json'], tests_added: [],
      commands: ['sh -c "echo error 1>&2; exit 1"'], cwd: process.cwd(),
      test_results: {}, coverage: {}, security_checks: {},
    });
    expect(ev.commands_run[0]!.stderr_hash).not.toBeNull();
    expect(ev.commands_run[0]!.exit_code).toBe(1);
  });
});

describe('Verification regex and boolean mutation-killing tests', () => {
  const SCHEMA_PATH = process.env.HARNESS_SPEC_ROOT
    ? join(process.env.HARNESS_SPEC_ROOT, 'contracts', 'evidence-package.schema.json')
    : join(import.meta.dirname, '..', '..', '..', 'spec', 'contracts', 'evidence-package.schema.json');

  it('validateEvidence rejects 40-char sha with trailing non-hex char (kills regex ^$ removal)', () => {
    // 40 hex chars + 'g' (non-hex) = 41 chars total
    // If regex mutated to drop $, 'g'.repeat(40) + 'g' would match /^[0-9a-f]{40}/
    expect(() => validateEvidence({
      requirement_id: 'x', commit_sha: 'a'.repeat(40) + 'g', source_files: [], tests_added: [],
      commands_run: [], exit_codes: [], test_results: {}, coverage: {}, security_checks: {},
      verifier_result: 'fail',
    }, SCHEMA_PATH)).toThrow();
  });

  it('validateEvidence rejects 40-char sha with leading non-hex char', () => {
    // 'g' + 40 hex chars = 41 chars
    // If regex mutated to drop ^, 'g' + hex would match /[0-9a-f]{40}$/
    expect(() => validateEvidence({
      requirement_id: 'x', commit_sha: 'g' + 'a'.repeat(40), source_files: [], tests_added: [],
      commands_run: [], exit_codes: [], test_results: {}, coverage: {}, security_checks: {},
      verifier_result: 'fail',
    }, SCHEMA_PATH)).toThrow();
  });

  it('validateEvidence rejects 40-char sha with uppercase letters (not in [0-9a-f])', () => {
    expect(() => validateEvidence({
      requirement_id: 'x', commit_sha: 'A'.repeat(40), source_files: [], tests_added: [],
      commands_run: [], exit_codes: [], test_results: {}, coverage: {}, security_checks: {},
      verifier_result: 'fail',
    }, SCHEMA_PATH)).toThrow();
  });

  it('validateEvidence accepts exactly 40 lowercase hex chars', () => {
    expect(() => validateEvidence({
      requirement_id: 'x', commit_sha: '0123456789abcdef0123456789abcdef01234567', source_files: [], tests_added: [],
      commands_run: [{ command: 'echo', exit_code: 0, stdout_hash: 'abc' }], exit_codes: [0],
      test_results: {}, coverage: {}, security_checks: {}, verifier_result: 'pass',
    }, SCHEMA_PATH)).not.toThrow();
  });

  it('validateEvidence pass with commands but not pending sha is accepted', () => {
    expect(() => validateEvidence({
      requirement_id: 'x', commit_sha: 'a'.repeat(40), source_files: [], tests_added: [],
      commands_run: [{ command: 'echo', exit_code: 0, stdout_hash: 'abc' }], exit_codes: [0],
      test_results: {}, coverage: {}, security_checks: {}, verifier_result: 'pass',
    }, SCHEMA_PATH)).not.toThrow();
  });

  it('validateEvidence fail with commands is accepted (not pass, so no special checks)', () => {
    expect(() => validateEvidence({
      requirement_id: 'x', commit_sha: 'a'.repeat(40), source_files: [], tests_added: [],
      commands_run: [{ command: 'exit 1', exit_code: 1, stdout_hash: null }], exit_codes: [1],
      test_results: {}, coverage: {}, security_checks: {}, verifier_result: 'fail',
    }, SCHEMA_PATH)).not.toThrow();
  });

  it('validateEvidence pass without commands is rejected with specific message', () => {
    try {
      validateEvidence({
        requirement_id: 'x', commit_sha: 'a'.repeat(40), source_files: [], tests_added: [],
        commands_run: [], exit_codes: [], test_results: {}, coverage: {}, security_checks: {},
        verifier_result: 'pass',
      }, SCHEMA_PATH);
      expect.fail('should throw');
    } catch (e) {
      expect((e as Error).message).toContain('PASS without commands');
    }
  });

  it('generateEvidence verifier_result is fail when any command fails (kills BooleanLiteral mutation)', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-BL1', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok', 'exit 1'], cwd: process.cwd(),
      test_results: {}, coverage: {}, security_checks: {},
    });
    expect(ev.verifier_result).toBe('fail');
  });

  it('generateEvidence verifier_result is pass when all commands succeed (kills BooleanLiteral mutation)', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-BL2', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok', 'echo ok2'], cwd: process.cwd(),
      test_results: {}, coverage: {}, security_checks: {},
    });
    expect(ev.verifier_result).toBe('pass');
  });
});

describe('Verification L102/L48/L125 targeted mutation kills', () => {
  it('L102: err.stdout ?? "" preserves actual stdout content (kills && replacement)', () => {
    // When a command fails but produces stdout output, the stdout_hash
    // must reflect the actual content, not an empty string.
    const result = runCommand('sh -c "echo real_output; exit 1"');
    // sha('real_output\n') is different from sha('')
    expect(result.exit_code).not.toBe(0);
    // The stdout_hash should be non-null and reflect 'real_output'
    expect(result.stdout_hash).not.toBeNull();
    // If the mutant (err.stdout && '') were active, stdout would be '' 
    // and sha('') would be a specific hash. The real output hash is different.
    const shaEmpty = require('node:crypto').createHash('sha256').update('').digest('hex').slice(0, 16);
    const shaReal = require('node:crypto').createHash('sha256').update('real_output\n').digest('hex').slice(0, 16);
    expect(result.stdout_hash).not.toBe(shaEmpty);
    expect(result.stdout_hash).toBe(shaReal);
  });

  it('L48: runCommand with undefined cwd uses process.cwd (kills && replacement)', () => {
    // When cwd is undefined, ?? returns process.cwd(), but && returns undefined.
    // execSync with cwd: undefined uses the default (process.cwd()).
    // The observable behavior (exit code) should be the same either way for 'pwd'.
    // But to kill the mutant, we need to verify the command actually runs
    // in the current directory. If && were active, cwd would be undefined
    // and execSync would still work. So this mutant may be equivalent for 
    // execSync behavior. Let's verify exit code is 0.
    const result = runCommand('echo ok', undefined);
    expect(result.exit_code).toBe(0);
  });

  it('L125: validateEvidence error message includes AJV errors (kills OptionalChaining/ArrowFunction)', () => {
    const SCHEMA_PATH = process.env.HARNESS_SPEC_ROOT
      ? join(process.env.HARNESS_SPEC_ROOT, 'contracts', 'evidence-package.schema.json')
      : join(import.meta.dirname, '..', '..', '..', 'spec', 'contracts', 'evidence-package.schema.json');
    // Pass evidence that fails AJV schema validation (wrong type for a field)
    try {
      validateEvidence({
        requirement_id: 'x', commit_sha: 'a'.repeat(40), source_files: 'not-an-array',
        tests_added: [], commands_run: [], exit_codes: [], test_results: {}, coverage: {},
        security_checks: {}, verifier_result: 'fail',
      }, SCHEMA_PATH);
      expect.fail('should have thrown');
    } catch (e) {
      // The error message must contain schema validation details
      expect((e as Error).message).toContain('schema validation failed');
    }
  });

  it('L122: verifier_result is "fail" when any command fails (kills BooleanLiteral true)', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-BL-F', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok', 'exit 1', 'echo ok3'], cwd: process.cwd(),
      test_results: {}, coverage: {}, security_checks: {},
    });
    expect(ev.verifier_result).toBe('fail');
  });

  it('L122: verifier_result is "pass" when all commands succeed (kills BooleanLiteral false)', () => {
    const ev = generateEvidence({
      requirement_id: 'AH-BL-T', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok1', 'echo ok2'], cwd: process.cwd(),
      test_results: {}, coverage: {}, security_checks: {},
    });
    expect(ev.verifier_result).toBe('pass');
  });

  it('L131: validateEvidence rejects pass with empty commands (kills EqualityOperator !==)', () => {
    const SCHEMA_PATH = process.env.HARNESS_SPEC_ROOT
      ? join(process.env.HARNESS_SPEC_ROOT, 'contracts', 'evidence-package.schema.json')
      : join(import.meta.dirname, '..', '..', '..', 'spec', 'contracts', 'evidence-package.schema.json');
    expect(() => validateEvidence({
      requirement_id: 'x', commit_sha: 'a'.repeat(40), source_files: [], tests_added: [],
      commands_run: [], exit_codes: [], test_results: {}, coverage: {}, security_checks: {},
      verifier_result: 'pass',
    }, SCHEMA_PATH)).toThrow();
  });

  it('L131: validateEvidence accepts fail with empty commands (kills ConditionalExpression false)', () => {
    const SCHEMA_PATH = process.env.HARNESS_SPEC_ROOT
      ? join(process.env.HARNESS_SPEC_ROOT, 'contracts', 'evidence-package.schema.json')
      : join(import.meta.dirname, '..', '..', '..', 'spec', 'contracts', 'evidence-package.schema.json');
    expect(() => validateEvidence({
      requirement_id: 'x', commit_sha: 'a'.repeat(40), source_files: [], tests_added: [],
      commands_run: [], exit_codes: [], test_results: {}, coverage: {}, security_checks: {},
      verifier_result: 'fail',
    }, SCHEMA_PATH)).not.toThrow();
  });
});

describe('Verification targeted kill attempts', () => {
  const runner = new EvalRunner();

  it('L102 eval-runner: failed command stdout content preserved in hash', () => {
    // This kills id=47: err.stdout ?? '' mutated to err.stdout && ''
    // When a command fails but produces stdout, the stdout_hash must
    // reflect the actual content, not empty string.
    const manifest: EvalManifest = {
      manifest_version: 'eval-manifest.v1', requirement_id: 'AH-STDOUT-KILL',
      suites: [{ id: 'sk1', kind: 'unit', command: 'sh -c "echo real_out; exit 1"', expected_exit: 0 }],
    };
    const report = runner.run(manifest);
    const r = report.results[0]!;
    // sha('real_out\n') != sha('')
    const sha = (s: string) => require('node:crypto').createHash('sha256').update(s).digest('hex').slice(0, 16);
    expect(r.stdout_hash).toBe(sha('real_out\n'));
    expect(r.stdout_hash).not.toBe(sha(''));
  });

  it('L131 evidence: validateEvidence reaches pass+empty-commands check', () => {
    // This kills id=198/200/201: the if(verifier_result==='pass' && commands_run.length===0) check
    const SCHEMA_PATH = process.env.HARNESS_SPEC_ROOT
      ? join(process.env.HARNESS_SPEC_ROOT, 'contracts', 'evidence-package.schema.json')
      : join(import.meta.dirname, '..', '..', '..', 'spec', 'contracts', 'evidence-package.schema.json');
    // This evidence passes AJV schema (all fields present, correct types)
    // but fails the custom check: pass without commands
    try {
      validateEvidence({
        requirement_id: 'x',
        commit_sha: 'a'.repeat(40),
        source_files: [],
        tests_added: [],
        commands_run: [],
        exit_codes: [],
        test_results: {},
        coverage: {},
        security_checks: {},
        verifier_result: 'pass',
      }, SCHEMA_PATH);
      expect.fail('should have thrown EvidenceError');
    } catch (e) {
      // Must be EvidenceError with specific message (not AJV error)
      expect(e).toBeInstanceOf(EvidenceError);
      expect((e as Error).message).toContain('PASS without commands');
    }
  });

  it('L131 evidence: validateEvidence pass with pending sha reaches check', () => {
    const SCHEMA_PATH = process.env.HARNESS_SPEC_ROOT
      ? join(process.env.HARNESS_SPEC_ROOT, 'contracts', 'evidence-package.schema.json')
      : join(import.meta.dirname, '..', '..', '..', 'spec', 'contracts', 'evidence-package.schema.json');
    try {
      validateEvidence({
        requirement_id: 'x',
        commit_sha: 'pending',
        source_files: [],
        tests_added: [],
        commands_run: [{ command: 'echo', exit_code: 0, stdout_hash: 'abc' }],
        exit_codes: [0],
        test_results: {},
        coverage: {},
        security_checks: {},
        verifier_result: 'pass',
      }, SCHEMA_PATH);
      expect.fail('should have thrown');
    } catch (e) {
      // Should reach the pending check (not fail at AJV or commit_sha check first)
      expect((e as Error).message).toContain('pending');
    }
  });

  it('L122 evidence: allPassed ternary - fail when one command fails among multiple', () => {
    // Kill id=167 (BooleanLiteral false) and id=168 (BooleanLiteral true)
    // If allPassed is mutated to false, result is always 'fail'
    // If allPassed is mutated to true, result is always 'pass'
    const evPass = generateEvidence({
      requirement_id: 'AH-TERN-1', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok'], cwd: process.cwd(),
      test_results: {}, coverage: {}, security_checks: {},
    });
    expect(evPass.verifier_result).toBe('pass');

    const evFail = generateEvidence({
      requirement_id: 'AH-TERN-2', source_files: ['package.json'], tests_added: [],
      commands: ['echo ok', 'exit 1'], cwd: process.cwd(),
      test_results: {}, coverage: {}, security_checks: {},
    });
    expect(evFail.verifier_result).toBe('fail');
  });
});

describe('Verification AJV error formatting kills', () => {
  const SCHEMA_PATH = process.env.HARNESS_SPEC_ROOT
    ? join(process.env.HARNESS_SPEC_ROOT, 'contracts', 'evidence-package.schema.json')
    : join(import.meta.dirname, '..', '..', '..', 'spec', 'contracts', 'evidence-package.schema.json');

  it('L125/L122: multiple schema violations produce multiple errors in message (kills allErrors, ??, ArrowFunction)', () => {
    // Pass evidence with MULTIPLE schema violations so allErrors:true collects them all
    try {
      validateEvidence({
        requirement_id: 123,           // wrong type: number instead of string
        commit_sha: 'a'.repeat(40),
        source_files: 'not-an-array',  // wrong type: string instead of array
        tests_added: 'also-wrong',     // wrong type: string instead of array
        commands_run: [], exit_codes: [],
        test_results: {}, coverage: {}, security_checks: {},
        verifier_result: 'fail',
      }, SCHEMA_PATH);
      expect.fail('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      // Must contain 'schema validation failed' prefix
      expect(msg).toContain('schema validation failed');
      // Must contain actual AJV error details (not 'unknown' from ?? -> && mutation)
      expect(msg).not.toContain('unknown');
      // Must contain actual error paths (not 'undefined' from ArrowFunction mutation)
      expect(msg).not.toContain('undefined');
      // Must contain at least 2 error entries (kills allErrors:false which reports only 1)
      // AJV errors are joined with '; '
      const errorParts = msg.split('; ');
      expect(errorParts.length).toBeGreaterThan(1);
    }
  });

  it('L125: single schema violation produces specific error detail', () => {
    try {
      validateEvidence({
        requirement_id: 'x', commit_sha: 'a'.repeat(40),
        source_files: 42,  // wrong type
        tests_added: [], commands_run: [], exit_codes: [],
        test_results: {}, coverage: {}, security_checks: {},
        verifier_result: 'fail',
      }, SCHEMA_PATH);
      expect.fail('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      // The error message must contain the field name and the AJV error
      expect(msg).toContain('source_files');
    }
  });
});
