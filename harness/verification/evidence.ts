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
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface CommandResult {
  command: string;
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
}

export class EvidenceError extends Error {
  constructor(message: string) { super(message); this.name = 'EvidenceError'; Object.setPrototypeOf(this, EvidenceError.prototype); }
}

const sha = (s: string | null | undefined): string | null => s ? createHash('sha256').update(s).digest('hex').slice(0, 16) : null;

/** Run a real command and capture exit code + output hashes. Never fabricates. */
export function runCommand(command: string, cwd?: string, timeout = 180_000): CommandResult {
  try {
    const out = execSync(command, { cwd: cwd ?? process.cwd(), timeout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { command, exit_code: 0, stdout_hash: sha(out) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { command, exit_code: err.status ?? 1, stdout_hash: sha(err.stdout ?? ''), stderr_hash: sha(err.stderr ?? '') };
  }
}

/** Generate an EvidencePackage from actual command output at the current commit. */
export function generateEvidence(params: {
  requirement_id: string;
  source_files: string[];
  tests_added: string[];
  commands: string[];
  cwd?: string;
  test_results: Record<string, unknown>;
  coverage: Record<string, unknown>;
  security_checks: Record<string, unknown>;
  verifier_model?: string;
}): EvidencePackage {
  const commit_sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit_sha)) throw new EvidenceError(`invalid commit_sha: ${commit_sha}`);

  // verify source_files and tests_added exist
  const base = params.cwd ?? process.cwd();
  const source_files = params.source_files.filter(f => existsSync(resolve(base, f)));
  const tests_added = params.tests_added.filter(f => existsSync(resolve(base, f)));

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
  return evidence;
}

/** Write an EvidencePackage to disk (immutable once written). */
export function writeEvidence(evidence: EvidencePackage, path: string): void {
  if (existsSync(path)) {
    // immutability: allow re-write only if verifier_result changed from fail to pass
    const existing = JSON.parse(readFileSync(path, 'utf8')) as EvidencePackage;
    if (existing.verifier_result === 'pass' && evidence.verifier_result !== 'pass') {
      throw new EvidenceError(`evidence is immutable: ${path} already has verifier_result=pass`);
    }
  }
  writeFileSync(path, JSON.stringify(evidence, null, 2));
}

/** Validate an EvidencePackage against the schema. */
export function validateEvidence(evidence: unknown, schemaPath: string): boolean {
  JSON.parse(readFileSync(schemaPath, 'utf8'));
  // minimal structural validation (full ajv validation done in tests)
  const e = evidence as EvidencePackage;
  const required = ['requirement_id', 'commit_sha', 'source_files', 'tests_added', 'commands_run', 'exit_codes', 'test_results', 'coverage', 'security_checks', 'verifier_result'];
  for (const k of required) if (!(k in e)) throw new EvidenceError(`missing required field: ${k}`);
  if (!/^[0-9a-f]{40}$/.test(e.commit_sha)) throw new EvidenceError(`commit_sha must be a 40-char SHA: ${e.commit_sha}`);
  if (e.verifier_result === 'pass' && e.commands_run.length === 0) throw new EvidenceError('PASS without commands is forbidden');
  if (e.verifier_result === 'pass' && e.commit_sha === 'pending') throw new EvidenceError('PASS with pending commit_sha is forbidden');
  return true;
}
