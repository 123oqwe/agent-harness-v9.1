import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const temporaryRoots: string[] = [];
const { buildPhase1Report, planMutationChunks } = await import(
  // @ts-expect-error The mutation runner is intentionally plain ESM for Node.
  '../../scripts/run-mutation.mjs'
);
const { mutationModules: rawMutationModules } = await import(
  // @ts-expect-error The mutation manifest is intentionally plain ESM for Node.
  '../../mutation/modules.mjs'
);

interface MutationModule {
  mutate: string[];
  minimum: number;
  perFileMinimum?: number;
}

const mutationModules = rawMutationModules as Record<string, MutationModule>;

interface PublishedArtifactInput {
  report: Record<string, unknown>;
  reportsDir: string;
  commitSha: string;
  configurationHash: string;
  waiverKeys: Set<string>;
  root: string;
}

interface Checker {
  validatePublishedPhase1Artifacts: (
    input: PublishedArtifactInput,
  ) => boolean;
}

async function loadChecker(): Promise<Checker> {
  return (await import(
    // @ts-expect-error The checker is intentionally plain ESM for Node.
    '../../scripts/check-mutation-thresholds.mjs'
  )) as Checker;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeJson(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, text);
  return text;
}

function artifactFixture() {
  const reportsDir = mkdtempSync(join(tmpdir(), 'phase1-mutation-artifact-'));
  temporaryRoots.push(reportsDir);
  const runId =
    '2026-08-02T00-00-00-000Z-11111111-1111-4111-8111-111111111111';
  const commitSha = 'a'.repeat(40);
  const configurationHash = 'b'.repeat(64);
  const results = Object.entries(mutationModules).map(([moduleName, module]) => {
    const files = Object.fromEntries(
      module.mutate.map((sourceFile) => [
        sourceFile,
        {
          language: 'typescript',
          source: readFileSync(join(root, sourceFile), 'utf8'),
          mutants: [
            {
              id: '0',
              mutatorName: 'BooleanLiteral',
              replacement: 'false',
              status: 'Killed',
              location: {
                start: { line: 1, column: 1 },
                end: { line: 1, column: 2 },
              },
            },
          ],
        },
      ]),
    );
    const raw = { schemaVersion: '1.0', files };
    const rawPath = join(reportsDir, 'runs', runId, moduleName, 'mutation.json');
    const rawText = writeJson(rawPath, raw);
    const count = module.mutate.length;
    const counts = {
      total: count,
      killed: count,
      timeout: 0,
      survived: 0,
      noCoverage: 0,
      ignored: 0,
    };
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
      counts,
      per_file: Object.fromEntries(
        module.mutate.map((sourceFile) => [
          sourceFile,
          {
            total: 1,
            killed: 1,
            timeout: 0,
            survived: 0,
            noCoverage: 0,
            ignored: 0,
            score: 100,
            minimum: module.perFileMinimum ?? 0,
            status: 'PASS',
          },
        ]),
      ),
      chunks: planMutationChunks(module.mutate, root, 150).map((chunk: {
        chunk_id: string;
        source_file: string;
        start_line: number;
        end_line: number;
      }) => ({
        chunk_id: chunk.chunk_id,
        source_file: chunk.source_file,
        start_line: chunk.start_line,
        end_line: chunk.end_line,
      })),
      raw_report_sha256: sha256(rawText),
      started_at: '2026-08-02T00:00:00.000Z',
      completed_at: '2026-08-02T00:01:00.000Z',
    };
  });
  const report = buildPhase1Report(
    { runId, commitSha, configurationHash },
    results,
  );
  return { reportsDir, runId, commitSha, configurationHash, report };
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('published Phase 1 mutation artifact integrity', () => {
  it('recomputes every raw report hash, module score, per-file score, and aggregate', async () => {
    const checker = await loadChecker();
    expect(checker.validatePublishedPhase1Artifacts).toBeTypeOf('function');
    const fixture = artifactFixture();
    const input = {
      report: fixture.report,
      reportsDir: fixture.reportsDir,
      commitSha: fixture.commitSha,
      configurationHash: fixture.configurationHash,
      waiverKeys: new Set<string>(),
      root,
    };
    expect(() => checker.validatePublishedPhase1Artifacts(input)).not.toThrow();

    const gatewayRaw = join(
      fixture.reportsDir,
      'runs',
      fixture.runId,
      'gateway',
      'mutation.json',
    );
    writeFileSync(gatewayRaw, '{}\n');
    expect(() => checker.validatePublishedPhase1Artifacts(input)).toThrow(
      /raw report hash/u,
    );

    rmSync(gatewayRaw);
    expect(() => checker.validatePublishedPhase1Artifacts(input)).toThrow(
      /raw report missing/u,
    );
  });

  it('rejects report counts that do not match untampered raw mutants', async () => {
    const checker = await loadChecker();
    expect(checker.validatePublishedPhase1Artifacts).toBeTypeOf('function');
    const fixture = artifactFixture();
    const report = structuredClone(fixture.report);
    report.modules[0].counts.killed -= 1;
    expect(() =>
      checker.validatePublishedPhase1Artifacts({
        report,
        reportsDir: fixture.reportsDir,
        commitSha: fixture.commitSha,
        configurationHash: fixture.configurationHash,
        waiverKeys: new Set<string>(),
        root,
      }),
    ).toThrow(/raw report counts/u);
  });

  it('rejects traversal run IDs and timestamps outside the run envelope', async () => {
    const checker = await loadChecker();
    const fixture = artifactFixture();
    const traversal = structuredClone(fixture.report);
    traversal.run_id = '../outside';
    expect(() =>
      checker.validatePublishedPhase1Artifacts({
        report: traversal,
        reportsDir: fixture.reportsDir,
        commitSha: fixture.commitSha,
        configurationHash: fixture.configurationHash,
        waiverKeys: new Set<string>(),
        root,
      }),
    ).toThrow(/run_id/u);

    const invalidTime = structuredClone(fixture.report);
    invalidTime.modules[0].started_at = '2026-08-01T23:59:59.000Z';
    expect(() =>
      checker.validatePublishedPhase1Artifacts({
        report: invalidTime,
        reportsDir: fixture.reportsDir,
        commitSha: fixture.commitSha,
        configurationHash: fixture.configurationHash,
        waiverKeys: new Set<string>(),
        root,
      }),
    ).toThrow(/timestamp/u);
  });
});
