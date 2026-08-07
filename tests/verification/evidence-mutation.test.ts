import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeSelfHash,
  verifyHashChain,
  generateEvidence,
  writeEvidence,
  validateEvidence,
  runCommand,
  EvidenceError,
  type EvidencePackage,
  type CommandSpec,
} from '../../verification/evidence.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'evidence-mut-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('computeSelfHash', () => {
  it('produces a 16-char hex string', () => {
    const evidence = {
      requirement_id: 'AH-TEST-001',
      commit_sha: 'a'.repeat(40),
      source_files: [],
      tests_added: [],
      commands_run: [],
      exit_codes: [],
      test_results: {},
      coverage: {},
      security_checks: {},
      verifier_result: 'pass' as const,
      verifier_model: 'test',
      test_output: null,
      test_output_hash: null,
    };
    const hash = computeSelfHash(evidence);
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('excludes self_hash from the hash computation', () => {
    const base = {
      requirement_id: 'AH-TEST-001',
      commit_sha: 'a'.repeat(40),
      source_files: [],
      tests_added: [],
      commands_run: [],
      exit_codes: [],
      test_results: {},
      coverage: {},
      security_checks: {},
      verifier_result: 'pass' as const,
      verifier_model: 'test',
      test_output: null,
      test_output_hash: null,
    };
    const hash1 = computeSelfHash({ ...base, self_hash: 'abc' } as any);
    const hash2 = computeSelfHash({ ...base, self_hash: 'xyz' } as any);
    expect(hash1).toBe(hash2);
  });

  it('includes prev_hash in the hash computation', () => {
    const base = {
      requirement_id: 'AH-TEST-001',
      commit_sha: 'a'.repeat(40),
      source_files: [],
      tests_added: [],
      commands_run: [],
      exit_codes: [],
      test_results: {},
      coverage: {},
      security_checks: {},
      verifier_result: 'pass' as const,
      verifier_model: 'test',
      test_output: null,
      test_output_hash: null,
    };
    const hash1 = computeSelfHash({ ...base, prev_hash: null } as any);
    const hash2 = computeSelfHash({ ...base, prev_hash: 'prev123' } as any);
    expect(hash1).not.toBe(hash2);
  });

  it('produces different hashes for different requirement_ids', () => {
    const base = {
      commit_sha: 'a'.repeat(40),
      source_files: [],
      tests_added: [],
      commands_run: [],
      exit_codes: [],
      test_results: {},
      coverage: {},
      security_checks: {},
      verifier_result: 'pass' as const,
      verifier_model: 'test',
      test_output: null,
      test_output_hash: null,
    };
    const hash1 = computeSelfHash({ ...base, requirement_id: 'AH-A-001' } as any);
    const hash2 = computeSelfHash({ ...base, requirement_id: 'AH-B-001' } as any);
    expect(hash1).not.toBe(hash2);
  });

  it('produces different hashes for different commit_shas', () => {
    const base = {
      requirement_id: 'AH-TEST-001',
      source_files: [],
      tests_added: [],
      commands_run: [],
      exit_codes: [],
      test_results: {},
      coverage: {},
      security_checks: {},
      verifier_result: 'pass' as const,
      verifier_model: 'test',
      test_output: null,
      test_output_hash: null,
    };
    const hash1 = computeSelfHash({ ...base, commit_sha: 'a'.repeat(40) } as any);
    const hash2 = computeSelfHash({ ...base, commit_sha: 'b'.repeat(40) } as any);
    expect(hash1).not.toBe(hash2);
  });
});

describe('verifyHashChain', () => {
  it('returns true for legacy packages without self_hash (undefined)', () => {
    const evidence = {
      requirement_id: 'AH-TEST-001',
      commit_sha: 'a'.repeat(40),
      source_files: [],
      tests_added: [],
      commands_run: [],
      exit_codes: [],
      test_results: {},
      coverage: {},
      security_checks: {},
      verifier_result: 'pass' as const,
      verifier_model: 'test',
      test_output: null,
      test_output_hash: null,
    };
    expect(verifyHashChain(evidence as any)).toBe(true);
  });

  it('returns true for legacy packages with self_hash null', () => {
    const evidence = {
      requirement_id: 'AH-TEST-001',
      commit_sha: 'a'.repeat(40),
      source_files: [],
      tests_added: [],
      commands_run: [],
      exit_codes: [],
      test_results: {},
      coverage: {},
      security_checks: {},
      verifier_result: 'pass' as const,
      verifier_model: 'test',
      test_output: null,
      test_output_hash: null,
      self_hash: null,
    };
    expect(verifyHashChain(evidence as any)).toBe(true);
  });

  it('returns true when self_hash matches recomputed hash', () => {
    const evidence = {
      requirement_id: 'AH-TEST-001',
      commit_sha: 'a'.repeat(40),
      source_files: [],
      tests_added: [],
      commands_run: [],
      exit_codes: [],
      test_results: {},
      coverage: {},
      security_checks: {},
      verifier_result: 'pass' as const,
      verifier_model: 'test',
      test_output: null,
      test_output_hash: null,
      prev_hash: null,
    } as any;
    evidence.self_hash = computeSelfHash(evidence);
    expect(verifyHashChain(evidence)).toBe(true);
  });

  it('returns false when self_hash does not match (tampered)', () => {
    const evidence = {
      requirement_id: 'AH-TEST-001',
      commit_sha: 'a'.repeat(40),
      source_files: [],
      tests_added: [],
      commands_run: [],
      exit_codes: [],
      test_results: {},
      coverage: {},
      security_checks: {},
      verifier_result: 'pass' as const,
      verifier_model: 'test',
      test_output: null,
      test_output_hash: null,
      prev_hash: null,
      self_hash: 'tampered1234567',
    } as any;
    expect(verifyHashChain(evidence)).toBe(false);
  });

  it('returns false when self_hash is present but requirement_id was changed after hashing', () => {
    const evidence = {
      requirement_id: 'AH-ORIGINAL-001',
      commit_sha: 'a'.repeat(40),
      source_files: [],
      tests_added: [],
      commands_run: [],
      exit_codes: [],
      test_results: {},
      coverage: {},
      security_checks: {},
      verifier_result: 'pass' as const,
      verifier_model: 'test',
      test_output: null,
      test_output_hash: null,
      prev_hash: null,
    } as any;
    evidence.self_hash = computeSelfHash(evidence);
    evidence.requirement_id = 'AH-TAMPERED-001';
    expect(verifyHashChain(evidence)).toBe(false);
  });
});

describe('writeEvidence hash chain', () => {
  it('sets prev_hash=null for first evidence file', () => {
    const evidence: EvidencePackage = {
      requirement_id: 'AH-TEST-001',
      commit_sha: 'a'.repeat(40),
      source_files: [],
      tests_added: [],
      commands_run: [{ command: '[]', argv: [], exit_code: 0, stdout_hash: null, stderr_hash: null }],
      exit_codes: [0],
      test_results: {},
      coverage: {},
      security_checks: {},
      verifier_result: 'pass',
      verifier_model: 'test',
      test_output: null,
      test_output_hash: null,
    } as any;
    const path = join(tempDir, 'evidence.json');
    writeEvidence(evidence, path);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.prev_hash).toBeNull();
    expect(written.self_hash).toBeDefined();
    expect(verifyHashChain(written)).toBe(true);
  });

  it('chains prev_hash to existing self_hash when replacing fail with pass', () => {
    const failedEvidence: EvidencePackage = {
      requirement_id: 'AH-TEST-001',
      commit_sha: 'a'.repeat(40),
      source_files: [],
      tests_added: [],
      commands_run: [{ command: '[]', argv: [], exit_code: 1, stdout_hash: null, stderr_hash: null }],
      exit_codes: [1],
      test_results: {},
      coverage: {},
      security_checks: {},
      verifier_result: 'fail',
      verifier_model: 'test',
      test_output: null,
      test_output_hash: null,
    } as any;
    const path = join(tempDir, 'evidence.json');
    writeEvidence(failedEvidence, path);
    const firstWritten = JSON.parse(readFileSync(path, 'utf8'));
    
    const passedEvidence: EvidencePackage = {
      ...failedEvidence,
      commands_run: [{ command: '[]', argv: [], exit_code: 0, stdout_hash: null, stderr_hash: null }],
      exit_codes: [0],
      verifier_result: 'pass',
    } as any;
    writeEvidence(passedEvidence, path);
    const secondWritten = JSON.parse(readFileSync(path, 'utf8'));
    expect(secondWritten.prev_hash).toBe(firstWritten.self_hash);
    expect(verifyHashChain(secondWritten)).toBe(true);
  });

  it('throws when trying to overwrite a pass evidence with another pass', () => {
    const passEvidence: EvidencePackage = {
      requirement_id: 'AH-TEST-001',
      commit_sha: 'a'.repeat(40),
      source_files: [],
      tests_added: [],
      commands_run: [{ command: '[]', argv: [], exit_code: 0, stdout_hash: null, stderr_hash: null }],
      exit_codes: [0],
      test_results: {},
      coverage: {},
      security_checks: {},
      verifier_result: 'pass',
      verifier_model: 'test',
      test_output: null,
      test_output_hash: null,
    } as any;
    const path = join(tempDir, 'evidence.json');
    writeEvidence(passEvidence, path);
    expect(() => writeEvidence(passEvidence, path)).toThrow(EvidenceError);
  });

  it('throws when trying to overwrite a pass evidence with a fail', () => {
    const passEvidence: EvidencePackage = {
      requirement_id: 'AH-TEST-001',
      commit_sha: 'a'.repeat(40),
      source_files: [],
      tests_added: [],
      commands_run: [{ command: '[]', argv: [], exit_code: 0, stdout_hash: null, stderr_hash: null }],
      exit_codes: [0],
      test_results: {},
      coverage: {},
      security_checks: {},
      verifier_result: 'pass',
      verifier_model: 'test',
      test_output: null,
      test_output_hash: null,
    } as any;
    const path = join(tempDir, 'evidence.json');
    writeEvidence(passEvidence, path);
    const failEvidence = { ...passEvidence, verifier_result: 'fail' as const, exit_codes: [1], commands_run: [{ command: '[]', argv: [], exit_code: 1, stdout_hash: null, stderr_hash: null }] };
    expect(() => writeEvidence(failEvidence as any, path)).toThrow(EvidenceError);
  });
});

describe('validateEvidence', () => {
  const validEvidence = {
    requirement_id: 'AH-TEST-001',
    commit_sha: 'a'.repeat(40),
    source_files: [],
    tests_added: [],
    commands_run: [{ command: '[]', argv: [], exit_code: 0, stdout_hash: null, stderr_hash: null }],
    exit_codes: [0],
    test_results: {},
    coverage: {},
    security_checks: {},
    verifier_result: 'pass',
    verifier_model: 'test',
    test_output: null,
    test_output_hash: null,
    prev_hash: null,
    self_hash: null,
  };

  it('throws when commit_sha is not 40 chars', () => {
    const bad = { ...validEvidence, commit_sha: 'short' };
    expect(() => validateEvidence(bad, join(process.cwd(), 'benchmarks/phase1/final-evidence.schema.json'))).toThrow(EvidenceError);
  });

  it('throws when commands_run is empty', () => {
    const bad = { ...validEvidence, commands_run: [], exit_codes: [] };
    expect(() => validateEvidence(bad, join(process.cwd(), 'benchmarks/phase1/final-evidence.schema.json'))).toThrow(EvidenceError);
  });

  it('throws when exit_codes length does not match commands_run length', () => {
    const bad = { ...validEvidence, exit_codes: [0, 0] };
    expect(() => validateEvidence(bad, join(process.cwd(), 'benchmarks/phase1/final-evidence.schema.json'))).toThrow(EvidenceError);
  });

  it('throws when verifier_result=pass but commands failed', () => {
    const bad = { ...validEvidence, verifier_result: 'pass', exit_codes: [1], commands_run: [{ command: '[]', argv: [], exit_code: 1, stdout_hash: null, stderr_hash: null }] };
    expect(() => validateEvidence(bad, join(process.cwd(), 'benchmarks/phase1/final-evidence.schema.json'))).toThrow(EvidenceError);
  });

  it('throws when verifier_result=fail but commands passed', () => {
    const bad = { ...validEvidence, verifier_result: 'fail' };
    expect(() => validateEvidence(bad, join(process.cwd(), 'benchmarks/phase1/final-evidence.schema.json'))).toThrow(EvidenceError);
  });

  it('throws when self_hash is present but does not match', () => {
    const bad = { ...validEvidence, self_hash: 'tampered1234567' };
    expect(() => validateEvidence(bad, join(process.cwd(), 'benchmarks/phase1/final-evidence.schema.json'))).toThrow(EvidenceError);
  });

  it('throws when self_hash is present but tampered (schema + hash check)', () => {
    const bad = { ...validEvidence, self_hash: 'tampered1234567' };
    expect(() => validateEvidence(bad, join(process.cwd(), 'benchmarks/phase1/final-evidence.schema.json'))).toThrow();
  });
});

describe('runCommand', () => {
  it('captures stdout hash for a successful command', () => {
    const result = runCommand({ argv: [process.execPath, '-e', 'process.stdout.write("hello")'] });
    expect(result.exit_code).toBe(0);
    expect(result.stdout_hash).not.toBeUndefined();
  });

  it('captures stderr hash for a failing command', () => {
    const result = runCommand({ argv: [process.execPath, '-e', 'process.stderr.write("err"); process.exit(1)'] });
    expect(result.exit_code).toBe(1);
    expect(result.stderr_hash).not.toBeNull();
  });

  it('returns exit_code 1 when command does not exist', () => {
    const result = runCommand({ argv: ['nonexistent-binary-xyz'] });
    expect(result.exit_code).not.toBe(0);
  });

  it('serializes argv in command field', () => {
    const result = runCommand({ argv: [process.execPath, '-e', 'process.exit(0)'] });
    expect(result.command).toContain(process.execPath);
    expect(result.argv).toEqual([process.execPath, '-e', 'process.exit(0)']);
  });

  it('throws on empty argv', () => {
    expect(() => runCommand({ argv: [] } as CommandSpec)).toThrow(EvidenceError);
  });

  it('throws on argv with empty string', () => {
    expect(() => runCommand({ argv: [''] })).toThrow(EvidenceError);
  });

  it('throws on non-string argv element', () => {
    expect(() => runCommand({ argv: [123 as any] })).toThrow(EvidenceError);
  });

  it('throws on invalid timeout_ms (zero)', () => {
    expect(() => runCommand({ argv: ['echo'], timeout_ms: 0 })).toThrow(EvidenceError);
  });

  it('throws on invalid timeout_ms (negative)', () => {
    expect(() => runCommand({ argv: ['echo'], timeout_ms: -1 })).toThrow(EvidenceError);
  });

  it('throws on invalid timeout_ms (float)', () => {
    expect(() => runCommand({ argv: ['echo'], timeout_ms: 1.5 })).toThrow(EvidenceError);
  });

  it('returns empty string stdout_hash when command produces no output', () => {
    const result = runCommand({ argv: [process.execPath, '-e', 'process.exit(0)'] });
    expect(result.exit_code).toBe(0);
    // sha of empty string is not null, it's a real hash
    expect(result.stdout_hash).not.toBeUndefined();
  });
});

describe('generateEvidence', () => {
  it('throws when commands list is empty (self-reported PASS forbidden)', () => {
    expect(() => generateEvidence({
      requirement_id: 'AH-TEST-001',
      source_files: ['verification/evidence.ts'],
      tests_added: [],
      commands: [],
      cwd: process.cwd(),
      test_results: {},
      coverage: {},
      security_checks: {},
    })).toThrow(EvidenceError);
  });

  it('throws when source_file does not exist', () => {
    expect(() => generateEvidence({
      requirement_id: 'AH-TEST-001',
      source_files: ['nonexistent.ts'],
      tests_added: [],
      commands: [{ argv: ['echo', 'hi'] }],
      cwd: process.cwd(),
      test_results: {},
      coverage: {},
      security_checks: {},
    })).toThrow(EvidenceError);
  });

  it('throws when tests_added file does not exist', () => {
    expect(() => generateEvidence({
      requirement_id: 'AH-TEST-001',
      source_files: ['verification/evidence.ts'],
      tests_added: ['tests/verification/truly-nonexistent-file.test.ts'],
      commands: [{ argv: ['echo', 'hi'] }],
      cwd: process.cwd(),
      test_results: {},
      coverage: {},
      security_checks: {},
    })).toThrow(EvidenceError);
  });

  it('sets verifier_result to fail when command exits non-zero', () => {
    const evidence = generateEvidence({
      requirement_id: 'AH-TEST-001',
      source_files: ['verification/evidence.ts'],
      tests_added: [],
      commands: [{ argv: [process.execPath, '-e', 'process.exit(1)'] }],
      cwd: process.cwd(),
      test_results: {},
      coverage: {},
      security_checks: {},
    });
    expect(evidence.verifier_result).toBe('fail');
  });

  it('sets verifier_result to pass when all commands exit 0', () => {
    const evidence = generateEvidence({
      requirement_id: 'AH-TEST-001',
      source_files: ['verification/evidence.ts'],
      tests_added: [],
      commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'] }],
      cwd: process.cwd(),
      test_results: {},
      coverage: {},
      security_checks: {},
    });
    expect(evidence.verifier_result).toBe('pass');
  });

  it('sets self_hash on generated evidence', () => {
    const evidence = generateEvidence({
      requirement_id: 'AH-TEST-001',
      source_files: ['verification/evidence.ts'],
      tests_added: [],
      commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'] }],
      cwd: process.cwd(),
      test_results: {},
      coverage: {},
      security_checks: {},
    });
    expect(evidence.self_hash).toBeDefined();
    expect(evidence.self_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('sets prev_hash to null on generated evidence', () => {
    const evidence = generateEvidence({
      requirement_id: 'AH-TEST-001',
      source_files: ['verification/evidence.ts'],
      tests_added: [],
      commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'] }],
      cwd: process.cwd(),
      test_results: {},
      coverage: {},
      security_checks: {},
    });
    expect(evidence.prev_hash).toBeNull();
  });

  it('uses default verifier_model when not provided', () => {
    const evidence = generateEvidence({
      requirement_id: 'AH-TEST-001',
      source_files: ['verification/evidence.ts'],
      tests_added: [],
      commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'] }],
      cwd: process.cwd(),
      test_results: {},
      coverage: {},
      security_checks: {},
    });
    expect(evidence.verifier_model).toBe('independent rerun at exact implementation SHA');
  });

  it('uses provided verifier_model', () => {
    const evidence = generateEvidence({
      requirement_id: 'AH-TEST-001',
      source_files: ['verification/evidence.ts'],
      tests_added: [],
      commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'] }],
      cwd: process.cwd(),
      test_results: {},
      coverage: {},
      security_checks: {},
      verifier_model: 'glm-5.2-xhigh',
    });
    expect(evidence.verifier_model).toBe('glm-5.2-xhigh');
  });
});
