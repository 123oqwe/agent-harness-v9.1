#!/usr/bin/env node
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';

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
    granted: request.risk_tier <= 3,
    level: api.deriveConsentLevel(request.risk_tier),
    reason: 'benchmark local workspace consent',
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

function outputFromRequest(request) {
  return request.turns
    .map((turn) => turn.content)
    .filter((value) => typeof value === 'string' && value.length > 0)
    .join('\n');
}

function vfsText(vfs, path) {
  try {
    return vfs.readText(`/workspace/${path}`);
  } catch {
    return null;
  }
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
        check(`unchanged:${path}`, vfsText(request.vfs, path) === original.get(path));
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
        const result = await api.executeCommand(request.sandbox, {
          argv: [...grade.command.argv],
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

function makeTask(benchmarkCase) {
  const constraints = [];
  if (
    benchmarkCase.category === 'security' &&
    benchmarkCase.id !== 'security_cancellation'
  ) {
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
    rules: [],
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

async function runHarnessCase(input) {
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
        token_limit: benchmarkCase.token_budget ?? 12_000,
        usd_micros: 5_000_000,
      },
      risk_level: 2,
      confirmation_key_thumbprint: 'benchmark-local-key',
      clock,
    },
    verification,
    signal: abort.signal,
    buildCommitSha: input.commit_sha,
  });
  try {
    const outcome = await harness.run(makeTask(benchmarkCase), runId);
    const output = outcome.loop_result.turns
      .map((turn) => turn.content)
      .filter(Boolean)
      .join('\n');
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

try {
  const input = await readStdin();
  const result = await runHarnessCase(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
}
