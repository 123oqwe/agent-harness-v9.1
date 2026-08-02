import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Instrumenter } from '@stryker-mutator/instrumenter';

const root = resolve(import.meta.dirname, '../..');
const {
  buildPhase1Report,
  mergeChunkReports,
  planMutationChunks,
} = await import(
  // @ts-expect-error The mutation runner is intentionally plain ESM for Node.
  '../../scripts/run-mutation.mjs'
);
const { mutationModules: rawMutationModules } = await import(
  // @ts-expect-error The mutation manifest is intentionally plain ESM for Node.
  '../../mutation/modules.mjs'
);
const { strykerBase } = await import(
  // @ts-expect-error The Stryker base is intentionally plain ESM for Node.
  '../../mutation/stryker.base.mjs'
);

interface MutationModule {
  mutate: string[];
  minimum: number;
  perFileMinimum?: number;
}

interface Chunk {
  chunk_id: string;
  source_file: string;
  start_line: number;
  end_line: number;
  mutate_pattern: string;
}

interface ChunkEvidence extends Chunk {
  raw_report_sha256: string;
  config_sha256: string;
  mutant_count: number;
}

interface ModuleEvidence {
  module: string;
  source_files: string[];
  chunks: ChunkEvidence[];
  raw_report_sha256: string;
  counts: ReturnType<typeof counts>;
  per_file: Record<string, ReturnType<typeof counts> & {
    score: number;
    minimum: number;
    status: string;
  }>;
  score: number;
}

interface Checker {
  validatePublishedPhase1ArtifactContents: (input: {
    report: Record<string, unknown>;
    artifactEntries: Map<string, string>;
    commitSources: Map<string, string>;
    commitSha: string;
    configurationHash: string;
    waiverKeys: Set<string>;
    attestation: Record<string, unknown>;
    expectedArtifactDigest: string;
    independentMutants: Map<string, Array<Record<string, unknown>>>;
  }) => boolean;
}

const mutationModules = rawMutationModules as Record<string, MutationModule>;
const silentLogger = new Proxy(
  {},
  {
    get: (_target, property) =>
      String(property).startsWith('is') ? () => false : () => {},
  },
);

const enumeratedChunks = (async () => {
  const instrumenter = new Instrumenter(silentLogger as never);
  const enumerated = new Map<string, Array<Record<string, unknown>>>();
  for (const [moduleName, module] of Object.entries(mutationModules)) {
    for (const chunk of planMutationChunks(module.mutate, root, 150) as Chunk[]) {
      const source = readFileSync(join(root, chunk.source_file), 'utf8');
      const result = await instrumenter.instrument(
        [
          {
            name: chunk.source_file,
            content: source,
            mutate: [
              {
                start: { line: chunk.start_line - 1, column: 0 },
                end: {
                  line: chunk.end_line - 1,
                  column: Number.MAX_SAFE_INTEGER,
                },
              },
            ],
          },
        ],
        { plugins: null, ignorers: [], excludedMutations: [] },
      );
      enumerated.set(
        `${moduleName}/${chunk.chunk_id}`,
        result.mutants.map(({ id, mutatorName, replacement, location }) => ({
          id,
          mutatorName,
          replacement,
          location: {
            start: {
              line: location.start.line + 1,
              column: location.start.column + 1,
            },
            end: {
              line: location.end.line + 1,
              column: location.end.column + 1,
            },
          },
          status: 'Killed',
        })),
      );
    }
  }
  return enumerated;
})();

async function loadChecker(): Promise<Checker> {
  return (await import(
    // @ts-expect-error The checker is intentionally plain ESM for Node.
    '../../scripts/check-mutation-thresholds.mjs'
  )) as Checker;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function counts(total: number) {
  return {
    total,
    killed: total,
    timeout: 0,
    survived: 0,
    noCoverage: 0,
    ignored: 0,
  };
}

function configFor(moduleName: string, module: MutationModule, chunk: Chunk, runId: string) {
  const chunkRoot = `reports/mutation/runs/${runId}/${moduleName}/chunks/${chunk.chunk_id}`;
  return {
    ...strykerBase,
    mutate: [chunk.mutate_pattern],
    tempDirName: `.stryker-tmp/${runId}/${moduleName}/${chunk.chunk_id}`,
    jsonReporter: { fileName: `${chunkRoot}/mutation.json` },
    htmlReporter: { fileName: `${chunkRoot}/mutation.html` },
    ...(moduleName === 'sandbox'
      ? { concurrency: 1, timeoutMS: 60_000 }
      : {}),
    thresholds: {
      high: module.minimum,
      low: Math.max(0, module.minimum - 5),
      break: null,
    },
  };
}

async function artifactFixture() {
  const exactMutants = await enumeratedChunks;
  const runId =
    '2026-08-02T00-00-00-000Z-11111111-1111-4111-8111-111111111111';
  const commitSha = 'a'.repeat(40);
  const configurationHash = 'b'.repeat(64);
  const artifactDigest = 'c'.repeat(64);
  const artifactEntries = new Map<string, string>();
  const commitSources = new Map<string, string>();
  const independentMutants = new Map<string, Array<Record<string, unknown>>>();
  const results = Object.entries(mutationModules).map(([moduleName, module]) => {
    const chunks = planMutationChunks(module.mutate, root, 150) as Chunk[];
    const chunkReports: Array<Record<string, unknown>> = [];
    const chunkEvidence = chunks.map((chunk) => {
      const source = readFileSync(join(root, chunk.source_file), 'utf8');
      commitSources.set(chunk.source_file, source);
      const mutants = structuredClone(
        exactMutants.get(`${moduleName}/${chunk.chunk_id}`)!,
      );
      const raw = {
        schemaVersion: '1.0',
        files: {
          [chunk.source_file]: {
            language: 'typescript',
            source,
            mutants,
          },
        },
      };
      chunkReports.push(raw);
      independentMutants.set(
        `${moduleName}/${chunk.chunk_id}`,
        structuredClone(mutants),
      );
      const chunkRoot = `runs/${runId}/${moduleName}/chunks/${chunk.chunk_id}`;
      const rawText = json(raw);
      const configText = json(configFor(moduleName, module, chunk, runId));
      artifactEntries.set(`${chunkRoot}/mutation.json`, rawText);
      artifactEntries.set(`${chunkRoot}/stryker.config.json`, configText);
      return {
        chunk_id: chunk.chunk_id,
        source_file: chunk.source_file,
        start_line: chunk.start_line,
        end_line: chunk.end_line,
        raw_report_sha256: sha256(rawText),
        config_sha256: sha256(configText),
        mutant_count: mutants.length,
      };
    });
    const merged = mergeChunkReports(chunks, chunkReports, root);
    const mergedText = json(merged);
    artifactEntries.set(`runs/${runId}/${moduleName}/mutation.json`, mergedText);
    const perFileTotals = new Map<string, number>();
    for (const chunk of chunks) {
      perFileTotals.set(
        chunk.source_file,
        (perFileTotals.get(chunk.source_file) ?? 0) +
          exactMutants.get(`${moduleName}/${chunk.chunk_id}`)!.length,
      );
    }
    const moduleTotal = [...perFileTotals.values()].reduce(
      (sum, total) => sum + total,
      0,
    );
    return {
      schema_version: 1,
      run_id: runId,
      commit_sha: commitSha,
      configuration_hash: configurationHash,
      module: moduleName,
      source_files: [...module.mutate].sort(),
      minimum: module.minimum,
      score: 100,
      status: 'PASS',
      counts: counts(moduleTotal),
      per_file: Object.fromEntries(
        [...perFileTotals].map(([sourceFile, total]) => [
          sourceFile,
          {
            ...counts(total),
            score: total === 0 ? 0 : 100,
            minimum: module.perFileMinimum ?? 0,
            status: 'PASS',
          },
        ]),
      ),
      chunks: chunkEvidence,
      raw_report_sha256: sha256(mergedText),
      started_at: '2026-08-02T00:00:00.000Z',
      completed_at: '2026-08-02T00:01:00.000Z',
    };
  });
  const report = buildPhase1Report(
    {
      runId,
      commitSha,
      configurationHash,
      startedAt: '2026-08-02T00:00:00.000Z',
    },
    results,
  );
  report.completed_at = '2026-08-02T00:02:00.000Z';
  const phase1Text = json(report);
  artifactEntries.set(`runs/${runId}/phase1.json`, phase1Text);
  artifactEntries.set('phase1/mutation.json', phase1Text);
  const attestation = {
    schema_version: 1,
    workflow_sha: commitSha,
    artifact_name: `phase1-mutation-${commitSha}`,
    artifact_digest: artifactDigest,
    run_id: runId,
    configuration_hash: configurationHash,
    phase1_report_sha256: sha256(phase1Text),
  };
  return {
    runId,
    commitSha,
    configurationHash,
    artifactDigest,
    artifactEntries,
    commitSources,
    report,
    attestation,
    independentMutants,
  };
}

type ArtifactFixture = Awaited<ReturnType<typeof artifactFixture>>;

function input(fixture: ArtifactFixture) {
  return {
    report: fixture.report,
    artifactEntries: fixture.artifactEntries,
    commitSources: fixture.commitSources,
    commitSha: fixture.commitSha,
    configurationHash: fixture.configurationHash,
    waiverKeys: new Set<string>(),
    attestation: fixture.attestation,
    expectedArtifactDigest: fixture.artifactDigest,
    independentMutants: fixture.independentMutants,
  };
}

function firstChunk(fixture: ArtifactFixture) {
  const modules = fixture.report.modules as ModuleEvidence[];
  const result = modules.find((candidate) =>
    candidate.chunks.some((chunk) => chunk.mutant_count > 1),
  )!;
  const chunk = result.chunks.find((candidate) => candidate.mutant_count > 1)!;
  const base = `runs/${fixture.runId}/${result.module}/chunks/${chunk.chunk_id}`;
  return { result, chunk, rawPath: `${base}/mutation.json` };
}

function refreshPhase1Report(fixture: ArtifactFixture): void {
  const text = json(fixture.report);
  fixture.artifactEntries.set('phase1/mutation.json', text);
  fixture.artifactEntries.set(`runs/${fixture.runId}/phase1.json`, text);
  fixture.attestation.phase1_report_sha256 = sha256(text);
}

function rebuildModuleClaims(
  fixture: ArtifactFixture,
  result: ModuleEvidence,
): void {
  const chunks = result.chunks.map((chunk) => ({
    ...chunk,
    mutate_pattern: `${chunk.source_file}:${chunk.start_line}-${chunk.end_line}`,
  }));
  const rawReports = chunks.map((chunk) => {
    const path =
      `runs/${fixture.runId}/${result.module}/chunks/${chunk.chunk_id}` +
      '/mutation.json';
    return JSON.parse(fixture.artifactEntries.get(path)!);
  });
  const merged = mergeChunkReports(chunks, rawReports, root);
  const mergedText = json(merged);
  fixture.artifactEntries.set(
    `runs/${fixture.runId}/${result.module}/mutation.json`,
    mergedText,
  );
  result.raw_report_sha256 = sha256(mergedText);
  const module = mutationModules[result.module]!;
  const perFile = Object.fromEntries(
    result.source_files.map((sourceFile) => {
      const total = merged.files[sourceFile].mutants.length;
      return [
        sourceFile,
        {
          ...counts(total),
          score: total === 0 ? 0 : 100,
          minimum: module.perFileMinimum ?? 0,
          status: 'PASS',
        },
      ];
    }),
  );
  const total = Object.values(perFile).reduce(
    (sum, file) => sum + file.total,
    0,
  );
  result.counts = counts(total);
  result.per_file = perFile;
  result.score = total === 0 ? 0 : 100;
  const rebuilt = buildPhase1Report(
    {
      runId: fixture.runId,
      commitSha: fixture.commitSha,
      configurationHash: fixture.configurationHash,
      startedAt: fixture.report.started_at,
    },
    fixture.report.modules,
  );
  fixture.report.aggregate = rebuilt.aggregate;
  refreshPhase1Report(fixture);
}

describe('published Phase 1 mutation artifact integrity', () => {
  it('accepts only exact raw chunks, configs, merged reports, and workflow digest attestation', async () => {
    const checker = await loadChecker();
    const fixture = await artifactFixture();
    expect(() =>
      checker.validatePublishedPhase1ArtifactContents(input(fixture)),
    ).not.toThrow();

    const missing = await artifactFixture();
    missing.artifactEntries.delete(firstChunk(missing).rawPath);
    expect(() =>
      checker.validatePublishedPhase1ArtifactContents(input(missing)),
    ).toThrow(/chunk raw report missing/u);

    const badDigest = await artifactFixture();
    badDigest.attestation.artifact_digest = 'd'.repeat(64);
    expect(() =>
      checker.validatePublishedPhase1ArtifactContents(input(badDigest)),
    ).toThrow(/artifact digest attestation/u);
  });

  it('rejects duplicate mutant IDs and locations outside the exact chunk range', async () => {
    const checker = await loadChecker();
    const duplicate = await artifactFixture();
    const duplicateChunk = firstChunk(duplicate);
    const duplicateRaw = JSON.parse(
      duplicate.artifactEntries.get(duplicateChunk.rawPath)!,
    );
    const duplicateMutants = duplicateRaw.files[duplicateChunk.chunk.source_file].mutants;
    duplicateMutants.push(structuredClone(duplicateMutants[0]));
    const duplicateText = json(duplicateRaw);
    duplicate.artifactEntries.set(duplicateChunk.rawPath, duplicateText);
    duplicateChunk.chunk.raw_report_sha256 = sha256(duplicateText);
    refreshPhase1Report(duplicate);
    expect(() =>
      checker.validatePublishedPhase1ArtifactContents(input(duplicate)),
    ).toThrow(/duplicate mutant ID/u);

    const outside = await artifactFixture();
    const outsideChunk = firstChunk(outside);
    const outsideRaw = JSON.parse(outside.artifactEntries.get(outsideChunk.rawPath)!);
    outsideRaw.files[outsideChunk.chunk.source_file].mutants[0].location.start.line =
      outsideChunk.chunk.end_line + 1;
    const outsideText = json(outsideRaw);
    outside.artifactEntries.set(outsideChunk.rawPath, outsideText);
    outsideChunk.chunk.raw_report_sha256 = sha256(outsideText);
    refreshPhase1Report(outside);
    expect(() =>
      checker.validatePublishedPhase1ArtifactContents(input(outside)),
    ).toThrow(/outside chunk range/u);
  });

  it('rejects a forged one-mutant merged report even when its claimed hash is updated', async () => {
    const checker = await loadChecker();
    const fixture = await artifactFixture();
    const { result } = firstChunk(fixture);
    const mergedPath = `runs/${fixture.runId}/${result.module}/mutation.json`;
    const merged = JSON.parse(fixture.artifactEntries.get(mergedPath)!);
    const firstFile = Object.keys(merged.files)[0]!;
    merged.files = {
      [firstFile]: {
        ...merged.files[firstFile],
        mutants: merged.files[firstFile].mutants.slice(0, 1),
      },
    };
    const forgedText = json(merged);
    fixture.artifactEntries.set(mergedPath, forgedText);
    result.raw_report_sha256 = sha256(forgedText);
    refreshPhase1Report(fixture);
    expect(() =>
      checker.validatePublishedPhase1ArtifactContents(input(fixture)),
    ).toThrow(/merged raw report reconstruction/u);
  });

  it('rejects a missing mutant even when every artifact claim is internally consistent', async () => {
    const checker = await loadChecker();
    const fixture = await artifactFixture();
    const { result, chunk, rawPath } = firstChunk(fixture);
    const raw = JSON.parse(fixture.artifactEntries.get(rawPath)!);
    raw.files[chunk.source_file].mutants.splice(0, 1);
    const rawText = json(raw);
    fixture.artifactEntries.set(rawPath, rawText);
    chunk.raw_report_sha256 = sha256(rawText);
    chunk.mutant_count -= 1;
    rebuildModuleClaims(fixture, result);
    expect(() =>
      checker.validatePublishedPhase1ArtifactContents(input(fixture)),
    ).toThrow(/independent mutant enumeration/u);
  });
});
