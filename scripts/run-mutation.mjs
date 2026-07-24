#!/usr/bin/env node
/**
 * Trustworthy Phase 1 mutation runner.
 *
 * Every run is isolated and bound to one repository commit and one mutation
 * configuration. Reports are published only after their integrity has been
 * checked. A filesystem lock prevents two Stryker processes from sharing
 * temporary or report state.
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutationModules, phase1Minimum } from '../mutation/modules.mjs';
import { strykerBase } from '../mutation/stryker.base.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const harnessRoot = resolve(dirname(scriptPath), '..');
const reportsDir = join(harnessRoot, 'reports', 'mutation');
const mutationAuthorityFiles = [
  'mutation/modules.mjs',
  'mutation/thresholds.json',
  'mutation/stryker.base.mjs',
  'mutation/equivalent-mutants.json',
  'package.json',
  'package-lock.json',
  'patches/@stryker-mutator+vitest-runner+9.6.1.patch',
  'vitest.mutation.config.ts',
  'scripts/run-mutation.mjs',
  'scripts/check-mutation-thresholds.mjs',
];
const securityCriticalModules = new Set([
  'router',
  'toolsRegistry',
  'actionControl',
  'identitySecrets',
  'vfs',
  'sandbox',
  'session',
  'runtime',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
}

function normalizedAuthorityContent(path, content) {
  if (!path.endsWith('equivalent-mutants.json')) return content;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
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

export function computeMutationConfigurationHash(root = harnessRoot) {
  const hash = createHash('sha256');
  for (const relativePath of mutationAuthorityFiles) {
    const absolutePath = join(root, relativePath);
    if (!existsSync(absolutePath)) {
      throw new Error(`mutation authority missing: ${relativePath}`);
    }
    const content = normalizedAuthorityContent(
      relativePath,
      readFileSync(absolutePath, 'utf8'),
    );
    hash.update(relativePath);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function readLockMetadata(lockPath) {
  try {
    return JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

export function acquireRunLock(lockPath, owner) {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = readLockMetadata(lockPath);
      const stale =
        existing?.hostname === hostname() && !processIsAlive(existing.pid);
      if (stale && attempt === 0) {
        const stalePath = `${lockPath}.stale.${existing.run_id}.${randomUUID()}`;
        try {
          renameSync(lockPath, stalePath);
          rmSync(stalePath, { force: true, recursive: true });
          continue;
        } catch (recoveryError) {
          throw new Error('failed to recover stale mutation lock', {
            cause: recoveryError,
          });
        }
      }
      const detail = existing
        ? `run_id=${existing.run_id} pid=${existing.pid}`
        : 'owner metadata unavailable';
      throw new Error(`mutation runner already running (${detail})`, {
        cause: error,
      });
    }
  }
  try {
    atomicWriteJson(join(lockPath, 'owner.json'), {
      ...owner,
      hostname: owner.hostname ?? hostname(),
    });
  } catch (error) {
    rmSync(lockPath, { force: true, recursive: true });
    throw error;
  }
}

export function releaseRunLock(lockPath, runId) {
  const existing = readLockMetadata(lockPath);
  if (!existing || existing.run_id !== runId) {
    throw new Error(`run ${runId} does not own mutation lock`);
  }
  rmSync(lockPath, { force: true, recursive: true });
}

function validSha(value, length) {
  return (
    typeof value === 'string' &&
    new RegExp(`^[0-9a-f]{${length}}$`, 'u').test(value)
  );
}

export function loadEquivalentMutants(path, commitSha, configurationHash) {
  let entries;
  try {
    entries = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `equivalent-mutants.json must be valid JSON: ${error.message}`,
      { cause: error },
    );
  }
  if (!Array.isArray(entries)) {
    throw new Error('equivalent-mutants.json must be an array');
  }
  const keys = new Set();
  for (const [index, entry] of entries.entries()) {
    const prefix = `equivalent mutant waiver ${index}`;
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.strykerMutantId !== 'string' ||
      entry.strykerMutantId.trim() === '' ||
      typeof entry.module !== 'string' ||
      typeof entry.sourceFile !== 'string' ||
      typeof entry.reason !== 'string' ||
      entry.reason.trim().length < 20 ||
      typeof entry.reviewedBy !== 'string' ||
      entry.reviewedBy.trim() === '' ||
      typeof entry.reviewedAt !== 'string' ||
      Number.isNaN(Date.parse(entry.reviewedAt)) ||
      !validSha(entry.commitSha, 40) ||
      !validSha(entry.configurationHash, 64)
    ) {
      throw new Error(`${prefix} is incomplete`);
    }
    if (
      /^(agent|codex|claude|glm|model|automation)$/iu.test(
        entry.reviewedBy.trim(),
      )
    ) {
      throw new Error(`${prefix} requires a human reviewer`);
    }
    const module = mutationModules[entry.module];
    if (!module) throw new Error(`${prefix} names an unknown module`);
    if (securityCriticalModules.has(entry.module)) {
      throw new Error(`module ${entry.module} cannot be waived`);
    }
    if (!module.mutate.includes(entry.sourceFile)) {
      throw new Error(`${prefix} source file is outside its module`);
    }
    if (entry.commitSha !== commitSha) {
      throw new Error(`${prefix} is not bound to the current commit`);
    }
    if (entry.configurationHash !== configurationHash) {
      throw new Error(`${prefix} is not bound to the current configuration`);
    }
    const key = `${entry.module}:${entry.sourceFile}:${entry.strykerMutantId}`;
    if (keys.has(key)) throw new Error(`${prefix} is duplicated`);
    keys.add(key);
  }
  return keys;
}

function resolveMutationFiles(patterns, root = harnessRoot) {
  const files = new Set();
  for (const pattern of patterns) {
    for (const match of globSync(pattern, { cwd: root })) {
      if (
        match.endsWith('index.ts') ||
        match.endsWith('.d.ts') ||
        match.endsWith('.test.ts') ||
        match.endsWith('.spec.ts') ||
        match.startsWith('contracts/') ||
        match.startsWith('tests/') ||
        match.startsWith('dist/') ||
        match.startsWith('node_modules/')
      ) {
        continue;
      }
      files.add(match);
    }
  }
  return [...files].sort();
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

export function planMutationChunks(
  sourceFiles,
  root = harnessRoot,
  linesPerChunk = 250,
) {
  if (!Number.isSafeInteger(linesPerChunk) || linesPerChunk <= 0) {
    throw new Error('linesPerChunk must be a positive safe integer');
  }
  const chunks = [];
  for (const sourceFile of [...sourceFiles].sort()) {
    const absolutePath = join(root, sourceFile);
    if (!existsSync(absolutePath)) {
      throw new Error(`mutation source missing: ${sourceFile}`);
    }
    const lineCount = sourceLineCount(readFileSync(absolutePath, 'utf8'));
    for (
      let startLine = 1;
      startLine <= lineCount;
      startLine += linesPerChunk
    ) {
      const endLine = Math.min(lineCount, startLine + linesPerChunk - 1);
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

function mutantIdentity(sourceFile, mutant) {
  return canonicalJson({
    source_file: sourceFile,
    mutator_name: mutant.mutatorName,
    replacement: mutant.replacement,
    location: mutant.location,
  });
}

export function mergeChunkReports(chunks, reports) {
  if (chunks.length === 0 || chunks.length !== reports.length) {
    throw new Error('chunk/report cardinality mismatch');
  }
  const merged = {
    ...reports[0],
    files: {},
    phase1_chunked: true,
    chunks: chunks.map((chunk) => ({ ...chunk })),
  };
  const identities = new Set();
  for (const [index, report] of reports.entries()) {
    const chunk = chunks[index];
    if (!report?.files || typeof report.files !== 'object') {
      throw new Error(`chunk ${chunk.chunk_id} has no files object`);
    }
    const entries = Object.entries(report.files);
    if (entries.length !== 1 || entries[0][0] !== chunk.source_file) {
      throw new Error(`chunk ${chunk.chunk_id} source file mismatch`);
    }
    const [sourceFile, file] = entries[0];
    const target = merged.files[sourceFile] ?? {
      ...file,
      mutants: [],
    };
    if (target.source !== file.source || target.language !== file.language) {
      throw new Error(`chunk ${chunk.chunk_id} source content mismatch`);
    }
    for (const mutant of file.mutants ?? []) {
      const identity = mutantIdentity(sourceFile, mutant);
      if (identities.has(identity)) continue;
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
  exactSet(
    Object.keys(merged.files),
    [...new Set(chunks.map((chunk) => chunk.source_file))],
    'merged chunk source files',
  );
  return merged;
}

function reportFiles(report) {
  if (!report?.files || typeof report.files !== 'object') {
    throw new Error('Stryker report has no files object');
  }
  return Object.entries(report.files)
    .map(([sourceFile, value]) => ({
      sourceFile,
      mutants: Array.isArray(value?.mutants) ? value.mutants : [],
    }))
    .sort((left, right) => left.sourceFile.localeCompare(right.sourceFile));
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

function scoreFromCounts(counts) {
  const testable = counts.total - counts.ignored;
  if (testable <= 0) return 0;
  return Number(
    (((counts.killed + counts.timeout) / testable) * 100).toFixed(2),
  );
}

function addCounts(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key];
}

function countMutants(files, moduleName, waiverKeys) {
  const counts = emptyCounts();
  for (const file of files) {
    for (const mutant of file.mutants) {
      counts.total += 1;
      const waiverKey = `${moduleName}:${file.sourceFile}:${String(mutant.id)}`;
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
          throw new Error(
            `unreviewed ignored mutant ${mutant.id} in ${file.sourceFile}`,
          );
        default:
          throw new Error(
            `non-terminal mutant ${mutant.id} has status ${mutant.status}`,
          );
      }
    }
  }
  return counts;
}

function exactSet(actual, expected, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(
      `${label} mismatch: actual=[${left.join(', ')}] ` +
        `expected=[${right.join(', ')}]`,
    );
  }
}

function moduleResultFromReport(
  moduleName,
  report,
  context,
  rawReportText,
  chunks,
) {
  const module = mutationModules[moduleName];
  if (!module) throw new Error(`unknown mutation module: ${moduleName}`);
  const expectedFiles = resolveMutationFiles(module.mutate);
  const files = reportFiles(report);
  exactSet(
    files.map((file) => file.sourceFile),
    expectedFiles,
    `report source files for ${moduleName}`,
  );
  const counts = countMutants(files, moduleName, context.waiverKeys);
  const score = scoreFromCounts(counts);
  const perFile = {};
  let perFilePassed = true;
  for (const file of files) {
    const fileCounts = countMutants([file], moduleName, context.waiverKeys);
    const fileScore = scoreFromCounts(fileCounts);
    const minimum = module.perFileMinimum ?? 0;
    const status = fileScore >= minimum ? 'PASS' : 'FAIL';
    if (status === 'FAIL') perFilePassed = false;
    perFile[file.sourceFile] = {
      ...fileCounts,
      score: fileScore,
      minimum,
      status,
    };
  }
  const passed = score >= module.minimum && perFilePassed;
  return {
    schema_version: 1,
    run_id: context.runId,
    commit_sha: context.commitSha,
    configuration_hash: context.configurationHash,
    module: moduleName,
    source_files: expectedFiles,
    minimum: module.minimum,
    score,
    status: passed ? 'PASS' : 'FAIL',
    counts,
    per_file: perFile,
    chunks: chunks.map((chunk) => ({
      chunk_id: chunk.chunk_id,
      source_file: chunk.source_file,
      start_line: chunk.start_line,
      end_line: chunk.end_line,
    })),
    raw_report_sha256: sha256(rawReportText),
    started_at: context.moduleStartedAt,
    completed_at: new Date().toISOString(),
  };
}

function failedModuleResult(moduleName, context, error) {
  return {
    schema_version: 1,
    run_id: context.runId,
    commit_sha: context.commitSha,
    configuration_hash: context.configurationHash,
    module: moduleName,
    source_files: [...mutationModules[moduleName].mutate].sort(),
    minimum: mutationModules[moduleName].minimum,
    score: 0,
    status: 'FAIL',
    counts: emptyCounts(),
    per_file: {},
    chunks: [],
    raw_report_sha256: null,
    started_at: context.moduleStartedAt,
    completed_at: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  };
}

export function buildPhase1Report(context, results) {
  const aggregateCounts = emptyCounts();
  for (const result of results) addCounts(aggregateCounts, result.counts);
  const aggregateScore = scoreFromCounts(aggregateCounts);
  const expectedNames = Object.keys(mutationModules);
  const actualNames = results.map((result) => result.module);
  const moduleSetComplete =
    new Set(actualNames).size === expectedNames.length &&
    expectedNames.every((name) => actualNames.includes(name));
  const allModulesPass =
    moduleSetComplete && results.every((result) => result.status === 'PASS');
  const status =
    allModulesPass && aggregateScore >= phase1Minimum ? 'PASS' : 'FAIL';
  return {
    schema_version: 1,
    run_id: context.runId,
    commit_sha: context.commitSha,
    configuration_hash: context.configurationHash,
    started_at:
      context.startedAt ?? results[0]?.started_at ?? new Date().toISOString(),
    completed_at: new Date().toISOString(),
    aggregate: {
      ...aggregateCounts,
      score: aggregateScore,
      required: phase1Minimum,
      status,
    },
    modules: results,
  };
}

export function validatePhase1Report(report, expected) {
  if (
    !report ||
    report.schema_version !== 1 ||
    report.run_id !== expected.runId
  ) {
    throw new Error('Phase 1 report run identity mismatch');
  }
  if (report.commit_sha !== expected.commitSha) {
    throw new Error('Phase 1 report commit mismatch');
  }
  if (report.configuration_hash !== expected.configurationHash) {
    throw new Error('Phase 1 report configuration mismatch');
  }
  const expectedNames = Object.keys(mutationModules);
  const actualNames = (report.modules ?? []).map((module) => module.module);
  exactSet(actualNames, expectedNames, 'Phase 1 module set');
  if (new Set(actualNames).size !== actualNames.length) {
    throw new Error('Phase 1 module set contains duplicates');
  }
  const aggregateCounts = emptyCounts();
  for (const result of report.modules) {
    if (
      result.run_id !== expected.runId ||
      result.commit_sha !== expected.commitSha ||
      result.configuration_hash !== expected.configurationHash
    ) {
      throw new Error(`module ${result.module} has mixed run/commit/config`);
    }
    const module = mutationModules[result.module];
    exactSet(
      result.source_files ?? [],
      resolveMutationFiles(module.mutate),
      `module ${result.module} source files`,
    );
    const perFileNames = Object.keys(result.per_file ?? {});
    exactSet(
      perFileNames,
      result.source_files,
      `module ${result.module} per-file results`,
    );
    const expectedChunks = planMutationChunks(
      result.source_files,
      harnessRoot,
      150,
    ).map((chunk) => ({
      chunk_id: chunk.chunk_id,
      source_file: chunk.source_file,
      start_line: chunk.start_line,
      end_line: chunk.end_line,
    }));
    if (canonicalJson(result.chunks) !== canonicalJson(expectedChunks)) {
      throw new Error(`module ${result.module} chunk coverage mismatch`);
    }
    const perFilePassed = Object.values(result.per_file).every(
      (file) =>
        file.status === 'PASS' && file.score >= (module.perFileMinimum ?? 0),
    );
    if (
      result.status !== 'PASS' ||
      result.score < module.minimum ||
      !perFilePassed
    ) {
      throw new Error(`module ${result.module} is not passing`);
    }
    addCounts(aggregateCounts, result.counts);
  }
  const aggregateScore = scoreFromCounts(aggregateCounts);
  if (
    canonicalJson(aggregateCounts) !==
      canonicalJson({
        total: report.aggregate.total,
        killed: report.aggregate.killed,
        timeout: report.aggregate.timeout,
        survived: report.aggregate.survived,
        noCoverage: report.aggregate.noCoverage,
        ignored: report.aggregate.ignored,
      }) ||
    report.aggregate.score !== aggregateScore ||
    report.aggregate.required !== phase1Minimum ||
    report.aggregate.status !== 'PASS' ||
    aggregateScore < phase1Minimum
  ) {
    throw new Error('Phase 1 aggregate is not passing or is inconsistent');
  }
  return true;
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: harnessRoot,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`,
    );
  }
  return result.stdout.trim();
}

function repositoryContext(requireClean) {
  const commitSha = git(['rev-parse', 'HEAD']);
  const status = git([
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    '.',
  ]);
  if (requireClean && status !== '') {
    throw new Error(
      'Phase 1 mutation requires a clean Harness worktree; commit source ' +
        'and test changes first',
    );
  }
  return {
    commitSha,
    worktreeHash: sha256(status),
  };
}

function printModuleResult(result) {
  console.log(`\n--- ${result.module} ---`);
  console.log(
    `Score: ${result.score}% (required: ${result.minimum}%) ` +
      `-> ${result.status}`,
  );
  console.log(
    `Killed: ${result.counts.killed}, Timeout: ${result.counts.timeout}, ` +
      `Survived: ${result.counts.survived}, ` +
      `NoCoverage: ${result.counts.noCoverage}, ` +
      `Ignored: ${result.counts.ignored}`,
  );
  for (const [file, metrics] of Object.entries(result.per_file)) {
    if (metrics.minimum > 0) {
      console.log(
        `  ${file}: ${metrics.score}% / ${metrics.minimum}% ` +
          `[${metrics.status}]`,
      );
    }
  }
}

function runModule(moduleName, context) {
  const module = mutationModules[moduleName];
  if (!module) {
    throw new Error(
      `unknown module ${moduleName}; available: ` +
        `${Object.keys(mutationModules).join(', ')}`,
    );
  }
  const sourceFiles = resolveMutationFiles(module.mutate);
  exactSet(sourceFiles, module.mutate, `configured files for ${moduleName}`);

  const moduleRoot = join(context.runRoot, moduleName);
  mkdirSync(moduleRoot, { recursive: true });
  const rawReportPath = join(moduleRoot, 'mutation.json');
  const chunks = planMutationChunks(sourceFiles, harnessRoot, 150);

  console.log(`\n=== Mutation: ${moduleName} ===`);
  console.log(`Run: ${context.runId}`);
  console.log(`Files: ${sourceFiles.join(', ')}`);
  console.log(`Chunks: ${chunks.length} (complete 150-line ranges)`);
  const stryker = join(harnessRoot, 'node_modules', '.bin', 'stryker');
  const chunkReports = [];
  for (const [index, chunk] of chunks.entries()) {
    const chunkRoot = join(moduleRoot, 'chunks', chunk.chunk_id);
    const chunkReportPath = join(chunkRoot, 'mutation.json');
    const chunkHtmlPath = join(chunkRoot, 'mutation.html');
    const configPath = join(chunkRoot, 'stryker.config.json');
    const config = {
      ...strykerBase,
      mutate: [chunk.mutate_pattern],
      tempDirName: join(
        '.stryker-tmp',
        context.runId,
        moduleName,
        chunk.chunk_id,
      ),
      jsonReporter: {
        fileName: relative(harnessRoot, chunkReportPath),
      },
      htmlReporter: {
        fileName: relative(harnessRoot, chunkHtmlPath),
      },
      ...(moduleName === 'sandbox'
        ? { concurrency: 1, timeoutMS: 60_000 }
        : {}),
      thresholds: {
        high: module.minimum,
        low: Math.max(0, module.minimum - 5),
        break: null,
      },
    };
    atomicWriteJson(configPath, config);
    console.log(`\n[${index + 1}/${chunks.length}] ${chunk.mutate_pattern}`);
    const run = spawnSync(stryker, ['run', configPath], {
      cwd: harnessRoot,
      stdio: 'inherit',
      shell: false,
      timeout: 15 * 60 * 1000,
      env: {
        ...process.env,
        STRYKER: 'true',
        HARNESS_SPEC_ROOT: resolve(harnessRoot, '..', 'spec'),
      },
    });
    if (run.error) {
      throw new Error(
        `Stryker failed to start for ${moduleName}/${chunk.chunk_id}: ` +
          run.error.message,
      );
    }
    if (run.status !== 0) {
      throw new Error(
        `Stryker exited ${run.status} for ` +
          `${moduleName}/${chunk.chunk_id}; no report is accepted`,
      );
    }
    if (!existsSync(chunkReportPath)) {
      throw new Error(`Stryker did not produce ${chunkReportPath}`);
    }
    try {
      chunkReports.push(JSON.parse(readFileSync(chunkReportPath, 'utf8')));
    } catch (error) {
      throw new Error(
        `invalid Stryker report for ${moduleName}/${chunk.chunk_id}: ` +
          error.message,
        { cause: error },
      );
    }
  }
  const rawReport = mergeChunkReports(chunks, chunkReports);
  atomicWriteJson(rawReportPath, rawReport);
  const rawReportText = readFileSync(rawReportPath, 'utf8');
  const result = moduleResultFromReport(
    moduleName,
    rawReport,
    {
      ...context,
      moduleStartedAt: context.moduleStartedAt,
    },
    rawReportText,
    chunks,
  );
  atomicWriteJson(join(moduleRoot, 'result.json'), result);
  printModuleResult(result);
  return result;
}

function createRunContext(requireClean) {
  const repository = repositoryContext(requireClean);
  const configurationHash = computeMutationConfigurationHash(harnessRoot);
  const runId = `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${randomUUID()}`;
  const runRoot = join(reportsDir, 'runs', runId);
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const waiverKeys = loadEquivalentMutants(
    join(harnessRoot, 'mutation', 'equivalent-mutants.json'),
    repository.commitSha,
    configurationHash,
  );
  return {
    runId,
    runRoot,
    commitSha: repository.commitSha,
    worktreeHash: repository.worktreeHash,
    configurationHash,
    waiverKeys,
    startedAt: new Date().toISOString(),
  };
}

function publishJson(source, destination) {
  const parsed = JSON.parse(readFileSync(source, 'utf8'));
  atomicWriteJson(destination, parsed);
}

function runOne(moduleName, context) {
  const moduleContext = {
    ...context,
    moduleStartedAt: new Date().toISOString(),
  };
  const result = runModule(moduleName, moduleContext);
  const currentRoot = join(reportsDir, moduleName);
  publishJson(
    join(context.runRoot, moduleName, 'mutation.json'),
    join(currentRoot, 'mutation.json'),
  );
  atomicWriteJson(join(currentRoot, 'result.json'), result);
  return result;
}

function runPhase1(context) {
  const results = [];
  for (const moduleName of Object.keys(mutationModules)) {
    const moduleContext = {
      ...context,
      moduleStartedAt: new Date().toISOString(),
    };
    try {
      results.push(runModule(moduleName, moduleContext));
    } catch (error) {
      const failed = failedModuleResult(moduleName, moduleContext, error);
      results.push(failed);
      atomicWriteJson(join(context.runRoot, moduleName, 'result.json'), failed);
      console.error(`\nFAIL ${moduleName}: ${failed.error}`);
    }
  }
  const report = buildPhase1Report(context, results);
  atomicWriteJson(join(context.runRoot, 'phase1.json'), report);
  if (report.aggregate.status === 'PASS') {
    validatePhase1Report(report, context);
    atomicWriteJson(join(reportsDir, 'phase1', 'mutation.json'), report);
  }

  console.log('\n=== Phase 1 mutation aggregate ===');
  console.log(
    `${report.aggregate.score}% / ${phase1Minimum}% ` +
      `[${report.aggregate.status}]`,
  );
  for (const result of results) {
    console.log(
      `  ${result.module}: ${result.score}% / ${result.minimum}% ` +
        `[${result.status}]${result.error ? ` (${result.error})` : ''}`,
    );
  }
  return report;
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    throw new Error('usage: node scripts/run-mutation.mjs <module|phase1>');
  }
  if (target !== 'phase1' && !mutationModules[target]) {
    throw new Error(`unknown mutation target: ${target}`);
  }
  const context = createRunContext(target === 'phase1');
  const lockPath = join(reportsDir, '.phase1.lock');
  acquireRunLock(lockPath, {
    run_id: context.runId,
    pid: process.pid,
    commit_sha: context.commitSha,
    configuration_hash: context.configurationHash,
    started_at: context.startedAt,
  });
  try {
    if (target === 'phase1') {
      const report = runPhase1(context);
      process.exitCode = report.aggregate.status === 'PASS' ? 0 : 1;
    } else {
      const result = runOne(target, context);
      process.exitCode = result.status === 'PASS' ? 0 : 1;
    }
  } finally {
    releaseRunLock(lockPath, context.runId);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  main().catch((error) => {
    console.error(`FATAL: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
