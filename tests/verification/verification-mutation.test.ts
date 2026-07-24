import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EvalRunner } from '../../verification/eval-runner.js';
import { runCommand } from '../../verification/evidence.js';

describe('verification command boundary regressions', () => {
  it('source contains no shell-based child process API', () => {
    for (const file of [
      new URL('../../verification/eval-runner.ts', import.meta.url),
      new URL('../../verification/evidence.ts', import.meta.url),
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toContain('execSync(');
      expect(source).not.toContain('shell: true');
    }
  });

  it('preserves an argument containing spaces as one argument', () => {
    const result = runCommand({
      argv: [
        process.execPath,
        '-e',
        'process.exit(process.argv[1] === "one argument" ? 0 : 9)',
        'one argument',
      ],
    });
    expect(result.exit_code).toBe(0);
  });

  it('EvalRunner executes its frozen argv without command concatenation', () => {
    const report = new EvalRunner().run({
      manifest_version: 'eval-manifest.v1',
      requirement_id: 'AH-ARGV-FROZEN',
      suites: [
        {
          id: 'literal',
          kind: 'adversarial',
          argv: [
            process.execPath,
            '-e',
            'process.exit(process.argv[1] === "a;b" ? 0 : 4)',
            'a;b',
          ],
          expected_exit: 0,
        },
      ],
    });
    expect(report.all_passed).toBe(true);
  });
});
