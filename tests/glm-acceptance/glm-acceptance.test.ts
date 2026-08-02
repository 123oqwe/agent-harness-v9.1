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
    expect(runner).not.toContain("'--formal-acceptance'");
    expect(runner).toContain('prepareIsolatedReleaseTree');
    expect(runner).toContain('ACCEPTANCE_EVIDENCE_ROOT');
    expect(runner).toContain('MUTATION_ARTIFACT_DIGEST');
    expect(runner).toContain('phase1/mutation.json');
    expect(runner).toContain('final-evidence.schema.json');
    expect(runner).not.toContain("'--mutation-run-id'");
    expect(runner).not.toContain("'--mutation-configuration-hash'");
    expect(runner).toContain('rawReport');
    expect(runner).toContain('const report = { ...rawReport, provenance };');
    expect(runner).toContain('result_schema_sha256: sha256File(finalEvidenceSchemaPath)');
    expect(runner).toContain("'ci'");
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
    expect(
      runner.match(
        /\['rebuild', 'better-sqlite3', '--foreground-scripts'\]/gu,
      ),
    ).toHaveLength(2);
    expect(runner.match(/smokeSqliteSessionStore\(/gu)).toHaveLength(3);
    expect(runner).not.toContain("['rebuild', '--foreground-scripts']");
  });
});
