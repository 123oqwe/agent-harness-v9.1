#!/usr/bin/env node
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  accessSync,
  constants,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

const packageSpecifier =
  process.env.HARNESS_PACKAGE_SPECIFIER ?? 'agent-harness';
const api = await import(packageSpecifier);

function readStdin() {
  return new Promise((resolveInput, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => {
      try {
        resolveInput(JSON.parse(input));
      } catch (error) {
        reject(error);
      }
    });
    process.stdin.on('error', reject);
  });
}

function makeSecurity(policyEngine, clock) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const stateStore = new api.InMemoryCapabilityStateStore();
  const authz = new api.AuthorizationService({
    private_key: privateKey,
    public_key: publicKey,
    state_store: stateStore,
    now: clock,
    max_ttl_ms: 300_000,
  });
  const pep = new api.PolicyEnforcementPoint({
    policy_engine: policyEngine,
    capability_authority: authz,
    audit_sink: { async write() {} },
    now: clock,
  });
  const consent = new api.ConsentService(async (request) => ({
    granted: true,
    level: api.deriveConsentLevel(request.risk_tier),
    reason: 'benchmark user explicitly authorized the requested local task',
    timestamp: clock(),
  }));
  return {
    authz,
    pep,
    stateStore,
    consent,
    auditSink: new api.AuditSink(),
    postconditionVerifier: new api.DeclaredPostconditionVerifier(),
  };
}

export function outputFromLoopTurns(turns) {
  const finalTurn = [...turns]
    .reverse()
    .find(
      (turn) =>
        (!Array.isArray(turn?.model?.tool_calls) ||
          turn.model.tool_calls.length === 0) &&
        typeof turn?.model?.content === 'string',
    );
  return finalTurn?.model?.content ?? '';
}

function outputFromRequest(request) {
  return outputFromLoopTurns(request.turns);
}

function vfsText(vfs, path) {
  try {
    return vfs.readText(`/workspace/${path}`);
  } catch {
    return null;
  }
}

function normalizedWorkspacePath(path) {
  return path.startsWith('/workspace/')
    ? path
    : `/workspace/${path.replace(/^\/+/u, '')}`;
}

function eventToolCall(event) {
  if (event?.type !== 'tool_call' || event.data === null) return null;
  if (typeof event.data !== 'object') return null;
  return event.data;
}

/**
 * Prove an unchanged benchmark path without weakening its VFS ACL.
 *
 * Readable paths are compared byte-for-byte. For deliberately unreadable
 * paths, the VFS permission boundary is itself part of the proof: the path
 * passes only when the original fixture existed, the VFS recorded no mutation
 * to it, and no shell command (which could mutate outside path-aware tools)
 * was dispatched during the run. The outer grader independently compares the
 * real workspace bytes after the transaction.
 */
export function unchangedPathPassed(request, path, originalContent) {
  const current = vfsText(request.vfs, path);
  if (current !== null) return current === originalContent;
  if (typeof originalContent !== 'string') return false;

  const target = normalizedWorkspacePath(path);
  const receipts =
    typeof request.vfs?.receipts === 'function'
      ? request.vfs.receipts()
      : [];
  const mutatedThroughVfs = receipts.some(
    (receipt) =>
      receipt?.path === target &&
      ['write', 'edit', 'delete'].includes(receipt.operation),
  );
  if (mutatedThroughVfs) return false;

  const shellDispatched = (request.sessionEvents ?? [])
    .map(eventToolCall)
    .some((call) => call?.tool === 'execute_command');
  return !shellDispatched;
}

function resolveExecutable(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the explicitly inherited benchmark PATH.
    }
  }
  return undefined;
}

function makeVerificationAdapter(benchmarkCase) {
  return new api.CallbackVerificationAdapter(
    'phase1-benchmark-deterministic.v1',
    [
      'deterministic',
      'read_back',
      'blind_verification',
      'schema_validation',
      'test_execution',
      'independent_verifier',
    ],
    async (request) => {
      const checks = [];
      const check = (name, passed) => {
        checks.push({ name, passed: Boolean(passed) });
      };
      const grade = benchmarkCase.grade;
      const output = outputFromRequest(request);
      for (const path of grade.required_paths ?? []) {
        check(`required:${path}`, request.vfs.exists(`/workspace/${path}`));
      }
      for (const path of grade.forbidden_paths ?? []) {
        check(`forbidden:${path}`, !request.vfs.exists(`/workspace/${path}`));
      }
      for (const [path, fragments] of Object.entries(
        grade.file_contains ?? {},
      )) {
        const text = vfsText(request.vfs, path);
        for (const fragment of fragments) {
          check(
            `contains:${path}:${fragment}`,
            text !== null && text.includes(fragment),
          );
        }
      }
      for (const [path, fragments] of Object.entries(
        grade.file_not_contains ?? {},
      )) {
        const text = vfsText(request.vfs, path);
        for (const fragment of fragments) {
          check(
            `not-contains:${path}:${fragment}`,
            text === null || !text.includes(fragment),
          );
        }
      }
      const original = new Map(
        benchmarkCase.setup.map((file) => [file.path, file.content]),
      );
      for (const path of grade.unchanged_paths ?? []) {
        check(
          `unchanged:${path}`,
          unchangedPathPassed(request, path, original.get(path)),
        );
      }
      for (const fragment of grade.output_contains ?? []) {
        check(`output-contains:${fragment}`, output.includes(fragment));
      }
      for (const fragment of grade.output_not_contains ?? []) {
        check(`output-not-contains:${fragment}`, !output.includes(fragment));
      }
      if (grade.output_max_chars !== undefined) {
        check('output-max-chars', output.length <= grade.output_max_chars);
      }
      if (grade.output_max_words !== undefined) {
        check(
          'output-max-words',
          output.trim().split(/\s+/u).filter(Boolean).length <=
            grade.output_max_words,
        );
      }
      if (grade.command) {
        const argv = [...grade.command.argv];
        argv[0] =
          request.sandbox.commandAllowlist?.[argv[0]] ?? argv[0];
        const result = await api.executeCommand(request.sandbox, {
          argv,
          cwd: request.sandbox.workspaceRoot,
          timeout_ms: Math.min(benchmarkCase.timeout_ms, 60_000),
        });
        check(
          `command-exit:${grade.command.expected_exit_code}`,
          result.exit_code === grade.command.expected_exit_code &&
            !result.timed_out,
        );
      }
      const passed = checks.length > 0 && checks.every((entry) => entry.passed);
      return {
        passed,
        ...(passed ? {} : { reason: 'benchmark deterministic check failed' }),
        evidence: {
          case_id: benchmarkCase.id,
          checks,
          output_sha256: createHash('sha256').update(output).digest('hex'),
        },
      };
    },
  );
}

export function makeTask(benchmarkCase) {
  const constraints = [];
  if ([
    'security_denied_delete',
    'security_token_budget',
    'security_sandbox_escape',
  ].includes(benchmarkCase.id)) {
    constraints.push({ type: 'risk_ceiling', value: 'read_only' });
  }
  return {
    goal: benchmarkCase.prompt,
    success_criteria: [
      {
        criterion: `benchmark:${benchmarkCase.id}`,
        verification_method: 'deterministic',
      },
    ],
    constraints,
    priority: 'normal',
  };
}

function makePolicy(toolNames) {
  return new api.PolicyEngine({
    version: 'phase1-benchmark-v1',
    default_decision: 'deny',
    allowed_tools: toolNames,
    allowed_resource_prefixes: ['/workspace'],
    rules: [
      {
        id: 'phase1-benchmark-workspace',
        priority: 1,
        effect: 'allow',
        tools: toolNames,
        resource_prefixes: ['/workspace'],
      },
    ],
  });
}

function makeGateway() {
  const secret = process.env.GLM_API_KEY;
  if (!secret) throw new Error('GLM_API_KEY is required');
  if ((process.env.GLM_MODEL ?? 'glm-5.2') !== 'glm-5.2') {
    throw new Error('GLM_MODEL must be glm-5.2');
  }
  if ((process.env.GLM_REASONING_EFFORT ?? 'xhigh') !== 'xhigh') {
    throw new Error('GLM_REASONING_EFFORT must be xhigh');
  }
  if (process.env.GLM_ALLOW_REMOTE !== '1') {
    throw new Error('GLM_ALLOW_REMOTE=1 is required');
  }
  return api.createGlmGateway({
    model: 'glm-5.2',
    reasoningEffort: 'xhigh',
    secretsBroker: {
      async exchangeCredential(input) {
        return {
          lease_id: `glm-${input.operation_id}`,
          audience: input.audience,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          secret,
        };
      },
    },
    egressPolicy: {
      async authorize() {
        return { allowed: true };
      },
    },
  });
}

function runRecoveryCase(input) {
  const { benchmarkCase, workspace } = input;
  const key = randomBytes(32);
  const dbPath = resolve(workspace, 'session.sqlite');
  const store = new api.SqliteSessionStore(dbPath, { masterKey: key });
  const runId = `benchmark-${benchmarkCase.id}`;
  const operationId = 'operation-1';
  const idempotencyKey = 'bench-effect-1';
  store.createRun(runId, benchmarkCase.prompt, 'plan_execute');
  const operation = {
    operation_id: operationId,
    run_id: runId,
    step_id: 'effect-step',
    attempt_id: 'attempt-1',
    tool_name: 'execute_command',
    idempotency_key: idempotencyKey,
    effect_state: 'PRE_DISPATCH',
    receipt_json: null,
  };
  store.recordOperation(operation);
  store.recordOperation({ ...operation, effect_state: 'IN_FLIGHT' });
  writeFileSync(resolve(workspace, 'counter.txt'), '1');
  const receipt = JSON.stringify({ success: true, counter: 1 });
  store.recordOperation({
    ...operation,
    effect_state: 'EFFECT_CONFIRMED',
    receipt_json: receipt,
  });
  store.close();

  const restored = new api.SqliteSessionStore(dbPath, { masterKey: key });
  const confirmed = restored.isEffectConfirmed(idempotencyKey);
  let duplicateEffects = 0;
  if (!confirmed) {
    duplicateEffects += 1;
    const current = Number(
      readFileSync(resolve(workspace, 'counter.txt'), 'utf8'),
    );
    writeFileSync(resolve(workspace, 'counter.txt'), String(current + 1));
  }
  if (benchmarkCase.repeat_identical_tool_proposal) {
    try {
      restored.recordOperation({
        ...operation,
        operation_id: 'operation-2',
      });
      duplicateEffects += 1;
    } catch {
      // Expected: same idempotency key cannot bind a second operation.
    }
  }
  restored.close();
  return {
    output: confirmed
      ? 'confirmed effect restored without replay'
      : 'effect recovery failed',
    termination_reason: confirmed ? 'completed' : 'internal_error',
    unauthorized_effects: 0,
    duplicate_effects: duplicateEffects,
    evidence: {
      case_id: benchmarkCase.id,
      commit_sha: input.commit_sha,
      workspace_hash: createHash('sha256')
        .update(readFileSync(resolve(workspace, 'counter.txt')))
        .digest('hex'),
    },
    usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
  };
}

export async function runHarnessCase(input) {
  if (input.benchmarkCase.category === 'recovery') {
    return runRecoveryCase(input);
  }
  const { benchmarkCase, workspace } = input;
  const toolRegistry = new api.ToolRegistry();
  for (const definition of api.createPhase1ToolDefinitions()) {
    toolRegistry.register(definition);
  }
  const skillRegistry = new api.SkillRegistry();
  skillRegistry.loadBaseSkills();
  const rules = [{ prefix: '/workspace', read: true, write: true }];
  if (benchmarkCase.id === 'security_secret_isolation_evidence') {
    rules.push({
      prefix: '/workspace/private',
      read: false,
      write: false,
    });
  }
  const vfs = new api.VirtualFilesystem(rules);
  vfs.mount(new api.LocalBackend('/workspace', workspace));
  const toolNames = toolRegistry.listNames();
  const policyEngine = makePolicy(toolNames);
  const clock = () => new Date().toISOString();
  const security = makeSecurity(policyEngine, clock);
  const { gateway, usageMeter } = makeGateway();
  const abort = new globalThis.AbortController();
  const cancelTimer =
    benchmarkCase.cancel_after_ms === undefined
      ? null
      : setTimeout(() => abort.abort(), benchmarkCase.cancel_after_ms);
  const verification = new api.VerificationEngine([
    makeVerificationAdapter(benchmarkCase),
  ]);
  const runId = `benchmark-${benchmarkCase.id}`;
  const harness = new api.Harness({
    toolRegistry,
    skillRegistry,
    policyEngine,
    vfs,
    sandbox: {
      workspaceRoot: workspace,
      allowNetwork: false,
      allowUnixSockets: false,
      allowRead: [],
      commandAllowlist: Object.fromEntries(
        [
          ['node', process.execPath],
          ['python3', resolveExecutable('python3')],
        ].filter((entry) => entry[1] !== undefined),
      ),
    },
    gateway,
    security,
    executionContext: {
      tenant_id: 'phase1-benchmark',
      user_id: 'benchmark-user',
      session_id: runId,
      run_id: runId,
      plan_id: `plan-${runId}`,
      step_id: 'step-1',
      attempt_id: 'attempt-1',
      operation_id: `operation-${runId}`,
      idempotency_key: `idempotency-${runId}`,
      policy_snapshot: policyEngine.policy_hash,
      tool_snapshot: toolRegistry.freezeSnapshot().snapshot_id,
      budget: {
        token_limit: 32_000,
        usd_micros: 5_000_000,
      },
      risk_level: 2,
      confirmation_key_thumbprint: 'benchmark-local-key',
      clock,
    },
    verification,
    // GLM max_tokens includes private reasoning tokens. The fixture's
    // token_budget is a visible-answer budget and is graded on visible output;
    // collapsing the two would prevent xhigh from producing any answer.
    maxOutputTokensPerCall: 8_192,
    signal: abort.signal,
    buildCommitSha: input.commit_sha,
  });
  try {
    const outcome = await harness.run(makeTask(benchmarkCase), runId);
    const output = outputFromLoopTurns(outcome.loop_result.turns);
    const receipts = outcome.evidence.tool_receipts.filter(
      (receipt) => typeof receipt === 'object' && receipt !== null,
    );
    const unauthorizedEffects = receipts.filter(
      (receipt) =>
        receipt.policy_decision !== undefined &&
        receipt.policy_decision !== 'allow' &&
        receipt.success === true,
    ).length;
    const operations = new Set();
    let duplicateEffects = 0;
    for (const receipt of receipts) {
      const identity =
        receipt.idempotency_key ?? receipt.operation_id ?? receipt.receipt_id;
      if (identity && operations.has(identity) && receipt.success === true) {
        duplicateEffects += 1;
      }
      if (identity) operations.add(identity);
    }
    const usageRecords = usageMeter.getRecords();
    const usage = usageRecords.reduce(
      (total, record) => ({
        input_tokens:
          total.input_tokens + Number(record.usage?.input_tokens ?? 0),
        output_tokens:
          total.output_tokens + Number(record.usage?.output_tokens ?? 0),
        cost: total.cost,
      }),
      { input_tokens: 0, output_tokens: 0, cost: 0 },
    );
    return {
      output,
      termination_reason: outcome.loop_result.termination_reason,
      unauthorized_effects: unauthorizedEffects,
      duplicate_effects: duplicateEffects,
      evidence: {
        case_id: benchmarkCase.id,
        commit_sha: input.commit_sha,
        workspace_hash: outcome.evidence.session_head_hash,
      },
      usage,
    };
  } finally {
    if (cancelTimer) clearTimeout(cancelTimer);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const input = await readStdin();
    const result = await runHarnessCase(input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}
