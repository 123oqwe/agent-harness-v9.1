import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('live GLM acceptance entrypoint', () => {
  it('is an explicit fail-closed runner, not a silently skipped unit test', () => {
    const runner = readFileSync(
      resolve(import.meta.dirname, '../../scripts/run-glm-acceptance.mjs'),
      'utf8',
    );
    expect(runner).toContain('GLM_API_KEY is required');
    expect(runner).toContain('glm-5.2');
    expect(runner).toContain('xhigh');
    expect(runner).toContain('phase1-24-v1');
    expect(runner).toContain('run-agent.mjs');
    expect(runner).not.toContain('fetch(');
  });
});
