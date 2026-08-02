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
  writeRunnerOutput: (options: {
    outputPath: string;
    serialized: string;
    formalAcceptance: boolean;
    evidenceRoot?: string;
  }) => void;
}

const runnerUrl = pathToFileURL(
  resolve(import.meta.dirname, '../../benchmarks/phase1/runner/run-agent.mjs'),
).href;

describe('benchmark runner output compatibility', () => {
  it('keeps ordinary outputs replaceable while formal evidence is exclusive', async () => {
    const runner = (await import(runnerUrl)) as RunnerModule;
    const directory = mkdtempSync(join(tmpdir(), 'phase1-runner-output-'));
    try {
      const ordinary = join(directory, 'ordinary.json');
      runner.writeRunnerOutput({
        outputPath: ordinary,
        serialized: 'first\n',
        formalAcceptance: false,
      });
      runner.writeRunnerOutput({
        outputPath: ordinary,
        serialized: 'second\n',
        formalAcceptance: false,
      });
      expect(readFileSync(ordinary, 'utf8')).toBe('second\n');

      const formal = join(directory, 'formal.json');
      runner.writeRunnerOutput({
        outputPath: formal,
        serialized: 'first\n',
        formalAcceptance: true,
        evidenceRoot: directory,
      });
      expect(() =>
        runner.writeRunnerOutput({
          outputPath: formal,
          serialized: 'second\n',
          formalAcceptance: true,
          evidenceRoot: directory,
        }),
      ).toThrow(/already exists/u);
      expect(readFileSync(formal, 'utf8')).toBe('first\n');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
