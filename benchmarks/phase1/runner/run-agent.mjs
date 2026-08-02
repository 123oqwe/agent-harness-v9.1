#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import {
  gradeCase,
  summarizeResults,
  workspaceManifest,
} from '../grader/grade.mjs';
import {
  validateAcceptanceReport,
  writeEvidenceAtomicExclusive,
} from '../../../scripts/release-evidence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const defaultManifest = resolve(here, '../cases/cases.json');
const defaultResultSchema = resolve(here, '../result.schema.json');
const supportedAgents = new Set([
  'harness',
  'codex',
  'claude',
  'pi',
  'manus',
]);

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeWorkspacePath(workspace, path) {
  if (
    typeof path !== 'string' ||
    path.startsWith('/') ||
    path.split(/[\\/]/u).includes('..')
  ) {
    throw new Error(`unsafe fixture path: ${String(path)}`);
  }
  const root = resolve(workspace);
  const candidate = resolve(root, path);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`fixture path escaped workspace: ${path}`);
  }
  return candidate;
}

function writeFixture(workspace, benchmarkCase) {
  for (const file of benchmarkCase.setup) {
    const path = safeWorkspacePath(workspace, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content, { flag: 'wx' });
  }
}

function initialHashes(workspace) {
  return Object.fromEntries(
    workspaceManifest(workspace).map((entry) => [entry.path, entry.hash]),
  );
}

function sanitizedEnvironment() {
  const keep = [
    'PATH',
    'LANG',
    'LC_ALL',
    'TERM',
    'HOME',
    'CODEX_HOME',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_OAUTH_TOKEN',
    'OPENAI_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'ZAI_API_KEY',
    'ZAI_CODING_CN_API_KEY',
    'PI_CODING_AGENT_DIR',
    'GLM_API_KEY',
    'GLM_MODEL',
    'GLM_REASONING_EFFORT',
    'GLM_ALLOW_REMOTE',
    'HARNESS_PACKAGE_SPECIFIER',
  ];
  return Object.fromEntries(
    keep
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
}

export function commandFor(
  agent,
  workspace,
  benchmarkCase,
  fixtureVersion,
  commitSha,
) {
  const prompt = benchmarkCase.prompt;
  switch (agent) {
    case 'codex':
      return {
        command: 'codex',
        args: [
          'exec',
          '--sandbox',
          'workspace-write',
          '--skip-git-repo-check',
          '--ephemeral',
          '--ignore-rules',
          '--json',
          '-C',
          workspace,
          '-',
        ],
        stdin: prompt,
      };
    case 'claude':
      return {
        command: 'claude',
        args: [
          '--print',
          '--output-format',
          'json',
          '--permission-mode',
          'dontAsk',
          '--no-session-persistence',
          '--safe-mode',
          '--allowedTools',
          'Read,Write,Edit,Bash,Glob,Grep',
        ],
        stdin: prompt,
      };
    case 'pi':
      return {
        command: 'pi',
        args: [
          '--print',
          '--mode',
          'json',
          '--no-session',
          '--no-extensions',
          '--no-skills',
          '--no-context-files',
          '--approve',
          '--tools',
          'read,bash,edit,write,grep,find,ls',
          prompt,
        ],
        stdin: '',
      };
    case 'harness':
      return {
        command: process.execPath,
        args: [resolve(here, 'run-harness-case.mjs')],
        stdin: JSON.stringify({
          workspace,
          benchmarkCase,
          fixture_version: fixtureVersion,
          commit_sha: commitSha,
        }),
      };
    default:
      throw new Error(`no command adapter for ${agent}`);
  }
}

function runCommand(spec, options) {
  return new Promise((resolveResult) => {
    const child = spawn(spec.command, spec.args, {
      cwd: options.workspace,
      env: sanitizedEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let killedFor = null;
    const append = (current, chunk) =>
      `${current}${String(chunk)}`.slice(-2_000_000);
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    const terminate = (reason) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      killedFor = reason;
      if (process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      } else child.kill('SIGTERM');
    };
    const timeout = setTimeout(
      () => terminate('timeout'),
      options.timeout_ms,
    );
    const cancellation =
      options.cancel_after_ms === undefined
        ? null
        : setTimeout(
            () => terminate('cancelled'),
            options.cancel_after_ms,
          );
    child.on('error', (error) => {
      clearTimeout(timeout);
      if (cancellation) clearTimeout(cancellation);
      resolveResult({
        stdout,
        stderr: `${stderr}\n${error.message}`,
        exitCode: null,
        termination_reason: 'launch_error',
      });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timeout);
      if (cancellation) clearTimeout(cancellation);
      resolveResult({
        stdout,
        stderr,
        exitCode,
        termination_reason:
          killedFor ?? (exitCode === 0 ? 'completed' : 'agent_error'),
      });
    });
    child.stdin.end(spec.stdin);
  });
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part) =>
        part?.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('');
}

export function outputFromAgent(agent, execution) {
  if (agent === 'codex') {
    const events = execution.stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    const messages = events
      .map((event) => event?.item?.text ?? event?.message?.content)
      .filter((value) => typeof value === 'string');
    return messages.at(-1) ?? execution.stdout;
  }
  if (agent === 'claude') {
    try {
      const parsed = JSON.parse(execution.stdout);
      return String(
        parsed.result ??
          parsed.response ??
          parsed.message?.content ??
          execution.stdout,
      );
    } catch {
      return execution.stdout;
    }
  }
  if (agent === 'pi') {
    const events = execution.stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    const completedMessages = events
      .filter(
        (event) =>
          event?.type === 'message_end' &&
          event?.message?.role === 'assistant',
      )
      .map((event) => textContent(event.message.content))
      .filter(Boolean);
    if (completedMessages.length > 0) {
      return completedMessages.at(-1);
    }
    const finalMessages = events
      .filter((event) => event?.type === 'agent_end')
      .flatMap((event) => event.messages ?? [])
      .filter((message) => message?.role === 'assistant')
      .map((message) => textContent(message.content))
      .filter(Boolean);
    return finalMessages.at(-1) ?? execution.stdout;
  }
  if (agent === 'harness') {
    const lines = execution.stdout.split(/\r?\n/u).filter(Boolean);
    const parsed = JSON.parse(lines.at(-1) ?? '{}');
    return String(parsed.output ?? '');
  }
  return execution.stdout;
}

function versionFor(agent) {
  if (agent === 'manus') return 'authenticated-import';
  const spec =
    agent === 'codex'
      ? ['codex', ['--version']]
      : agent === 'claude'
        ? ['claude', ['--version']]
        : agent === 'pi'
          ? ['pi', ['--version']]
          : [process.execPath, ['--version']];
  const result = spawnSync(spec[0], spec[1], {
    encoding: 'utf8',
    env: sanitizedEnvironment(),
  });
  return `${result.stdout}${result.stderr}`.trim() || 'unknown';
}

function loadManusImport(path, fixtureVersion) {
  if (!path) {
    throw new Error(
      'real Manus comparison requires --manus-import with authenticated raw outputs',
    );
  }
  const parsed = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (
    parsed.schema_version !== 1 ||
    parsed.provider !== 'manus' ||
    parsed.authenticated !== true ||
    parsed.fixture_version !== fixtureVersion ||
    typeof parsed.captured_at !== 'string' ||
    Number.isNaN(Date.parse(parsed.captured_at)) ||
    !/^[0-9a-f]{64}$/u.test(parsed.raw_output_sha256 ?? '') ||
    !Array.isArray(parsed.cases) ||
    parsed.cases.length !== 24 ||
    new Set(parsed.cases.map((entry) => entry.case_id)).size !== 24 ||
    parsed.cases.some(
      (entry) =>
        typeof entry.execution_id !== 'string' ||
        entry.execution_id.length === 0,
    )
  ) {
    throw new Error(
      'Manus import requires authenticated 24-case provenance for the frozen fixture',
    );
  }
  const actualHash = createHash('sha256')
    .update(JSON.stringify(parsed.cases))
    .digest('hex');
  if (parsed.raw_output_sha256 !== actualHash) {
    throw new Error(
      'Manus raw_output_sha256 mismatch; expected sha256(JSON.stringify(cases))',
    );
  }
  return new Map(parsed.cases.map((entry) => [entry.case_id, entry]));
}

export function writeRunnerOutput({
  outputPath,
  serialized,
  formalAcceptance,
  evidenceRoot,
}) {
  const destination = resolve(outputPath);
  if (formalAcceptance) {
    writeEvidenceAtomicExclusive(
      destination,
      serialized,
      resolve(evidenceRoot ?? dirname(destination)),
    );
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, serialized);
}

async function main() {
  const agent = requiredArgument('--agent');
  if (!supportedAgents.has(agent)) throw new Error(`unsupported agent: ${agent}`);
  const manifestPath = resolve(argument('--manifest', defaultManifest));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const commit_sha = requiredArgument('--commit-sha');
  if (!/^[0-9a-f]{40}$/u.test(commit_sha)) {
    throw new Error('--commit-sha must be a full lowercase Git SHA');
  }
  const outputPath = argument('--output');
  const oneCase = argument('--case');
  const formalAcceptance = agent === 'harness' && !oneCase;
  const provenance = formalAcceptance
    ? {
        source_tree: requiredArgument('--source-tree'),
        fixture_sha256: requiredArgument('--fixture-sha256'),
        result_schema_sha256: requiredArgument('--result-schema-sha256'),
        package_tarball_sha256: requiredArgument('--package-tarball-sha256'),
        package_lock_sha256: requiredArgument('--package-lock-sha256'),
        consumer_lock_sha256: requiredArgument('--consumer-lock-sha256'),
        model: 'glm-5.2',
        reasoning_effort: 'xhigh',
        temperature: 1,
        seed: null,
        seed_support: 'unsupported',
      }
    : null;
  const selected = oneCase
    ? manifest.cases.filter((entry) => entry.id === oneCase)
    : manifest.cases;
  if (selected.length === 0) throw new Error(`unknown case: ${oneCase}`);
  const manus = agent === 'manus'
    ? loadManusImport(
        argument('--manus-import'),
        manifest.fixture_version,
      )
    : null;
  const started_at = new Date().toISOString();
  const results = [];

  for (const benchmarkCase of selected) {
    const workspace = mkdtempSync(
      resolve(tmpdir(), `phase1-${agent}-${benchmarkCase.id}-`),
    );
    const started = performance.now();
    try {
      writeFixture(workspace, benchmarkCase);
      const beforeHashes = initialHashes(workspace);
      let execution;
      if (agent === 'manus') {
        const imported = manus.get(benchmarkCase.id);
        if (!imported) {
          throw new Error(`Manus import missing case ${benchmarkCase.id}`);
        }
        for (const file of imported.files ?? []) {
          const path = safeWorkspacePath(workspace, file.path);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, String(file.content));
        }
        execution = {
          stdout: String(imported.output ?? ''),
          stderr: '',
          exitCode: Number(imported.exit_code ?? 0),
          termination_reason: String(
            imported.termination_reason ?? 'completed',
          ),
          unauthorized_effects: Number(imported.unauthorized_effects ?? 0),
          duplicate_effects: Number(imported.duplicate_effects ?? 0),
          evidence: imported.evidence ?? {},
        };
      } else {
        const spec = commandFor(
          agent,
          workspace,
          benchmarkCase,
          manifest.fixture_version,
          commit_sha,
        );
        execution = await runCommand(spec, {
          workspace,
          timeout_ms: benchmarkCase.timeout_ms,
          cancel_after_ms: benchmarkCase.cancel_after_ms,
        });
      }
      const output = outputFromAgent(agent, execution);
      const harnessMetadata =
        agent === 'harness'
          ? (() => {
              const line = execution.stdout.split(/\r?\n/u).filter(Boolean).at(-1);
              try {
                return JSON.parse(line ?? '{}');
              } catch {
                return {};
              }
            })()
          : {};
      const graded = gradeCase({
        benchmarkCase,
        workspace,
        beforeHashes,
        output,
        fixture_version: manifest.fixture_version,
        commit_sha,
        evidence: execution.evidence ?? harnessMetadata.evidence ?? {},
        termination_reason:
          harnessMetadata.termination_reason ??
          execution.termination_reason,
        unauthorized_effects:
          execution.unauthorized_effects ??
          harnessMetadata.unauthorized_effects ??
          0,
        duplicate_effects:
          execution.duplicate_effects ??
          harnessMetadata.duplicate_effects ??
          0,
      });
      results.push({
        ...graded,
        duration_ms: Math.round(performance.now() - started),
        ...(harnessMetadata.usage ? { usage: harnessMetadata.usage } : {}),
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  const result = {
    schema_version: 1,
    fixture_version: manifest.fixture_version,
    commit_sha,
    agent,
    agent_version: versionFor(agent),
    started_at,
    completed_at: new Date().toISOString(),
    ...(provenance ? { provenance } : {}),
    cases: results,
    summary: summarizeResults(results),
  };
  if (formalAcceptance) {
    const schemaPath = resolve(argument('--result-schema', defaultResultSchema));
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    validateAcceptanceReport({
      report: result,
      manifest,
      schema,
      expected: {
        commit_sha,
        fixture_version: manifest.fixture_version,
        provenance,
      },
      forbiddenSecrets: [process.env.GLM_API_KEY],
    });
  }
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) {
    writeRunnerOutput({
      outputPath,
      serialized,
      formalAcceptance,
      evidenceRoot: argument('--evidence-root'),
    });
  }
  process.stdout.write(serialized);
  if (
    results.length !== (oneCase ? 1 : 24) ||
    result.summary.failed !== 0 ||
    !result.summary.safety_hard_gate_passed
  ) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : error}\n`,
    );
    process.exitCode = 1;
  });
}
