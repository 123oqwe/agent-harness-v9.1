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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
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

if (!process.env.GLM_API_KEY) {
  fail('GLM_API_KEY is required for live acceptance');
} else if ((process.env.GLM_MODEL ?? 'glm-5.2') !== 'glm-5.2') {
  fail('GLM_MODEL must be glm-5.2');
} else if (
  (process.env.GLM_REASONING_EFFORT ?? 'xhigh') !== 'xhigh'
) {
  fail('GLM_REASONING_EFFORT must be xhigh');
} else if (process.env.GLM_ALLOW_REMOTE !== '1') {
  fail('GLM_ALLOW_REMOTE=1 is required for the explicit read-only model run');
} else {
  const temporary = mkdtempSync(resolve(tmpdir(), 'phase1-glm-acceptance-'));
  try {
    run('npm', ['run', 'build']);
    const packedJson = run(
      'npm',
      [
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        temporary,
      ],
      { capture: true },
    );
    const packed = JSON.parse(packedJson);
    const tarball = resolve(temporary, packed[0].filename);
    const consumer = resolve(temporary, 'consumer');
    mkdirSync(consumer, { recursive: true });
    writeFileSync(
      resolve(consumer, 'package.json'),
      '{"name":"phase1-glm-consumer","private":true,"type":"module"}\n',
    );
    run(
      'npm',
      [
        'install',
        '--no-audit',
        '--no-fund',
        tarball,
      ],
      { cwd: consumer },
    );
    const commitSha = run('git', ['rev-parse', 'HEAD'], {
      capture: true,
    }).trim();
    const output = resolve(
      root,
      'reports/acceptance/glm-5.2-xhigh-phase1.json',
    );
    const packageEntrypoint = pathToFileURL(
      resolve(consumer, 'node_modules/agent-harness/dist/index.js'),
    ).href;
    const result = spawnSync(
      process.execPath,
      [
        resolve(root, 'benchmarks/phase1/runner/run-agent.mjs'),
        '--agent',
        'harness',
        '--commit-sha',
        commitSha,
        '--output',
        output,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          GLM_MODEL: 'glm-5.2',
          GLM_REASONING_EFFORT: 'xhigh',
          GLM_ALLOW_REMOTE: '1',
          HARNESS_PACKAGE_SPECIFIER: packageEntrypoint,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 24 * 300_000,
        shell: false,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `GLM acceptance failed: ${result.stderr.slice(-2000)}`,
      );
    }
    const report = JSON.parse(readFileSync(output, 'utf8'));
    if (
      report.fixture_version !== 'phase1-24-v1' ||
      report.commit_sha !== commitSha ||
      report.summary.passed !== 24 ||
      report.summary.failed !== 0 ||
      report.summary.safety_hard_gate_passed !== true
    ) {
      throw new Error('GLM acceptance report failed its release assertions');
    }
    process.stdout.write(
      `GLM-5.2 xhigh acceptance PASS: ${report.summary.passed}/24, safety hard gate PASS\n`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
