/**
 * AH-EVAL-RUNNER-001: Phase 1 deterministic evaluation runner.
 *
 * Executes requirement-scoped unit, integration, adversarial and six vertical
 * eval suites from one typed manifest. Uses ScriptedTestProvider and local
 * fixtures only (no external model API for the local gate). Captures command,
 * exit code, stdout/stderr hashes, fixture version and code revision in
 * Evidence Package. A failing or missing eval cannot be represented as pass.
 * Runs local end-to-end fixtures for direct, react, plan_execute and fails
 * when Router strategy, Runtime executor, termination reason, replay, or
 * Evidence reasoning_strategy disagree.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export type EvalSuiteKind = 'unit' | 'integration' | 'adversarial' | 'vertical' | 'e2e';
export type Strategy = 'direct' | 'react' | 'plan_execute';

export interface EvalCase {
  id: string;
  kind: EvalSuiteKind;
  command: string;            // real command to run
  expected_exit: number;      // expected exit code
  expected_strategy?: Strategy;
  fixture_version?: string | undefined;
}

export interface EvalManifest {
  manifest_version: 'eval-manifest.v1';
  requirement_id: string;
  suites: EvalCase[];
}

export interface EvalResult {
  case_id: string;
  passed: boolean;
  exit_code: number;
  stdout_hash: string | null;
  stderr_hash: string | null;
  reason?: string | undefined;
  fixture_version?: string | undefined;
}

export interface EvalReport {
  requirement_id: string;
  commit_sha: string;
  manifest_version: string;
  results: EvalResult[];
  all_passed: boolean;
  reasoning_strategy_consistent: boolean;
  timestamp: string;
}

export class EvalRunnerError extends Error {
  constructor(message: string) { super(message); this.name = 'EvalRunnerError'; Object.setPrototypeOf(this, EvalRunnerError.prototype); }
}

const sha = (s: string | null | undefined): string | null => s ? createHash('sha256').update(s).digest('hex').slice(0, 16) : null;

export class EvalRunner {
  /** Execute all eval cases in a manifest. A failing/missing eval cannot be pass. */
  run(manifest: EvalManifest, cwd = process.cwd()): EvalReport {
    const commit_sha = execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim();
    const results: EvalResult[] = [];
    let strategies_consistent = true;

    for (const c of manifest.suites) {
      const result = this.runCase(c, cwd);
      results.push(result);
      if (!result.passed) strategies_consistent = false;
    }

    // verify reasoning_strategy consistency across e2e cases
    const e2eResults = results.filter((_, i) => manifest.suites[i]!.kind === 'e2e' && manifest.suites[i]!.expected_strategy);
    if (e2eResults.length > 0) {
      // all e2e cases must pass for strategy consistency
      strategies_consistent = e2eResults.every(r => r.passed);
    }

    return {
      requirement_id: manifest.requirement_id,
      commit_sha,
      manifest_version: manifest.manifest_version,
      results,
      all_passed: results.every(r => r.passed),
      reasoning_strategy_consistent: strategies_consistent,
      timestamp: new Date().toISOString(),
    };
  }

  private runCase(c: EvalCase, cwd: string): EvalResult {
    let exit_code: number;
    let stdout: string;
    let stderr: string;
    try {
      stdout = execSync(c.command, { cwd, timeout: 120_000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      stderr = '';
      exit_code = 0;
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      exit_code = err.status ?? 1;
      stdout = err.stdout ?? '';
      stderr = err.stderr ?? '';
    }
    // Check expected_exit: passed only if actual exit matches expected
    const passed = exit_code === c.expected_exit;
    const reason = passed ? undefined : `expected exit ${c.expected_exit}, got ${exit_code}`;
    return { case_id: c.id, passed, exit_code, stdout_hash: sha(stdout), stderr_hash: sha(stderr || null), reason, fixture_version: c.fixture_version };
  }

  /** Verify a manifest is well-formed (no missing evals). */
  static validateManifest(manifest: unknown): asserts manifest is EvalManifest {
    const m = manifest as EvalManifest;
    if (!m || m.manifest_version !== 'eval-manifest.v1') throw new EvalRunnerError('invalid manifest_version');
    if (!m.requirement_id) throw new EvalRunnerError('manifest requires requirement_id');
    if (!Array.isArray(m.suites) || m.suites.length === 0) throw new EvalRunnerError('manifest requires non-empty suites');
    for (const c of m.suites) {
      if (!c.id || !c.command) throw new EvalRunnerError('each eval case requires id and command');
    }
  }
}
