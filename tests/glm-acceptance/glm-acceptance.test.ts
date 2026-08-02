import { spawnSync } from 'node:child_process';
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

  it('requires EXPECTED_SHA before credentials or release work', () => {
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, '../../scripts/run-glm-acceptance.mjs')],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('EXPECTED_SHA is required');
    expect(result.stderr).not.toContain('GLM_API_KEY is required');
  });

  it('installs the packed consumer without lifecycle scripts', () => {
    const runner = readFileSync(
      resolve(import.meta.dirname, '../../scripts/run-glm-acceptance.mjs'),
      'utf8',
    );
    expect(runner).toContain("'--ignore-scripts'");
  });
});
