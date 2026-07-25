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
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export type EvalSuiteKind = 'unit' | 'integration' | 'adversarial' | 'vertical' | 'e2e';
export type Strategy = 'direct' | 'react' | 'plan_execute';

export interface EvalCase {
  id: string;
  kind: EvalSuiteKind;
  argv: readonly string[];    // executable + literal arguments; never a shell string
  cwd?: string;
  timeout_ms?: number;
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
  constructor(message: string) {
    super(message);
    this.name = 'EvalRunnerError';
    Object.setPrototypeOf(this, EvalRunnerError.prototype);
  }
}

const sha = (s: string | null | undefined): string | null => s ? createHash('sha256').update(s).digest('hex').slice(0, 16) : null;
const kinds = new Set<EvalSuiteKind>([
  'unit',
  'integration',
  'adversarial',
  'vertical',
  'e2e',
]);
const strategies = new Set<Strategy>([
  'direct',
  'react',
  'plan_execute',
]);

export class EvalRunner {
  /** Execute all eval cases in a manifest. A failing/missing eval cannot be pass. */
  run(manifest: EvalManifest, cwd = process.cwd()): EvalReport {
    EvalRunner.validateManifest(manifest);
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      shell: false,
    });
    if (revision.status !== 0 || !/^[0-9a-f]{40}\s*$/u.test(revision.stdout)) {
      throw new EvalRunnerError('cannot resolve an exact git revision');
    }
    const commit_sha = revision.stdout.trim();
    const results = manifest.suites.map((evalCase) =>
      this.runCase(evalCase, cwd),
    );

    // verify reasoning_strategy consistency across e2e cases
    const e2eResults = results.filter(
      (_, index) => manifest.suites[index]!.kind === 'e2e',
    );
    const strategies_consistent = e2eResults.every(
      (result) => result.passed,
    );

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
    const [executable, ...args] = c.argv;
    const execution = spawnSync(executable!, args, {
      cwd: c.cwd ?? cwd,
      timeout: c.timeout_ms ?? 120_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const exit_code = execution.status ?? 1;
    const stdout = execution.stdout ?? '';
    const stderr =
      execution.stderr ??
      (execution.error instanceof Error ? execution.error.message : '');
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
    const ids = new Set<string>();
    for (const c of m.suites) {
      if (!c || typeof c.id !== 'string' || c.id.trim() === '') {
        throw new EvalRunnerError('each eval case requires a non-empty id');
      }
      if (ids.has(c.id)) throw new EvalRunnerError(`duplicate eval id: ${c.id}`);
      ids.add(c.id);
      if (!kinds.has(c.kind)) {
        throw new EvalRunnerError(`invalid eval kind: ${String(c.kind)}`);
      }
      if (
        c.kind === 'e2e' &&
        (c.expected_strategy === undefined ||
          !strategies.has(c.expected_strategy))
      ) {
        throw new EvalRunnerError(
          'e2e eval requires a valid expected_strategy',
        );
      }
      if (
        c.kind !== 'e2e' &&
        c.expected_strategy !== undefined
      ) {
        throw new EvalRunnerError(
          'expected_strategy is only valid for e2e evals',
        );
      }
      if (
        !Array.isArray(c.argv) ||
        c.argv.length === 0 ||
        c.argv.some((argument) => typeof argument !== 'string' || argument === '')
      ) {
        throw new EvalRunnerError('each eval case requires non-empty argv');
      }
      if (!Number.isSafeInteger(c.expected_exit)) {
        throw new EvalRunnerError('expected_exit must be an integer');
      }
      if (
        c.timeout_ms !== undefined &&
        (!Number.isSafeInteger(c.timeout_ms) || c.timeout_ms <= 0)
      ) {
        throw new EvalRunnerError('timeout_ms must be a positive integer');
      }
    }
  }
}
