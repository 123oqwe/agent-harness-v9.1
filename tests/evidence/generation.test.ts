import { describe, it, expect, afterEach } from 'vitest';
import { generateEvidence, writeEvidence, validateEvidence, runCommand, EvidenceError } from '../../verification/evidence.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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
      tests_added: ['tests/x.test.ts'],
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
    expect(() => validateEvidence(bad, '../spec/contracts/evidence-package.schema.json')).toThrow(EvidenceError);
  });

  it('runCommand captures real exit code and output hash', () => {
    const r = runCommand('echo hello');
    expect(r.exit_code).toBe(0);
    expect(r.stdout_hash).toMatch(/^[0-9a-f]{16}$/);
  });
});
