import { describe, it, expect, afterEach } from 'vitest';
import { generateEvidence, writeEvidence, validateEvidence, runCommand, EvidenceError } from '../../verification/evidence.js';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('AH-EVIDENCE-001 evidence generation', () => {
  let dir: string;
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('generates evidence from actual command output', () => {
    dir = mkdtempSync(join(tmpdir(), 'ev-'));
    const ev = generateEvidence({
      requirement_id: 'AH-TEST-001',
      source_files: ['package.json'],
      tests_added: [],
      commands: ['echo hello'],
      cwd: process.cwd(),
      test_results: { total: 1, passed: 1 },
      coverage: { lines: 100 },
      security_checks: { none: true },
    });
    expect(ev.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(ev.commands_run).toHaveLength(1);
    expect(ev.commands_run[0]!.exit_code).toBe(0);
    expect(ev.verifier_result).toBe('pass');
  });

  it('includes commit_sha, source_files, tests_added, commands_run, exit_codes, test_results, coverage, security_checks', () => {
    dir = mkdtempSync(join(tmpdir(), 'ev-'));
    const ev = generateEvidence({
      requirement_id: 'AH-TEST-002',
      source_files: ['package.json'],
      tests_added: ['tests/evidence/generation.test.ts'],
      commands: ['echo ok'],
      cwd: process.cwd(),
      test_results: {},
      coverage: {},
      security_checks: {},
    });
    expect(ev.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(ev.source_files).toBeDefined();
    expect(ev.tests_added).toBeDefined();
    expect(ev.commands_run).toBeDefined();
    expect(ev.exit_codes).toBeDefined();
    expect(ev.test_results).toBeDefined();
    expect(ev.coverage).toBeDefined();
    expect(ev.security_checks).toBeDefined();
  });

  it('self-reported PASS without evidence forbidden (no commands)', () => {
    dir = mkdtempSync(join(tmpdir(), 'ev-'));
    expect(() => generateEvidence({
      requirement_id: 'AH-TEST-003',
      source_files: [], tests_added: [], commands: [],
      cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    })).toThrow(EvidenceError);
  });

  it('verifier_result is fail when any command fails', () => {
    dir = mkdtempSync(join(tmpdir(), 'ev-'));
    const ev = generateEvidence({
      requirement_id: 'AH-TEST-004',
      source_files: [], tests_added: [],
      commands: ['exit 1'],
      cwd: process.cwd(),
      test_results: {}, coverage: {}, security_checks: {},
    });
    expect(ev.verifier_result).toBe('fail');
    expect(ev.exit_codes).toContain(1);
  });

  it('evidence is immutable once generated (pass cannot be downgraded)', () => {
    dir = mkdtempSync(join(tmpdir(), 'ev-'));
    const ev1 = generateEvidence({
      requirement_id: 'AH-TEST-005', source_files: [], tests_added: [],
      commands: ['echo ok'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
    });
    const path = join(dir, 'ev.json');
    writeEvidence(ev1, path);
    expect(existsSync(path)).toBe(true);
    // writing a fail evidence over a pass is forbidden
    const ev2 = { ...ev1, verifier_result: 'fail' as const };
    expect(() => writeEvidence(ev2, path)).toThrow(EvidenceError);
  });

  it('validateEvidence rejects pending commit_sha on pass', () => {
    const bad = {
      requirement_id: 'x', commit_sha: 'pending', source_files: [], tests_added: [],
      commands_run: [{ command: 'x', exit_code: 0, stdout_hash: 'x' }], exit_codes: [0],
      test_results: {}, coverage: {}, security_checks: {}, verifier_result: 'pass' as const,
    };
    expect(() => validateEvidence(bad, join(process.env.HARNESS_SPEC_ROOT ?? join(process.cwd(), '..', 'spec'), 'contracts', 'evidence-package.schema.json'))).toThrow(EvidenceError);
  });

  it('runCommand captures real exit code and output hash', () => {
    const r = runCommand('echo hello');
    expect(r.exit_code).toBe(0);
    expect(r.stdout_hash).toMatch(/^[0-9a-f]{16}$/);
  });


  it('validateEvidence uses AJV against evidence-package.schema.json', () => {
    // A valid evidence package should pass AJV validation
    const valid = {
      requirement_id: 'AH-TEST-006',
      commit_sha: 'a'.repeat(40),
      source_files: ['package.json'],
      tests_added: [],
      commands_run: [{ command: 'echo ok', exit_code: 0, stdout_hash: 'abc123' }],
      exit_codes: [0],
      test_results: { total: 1, passed: 1 },
      coverage: { lines: 100 },
      security_checks: { none: true },
      verifier_result: 'pass' as const,
    };
    expect(() => validateEvidence(valid, join(process.env.HARNESS_SPEC_ROOT ?? join(process.cwd(), '..', 'spec'), 'contracts', 'evidence-package.schema.json'))).not.toThrow();
  });

  it('validateEvidence rejects evidence missing required fields via AJV', () => {
    const invalid = {
      requirement_id: 'AH-TEST-007',
      // missing commit_sha, source_files, etc.
    };
    expect(() => validateEvidence(invalid, join(process.env.HARNESS_SPEC_ROOT ?? join(process.cwd(), '..', 'spec'), 'contracts', 'evidence-package.schema.json'))).toThrow(EvidenceError);
  });

  it('generateEvidence fails when declared source_files do not exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'ev-'));
    expect(() => generateEvidence({
      requirement_id: 'AH-TEST-008',
      source_files: ['nonexistent-file.ts'],
      tests_added: [],
      commands: ['echo ok'],
      cwd: process.cwd(),
      test_results: {}, coverage: {}, security_checks: {},
    })).toThrow(EvidenceError);
  });

  it('generateEvidence fails when declared tests_added do not exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'ev-'));
    expect(() => generateEvidence({
      requirement_id: 'AH-TEST-009',
      source_files: [],
      tests_added: ['nonexistent-test.test.ts'],
      commands: ['echo ok'],
      cwd: process.cwd(),
      test_results: {}, coverage: {}, security_checks: {},
    })).toThrow(EvidenceError);
  });



  describe('mutation-killing: evidence edge cases', () => {
    it('runCommand captures non-zero exit code and stderr hash', () => {
      const r = runCommand('echo err >&2; exit 42');
      expect(r.exit_code).toBe(42);
      expect(r.stderr_hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('runCommand with stderr output captures stderr hash', () => {
      const r = runCommand('echo "error" >&2; exit 1');
      expect(r.exit_code).toBe(1);
      expect(r.stderr_hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('generateEvidence uses provided cwd parameter', () => {
      dir = mkdtempSync(join(tmpdir(), 'ev-cwd-'));
      const ev = generateEvidence({
        requirement_id: 'AH-CWD-001',
        source_files: [],
        tests_added: [],
        commands: ['echo ok'],
        cwd: dir,
        test_results: {}, coverage: {}, security_checks: {},
      });
      expect(ev.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    });

    it('generateEvidence allPassed is false when any command fails', () => {
      dir = mkdtempSync(join(tmpdir(), 'ev-fail-'));
      const ev = generateEvidence({
        requirement_id: 'AH-FAIL-001',
        source_files: [], tests_added: [],
        commands: ['echo ok', 'exit 1'],
        cwd: process.cwd(),
        test_results: {}, coverage: {}, security_checks: {},
      });
      expect(ev.verifier_result).toBe('fail');
      expect(ev.exit_codes).toContain(1);
    });

    it('generateEvidence verifier_model defaults to independent rerun string', () => {
      dir = mkdtempSync(join(tmpdir(), 'ev-model-'));
      const ev = generateEvidence({
        requirement_id: 'AH-MODEL-001',
        source_files: [], tests_added: [],
        commands: ['echo ok'],
        cwd: process.cwd(),
        test_results: {}, coverage: {}, security_checks: {},
      });
      expect(ev.verifier_model).toContain('independent');
    });

    it('generateEvidence with custom verifier_model', () => {
      dir = mkdtempSync(join(tmpdir(), 'ev-vm-'));
      const ev = generateEvidence({
        requirement_id: 'AH-VM-001',
        source_files: [], tests_added: [],
        commands: ['echo ok'],
        cwd: process.cwd(),
        test_results: {}, coverage: {}, security_checks: {},
        verifier_model: 'custom-verifier-v1',
      });
      expect(ev.verifier_model).toBe('custom-verifier-v1');
    });

    it('writeEvidence allows writing fail over pass then pass over fail', () => {
      dir = mkdtempSync(join(tmpdir(), 'ev-upgrade-'));
      const ev1 = generateEvidence({
        requirement_id: 'AH-UP-001', source_files: [], tests_added: [],
        commands: ['exit 1'], cwd: process.cwd(), test_results: {}, coverage: {}, security_checks: {},
      });
      const path = join(dir, 'ev.json');
      writeEvidence(ev1, path);
      // Writing pass over fail should be allowed (upgrading)
      const ev2 = { ...ev1, verifier_result: 'pass' as const, exit_codes: [0], commands_run: [{ command: 'echo ok', exit_code: 0, stdout_hash: 'abc' }] };
      writeEvidence(ev2, path);
      const read = JSON.parse(readFileSync(path, 'utf8')) as { verifier_result: string };
      expect(read.verifier_result).toBe('pass');
    });

    it('validateEvidence rejects non-40-char commit_sha', () => {
      const bad = {
        requirement_id: 'x', commit_sha: 'short', source_files: [], tests_added: [],
        commands_run: [{ command: 'x', exit_code: 0, stdout_hash: 'x' }], exit_codes: [0],
        test_results: {}, coverage: {}, security_checks: {}, verifier_result: 'fail' as const,
      };
      expect(() => validateEvidence(bad, join(process.env.HARNESS_SPEC_ROOT ?? join(process.cwd(), '..', 'spec'), 'contracts', 'evidence-package.schema.json'))).toThrow(EvidenceError);
    });

    it('validateEvidence passes with fail and no commands', () => {
      const ok = {
        requirement_id: 'x', commit_sha: 'a'.repeat(40), source_files: [], tests_added: [],
        commands_run: [], exit_codes: [],
        test_results: {}, coverage: {}, security_checks: {}, verifier_result: 'fail' as const,
      };
      expect(() => validateEvidence(ok, join(process.env.HARNESS_SPEC_ROOT ?? join(process.cwd(), '..', 'spec'), 'contracts', 'evidence-package.schema.json'))).not.toThrow();
    });
  });

});
