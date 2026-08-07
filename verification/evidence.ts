/**
 * AH-EVIDENCE-001: Evidence Package generation from actual command output.
 *
 * Evidence is generated from actual command output only. Self-reported PASS
 * without evidence is forbidden. Evidence is immutable once generated.
 * Includes commit_sha, source_files, tests_added, commands_run, exit_codes,
 * test_results, coverage, security_checks. Validates against
 * evidence-package.schema.json.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv/dist/2020.js';

export interface CommandResult {
  command: string;
  argv: string[];
  exit_code: number;
  stdout_hash: string | null;
  stderr_hash?: string | null;
}

export interface EvidencePackage {
  requirement_id: string;
  commit_sha: string;
  source_files: string[];
  tests_added: string[];
  commands_run: CommandResult[];
  exit_codes: number[];
  test_results: Record<string, unknown>;
  coverage: Record<string, unknown>;
  security_checks: Record<string, unknown>;
  verifier_result: 'pass' | 'fail';
  verifier_model?: string;
  test_output?: string | null;
  test_output_hash?: string | null;
  /**
   * P2-17: Hash chain link.
   * prev_hash is the self_hash of the preceding EvidencePackage in the chain,
   * or null if this is the first package. self_hash is the SHA-256 of the
   * canonical content of this package (everything except self_hash itself).
   */
  prev_hash?: string | null;
  self_hash?: string | null;
}

export class EvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceError';
    Object.setPrototypeOf(this, EvidenceError.prototype);
  }
}

const sha = (s: string | null | undefined): string | null => s ? createHash('sha256').update(s).digest('hex').slice(0, 16) : null;
const exactCommitSha = /^[0-9a-f]{40}$/u;

/**
 * P2-17: Compute the self_hash of an EvidencePackage.
 *
 * The hash covers the canonical JSON of every field EXCEPT self_hash.
 * prev_hash is included so the chain is tamper-evident.
 */
export function computeSelfHash(evidence: Readonly<EvidencePackage>): string {
  const { self_hash: _omitted, ...rest } = evidence;
  return createHash('sha256')
    .update(JSON.stringify(rest))
    .digest('hex')
    .slice(0, 16);
}

/**
 * P2-17: Verify the hash chain of an EvidencePackage.
 * Returns true if self_hash matches the recomputed hash (or is absent for
 * legacy packages). Does not throw — callers decide whether to reject.
 */
export function verifyHashChain(evidence: Readonly<EvidencePackage>): boolean {
  if (evidence.self_hash === undefined || evidence.self_hash === null) {
    // Legacy package without hash chain — accepted but not verified.
    return true;
  }
  return computeSelfHash(evidence) === evidence.self_hash;
}

export interface CommandSpec {
  argv: readonly string[];
  cwd?: string;
  timeout_ms?: number;
}

function validateCommand(command: CommandSpec): void {
  if (
    !command ||
    !Array.isArray(command.argv) ||
    command.argv.length === 0 ||
    command.argv.some(
      (argument) => typeof argument !== 'string' || argument.length === 0,
    )
  ) {
    throw new EvidenceError('command requires non-empty argv');
  }
  if (
    command.timeout_ms !== undefined &&
    (!Number.isSafeInteger(command.timeout_ms) || command.timeout_ms <= 0)
  ) {
    throw new EvidenceError('command timeout_ms must be a positive integer');
  }
}

/** Run a real command and capture exit code + output hashes. Never fabricates. */
export function runCommand(
  command: CommandSpec,
  defaultCwd = process.cwd(),
  defaultTimeout = 180_000,
): CommandResult {
  validateCommand(command);
  const [executable, ...args] = command.argv;
  const result = spawnSync(executable!, args, {
    cwd: command.cwd ?? defaultCwd,
    timeout: command.timeout_ms ?? defaultTimeout,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  const stderr =
    result.stderr ??
    (result.error instanceof Error ? result.error.message : '');
  return {
    command: JSON.stringify(command.argv),
    argv: [...command.argv],
    exit_code: result.status ?? 1,
    stdout_hash: sha(result.stdout ?? ''),
    stderr_hash: sha(stderr || null),
  };
}

/** Generate an EvidencePackage from actual command output at the current commit. */
export function generateEvidence(params: {
  requirement_id: string;
  source_files: string[];
  tests_added: string[];
  commands: CommandSpec[];
  cwd?: string;
  test_results: Record<string, unknown>;
  coverage: Record<string, unknown>;
  security_checks: Record<string, unknown>;
  verifier_model?: string;
}): EvidencePackage {
  const base = params.cwd ?? process.cwd();
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: base,
    encoding: 'utf8',
    shell: false,
  });
  const commit_sha = revision.status === 0 ? revision.stdout.trim() : '';
  if (!exactCommitSha.test(commit_sha)) {
    throw new EvidenceError(`invalid commit_sha: ${commit_sha}`);
  }

  // verify source_files and tests_added exist — fail on missing, do not silently filter
  for (const f of params.source_files) {
    if (!existsSync(resolve(base, f))) throw new EvidenceError(`source_file does not exist: ${f}`);
  }
  for (const f of params.tests_added) {
    if (!existsSync(resolve(base, f))) throw new EvidenceError(`tests_added file does not exist: ${f}`);
  }
  const source_files = params.source_files;
  const tests_added = params.tests_added;

  const commands_run = params.commands.map(c => runCommand(c, base));
  const exit_codes = commands_run.map(c => c.exit_code);
  const allPassed = exit_codes.every(c => c === 0);

  // forbidden: self-reported PASS without real commands
  if (params.commands.length === 0) throw new EvidenceError('self-reported PASS without commands is forbidden');

 const evidence: EvidencePackage = {
   requirement_id: params.requirement_id,
   commit_sha,
   source_files,
   tests_added,
   commands_run,
   exit_codes,
   test_results: params.test_results,
   coverage: params.coverage,
   security_checks: params.security_checks,
   verifier_result: allPassed ? 'pass' : 'fail',
   verifier_model: params.verifier_model ?? 'independent rerun at exact implementation SHA',
   test_output: null,
   test_output_hash: null,
 };
  // P2-17: hash chain — first package has prev_hash null
  evidence.prev_hash = null;
  evidence.self_hash = computeSelfHash(evidence);
 return evidence;
}

/** Write an EvidencePackage to disk (immutable once written). */
export function writeEvidence(evidence: EvidencePackage, path: string): void {
  if (existsSync(path)) {
    // A failed attempt may be replaced exactly once by a verified package.
    // A verified package is final and cannot be rewritten, even with PASS.
    const existing = JSON.parse(readFileSync(path, 'utf8')) as EvidencePackage;
    if (
      existing.verifier_result === 'pass' ||
      evidence.verifier_result !== 'pass'
    ) {
      throw new EvidenceError(
        `evidence is immutable: ${path} may only transition from fail to pass`,
      );
    }
    // P2-17: chain to the existing package's self_hash
    evidence.prev_hash = existing.self_hash ?? null;
  } else {
    evidence.prev_hash = null;
  }
  // P2-17: (re)compute self_hash after setting prev_hash
  evidence.self_hash = computeSelfHash(evidence);
  writeFileSync(path, JSON.stringify(evidence, null, 2));
}

/** Validate an EvidencePackage against the schema using AJV. */
export function validateEvidence(evidence: unknown, schemaPath: string): boolean {
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (!validate(evidence)) {
    const errors = validate.errors?.map((e: { instancePath: string; message?: string }) => `${e.instancePath}: ${e.message}`).join('; ') ?? 'unknown';
    throw new EvidenceError(`evidence schema validation failed: ${errors}`);
  }
  const e = evidence as EvidencePackage;
  if (!exactCommitSha.test(e.commit_sha)) {
    throw new EvidenceError(
      `commit_sha must be a 40-char SHA: ${e.commit_sha}`,
    );
  }
  if (e.commands_run.length === 0) {
    throw new EvidenceError('evidence without commands is forbidden');
  }
  if (
    e.commands_run.length !== e.exit_codes.length ||
    e.commands_run.some(
      (command, index) => command.exit_code !== e.exit_codes[index],
    )
  ) {
    throw new EvidenceError('command results and exit_codes do not match');
  }
  const commandsPassed = e.exit_codes.every((exitCode) => exitCode === 0);
  if (
    (e.verifier_result === 'pass' && !commandsPassed) ||
    (e.verifier_result === 'fail' && commandsPassed)
  ) {
    throw new EvidenceError(
      'verifier_result does not match the recorded command exits',
    );
  }
  // P2-17: verify hash chain if self_hash is present
  if (e.self_hash !== undefined && e.self_hash !== null) {
    if (!verifyHashChain(e)) {
      throw new EvidenceError(
        'hash chain verification failed: self_hash does not match recomputed hash',
      );
    }
  }
  return true;
}
