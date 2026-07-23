/** AH-EVAL-001: Deterministic Local Eval Runner */
import { createHash } from 'node:crypto';
import type { EvidenceRecord } from './evidence.js';

export interface EvalFixture {
  id: string;
  name: string;
  description: string;
  run: () => Promise<EvalFixtureResult>;
  expected: EvalExpected;
}

export interface EvalFixtureResult {
  passed: boolean;
  output: string;
  evidence?: EvidenceRecord;
  error?: string;
}

export interface EvalExpected {
  strategy?: string;
  output_contains?: string;
  stop_reason?: string;
  no_denied_actions?: boolean;
  no_secret_leaks?: boolean;
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  results: { id: string; name: string; passed: boolean; error?: string }[];
  digest: string;
}

export class EvalRunner {
  private readonly fixtures: EvalFixture[] = [];

  register(fixture: EvalFixture): void {
    this.fixtures.push(fixture);
  }

  async runAll(): Promise<EvalSummary> {
    const results: EvalSummary['results'] = [];
    let passed = 0;

    for (const fixture of this.fixtures) {
      try {
        const result = await fixture.run();
        if (result.passed) {
          passed++;
          results.push({ id: fixture.id, name: fixture.name, passed: true });
        } else {
          results.push({ id: fixture.id, name: fixture.name, passed: false, error: result.error ?? 'assertion failed' });
        }
      } catch (err) {
        results.push({ id: fixture.id, name: fixture.name, passed: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const digest = createHash('sha256').update(JSON.stringify(results)).digest('hex');
    return { total: this.fixtures.length, passed, failed: this.fixtures.length - passed, results, digest };
  }

  count(): number {
    return this.fixtures.length;
  }
}
