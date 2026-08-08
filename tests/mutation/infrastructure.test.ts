import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const {
  acquireRunLock,
  buildPhase1Report,
  computeMutationConfigurationHash,
  mutationAuthorityFiles,
  loadEquivalentMutants,
  mergeChunkReports,
  planMutationChunks,
  releaseRunLock,
  resolveChunkTimeoutMs,
  resolveMutationTarget,
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
const { phase2MutationRequirements } = await import(
  // @ts-expect-error The Phase 2 execution registry is intentionally plain ESM.
  '../../mutation/phase2-modules.mjs'
);
const { strykerBase } = await import(
  // @ts-expect-error The Stryker configuration is intentionally plain ESM.
  '../../mutation/stryker.base.mjs'
);

const harnessRoot = resolve(import.meta.dirname, '..', '..');
const temporaryRoots: string[] = [];
interface MutationModule {
  mutate: string[];
  minimum: number;
  perFileMinimum?: number;
  chunkTimeoutMs?: number;
}
const mutationModules = rawMutationModules as Record<string, MutationModule>;
const phase1Minimum = rawPhase1Minimum as number;

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ah-mutation-infra-'));
  temporaryRoots.push(root);
  return root;
}

function listTypeScriptSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptSources(path);
    if (!entry.isFile() || !entry.name.endsWith('.ts')) return [];
    return [relative(harnessRoot, path).split(sep).join('/')];
  });
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
    chunks: planMutationChunks(module.mutate, harnessRoot, 150).map(
      (chunk: {
        chunk_id: string;
        source_file: string;
        start_line: number;
        end_line: number;
      }) => ({
        chunk_id: chunk.chunk_id,
        source_file: chunk.source_file,
        start_line: chunk.start_line,
        end_line: chunk.end_line,
      }),
    ),
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

  it('patches Vitest mutation workers to use isolated forks', () => {
    const patch = readFileSync(
      join(
        harnessRoot,
        'patches',
        '@stryker-mutator+vitest-runner+9.6.1.patch',
      ),
      'utf8',
    );
    expect(patch).toContain("+            pool: 'forks'");
    expect(patch).toContain('+            fileParallelism: false');
    expect(patch).toContain("-            pool: 'threads'");
    expect(strykerBase.concurrency).toBe(2);
  });

  it('keeps generated mutation state out of every Stryker sandbox', () => {
    expect(strykerBase.ignorePatterns).toEqual(
      expect.arrayContaining(['/reports', '.stryker-tmp']),
    );
  });

  it('keeps static mutants static when a testFiles filter narrows the suite', () => {
    const patch = readFileSync(
      join(harnessRoot, 'patches', '@stryker-mutator+core+9.6.1.patch'),
      'utf8',
    );
    expect(patch).toContain(
      "mutantActivation: isStatic ? 'static' : testFilter ? 'runtime' : 'static'",
    );
  });

  it('owns every executable Phase 1 TypeScript source exactly once', () => {
    const phase2OwnedSources = new Set<string>(
      phase2MutationRequirements.flatMap(
        (requirement: { sources: readonly string[] }) => requirement.sources,
      ),
    );
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
      ...[
        'gateway',
        'router',
        'tools',
        'skills',
        'security',
        'vfs',
        'runtime',
        'sandbox',
        'session',
        'verification',
        'domains',
        'ingestion',
        'ui',
      ].flatMap((directory) =>
        listTypeScriptSources(join(harnessRoot, directory)),
      ),
    ]
      .filter(
        (sourceFile) =>
          !sourceFile.endsWith('/index.ts') &&
          !sourceFile.endsWith('.d.ts') &&
          sourceFile !== 'session/session-store.ts' &&
          sourceFile !== 'runtime/reasoning-strategy.ts' &&
          sourceFile !== 'ui/ui-state.ts' &&
          !phase2OwnedSources.has(sourceFile),
      )
      .sort();
    expect([...assigned.keys()].sort()).toEqual(executableSources);
    expect(
      [...assigned.keys()].filter((source) => phase2OwnedSources.has(source)),
    ).toEqual([]);
    for (const [sourceFile, owners] of assigned) {
      expect(owners, `${sourceFile} has duplicate owners`).toHaveLength(1);
    }
  });

  it('does not send the type-only session facade to Stryker', () => {
    expect(mutationModules.session!.mutate).not.toContain(
      'session/session-store.ts',
    );
    expect(
      readFileSync(join(harnessRoot, 'session', 'session-store.ts'), 'utf8'),
    ).toMatch(
      /^\/\*\*[\s\S]*\*\/\s*export \{[\s\S]*\} from ['"][^'"]+['"];\s*export type \{/u,
    );
  });

  it('does not send the type-only UI result contract to Stryker', () => {
    expect(mutationModules.uiAdapters!.mutate).not.toContain('ui/ui-state.ts');
    expect(
      readFileSync(join(harnessRoot, 'ui', 'ui-state.ts'), 'utf8'),
    ).toMatch(/export type UiState[\s\S]*export interface UiResult/u);
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

  it('gives only the known heavy modules a 30-minute chunk timeout', () => {
    expect(resolveChunkTimeoutMs('gateway')).toBe(30 * 60 * 1000);
    expect(resolveChunkTimeoutMs('router')).toBe(30 * 60 * 1000);
    expect(resolveChunkTimeoutMs('toolsRegistry')).toBe(30 * 60 * 1000);
    for (const moduleName of Object.keys(mutationModules).filter(
      (name) => name !== 'gateway' && name !== 'router' && name !== 'toolsRegistry' && name !== 'session',
    )) {
      expect(resolveChunkTimeoutMs(moduleName), moduleName).toBe(
        15 * 60 * 1000,
      );
    }
    expect(() => resolveChunkTimeoutMs('toString')).toThrow(/unknown/u);
  });

  it('rejects unknown mutation targets before creating a run', () => {
    expect(() => resolveMutationTarget('unknown-module')).toThrow(
      /unknown mutation target/u,
    );
    expect(() => resolveMutationTarget('toString')).toThrow(
      /unknown mutation target/u,
    );

    const result = spawnSync(
      process.execPath,
      ['scripts/run-mutation.mjs', 'unknown-module'],
      { cwd: harnessRoot, encoding: 'utf8', shell: false },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'FATAL: unknown mutation target: unknown-module',
    );
  });

  it('offers phase1 and every single module as dispatch targets', () => {
    const workflow = readFileSync(
      join(harnessRoot, '.github', 'workflows', 'mutation.yml'),
      'utf8',
    );
    expect(workflow).toContain('target:');
    expect(workflow).toContain('type: choice');
    for (const target of ['phase1', ...Object.keys(mutationModules)]) {
      expect(workflow, target).toContain(`- ${target}`);
    }
    expect(workflow).toContain(
      'node scripts/run-mutation.mjs "$MUTATION_TARGET"',
    );
    expect(workflow).toContain(
      'name: mutation-${{ inputs.target }}-${{ github.sha }}',
    );
    expect(workflow).toContain('timeout-minutes: 360');
    expect(workflow).not.toContain('name: phase1-mutation-${{ github.sha }}');
  });
});

describe('atomic mutation run ownership', () => {
  it('rejects a second runner and only lets the owner release the lock', () => {
    const root = temporaryRoot();
    const lockPath = join(root, '.phase1.lock');
    const first = {
      run_id: 'first',
      pid: process.pid,
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

  it('recovers a lock owned by a dead process on this host', () => {
    const root = temporaryRoot();
    const lockPath = join(root, '.phase1.lock');
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, 'owner.json'),
      JSON.stringify({
        run_id: 'dead',
        pid: 2_147_483_647,
        hostname: hostname(),
      }),
    );
    const next = {
      run_id: 'next',
      pid: process.pid,
      commit_sha: 'a'.repeat(40),
      started_at: '2026-07-25T00:00:00.000Z',
    };
    acquireRunLock(lockPath, next);
    expect(
      JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')).run_id,
    ).toBe('next');
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
  it('partitions every source line into deterministic non-overlapping chunks', () => {
    const root = temporaryRoot();
    mkdirSync(join(root, 'gateway'), { recursive: true });
    writeFileSync(join(root, 'gateway', 'provider.ts'), '1\n2\n3\n4\n5\n');

    expect(planMutationChunks(['gateway/provider.ts'], root, 2)).toEqual([
      {
        chunk_id: 'gateway-provider-ts-1-2',
        source_file: 'gateway/provider.ts',
        start_line: 1,
        end_line: 2,
        mutate_pattern: 'gateway/provider.ts:1-2',
      },
      {
        chunk_id: 'gateway-provider-ts-3-4',
        source_file: 'gateway/provider.ts',
        start_line: 3,
        end_line: 4,
        mutate_pattern: 'gateway/provider.ts:3-4',
      },
      {
        chunk_id: 'gateway-provider-ts-5-5',
        source_file: 'gateway/provider.ts',
        start_line: 5,
        end_line: 5,
        mutate_pattern: 'gateway/provider.ts:5-5',
      },
    ]);
  });

  it('merges chunk reports without dropping or double-counting mutants', () => {
    const chunks = [
      {
        chunk_id: 'chunk-a',
        source_file: 'gateway/provider.ts',
        start_line: 1,
        end_line: 2,
        mutate_pattern: 'gateway/provider.ts:1-2',
      },
      {
        chunk_id: 'chunk-b',
        source_file: 'gateway/provider.ts',
        start_line: 3,
        end_line: 4,
        mutate_pattern: 'gateway/provider.ts:3-4',
      },
    ];
    const firstMutant = {
      id: '0',
      mutatorName: 'StringLiteral',
      replacement: '""',
      status: 'Killed',
      location: {
        start: { line: 1, column: 1 },
        end: { line: 1, column: 4 },
      },
    };
    const secondMutant = {
      id: '0',
      mutatorName: 'BooleanLiteral',
      replacement: 'false',
      status: 'Survived',
      location: {
        start: { line: 3, column: 1 },
        end: { line: 3, column: 5 },
      },
    };
    const report = (mutants: unknown[]) => ({
      schemaVersion: '1.0',
      files: {
        'gateway/provider.ts': {
          language: 'typescript',
          source: 'const one = true;\nconst two = true;',
          mutants,
        },
      },
    });

    const merged = mergeChunkReports(chunks, [
      report([firstMutant]),
      report([secondMutant, secondMutant]),
    ]);
    const mutants = merged.files['gateway/provider.ts']!.mutants;
    expect(mutants).toHaveLength(2);
    expect(mutants.map((mutant: { id: string }) => mutant.id)).toEqual([
      'chunk-a:0',
      'chunk-b:0',
    ]);
  });

  it('accepts an empty chunk report when another chunk covers the source', () => {
    const chunks = [
      {
        chunk_id: 'chunk-empty',
        source_file: 'gateway/provider.ts',
        start_line: 1,
        end_line: 2,
        mutate_pattern: 'gateway/provider.ts:1-2',
      },
      {
        chunk_id: 'chunk-mutants',
        source_file: 'gateway/provider.ts',
        start_line: 3,
        end_line: 4,
        mutate_pattern: 'gateway/provider.ts:3-4',
      },
    ];
    const reportWithMutant = {
      schemaVersion: '1.0',
      files: {
        'gateway/provider.ts': {
          language: 'typescript',
          source: 'const one = true;\nconst two = true;',
          mutants: [
            {
              id: '0',
              mutatorName: 'BooleanLiteral',
              replacement: 'false',
              status: 'Killed',
              location: {
                start: { line: 3, column: 1 },
                end: { line: 3, column: 5 },
              },
            },
          ],
        },
      },
    };

    const merged = mergeChunkReports(chunks, [
      { schemaVersion: '1.0', files: {} },
      reportWithMutant,
    ]);

    expect(Object.keys(merged.files)).toEqual(['gateway/provider.ts']);
    expect(merged.files['gateway/provider.ts']!.mutants).toHaveLength(1);
  });

  it('records an all-empty source file instead of dropping it', () => {
    const root = temporaryRoot();
    mkdirSync(join(root, 'gateway'), { recursive: true });
    writeFileSync(join(root, 'gateway', 'empty.ts'), 'export {};\n');
    const chunks = [
      {
        chunk_id: 'chunk-empty',
        source_file: 'gateway/empty.ts',
        start_line: 1,
        end_line: 1,
        mutate_pattern: 'gateway/empty.ts:1-1',
      },
    ];

    const merged = mergeChunkReports(
      chunks,
      [{ schemaVersion: '1.0', files: {} }],
      root,
    );

    expect(merged.files['gateway/empty.ts']).toEqual({
      language: 'typescript',
      source: 'export {};\n',
      mutants: [],
    });
  });

  it('hashes every mutation authority and changes if one changes', () => {
    const root = temporaryRoot();
    mkdirSync(join(root, 'mutation'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'mutation', 'modules.mjs'), 'modules-a');
    writeFileSync(join(root, 'mutation', 'thresholds.json'), '{}');
    writeFileSync(join(root, 'mutation', 'stryker.base.mjs'), 'base');
    writeFileSync(join(root, 'mutation', 'equivalent-mutants.json'), '[]');
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, 'package-lock.json'), '{}');
    mkdirSync(join(root, 'patches'), { recursive: true });
    writeFileSync(
      join(root, 'patches', '@stryker-mutator+core+9.6.1.patch'),
      'static-activation-patch',
    );
    writeFileSync(
      join(root, 'patches', '@stryker-mutator+vitest-runner+9.6.1.patch'),
      'fork-patch',
    );
    writeFileSync(join(root, 'scripts', 'run-mutation.mjs'), 'runner');
    writeFileSync(join(root, 'scripts', 'run-process-tree.mjs'), 'tree-runner');
    writeFileSync(
      join(root, 'scripts', 'check-mutation-thresholds.mjs'),
      'checker',
    );
    writeFileSync(join(root, 'scripts', 'repository-paths.mjs'), 'paths');
    writeFileSync(join(root, 'scripts', 'trusted-git.mjs'), 'trusted-git');
    writeFileSync(join(root, 'scripts', 'secure-release-io.mjs'), 'secure-js');
    writeFileSync(join(root, 'scripts', 'secure-release-io.py'), 'secure-py');
    writeFileSync(join(root, 'vitest.mutation.config.ts'), 'vitest');
    mkdirSync(join(root, 'benchmarks', 'phase1'), { recursive: true });
    writeFileSync(
      join(root, 'benchmarks', 'phase1', 'final-evidence.schema.json'),
      'final-schema',
    );

    const first = computeMutationConfigurationHash(root);
    writeFileSync(
      join(root, 'mutation', 'modules.mjs'),
      'modules-a\nexport const gatewayChunkTimeoutMs = 1800000;',
    );
    expect(computeMutationConfigurationHash(root)).not.toBe(first);
  });

  it('binds the independent verifier and secure object readers into mutation authority', () => {
    expect(mutationAuthorityFiles).toEqual(
      expect.arrayContaining([
        'scripts/check-mutation-thresholds.mjs',
        'scripts/run-process-tree.mjs',
        'scripts/trusted-git.mjs',
        'scripts/secure-release-io.mjs',
        'scripts/secure-release-io.py',
        'benchmarks/phase1/final-evidence.schema.json',
      ]),
    );
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

    const mixedConfiguration = structuredClone(report);
    mixedConfiguration.modules[0]!.configuration_hash = 'e'.repeat(64);
    expect(() =>
      validatePhase1Report(mixedConfiguration, {
        runId,
        commitSha,
        configurationHash,
      }),
    ).toThrow(/config/u);
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
