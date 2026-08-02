#!/usr/bin/env node
/** Independently verifies complete Phase 1 mutation artifacts. */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { mutationModules, phase1Minimum } from '../mutation/modules.mjs';
import {
  buildMutationChunkConfig,
  mutationAuthorityFiles,
  parseEquivalentMutants,
} from './run-mutation.mjs';
import { secureReleaseIo } from './secure-release-io.mjs';
import { readTrustedGitBlob, runTrustedGit } from './gates/trusted-git.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const harnessRoot = resolve(dirname(scriptPath), '..');
const reportsDir = resolve(harnessRoot, 'reports', 'mutation');
const requiredInstrumenterVersion = '9.6.1';
const instrumenterPackagePath = resolve(
  dirname(fileURLToPath(import.meta.resolve('@stryker-mutator/instrumenter'))),
  '..',
  '..',
  'package.json',
);

const silentLogger = Object.freeze({
  debug() {},
  error() {},
  fatal() {},
  info() {},
  trace() {},
  warn() {},
  isDebugEnabled: () => false,
  isErrorEnabled: () => false,
  isFatalEnabled: () => false,
  isInfoEnabled: () => false,
  isTraceEnabled: () => false,
  isWarnEnabled: () => false,
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function exactSet(actual, expected, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (canonicalJson(left) !== canonicalJson(right)) {
    throw new Error(`${label} mismatch`);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`, { cause: error });
  }
}

function emptyCounts() {
  return {
    total: 0,
    killed: 0,
    timeout: 0,
    survived: 0,
    noCoverage: 0,
    ignored: 0,
  };
}

function addCounts(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key];
}

function scoreFromCounts(counts) {
  const testable = counts.total - counts.ignored;
  if (testable <= 0) return 0;
  return Number(
    (((counts.killed + counts.timeout) / testable) * 100).toFixed(2),
  );
}

function countMutants(moduleName, sourceFile, mutants, waiverKeys) {
  const counts = emptyCounts();
  for (const mutant of mutants) {
    counts.total += 1;
    const waiverKey = `${moduleName}:${sourceFile}:${String(mutant.id)}`;
    if (waiverKeys.has(waiverKey)) {
      counts.ignored += 1;
      continue;
    }
    switch (mutant.status) {
      case 'Killed':
        counts.killed += 1;
        break;
      case 'Timeout':
        counts.timeout += 1;
        break;
      case 'Survived':
        counts.survived += 1;
        break;
      case 'NoCoverage':
        counts.noCoverage += 1;
        break;
      case 'Ignored':
        throw new Error(`unreviewed ignored mutant ${moduleName}/${sourceFile}`);
      default:
        throw new Error(`non-terminal mutant ${moduleName}/${sourceFile}`);
    }
  }
  return counts;
}

function sourceLineCount(source) {
  if (source.length === 0) return 1;
  const lines = source.split('\n');
  return lines.at(-1) === '' ? Math.max(1, lines.length - 1) : lines.length;
}

function chunkId(sourceFile, startLine, endLine) {
  const slug = sourceFile
    .replaceAll(/[^a-zA-Z0-9]+/gu, '-')
    .replaceAll(/^-|-$/gu, '')
    .toLowerCase();
  return `${slug}-${startLine}-${endLine}`;
}

function expectedChunks(sourceFiles, commitSources) {
  const chunks = [];
  for (const sourceFile of [...sourceFiles].sort()) {
    const source = commitSources.get(sourceFile);
    if (source === undefined) {
      throw new Error(`commit source missing: ${sourceFile}`);
    }
    const lineCount = sourceLineCount(source);
    for (let startLine = 1; startLine <= lineCount; startLine += 150) {
      const endLine = Math.min(lineCount, startLine + 149);
      chunks.push({
        chunk_id: chunkId(sourceFile, startLine, endLine),
        source_file: sourceFile,
        start_line: startLine,
        end_line: endLine,
        mutate_pattern: `${sourceFile}:${startLine}-${endLine}`,
      });
    }
  }
  return chunks;
}

function mutantIdentity(mutant) {
  return {
    mutatorName: mutant?.mutatorName,
    replacement: mutant?.replacement,
    location: mutant?.location,
  };
}

function instrumentedMutantIdentity(mutant) {
  const identity = mutantIdentity(mutant);
  return {
    ...identity,
    location: {
      start: {
        line: identity.location.start.line + 1,
        column: identity.location.start.column + 1,
      },
      end: {
        line: identity.location.end.line + 1,
        column: identity.location.end.column + 1,
      },
    },
  };
}

function sortedMutantIdentities(mutants) {
  return mutants
    .map(mutantIdentity)
    .map(canonicalJson)
    .sort();
}

export async function enumerateCommitMutants(commitSources) {
  const instrumenter = new Instrumenter(silentLogger);
  const enumerated = new Map();
  for (const [moduleName, module] of Object.entries(mutationModules)) {
    for (const chunk of expectedChunks(module.mutate, commitSources)) {
      const source = commitSources.get(chunk.source_file);
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
        result.mutants.map(instrumentedMutantIdentity),
      );
    }
  }
  return enumerated;
}

function validateTimestampEnvelope(report) {
  const valid = (value) => {
    if (typeof value !== 'string') return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
  };
  if (
    typeof report?.run_id !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      report.run_id,
    )
  ) {
    throw new Error('Phase 1 artifact run_id format is invalid');
  }
  if (!valid(report.started_at) || !valid(report.completed_at)) {
    throw new Error('Phase 1 artifact timestamp is invalid');
  }
  const started = Date.parse(report.started_at);
  const completed = Date.parse(report.completed_at);
  if (started > completed) throw new Error('Phase 1 timestamp order is invalid');
  for (const result of report.modules ?? []) {
    if (!valid(result.started_at) || !valid(result.completed_at)) {
      throw new Error(`module ${result.module} timestamp is invalid`);
    }
    const moduleStarted = Date.parse(result.started_at);
    const moduleCompleted = Date.parse(result.completed_at);
    if (
      moduleStarted < started ||
      moduleStarted > moduleCompleted ||
      moduleCompleted > completed
    ) {
      throw new Error(`module ${result.module} timestamp is outside run envelope`);
    }
  }
}

function validateAttestation({
  attestation,
  report,
  configurationHash,
  phase1Text,
  expectedArtifactDigest,
}) {
  const expected = {
    schema_version: 1,
    workflow_sha: report.commit_sha,
    artifact_name: `phase1-mutation-${report.commit_sha}`,
    artifact_digest: expectedArtifactDigest,
    run_id: report.run_id,
    configuration_hash: configurationHash,
    phase1_report_sha256: sha256(phase1Text),
  };
  if (
    !/^[0-9a-f]{64}$/u.test(expectedArtifactDigest ?? '') ||
    canonicalJson(attestation) !== canonicalJson(expected)
  ) {
    throw new Error('artifact digest attestation mismatch');
  }
}

function validateMutantLocation(mutant, chunk, label) {
  const start = mutant?.location?.start;
  const end = mutant?.location?.end;
  if (
    !Number.isSafeInteger(start?.line) ||
    !Number.isSafeInteger(end?.line) ||
    !Number.isSafeInteger(start?.column) ||
    !Number.isSafeInteger(end?.column) ||
    start.line < chunk.start_line ||
    start.line > chunk.end_line ||
    end.line < start.line ||
    end.line > chunk.end_line ||
    start.column < 0 ||
    end.column < 0
  ) {
    throw new Error(`mutant location outside chunk range: ${label}`);
  }
}

function reconstructMergedReport(chunks, chunkReports, commitSources) {
  const merged = { ...chunkReports[0], files: {}, phase1_chunked: true };
  merged.chunks = chunks.map((chunk) => ({ ...chunk }));
  const identities = new Set();
  for (const [index, report] of chunkReports.entries()) {
    const chunk = chunks[index];
    const entries = Object.entries(report.files ?? {});
    if (entries.length > 1 || (entries.length === 1 && entries[0][0] !== chunk.source_file)) {
      throw new Error(`chunk raw report source mismatch: ${chunk.chunk_id}`);
    }
    if (entries.length === 0) continue;
    const [sourceFile, file] = entries[0];
    const target = merged.files[sourceFile] ?? {
      language: file.language,
      source: file.source,
      mutants: [],
    };
    if (target.language !== file.language || target.source !== file.source) {
      throw new Error(`chunk raw report source metadata mismatch: ${chunk.chunk_id}`);
    }
    for (const mutant of file.mutants) {
      const identity = canonicalJson({
        source_file: sourceFile,
        mutator_name: mutant.mutatorName,
        replacement: mutant.replacement,
        location: mutant.location,
      });
      if (identities.has(identity)) {
        throw new Error(`duplicate mutant identity across chunks: ${chunk.chunk_id}`);
      }
      identities.add(identity);
      target.mutants.push({
        ...mutant,
        id: `${chunk.chunk_id}:${String(mutant.id)}`,
        stryker_chunk_id: chunk.chunk_id,
        stryker_original_id: String(mutant.id),
      });
    }
    merged.files[sourceFile] = target;
  }
  for (const sourceFile of new Set(chunks.map((chunk) => chunk.source_file))) {
    if (merged.files[sourceFile]) continue;
    merged.files[sourceFile] = {
      language: 'typescript',
      source: commitSources.get(sourceFile),
      mutants: [],
    };
  }
  return merged;
}

function assertMetrics(moduleName, result, reconstructed, waiverKeys) {
  const module = mutationModules[moduleName];
  const moduleCounts = emptyCounts();
  const perFile = {};
  for (const sourceFile of result.source_files) {
    const mutants = reconstructed.files[sourceFile]?.mutants;
    if (!Array.isArray(mutants)) {
      throw new Error(`merged raw report source missing: ${moduleName}/${sourceFile}`);
    }
    const counts = countMutants(moduleName, sourceFile, mutants, waiverKeys);
    addCounts(moduleCounts, counts);
    const score = scoreFromCounts(counts);
    const minimum = module.perFileMinimum ?? 0;
    perFile[sourceFile] = {
      ...counts,
      score,
      minimum,
      status: score >= minimum ? 'PASS' : 'FAIL',
    };
  }
  if (
    canonicalJson(result.counts) !== canonicalJson(moduleCounts) ||
    canonicalJson(result.per_file) !== canonicalJson(perFile) ||
    result.score !== scoreFromCounts(moduleCounts)
  ) {
    throw new Error(`raw report counts mismatch for ${moduleName}`);
  }
  const perFilePassed = Object.values(perFile).every((file) => file.status === 'PASS');
  if (
    result.minimum !== module.minimum ||
    result.status !== 'PASS' ||
    result.score < module.minimum ||
    !perFilePassed
  ) {
    throw new Error(`module ${moduleName} is not passing`);
  }
  return moduleCounts;
}

export function validatePublishedPhase1ArtifactContents({
  report,
  artifactEntries,
  commitSources,
  commitSha,
  configurationHash,
  waiverKeys,
  attestation,
  expectedArtifactDigest,
  independentMutants,
}) {
  validateTimestampEnvelope(report);
  if (
    report.schema_version !== 1 ||
    report.commit_sha !== commitSha ||
    report.configuration_hash !== configurationHash
  ) {
    throw new Error('Phase 1 report commit/configuration identity mismatch');
  }
  const phase1Text = artifactEntries.get('phase1/mutation.json');
  const runPhase1Text = artifactEntries.get(`runs/${report.run_id}/phase1.json`);
  if (
    phase1Text === undefined ||
    runPhase1Text !== phase1Text ||
    canonicalJson(parseJson(phase1Text, 'Phase 1 report')) !== canonicalJson(report)
  ) {
    throw new Error('published Phase 1 report bytes mismatch');
  }
  validateAttestation({
    attestation,
    report,
    configurationHash,
    phase1Text,
    expectedArtifactDigest,
  });

  const expectedModules = Object.keys(mutationModules);
  const actualModules = (report.modules ?? []).map((result) => result.module);
  exactSet(actualModules, expectedModules, 'Phase 1 module set');
  if (new Set(actualModules).size !== actualModules.length) {
    throw new Error('Phase 1 module set contains duplicates');
  }
  const aggregate = emptyCounts();
  const requiredChunkFiles = new Set();
  const requiredEnumerationKeys = new Set();
  for (const result of report.modules) {
    const moduleName = result.module;
    const module = mutationModules[moduleName];
    if (
      result.run_id !== report.run_id ||
      result.commit_sha !== commitSha ||
      result.configuration_hash !== configurationHash
    ) {
      throw new Error(`module ${moduleName} has mixed run/commit/config`);
    }
    exactSet(result.source_files ?? [], module.mutate, `module ${moduleName} source files`);
    const chunks = expectedChunks(module.mutate, commitSources);
    const evidence = result.chunks ?? [];
    if (evidence.length !== chunks.length) {
      throw new Error(`exact chunk set mismatch for ${moduleName}`);
    }
    const chunkReports = [];
    for (const [index, chunk] of chunks.entries()) {
      const claimed = evidence[index];
      if (
        claimed?.chunk_id !== chunk.chunk_id ||
        claimed.source_file !== chunk.source_file ||
        claimed.start_line !== chunk.start_line ||
        claimed.end_line !== chunk.end_line
      ) {
        throw new Error(`exact chunk set mismatch for ${moduleName}`);
      }
      const base =
        `runs/${report.run_id}/${moduleName}/chunks/${chunk.chunk_id}`;
      const rawPath = `${base}/mutation.json`;
      const configPath = `${base}/stryker.config.json`;
      requiredChunkFiles.add(rawPath);
      requiredChunkFiles.add(configPath);
      const rawText = artifactEntries.get(rawPath);
      const configText = artifactEntries.get(configPath);
      if (rawText === undefined) throw new Error(`chunk raw report missing: ${rawPath}`);
      if (configText === undefined) throw new Error(`chunk config missing: ${configPath}`);
      if (
        claimed.raw_report_sha256 !== sha256(rawText) ||
        claimed.config_sha256 !== sha256(configText)
      ) {
        throw new Error(`chunk artifact hash mismatch: ${moduleName}/${chunk.chunk_id}`);
      }
      const config = parseJson(configText, `chunk config ${chunk.chunk_id}`);
      if (
        canonicalJson(config) !==
        canonicalJson(buildMutationChunkConfig(moduleName, chunk, report.run_id))
      ) {
        throw new Error(`chunk config mismatch: ${moduleName}/${chunk.chunk_id}`);
      }
      const raw = parseJson(rawText, `chunk raw report ${chunk.chunk_id}`);
      const entries = Object.entries(raw.files ?? {});
      if (entries.length > 1 || (entries.length === 1 && entries[0][0] !== chunk.source_file)) {
        throw new Error(`chunk raw report source mismatch: ${chunk.chunk_id}`);
      }
      const mutants = entries.length === 0 ? [] : entries[0][1]?.mutants;
      if (!Array.isArray(mutants)) {
        throw new Error(`chunk mutant list missing: ${chunk.chunk_id}`);
      }
      if (
        entries.length === 1 &&
        entries[0][1]?.source !== commitSources.get(chunk.source_file)
      ) {
        throw new Error(`chunk source differs from commit Git object: ${chunk.chunk_id}`);
      }
      const ids = new Set();
      for (const mutant of mutants) {
        const id = String(mutant.id);
        if (ids.has(id)) throw new Error(`duplicate mutant ID: ${chunk.chunk_id}/${id}`);
        ids.add(id);
        validateMutantLocation(mutant, chunk, `${chunk.chunk_id}/${id}`);
      }
      if (claimed.mutant_count !== mutants.length) {
        throw new Error(`chunk mutant count mismatch: ${chunk.chunk_id}`);
      }
      const enumerationKey = `${moduleName}/${chunk.chunk_id}`;
      requiredEnumerationKeys.add(enumerationKey);
      const independentlyEnumerated = independentMutants?.get(enumerationKey);
      if (
        !Array.isArray(independentlyEnumerated) ||
        canonicalJson(sortedMutantIdentities(mutants)) !==
          canonicalJson(sortedMutantIdentities(independentlyEnumerated))
      ) {
        throw new Error(
          `independent mutant enumeration mismatch: ${enumerationKey}`,
        );
      }
      chunkReports.push(raw);
    }
    const mergedPath = `runs/${report.run_id}/${moduleName}/mutation.json`;
    const mergedText = artifactEntries.get(mergedPath);
    if (mergedText === undefined) throw new Error(`merged raw report missing: ${moduleName}`);
    if (result.raw_report_sha256 !== sha256(mergedText)) {
      throw new Error(`merged raw report hash mismatch: ${moduleName}`);
    }
    const reconstructed = reconstructMergedReport(chunks, chunkReports, commitSources);
    const merged = parseJson(mergedText, `merged raw report ${moduleName}`);
    if (canonicalJson(merged) !== canonicalJson(reconstructed)) {
      throw new Error(`merged raw report reconstruction mismatch: ${moduleName}`);
    }
    addCounts(
      aggregate,
      assertMetrics(moduleName, result, reconstructed, waiverKeys),
    );
  }
  const actualChunkFiles = [...artifactEntries.keys()].filter((path) =>
    /\/chunks\/[^/]+\/(?:mutation\.json|stryker\.config\.json)$/u.test(path),
  );
  exactSet(actualChunkFiles, requiredChunkFiles, 'artifact exact chunk file set');
  exactSet(
    independentMutants?.keys() ?? [],
    requiredEnumerationKeys,
    'independent mutant enumeration chunk set',
  );
  const aggregateScore = scoreFromCounts(aggregate);
  if (
    canonicalJson(report.aggregate) !==
      canonicalJson({
        ...aggregate,
        score: aggregateScore,
        required: phase1Minimum,
        status: 'PASS',
      }) ||
    aggregateScore < phase1Minimum
  ) {
    throw new Error('Phase 1 aggregate is inconsistent');
  }
  return true;
}

function normalizedAuthorityContent(path, content) {
  if (!path.endsWith('equivalent-mutants.json')) return content;
  const parsed = parseJson(content, 'equivalent-mutants.json');
  if (!Array.isArray(parsed)) return content;
  return canonicalJson(
    parsed.map((value) =>
      Object.fromEntries(
        Object.entries(value).filter(
          ([key]) => key !== 'commitSha' && key !== 'configurationHash',
        ),
      ),
    ),
  );
}

function configurationFromGit(repositoryRoot, commitSha) {
  const hash = createHash('sha256');
  for (const path of mutationAuthorityFiles) {
    const content = readTrustedGitBlob(repositoryRoot, commitSha, path).toString('utf8');
    hash.update(path);
    hash.update('\0');
    hash.update(normalizedAuthorityContent(path, content));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function assertInstrumenterAuthority(repositoryRoot, commitSha) {
  const packageJson = parseJson(
    readTrustedGitBlob(repositoryRoot, commitSha, 'package.json').toString('utf8'),
    'commit package.json',
  );
  const packageLock = parseJson(
    readTrustedGitBlob(repositoryRoot, commitSha, 'package-lock.json').toString('utf8'),
    'commit package-lock.json',
  );
  const locked = packageLock?.packages?.['node_modules/@stryker-mutator/instrumenter'];
  const installed = parseJson(
    readFileSync(instrumenterPackagePath, 'utf8'),
    'installed instrumenter package.json',
  );
  if (
    packageJson?.devDependencies?.['@stryker-mutator/instrumenter'] !==
      requiredInstrumenterVersion ||
    packageLock?.packages?.['']?.devDependencies?.[
      '@stryker-mutator/instrumenter'
    ] !== requiredInstrumenterVersion ||
    locked?.version !== requiredInstrumenterVersion ||
    typeof locked?.integrity !== 'string' ||
    !locked.integrity.startsWith('sha512-') ||
    installed?.version !== requiredInstrumenterVersion
  ) {
    throw new Error('Stryker instrumenter version/lock authority mismatch');
  }
}

function secureArtifactEntries(repositoryRoot, commitSha, artifactReportsDir) {
  const parent = dirname(artifactReportsDir);
  const read = secureReleaseIo({
    authority: { repositoryRoot, commitSha },
    ioRoot: parent,
    operation: 'read_tree',
    path: basename(artifactReportsDir),
  });
  return new Map(
    read.files.map((entry) => {
      const bytes = Buffer.from(entry.contentBase64, 'base64');
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes)) {
        throw new Error(`mutation artifact path is not UTF-8 text: ${entry.path}`);
      }
      return [entry.path, text];
    }),
  );
}

export async function validatePublishedPhase1Artifacts({
  repositoryRoot = harnessRoot,
  artifactReportsDir = reportsDir,
  expectedSha,
  expectedArtifactDigest,
  expectedArtifactName,
}) {
  const current = runTrustedGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  if (current !== expectedSha || !/^[0-9a-f]{40}$/u.test(expectedSha ?? '')) {
    throw new Error('mutation verification expected SHA mismatch');
  }
  const artifactEntries = secureArtifactEntries(
    repositoryRoot,
    current,
    artifactReportsDir,
  );
  const phase1Text = artifactEntries.get('phase1/mutation.json');
  if (phase1Text === undefined) throw new Error('published Phase 1 report missing');
  const report = parseJson(phase1Text, 'published Phase 1 report');
  assertInstrumenterAuthority(repositoryRoot, current);
  const configurationHash = configurationFromGit(repositoryRoot, current);
  const commitSources = new Map();
  for (const module of Object.values(mutationModules)) {
    for (const sourceFile of module.mutate) {
      if (!commitSources.has(sourceFile)) {
        commitSources.set(
          sourceFile,
          readTrustedGitBlob(repositoryRoot, current, sourceFile).toString('utf8'),
        );
      }
    }
  }
  const waivers = parseJson(
    readTrustedGitBlob(
      repositoryRoot,
      current,
      'mutation/equivalent-mutants.json',
    ).toString('utf8'),
    'equivalent-mutants.json',
  );
  const waiverKeys = parseEquivalentMutants(
    waivers,
    current,
    configurationHash,
  );
  const independentMutants = await enumerateCommitMutants(commitSources);
  const attestation = {
    schema_version: 1,
    workflow_sha: current,
    artifact_name: expectedArtifactName,
    artifact_digest: expectedArtifactDigest,
    run_id: report.run_id,
    configuration_hash: configurationHash,
    phase1_report_sha256: sha256(phase1Text),
  };
  return validatePublishedPhase1ArtifactContents({
    report,
    artifactEntries,
    commitSources,
    commitSha: current,
    configurationHash,
    waiverKeys,
    attestation,
    expectedArtifactDigest,
    independentMutants,
  });
}

async function main() {
  if (process.argv[2] !== 'phase1') {
    throw new Error('usage: node scripts/check-mutation-thresholds.mjs phase1');
  }
  await validatePublishedPhase1Artifacts({
    expectedSha: process.env.EXPECTED_SHA,
    expectedArtifactDigest: process.env.MUTATION_ARTIFACT_DIGEST,
    expectedArtifactName: process.env.MUTATION_ARTIFACT_NAME,
  });
  console.log(`Phase 1 mutation artifact PASS for ${process.env.EXPECTED_SHA}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  main().catch((error) => {
    console.error(`FAIL: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
