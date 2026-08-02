import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface RunnerModule {
  assertRawBenchmarkMode: (args: string[]) => true;
  writeRunnerOutput: (options: {
    outputPath: string;
    serialized: string;
  }) => void;
}

const runnerUrl = pathToFileURL(
  resolve(import.meta.dirname, '../../benchmarks/phase1/runner/run-agent.mjs'),
).href;

describe('benchmark runner output compatibility', () => {
  it('rejects every final-Evidence argument and keeps the runner raw-only', async () => {
    const runner = (await import(runnerUrl)) as RunnerModule;
    expect(runner.assertRawBenchmarkMode([])).toBe(true);
    for (const argument of [
      '--formal-acceptance',
      '--source-tree',
      '--fixture-sha256',
      '--result-schema-sha256',
      '--package-tarball-sha256',
      '--package-lock-sha256',
      '--consumer-lock-sha256',
      '--mutation-artifact-digest',
      '--mutation-artifact-name',
      '--mutation-configuration-hash',
      '--mutation-run-id',
    ]) {
      expect(() => runner.assertRawBenchmarkMode([argument, 'forged'])).toThrow(
        /wrapper|Evidence|raw-only/u,
      );
    }
    const source = readFileSync(
      resolve(import.meta.dirname, '../../benchmarks/phase1/runner/run-agent.mjs'),
      'utf8',
    );
    expect(source).not.toContain('final-evidence.schema.json');
    expect(source).not.toContain('validateAcceptanceReport');
    expect(source).not.toContain('secureReleaseIo');
  });

  it('keeps ordinary raw outputs replaceable', async () => {
    const runner = (await import(runnerUrl)) as RunnerModule;
    const directory = mkdtempSync(join(tmpdir(), 'phase1-runner-output-'));
    try {
      const ordinary = join(directory, 'ordinary.json');
      runner.writeRunnerOutput({
        outputPath: ordinary,
        serialized: 'first\n',
      });
      runner.writeRunnerOutput({
        outputPath: ordinary,
        serialized: 'second\n',
      });
      expect(readFileSync(ordinary, 'utf8')).toBe('second\n');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
