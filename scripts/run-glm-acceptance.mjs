#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildReleaseEnvironment,
  prepareIsolatedReleaseTree,
  removeIsolatedReleaseTree,
  sha256File,
  validateAcceptanceReport,
  verifyReleaseRepository,
} from './release-evidence.mjs';
import { secureReleaseIo } from './secure-release-io.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    timeout: options.timeout,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} exited ${String(result.status)}${
        result.stderr ? `: ${result.stderr.slice(-1000)}` : ''
      }`,
    );
  }
  return result.stdout ?? '';
}

function assertLiveConfiguration(source) {
  if (!source.GLM_API_KEY) {
    throw new Error('GLM_API_KEY is required for live acceptance');
  }
  if ((source.GLM_MODEL ?? 'glm-5.2') !== 'glm-5.2') {
    throw new Error('GLM_MODEL must be glm-5.2');
  }
  if ((source.GLM_REASONING_EFFORT ?? 'xhigh') !== 'xhigh') {
    throw new Error('GLM_REASONING_EFFORT must be xhigh');
  }
  if (source.GLM_ALLOW_REMOTE !== '1') {
    throw new Error('GLM_ALLOW_REMOTE=1 is required for the explicit read-only model run');
  }
}

function smokeSqliteSessionStore(packageEntrypoint, databasePath, options) {
  const program = [
    "import { Buffer } from 'node:buffer';",
    `import { SqliteSessionStore } from ${JSON.stringify(packageEntrypoint)};`,
    `const store = new SqliteSessionStore(${JSON.stringify(databasePath)},`,
    '  { masterKey: Buffer.alloc(32, 7) });',
    'store.close();',
  ].join('\n');
  run(process.execPath, ['--input-type=module', '--eval', program], options);
}

function readVerifiedMutationProvenance(source, commitSha) {
  const digest = source.MUTATION_ARTIFACT_DIGEST;
  const name = source.MUTATION_ARTIFACT_NAME;
  if (!/^[0-9a-f]{64}$/u.test(digest ?? '')) {
    throw new Error('MUTATION_ARTIFACT_DIGEST must be an external upload digest');
  }
  if (name !== `phase1-mutation-${commitSha}`) {
    throw new Error('MUTATION_ARTIFACT_NAME does not match the release commit');
  }
  const read = secureReleaseIo({
    authority: { repositoryRoot: root, commitSha },
    ioRoot: resolve(root, 'reports'),
    operation: 'read_tree',
    path: 'mutation',
  });
  const entry = read.files.find((file) => file.path === 'phase1/mutation.json');
  if (!entry) throw new Error('verified Phase 1 mutation report is missing');
  const bytes = Buffer.from(entry.contentBase64, 'base64');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error('verified Phase 1 mutation report is not UTF-8');
  }
  const report = JSON.parse(text);
  if (
    report?.commit_sha !== commitSha ||
    !/^[0-9a-f]{64}$/u.test(report?.configuration_hash ?? '') ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      report?.run_id ?? '',
    ) ||
    report?.aggregate?.status !== 'PASS'
  ) {
    throw new Error('verified Phase 1 mutation report identity is invalid');
  }
  return {
    mutation_artifact_digest: digest,
    mutation_artifact_name: name,
    mutation_configuration_hash: report.configuration_hash,
    mutation_run_id: report.run_id,
  };
}

export function runGlmAcceptance(source = process.env) {
  const repository = verifyReleaseRepository(root, source.EXPECTED_SHA);
  assertLiveConfiguration(source);
  const mutationProvenance = readVerifiedMutationProvenance(
    source,
    repository.commit_sha,
  );
  if (!isAbsolute(source.ACCEPTANCE_EVIDENCE_ROOT ?? '')) {
    throw new Error('ACCEPTANCE_EVIDENCE_ROOT must be an absolute external directory');
  }
  const evidenceRoot = resolve(source.ACCEPTANCE_EVIDENCE_ROOT);
  const evidenceRelative = relative(root, evidenceRoot);
  if (
    evidenceRelative === '' ||
    (evidenceRelative !== '..' && !evidenceRelative.startsWith(`..${sep}`))
  ) {
    throw new Error('ACCEPTANCE_EVIDENCE_ROOT must be outside the source repository');
  }

  const temporary = mkdtempSync(resolve(tmpdir(), 'phase1-glm-acceptance-'));
  const isolatedRoot = resolve(temporary, 'source');
  let isolatedCreated = false;
  try {
    const isolated = prepareIsolatedReleaseTree(
      root,
      repository.commit_sha,
      isolatedRoot,
    );
    isolatedCreated = true;
    if (isolated.source_tree !== repository.source_tree) {
      throw new Error('isolated release source tree does not match repository authority');
    }
    const fixturePath = resolve(
      isolatedRoot,
      'benchmarks/phase1/cases/cases.json',
    );
    const finalEvidenceSchemaPath = resolve(
      isolatedRoot,
      'benchmarks/phase1/final-evidence.schema.json',
    );
    const home = resolve(temporary, 'home');
    const npmCache = resolve(temporary, 'npm-cache');
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(npmCache, { mode: 0o700 });
    const nonModelEnvironment = buildReleaseEnvironment({
      source,
      home,
      npmCache,
      includeModelCredential: false,
    });

    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: isolatedRoot,
      env: nonModelEnvironment,
    });
    run('npm', ['rebuild', 'better-sqlite3', '--foreground-scripts'], {
      cwd: isolatedRoot,
      env: nonModelEnvironment,
    });
    run('npm', ['run', 'build:workspaces', '--silent'], {
      cwd: isolatedRoot,
      env: nonModelEnvironment,
    });
    run('npm', ['run', 'build'], {
      cwd: isolatedRoot,
      env: nonModelEnvironment,
    });
    smokeSqliteSessionStore(
      pathToFileURL(resolve(isolatedRoot, 'dist/index.js')).href,
      resolve(temporary, 'source-sqlite-smoke.sqlite'),
      { cwd: isolatedRoot, env: nonModelEnvironment },
    );
    const packedJson = run(
      'npm',
      [
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        temporary,
      ],
      { cwd: isolatedRoot, capture: true, env: nonModelEnvironment },
    );
    const packed = JSON.parse(packedJson);
    if (!Array.isArray(packed) || packed.length !== 1 || !packed[0]?.filename) {
      throw new Error('npm pack did not return exactly one package tarball');
    }
    const tarball = resolve(temporary, packed[0].filename);
    const consumer = resolve(temporary, 'consumer');
    mkdirSync(consumer, { mode: 0o700 });
    writeFileSync(
      resolve(consumer, 'package.json'),
      '{"name":"phase1-glm-consumer","private":true,"type":"module"}\n',
      { flag: 'wx', mode: 0o600 },
    );
    run(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        tarball,
      ],
      { cwd: consumer, env: nonModelEnvironment },
    );
    run('npm', ['rebuild', 'better-sqlite3', '--foreground-scripts'], {
      cwd: consumer,
      env: nonModelEnvironment,
    });

    const provenance = {
      commit_sha: repository.commit_sha,
      source_tree: repository.source_tree,
      fixture_sha256: sha256File(fixturePath),
      result_schema_sha256: sha256File(finalEvidenceSchemaPath),
      package_tarball_sha256: sha256File(tarball),
      package_lock_sha256: sha256File(resolve(isolatedRoot, 'package-lock.json')),
      consumer_lock_sha256: sha256File(resolve(consumer, 'package-lock.json')),
      ...mutationProvenance,
      model: 'glm-5.2',
      reasoning_effort: 'xhigh',
      temperature: 1,
      seed: null,
      seed_support: 'unsupported',
    };
    const outputName =
      `glm-5.2-xhigh-phase1-${repository.commit_sha}.json`;
    const output = resolve(evidenceRoot, outputName);
    const packageEntrypoint = pathToFileURL(
      resolve(consumer, 'node_modules/agent-harness/dist/index.js'),
    ).href;
    smokeSqliteSessionStore(
      packageEntrypoint,
      resolve(temporary, 'sqlite-smoke.sqlite'),
      { cwd: consumer, env: nonModelEnvironment },
    );
    const modelEnvironment = buildReleaseEnvironment({
      source,
      home,
      npmCache,
      includeModelCredential: true,
      packageSpecifier: packageEntrypoint,
    });
    const serialized = run(
      process.execPath,
      [
        resolve(isolatedRoot, 'benchmarks/phase1/runner/run-agent.mjs'),
        '--agent',
        'harness',
        '--commit-sha',
        repository.commit_sha,
      ],
      {
        cwd: isolatedRoot,
        env: modelEnvironment,
        capture: true,
        timeout: 24 * 300_000,
      },
    );

    const rawReport = JSON.parse(serialized);
    if (Object.hasOwn(rawReport, 'provenance')) {
      throw new Error('raw benchmark result must not contain final provenance');
    }
    const report = { ...rawReport, provenance };
    const manifest = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const schema = JSON.parse(readFileSync(finalEvidenceSchemaPath, 'utf8'));
    validateAcceptanceReport({
      report,
      manifest,
      schema,
      expected: {
        commit_sha: repository.commit_sha,
        fixture_version: 'phase1-24-v1',
        provenance,
      },
      forbiddenSecrets: [source.GLM_API_KEY],
    });
    secureReleaseIo({
      authority: { repositoryRoot: root, commitSha: repository.commit_sha },
      ioRoot: evidenceRoot,
      operation: 'write_file_exclusive',
      path: outputName,
      contentBase64: Buffer.from(`${JSON.stringify(report, null, 2)}\n`).toString(
        'base64',
      ),
    });
    process.stdout.write(
      `GLM-5.2 xhigh acceptance PASS: ${report.summary.passed}/24, safety hard gate PASS\n`,
    );
    process.stdout.write(`Evidence: ${output}\n`);
    return output;
  } finally {
    if (isolatedCreated) {
      removeIsolatedReleaseTree(root, isolatedRoot);
    }
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  try {
    runGlmAcceptance();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
