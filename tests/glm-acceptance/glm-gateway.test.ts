import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('packed GLM gateway acceptance boundary', () => {
  it('uses the public package entrypoint and never a direct provider fetch', () => {
    const harnessRunner = readFileSync(
      resolve(
        import.meta.dirname,
        '../../benchmarks/phase1/runner/run-harness-case.mjs',
      ),
      'utf8',
    );
    expect(harnessRunner).toContain('HARNESS_PACKAGE_SPECIFIER');
    expect(harnessRunner).toContain('createGlmGateway');
    expect(harnessRunner).toContain('gateway');
    expect(harnessRunner).not.toContain('fetch(');
    expect(harnessRunner).not.toContain('glm-4-plus');
  });
});
