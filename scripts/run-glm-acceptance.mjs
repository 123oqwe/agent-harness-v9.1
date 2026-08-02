#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildReleaseEnvironment,
  sha256File,
  validateAcceptanceReport,
  verifyReleaseRepository,
} from './release-evidence.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), '..');
const fixturePath = resolve(root, 'benchmarks/phase1/cases/cases.json');
const resultSchemaPath = resolve(root, 'benchmarks/phase1/result.schema.json');

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

export function runGlmAcceptance(source = process.env) {
  const repository = verifyReleaseRepository(root, source.EXPECTED_SHA);
  assertLiveConfiguration(source);

  const temporary = mkdtempSync(resolve(tmpdir(), 'phase1-glm-acceptance-'));
  try {
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

    run('npm', ['run', 'build'], { env: nonModelEnvironment });
    const packedJson = run(
      'npm',
      [
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        temporary,
      ],
      { capture: true, env: nonModelEnvironment },
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

    const provenance = {
      source_tree: repository.source_tree,
      fixture_sha256: sha256File(fixturePath),
      result_schema_sha256: sha256File(resultSchemaPath),
      package_tarball_sha256: sha256File(tarball),
      package_lock_sha256: sha256File(resolve(root, 'package-lock.json')),
      consumer_lock_sha256: sha256File(resolve(consumer, 'package-lock.json')),
      model: 'glm-5.2',
      reasoning_effort: 'xhigh',
      temperature: 1,
      seed: null,
      seed_support: 'unsupported',
    };
    const output = resolve(
      root,
      `reports/acceptance/glm-5.2-xhigh-phase1-${repository.commit_sha}.json`,
    );
    const packageEntrypoint = pathToFileURL(
      resolve(consumer, 'node_modules/agent-harness/dist/index.js'),
    ).href;
    const modelEnvironment = buildReleaseEnvironment({
      source,
      home,
      npmCache,
      includeModelCredential: true,
      packageSpecifier: packageEntrypoint,
    });
    run(
      process.execPath,
      [
        resolve(root, 'benchmarks/phase1/runner/run-agent.mjs'),
        '--agent',
        'harness',
        '--commit-sha',
        repository.commit_sha,
        '--output',
        output,
        '--evidence-root',
        root,
        '--source-tree',
        provenance.source_tree,
        '--fixture-sha256',
        provenance.fixture_sha256,
        '--result-schema-sha256',
        provenance.result_schema_sha256,
        '--package-tarball-sha256',
        provenance.package_tarball_sha256,
        '--package-lock-sha256',
        provenance.package_lock_sha256,
        '--consumer-lock-sha256',
        provenance.consumer_lock_sha256,
      ],
      {
        env: modelEnvironment,
        capture: true,
        timeout: 24 * 300_000,
      },
    );

    const report = JSON.parse(readFileSync(output, 'utf8'));
    const manifest = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const schema = JSON.parse(readFileSync(resultSchemaPath, 'utf8'));
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
    process.stdout.write(
      `GLM-5.2 xhigh acceptance PASS: ${report.summary.passed}/24, safety hard gate PASS\n`,
    );
    process.stdout.write(`Evidence: ${output}\n`);
    return output;
  } finally {
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
