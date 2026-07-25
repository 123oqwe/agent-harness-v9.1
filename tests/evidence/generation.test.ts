import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EvidenceError,
  generateEvidence,
  runCommand,
  validateEvidence,
  writeEvidence,
  type EvidencePackage,
} from '../../verification/evidence.js';

const node = process.execPath;
const schemaPath = join(
  process.env.HARNESS_SPEC_ROOT ?? join(process.cwd(), '..', 'spec'),
  'contracts',
  'evidence-package.schema.json',
);

function validEvidence(
  overrides: Partial<EvidencePackage> = {},
): EvidencePackage {
  return {
    requirement_id: 'AH-EVIDENCE-TEST',
    commit_sha: 'a'.repeat(40),
    source_files: [],
    tests_added: [],
    commands_run: [
      {
        command: JSON.stringify([node, '-e', 'process.exit(0)']),
        argv: [node, '-e', 'process.exit(0)'],
        exit_code: 0,
        stdout_hash: null,
        stderr_hash: null,
      },
    ],
    exit_codes: [0],
    test_results: {},
    coverage: {},
    security_checks: {},
    verifier_result: 'pass',
    ...overrides,
  };
}

describe('AH-EVIDENCE-001 real argv evidence', () => {
  let scratch: string | undefined;
  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it('captures literal argv, exit code, stdout and stderr hashes', () => {
    const result = runCommand({
      argv: [
        node,
        '-e',
        'process.stdout.write("out");process.stderr.write("err");process.exit(5)',
      ],
    });
    expect(result.argv).toEqual([
      node,
      '-e',
      'process.stdout.write("out");process.stderr.write("err");process.exit(5)',
    ]);
    expect(result.exit_code).toBe(5);
    expect(result.stdout_hash).toMatch(/^[0-9a-f]{16}$/u);
    expect(result.stderr_hash).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('does not interpret shell metacharacters', () => {
    scratch = mkdtempSync(join(tmpdir(), 'evidence-literal-'));
    const target = join(scratch, 'must-not-exist');
    const result = runCommand({ argv: ['/bin/echo', `;touch ${target}`] });
    expect(result.exit_code).toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it('honours cwd and timeout and fails closed on spawn errors', () => {
    scratch = mkdtempSync(join(tmpdir(), 'evidence-cwd-'));
    expect(
      runCommand({
        argv: [
          node,
          '-e',
          'process.exit(process.cwd()===process.argv[1]?0:8)',
          realpathSync(scratch),
        ],
        cwd: scratch!,
      }).exit_code,
    ).toBe(0);
    expect(
      runCommand({
        argv: [node, '-e', 'setTimeout(()=>{},5000)'],
        timeout_ms: 20,
      }).exit_code,
    ).toBe(1);
    expect(
      runCommand({ argv: ['/definitely/not/an/executable'] }).exit_code,
    ).toBe(1);
  });

  it.each([
    null,
    {},
    { argv: [] },
    { argv: [''] },
    { argv: [node], timeout_ms: 0 },
  ])('rejects malformed command %#', (candidate) => {
    expect(() => runCommand(candidate as never)).toThrow(EvidenceError);
  });

  it('generates evidence only from real commands and exact files', () => {
    const evidence = generateEvidence({
      requirement_id: 'AH-EVIDENCE-GENERATE',
      source_files: ['verification/evidence.ts'],
      tests_added: ['tests/evidence/generation.test.ts'],
      commands: [
        { argv: [node, '-e', 'process.stdout.write("verified")'] },
      ],
      cwd: process.cwd(),
      test_results: { passed: 1 },
      coverage: { lines: 100 },
      security_checks: { argv_only: true },
    });
    expect(evidence.commit_sha).toMatch(/^[0-9a-f]{40}$/u);
    expect(evidence.exit_codes).toEqual([0]);
    expect(evidence.verifier_result).toBe('pass');
    expect(evidence.verifier_model).toContain('independent');
  });

  it('one failed command makes the complete package fail', () => {
    const evidence = generateEvidence({
      requirement_id: 'AH-EVIDENCE-FAIL',
      source_files: [],
      tests_added: [],
      commands: [
        { argv: [node, '-e', 'process.exit(0)'] },
        { argv: [node, '-e', 'process.exit(7)'] },
      ],
      cwd: process.cwd(),
      test_results: {},
      coverage: {},
      security_checks: {},
      verifier_model: 'independent-test',
    });
    expect(evidence.exit_codes).toEqual([0, 7]);
    expect(evidence.verifier_result).toBe('fail');
    expect(evidence.verifier_model).toBe('independent-test');
  });

  it('forbids empty evidence and nonexistent declared files', () => {
    const base = {
      requirement_id: 'AH-EVIDENCE-INVALID',
      source_files: [] as string[],
      tests_added: [] as string[],
      commands: [{ argv: [node, '-e', 'process.exit(0)'] }],
      cwd: process.cwd(),
      test_results: {},
      coverage: {},
      security_checks: {},
    };
    expect(() => generateEvidence({ ...base, commands: [] })).toThrow(
      'self-reported PASS',
    );
    expect(() =>
      generateEvidence({ ...base, source_files: ['missing-source.ts'] }),
    ).toThrow('source_file does not exist');
    expect(() =>
      generateEvidence({ ...base, tests_added: ['missing-test.ts'] }),
    ).toThrow('tests_added file does not exist');
  });

  it('writes evidence and prevents a verified package from being downgraded', () => {
    scratch = mkdtempSync(join(tmpdir(), 'evidence-write-'));
    const path = join(scratch, 'evidence.json');
    const pass = validEvidence();
    writeEvidence(pass, path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      verifier_result: 'pass',
    });
    expect(() =>
      writeEvidence({ ...pass, verifier_result: 'fail' }, path),
    ).toThrow('immutable');
    expect(() => writeEvidence(pass, path)).toThrow('immutable');

    const retryPath = join(scratch, 'retry.json');
    writeEvidence(
      validEvidence({
        verifier_result: 'fail',
        exit_codes: [1],
        commands_run: [
          {
            ...validEvidence().commands_run[0]!,
            exit_code: 1,
          },
        ],
      }),
      retryPath,
    );
    expect(() => writeEvidence(pass, retryPath)).not.toThrow();
    expect(JSON.parse(readFileSync(retryPath, 'utf8'))).toMatchObject({
      verifier_result: 'pass',
    });
  });

  it('validates schema plus semantic evidence invariants', () => {
    expect(validateEvidence(validEvidence(), schemaPath)).toBe(true);
    expect(() =>
      validateEvidence(validEvidence({ commit_sha: 'pending' }), schemaPath),
    ).toThrow(EvidenceError);
    expect(() =>
      validateEvidence(validEvidence({ commit_sha: 'x'.repeat(40) }), schemaPath),
    ).toThrow(EvidenceError);
    expect(() =>
      validateEvidence(validEvidence({ commands_run: [] }), schemaPath),
    ).toThrow(EvidenceError);
    expect(() => validateEvidence({ requirement_id: 'missing' }, schemaPath)).toThrow(
      EvidenceError,
    );
    expect(() =>
      validateEvidence(
        validEvidence({ exit_codes: [1] }),
        schemaPath,
      ),
    ).toThrow('command results and exit_codes do not match');
    expect(() =>
      validateEvidence(
        validEvidence({
          verifier_result: 'fail',
        }),
        schemaPath,
      ),
    ).toThrow('does not match');
    expect(() =>
      validateEvidence(
        validEvidence({
          verifier_result: 'pass',
          exit_codes: [7],
          commands_run: [
            { ...validEvidence().commands_run[0]!, exit_code: 7 },
          ],
        }),
        schemaPath,
      ),
    ).toThrow('does not match');
  });

  it('uses the requested repository cwd when resolving the exact revision', () => {
    scratch = mkdtempSync(join(tmpdir(), 'evidence-not-repo-'));
    expect(() =>
      generateEvidence({
        requirement_id: 'AH-EVIDENCE-WRONG-REPO',
        source_files: [],
        tests_added: [],
        commands: [{ argv: [node, '-e', 'process.exit(0)'] }],
        cwd: scratch!,
        test_results: {},
        coverage: {},
        security_checks: {},
      }),
    ).toThrow('invalid commit_sha');
  });

  it('preserves error identity and exact validation diagnostics', () => {
    const error = new EvidenceError('boundary');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('EvidenceError');
    expect(error.message).toBe('boundary');
    expect(() =>
      validateEvidence(
        { requirement_id: 'missing' },
        schemaPath,
      ),
    ).toThrow(/evidence schema validation failed:/u);
  });
});
