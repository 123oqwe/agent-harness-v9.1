import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as publicApi from '../../index.js';

const root = resolve(import.meta.dirname, '../..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

describe('Phase 1 source architecture boundaries', () => {
  it('keeps sandbox, skills, and verticals in their canonical modules', () => {
    const canonical = [
      'sandbox/process-sandbox.ts',
      'skills/skill-registry.ts',
      'domains/coding/ah_coding_vertical_001.ts',
      'domains/documents/ah_doc_vertical_001.ts',
      'domains/research/ah_research_vertical_001.ts',
      'domains/writing/ah_writing_vertical_001.ts',
      'domains/planning/ah_planning_vertical_001.ts',
      'domains/personal-assistant/ah_pa_vertical_001.ts',
    ];
    const legacy = [
      'runtime/sandbox.ts',
      'tools/skill-registry.ts',
      'ingestion/ah_doc_vertical_001.ts',
      'research/ah_research_vertical_001.ts',
      'writing/ah_writing_vertical_001.ts',
      'planning/ah_planning_vertical_001.ts',
      'personal_assistant/ah_pa_vertical_001.ts',
    ];

    expect(canonical.filter((path) => !existsSync(resolve(root, path)))).toEqual([]);
    expect(legacy.filter((path) => existsSync(resolve(root, path)))).toEqual([]);
  });

  it('has a deterministic production import-cycle gate', () => {
    const checked = spawnSync(npmCommand, ['run', 'check:cycles'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 30_000,
    });

    expect(checked.status, `${checked.stdout}\n${checked.stderr}`).toBe(0);
    expect(checked.stdout).toContain('No production import cycles found');
  });

  it('does not expose sandbox and host-environment internals at package root', () => {
    expect(publicApi).toHaveProperty('Harness');
    expect(publicApi).toHaveProperty('LoopEngine');
    expect(publicApi).toHaveProperty('execSandboxed');
    expect(publicApi).toHaveProperty('SkillRegistry');

    for (const internal of [
      'buildSandboxArgv',
      'buildSandboxSpawnOptions',
      'classifyResourceLimit',
      'compileSeatbeltProfile',
      'inspectProcessResourceLimit',
      'isValidEgressHost',
      'killSandboxProcessTree',
      'limitOutputChunk',
      'measureProcessTree',
      'parseProcessTable',
      'stripCredentialsFromEnv',
    ]) {
      expect(publicApi).not.toHaveProperty(internal);
    }
  });
});
