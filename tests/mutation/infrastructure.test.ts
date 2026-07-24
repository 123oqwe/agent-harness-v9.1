import {
  globSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const {
  acquireRunLock,
  buildPhase1Report,
  computeMutationConfigurationHash,
  loadEquivalentMutants,
  releaseRunLock,
  validatePhase1Report,
} = await import(
  // @ts-expect-error The production runner is intentionally plain ESM for Node.
  '../../scripts/run-mutation.mjs'
);
const { mutationModules: rawMutationModules, phase1Minimum: rawPhase1Minimum } =
  await import(
    // @ts-expect-error The mutation manifest is intentionally plain ESM for Node.
    '../../mutation/modules.mjs'
  );

const harnessRoot = resolve(import.meta.dirname, '..', '..');
const temporaryRoots: string[] = [];
interface MutationModule {
  mutate: string[];
  minimum: number;
  perFileMinimum?: number;
}
const mutationModules = rawMutationModules as Record<string, MutationModule>;
const phase1Minimum = rawPhase1Minimum as number;

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ah-mutation-infra-'));
  temporaryRoots.push(root);
  return root;
}

function zeroCounts() {
  return {
    total: 100,
    killed: 90,
    timeout: 0,
    survived: 10,
    noCoverage: 0,
    ignored: 0,
  };
}

function passingModuleResult(
  moduleName: keyof typeof mutationModules,
  runId = 'run-1',
  commitSha = 'a'.repeat(40),
  configurationHash = 'b'.repeat(64),
) {
  const module = mutationModules[moduleName]!;
  const perFile = Object.fromEntries(
    module.mutate.map((sourceFile) => [
      sourceFile,
      {
        ...zeroCounts(),
        score: 90,
        minimum: module.perFileMinimum ?? 0,
        status: 'PASS',
      },
    ]),
  );
  return {
    schema_version: 1,
    run_id: runId,
    commit_sha: commitSha,
    configuration_hash: configurationHash,
    module: moduleName,
    source_files: [...module.mutate],
    minimum: module.minimum,
    score: 90,
    status: 'PASS',
    counts: zeroCounts(),
    per_file: perFile,
    raw_report_sha256: 'c'.repeat(64),
    started_at: '2026-07-25T00:00:00.000Z',
    completed_at: '2026-07-25T00:01:00.000Z',
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('Phase 1 mutation manifest', () => {
  it('routes the public mutation command through the Phase 1 runner', () => {
    const packageJson = JSON.parse(
      readFileSync(join(harnessRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts['test:mutation']).toBe(
      'node scripts/run-mutation.mjs phase1',
    );
  });

  it('keeps sandbox and command security tests in mutation acceptance', () => {
    const config = readFileSync(
      join(harnessRoot, 'vitest.mutation.config.ts'),
      'utf8',
    );
    expect(config).not.toContain('tests/sandbox/limits.test.ts');
    expect(config).not.toContain('tests/sandbox/network-denied.test.ts');
    expect(config).not.toContain(
      'tests/tools/execute-command-security.test.ts',
    );
  });

  it('owns every executable Phase 1 TypeScript source exactly once', () => {
    const assigned = new Map<string, string[]>();
    for (const [moduleName, module] of Object.entries(mutationModules)) {
      expect(module.mutate.length, moduleName).toBeGreaterThan(0);
      expect(module.minimum, moduleName).toBeGreaterThanOrEqual(85);
      for (const sourceFile of module.mutate) {
        const owners = assigned.get(sourceFile) ?? [];
        owners.push(moduleName);
        assigned.set(sourceFile, owners);
        expect(
          readFileSync(join(harnessRoot, sourceFile), 'utf8').length,
          `${moduleName}: ${sourceFile}`,
        ).toBeGreaterThan(0);
      }
    }

    const executableSources = [
      'harness.ts',
      ...globSync(
        '{gateway,router,tools,skills,security,vfs,runtime,session,verification,domains,ingestion,research,writing,planning,personal_assistant,ui}/**/*.ts',
        { cwd: harnessRoot },
      ),
    ]
      .filter(
        (sourceFile) =>
          !sourceFile.endsWith('/index.ts') &&
          !sourceFile.endsWith('.d.ts') &&
          sourceFile !== 'runtime/reasoning-strategy.ts',
      )
      .sort();
    expect([...assigned.keys()].sort()).toEqual(executableSources);
    for (const [sourceFile, owners] of assigned) {
      expect(owners, `${sourceFile} has duplicate owners`).toHaveLength(1);
    }
  });

  it('keeps the declared aggregate and critical-module floors', () => {
    expect(phase1Minimum).toBe(85);
    for (const name of [
      'router',
      'toolsRegistry',
      'actionControl',
      'identitySecrets',
      'vfs',
      'sandbox',
      'session',
      'runtime',
    ] as const) {
      expect(mutationModules[name]!.minimum, name).toBe(90);
    }
    expect(mutationModules.toolsLeaf!.perFileMinimum).toBe(80);
    expect(mutationModules.verticals!.perFileMinimum).toBe(80);
  });
});

describe('atomic mutation run ownership', () => {
  it('rejects a second runner and only lets the owner release the lock', () => {
    const root = temporaryRoot();
    const lockPath = join(root, '.phase1.lock');
    const first = {
      run_id: 'first',
      pid: 11,
      commit_sha: 'a'.repeat(40),
      started_at: '2026-07-25T00:00:00.000Z',
    };
    acquireRunLock(lockPath, first);

    expect(() =>
      acquireRunLock(lockPath, { ...first, run_id: 'second', pid: 12 }),
    ).toThrow(/already running/u);
    expect(() => releaseRunLock(lockPath, 'second')).toThrow(/not own/u);
    releaseRunLock(lockPath, 'first');
    acquireRunLock(lockPath, { ...first, run_id: 'third' });
  });
});

describe('equivalent mutant governance', () => {
  it('rejects malformed, agent-reviewed, stale or security-critical waivers', () => {
    const root = temporaryRoot();
    const path = join(root, 'equivalent-mutants.json');
    const base = {
      strykerMutantId: '42',
      module: 'gateway',
      sourceFile: 'gateway/model-gateway.ts',
      reason: 'Compiler-equivalent branch proved by generated code.',
      reviewedBy: 'human@example.com',
      reviewedAt: '2026-07-25T00:00:00.000Z',
      commitSha: 'a'.repeat(40),
      configurationHash: 'b'.repeat(64),
    };

    writeFileSync(path, JSON.stringify([{ ...base, reviewedBy: 'agent' }]));
    expect(() =>
      loadEquivalentMutants(path, base.commitSha, base.configurationHash),
    ).toThrow(/human reviewer/u);

    writeFileSync(path, JSON.stringify([{ ...base, module: 'actionControl' }]));
    expect(() =>
      loadEquivalentMutants(path, base.commitSha, base.configurationHash),
    ).toThrow(/cannot be waived/u);

    writeFileSync(
      path,
      JSON.stringify([{ ...base, commitSha: 'd'.repeat(40) }]),
    );
    expect(() =>
      loadEquivalentMutants(path, base.commitSha, base.configurationHash),
    ).toThrow(/current commit/u);

    writeFileSync(path, '{');
    expect(() =>
      loadEquivalentMutants(path, base.commitSha, base.configurationHash),
    ).toThrow(/valid JSON/u);
  });

  it('accepts only a complete, human-reviewed, run-bound waiver', () => {
    const root = temporaryRoot();
    const path = join(root, 'equivalent-mutants.json');
    const commitSha = 'a'.repeat(40);
    const configurationHash = 'b'.repeat(64);
    writeFileSync(
      path,
      JSON.stringify([
        {
          strykerMutantId: '42',
          module: 'gateway',
          sourceFile: 'gateway/model-gateway.ts',
          reason: 'Compiler-equivalent branch proved by generated code.',
          reviewedBy: 'human@example.com',
          reviewedAt: '2026-07-25T00:00:00.000Z',
          commitSha,
          configurationHash,
        },
      ]),
    );
    expect(loadEquivalentMutants(path, commitSha, configurationHash)).toEqual(
      new Set(['gateway:gateway/model-gateway.ts:42']),
    );
  });
});

describe('Phase 1 mutation report integrity', () => {
  it('hashes every mutation authority and changes if one changes', () => {
    const root = temporaryRoot();
    mkdirSync(join(root, 'mutation'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'mutation', 'modules.mjs'), 'modules-a');
    writeFileSync(join(root, 'mutation', 'thresholds.json'), '{}');
    writeFileSync(join(root, 'mutation', 'stryker.base.mjs'), 'base');
    writeFileSync(join(root, 'mutation', 'equivalent-mutants.json'), '[]');
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, 'scripts', 'run-mutation.mjs'), 'runner');
    writeFileSync(
      join(root, 'scripts', 'check-mutation-thresholds.mjs'),
      'checker',
    );
    writeFileSync(join(root, 'vitest.mutation.config.ts'), 'vitest');

    const first = computeMutationConfigurationHash(root);
    writeFileSync(join(root, 'vitest.mutation.config.ts'), 'changed');
    expect(computeMutationConfigurationHash(root)).not.toBe(first);
  });

  it('requires all 15 modules from one run, commit and configuration', () => {
    const runId = 'run-1';
    const commitSha = 'a'.repeat(40);
    const configurationHash = 'b'.repeat(64);
    const results = Object.keys(mutationModules).map((moduleName) =>
      passingModuleResult(
        moduleName as keyof typeof mutationModules,
        runId,
        commitSha,
        configurationHash,
      ),
    );
    const report = buildPhase1Report(
      { runId, commitSha, configurationHash },
      results,
    );

    expect(() =>
      validatePhase1Report(report, { runId, commitSha, configurationHash }),
    ).not.toThrow();
    expect(report.modules).toHaveLength(15);

    expect(() =>
      validatePhase1Report(
        { ...report, modules: report.modules.slice(1) },
        { runId, commitSha, configurationHash },
      ),
    ).toThrow(/module set/u);

    const mixed = structuredClone(report);
    mixed.modules[0]!.commit_sha = 'd'.repeat(40);
    expect(() =>
      validatePhase1Report(mixed, { runId, commitSha, configurationHash }),
    ).toThrow(/commit/u);
  });

  it('fails aggregate acceptance when a per-file floor fails', () => {
    const runId = 'run-1';
    const commitSha = 'a'.repeat(40);
    const configurationHash = 'b'.repeat(64);
    const results = Object.keys(mutationModules).map((moduleName) =>
      passingModuleResult(
        moduleName as keyof typeof mutationModules,
        runId,
        commitSha,
        configurationHash,
      ),
    );
    const toolsLeaf = results.find((result) => result.module === 'toolsLeaf')!;
    const firstFile = Object.keys(toolsLeaf.per_file)[0]!;
    toolsLeaf.per_file[firstFile]!.score = 79.99;
    toolsLeaf.per_file[firstFile]!.status = 'FAIL';
    toolsLeaf.status = 'FAIL';

    const report = buildPhase1Report(
      { runId, commitSha, configurationHash },
      results,
    );
    expect(report.aggregate.status).toBe('FAIL');
    expect(() =>
      validatePhase1Report(report, { runId, commitSha, configurationHash }),
    ).toThrow(/not passing/u);
  });
});
