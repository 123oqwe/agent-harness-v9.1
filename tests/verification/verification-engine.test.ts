import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunPlan, TaskContract } from '../../contracts/index.js';
import type { LoopResult } from '../../runtime/loop.js';
import type { SandboxProfile } from '../../runtime/sandbox.js';
import {
  CallbackVerificationAdapter,
  JsonSchemaVerificationAdapter,
  ReadBackVerificationAdapter,
  ReceiptPostconditionVerificationAdapter,
  SandboxTestVerificationAdapter,
  VerificationEngine,
  VerificationEngineError,
  WorkspaceDiffVerificationAdapter,
} from '../../verification/verification-engine.js';
import {
  LocalBackend,
  VirtualFilesystem,
} from '../../vfs/virtual-filesystem.js';

const node = process.execPath;

describe('Phase 1 VerificationGraph execution', () => {
  let workspaceRoot: string;
  let vfs: VirtualFilesystem;
  let sandbox: SandboxProfile;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'ah-verification-'));
    vfs = new VirtualFilesystem([
      { prefix: '/workspace', read: true, write: true },
    ]);
    vfs.mount(new LocalBackend('/workspace', workspaceRoot));
    sandbox = {
      workspaceRoot,
      allowNetwork: false,
      allowUnixSockets: false,
      allowRead: [],
    };
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function fixture(
    method: TaskContract['success_criteria'][number]['verification_method'],
    verificationType:
      | 'deterministic'
      | 'schema_validation'
      | 'test_execution'
      | 'read_back'
      | 'blind_verification'
      | 'independent_verifier'
      | 'human_review',
  ): { task: TaskContract; runPlan: RunPlan; loopResult: LoopResult } {
    const task = {
      goal: 'produce a verified result',
      success_criteria: [
        { criterion: 'criterion-0', verification_method: method },
      ],
      constraints: [],
    } as TaskContract;
    const runPlan = {
      revision: 1,
      workflow_graph: {
        nodes: [
          {
            step_id: 'verify-step',
            step_type: 'verification',
            status: 'pending',
          },
        ],
        edges: [],
      },
      verification_graph: {
        nodes: [
          {
            verification_id: 'verify-0',
            step_id_ref: 'verify-step',
            verification_type: verificationType,
            strictness: 'standard',
            acceptance_criteria_refs: ['0'],
          },
        ],
        edges: [],
      },
    } as unknown as RunPlan;
    const loopResult: LoopResult = {
      strategy: 'direct',
      iterations: 1,
      termination_reason: 'completed',
      turns: [],
      decision_summaries: [],
      context_reset_emitted: false,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      step_states: Object.freeze({}),
    };
    return { task, runPlan, loopResult };
  }

  const context = (
    input: ReturnType<typeof fixture>,
    toolReceipts: readonly unknown[] = [],
  ) => ({
    ...input,
    vfs,
    sandbox,
    sessionEvents: [],
    toolReceipts,
  });

  it('fails closed when the required verification adapter is missing', async () => {
    const engine = new VerificationEngine([]);
    const input = fixture('deterministic', 'deterministic');

    const report = await engine.verify({
      ...input,
      vfs,
      sandbox,
      sessionEvents: [],
      toolReceipts: [],
    });

    expect(report.all_passed).toBe(false);
    expect(report.records[0]!.reason).toMatch(/missing adapter/);
  });

  it('verifies staged file bytes by read-back hash', async () => {
    writeFileSync(join(workspaceRoot, 'answer.txt'), 'verified');
    const expectedSha256 = createHash('sha256')
      .update('verified')
      .digest('hex');
    const engine = new VerificationEngine([
      new ReadBackVerificationAdapter({
        'criterion-0': {
          path: '/workspace/answer.txt',
          expectedSha256,
        },
      }),
    ]);
    const input = fixture('deterministic', 'deterministic');

    const report = await engine.verify({
      ...input,
      vfs,
      sandbox,
      sessionEvents: [],
      toolReceipts: [],
    });

    expect(report.all_passed).toBe(true);
    expect(report.records[0]!.evidence).toMatchObject({
      path: '/workspace/answer.txt',
      sha256: expectedSha256,
    });
  });

  it('runs test verification with argv and the staged cwd, not a shell string', async () => {
    writeFileSync(join(workspaceRoot, 'result.txt'), 'ok');
    const engine = new VerificationEngine([
      new SandboxTestVerificationAdapter({
        'criterion-0': {
          argv: ['/usr/bin/stat', 'result.txt'],
        },
      }),
    ]);
    const input = fixture('test', 'test_execution');

    const report = await engine.verify({
      ...input,
      vfs,
      sandbox,
      sessionEvents: [],
      toolReceipts: [],
    });

    expect(report.all_passed).toBe(true);
    expect(report.records[0]!.evidence).toMatchObject({ exit_code: 0 });
  });

  it('validates staged JSON against an explicit schema adapter', async () => {
    writeFileSync(join(workspaceRoot, 'result.json'), '{"status":"ok"}');
    const engine = new VerificationEngine([
      new JsonSchemaVerificationAdapter({
        'criterion-0': {
          path: '/workspace/result.json',
          schema: {
            type: 'object',
            required: ['status'],
            properties: { status: { const: 'ok' } },
            additionalProperties: false,
          },
        },
      }),
    ]);
    const input = fixture('deterministic', 'schema_validation');
    const report = await engine.verify({
      ...input,
      vfs,
      sandbox,
      sessionEvents: [],
      toolReceipts: [],
    });
    expect(report.all_passed).toBe(true);
    expect(report.records[0]!.adapter_id).toBe('json-schema.v1');
  });

  it('verifies a declared workspace diff by staged content hashes', async () => {
    writeFileSync(join(workspaceRoot, 'changed.ts'), 'export const ok = true;');
    const expectedSha256 = createHash('sha256')
      .update('export const ok = true;')
      .digest('hex');
    const engine = new VerificationEngine([
      new WorkspaceDiffVerificationAdapter({
        'criterion-0': {
          files: [
            { path: '/workspace/changed.ts', expectedSha256 },
          ],
        },
      }),
    ]);
    const input = fixture('deterministic', 'blind_verification');
    const report = await engine.verify({
      ...input,
      vfs,
      sandbox,
      sessionEvents: [],
      toolReceipts: [],
    });
    expect(report.all_passed).toBe(true);
    expect(report.records[0]!.evidence).toMatchObject({
      files: [expect.objectContaining({ passed: true })],
    });
  });

  it('requires real successful tool receipts for receipt verification', async () => {
    const engine = new VerificationEngine([
      new ReceiptPostconditionVerificationAdapter({
        'criterion-0': { expectedTools: ['edit_file', 'execute_command'] },
      }),
    ]);
    const input = fixture('deterministic', 'deterministic');
    const report = await engine.verify({
      ...input,
      vfs,
      sandbox,
      sessionEvents: [],
      toolReceipts: [
        {
          tool_name: 'edit_file',
          success: true,
          policy_decision: 'allow',
        },
        {
          tool_name: 'execute_command',
          success: true,
          policy_decision: 'allow',
        },
      ],
    });
    expect(report.all_passed).toBe(true);
    expect(report.records[0]!.evidence).toMatchObject({
      verified_tools: ['edit_file', 'execute_command'],
    });
  });

  it('requires an explicit independent adapter for semantic criteria', async () => {
    const adapter = new CallbackVerificationAdapter(
      'independent-test-reviewer',
      ['semantic'],
      async (request) => ({
        passed: request.criterion.criterion === 'criterion-0',
        evidence: { reviewer: 'separate-fixture' },
      }),
    );
    const engine = new VerificationEngine([adapter]);
    const input = fixture('semantic', 'independent_verifier');

    const report = await engine.verify({
      ...input,
      vfs,
      sandbox,
      sessionEvents: [],
      toolReceipts: [],
    });

    expect(report.all_passed).toBe(true);
    expect(report.records[0]!.adapter_id).toBe(
      'independent-test-reviewer',
    );
  });

  it('rejects duplicate graph IDs and missing workflow references before adapters run', async () => {
    const input = fixture('deterministic', 'deterministic');
    input.runPlan.verification_graph.nodes.push({
      ...input.runPlan.verification_graph.nodes[0]!,
    });
    const engine = new VerificationEngine([]);

    await expect(
      engine.verify({
        ...input,
        vfs,
        sandbox,
        sessionEvents: [],
        toolReceipts: [],
      }),
    ).rejects.toThrow(VerificationEngineError);
  });

  it('rejects every malformed workflow and verification identity', async () => {
    const cases: {
      mutate(input: ReturnType<typeof fixture>): void;
      message: RegExp;
    }[] = [
      {
        mutate: ({ runPlan }) => {
          runPlan.workflow_graph.nodes[0]!.step_id = ' ';
        },
        message: /duplicate or empty workflow step_id/u,
      },
      {
        mutate: ({ runPlan }) => {
          runPlan.workflow_graph.nodes.push({
            ...runPlan.workflow_graph.nodes[0]!,
          });
        },
        message: /duplicate or empty workflow step_id/u,
      },
      {
        mutate: ({ runPlan }) => {
          runPlan.verification_graph.nodes[0]!.verification_id = ' ';
        },
        message: /duplicate or empty verification_id/u,
      },
      {
        mutate: ({ runPlan }) => {
          runPlan.verification_graph.nodes[0]!.step_id_ref = 'missing';
        },
        message: /missing workflow step/u,
      },
      {
        mutate: ({ runPlan }) => {
          runPlan.verification_graph.nodes[0]!.acceptance_criteria_refs = [];
        },
        message: /has no acceptance criteria/u,
      },
      {
        mutate: ({ runPlan }) => {
          delete (
            runPlan.verification_graph.nodes[0]! as {
              acceptance_criteria_refs?: string[];
            }
          ).acceptance_criteria_refs;
        },
        message: /has no acceptance criteria/u,
      },
    ];
    for (const testCase of cases) {
      const input = fixture('deterministic', 'deterministic');
      testCase.mutate(input);
      await expect(
        new VerificationEngine([]).verify(context(input)),
      ).rejects.toThrow(testCase.message);
    }
  });

  it.each(['-1', '01', '1x', ' 0'])(
    'rejects non-canonical criterion ref %s',
    async (ref) => {
      const input = fixture('deterministic', 'deterministic');
      input.runPlan.verification_graph.nodes[0]!
        .acceptance_criteria_refs = [ref];
      await expect(
        new VerificationEngine([]).verify(context(input)),
      ).rejects.toThrow(`invalid criterion ref: ${ref}`);
    },
  );

  it('rejects missing, multiply owned, and incompatible criteria', async () => {
    const outOfRange = fixture('deterministic', 'deterministic');
    outOfRange.runPlan.verification_graph.nodes[0]!
      .acceptance_criteria_refs = ['1'];
    await expect(
      new VerificationEngine([]).verify(context(outOfRange)),
    ).rejects.toThrow('criterion ref out of range: 1');

    const duplicate = fixture('deterministic', 'deterministic');
    duplicate.runPlan.verification_graph.nodes.push({
      ...duplicate.runPlan.verification_graph.nodes[0]!,
      verification_id: 'verify-1',
    });
    await expect(
      new VerificationEngine([]).verify(context(duplicate)),
    ).rejects.toThrow('criterion 0 has multiple verification owners');

    const mismatch = fixture('test', 'deterministic');
    await expect(
      new VerificationEngine([]).verify(context(mismatch)),
    ).rejects.toThrow('verification type mismatch for criterion 0');

    const uncovered = fixture('deterministic', 'deterministic');
    uncovered.task.success_criteria.push({
      criterion: 'criterion-1',
      verification_method: 'deterministic',
    });
    await expect(
      new VerificationEngine([]).verify(context(uncovered)),
    ).rejects.toThrow(
      'every success criterion must have exactly one verification owner',
    );
  });

  it('rejects empty graphs, invalid edges, duplicate edges, and cycles', async () => {
    const empty = fixture('deterministic', 'deterministic');
    empty.runPlan.verification_graph.nodes = [];
    await expect(
      new VerificationEngine([]).verify(context(empty)),
    ).rejects.toThrow('VerificationGraph has no nodes');

    const edgeFixture = () => {
      const input = fixture('deterministic', 'deterministic');
      input.task.success_criteria.push({
        criterion: 'criterion-1',
        verification_method: 'deterministic',
      });
      input.runPlan.verification_graph.nodes.push({
        ...input.runPlan.verification_graph.nodes[0]!,
        verification_id: 'verify-1',
        acceptance_criteria_refs: ['1'],
      });
      return input;
    };
    const missing = edgeFixture();
    missing.runPlan.verification_graph.edges = [
      { from_verification: 'missing', to_verification: 'verify-1' },
    ];
    await expect(
      new VerificationEngine([]).verify(context(missing)),
    ).rejects.toThrow('edge references a missing node');

    const self = edgeFixture();
    self.runPlan.verification_graph.edges = [
      { from_verification: 'verify-0', to_verification: 'verify-0' },
    ];
    await expect(
      new VerificationEngine([]).verify(context(self)),
    ).rejects.toThrow('duplicate or self edge');

    const duplicate = edgeFixture();
    duplicate.runPlan.verification_graph.edges = [
      { from_verification: 'verify-0', to_verification: 'verify-1' },
      { from_verification: 'verify-0', to_verification: 'verify-1' },
    ];
    await expect(
      new VerificationEngine([]).verify(context(duplicate)),
    ).rejects.toThrow('duplicate or self edge');

    const cycle = edgeFixture();
    cycle.runPlan.verification_graph.edges = [
      { from_verification: 'verify-0', to_verification: 'verify-1' },
      { from_verification: 'verify-1', to_verification: 'verify-0' },
    ];
    await expect(
      new VerificationEngine([]).verify(context(cycle)),
    ).rejects.toThrow('VerificationGraph contains a cycle');
  });

  it('blocks dependants after any criterion on their owner node fails', async () => {
    const input = fixture('deterministic', 'deterministic');
    input.task.success_criteria.push(
      { criterion: 'criterion-1', verification_method: 'deterministic' },
      { criterion: 'criterion-2', verification_method: 'deterministic' },
    );
    input.runPlan.verification_graph.nodes[0]!
      .acceptance_criteria_refs = ['0', '1'];
    input.runPlan.verification_graph.nodes.push({
      ...input.runPlan.verification_graph.nodes[0]!,
      verification_id: 'verify-2',
      acceptance_criteria_refs: ['2'],
    });
    input.runPlan.verification_graph.edges = [
      { from_verification: 'verify-0', to_verification: 'verify-2' },
    ];
    const adapter = new CallbackVerificationAdapter(
      'deterministic-callback',
      ['deterministic'],
      async ({ criterionIndex }) => ({
        passed: criterionIndex !== 0,
        evidence: { criterionIndex },
      }),
    );
    const report = await new VerificationEngine([adapter]).verify(
      context(input),
    );
    expect(report.records.map((record) => record.status)).toEqual([
      'failed',
      'passed',
      'blocked',
    ]);
    expect(report.records[2]).toMatchObject({
      adapter_id: null,
      reason: 'dependency verification failed',
      evidence: {},
    });
    expect(report.all_passed).toBe(false);
  });

  it('rejects invalid adapter registration and preserves error identity', () => {
    const error = new VerificationEngineError('boundary');
    expect(error.name).toBe('VerificationEngineError');
    expect(error.message).toBe('boundary');
    expect(() =>
      new VerificationEngine([
        {
          adapterId: ' ',
          verificationTypes: ['deterministic'],
          verify: async () => ({ passed: true, evidence: {} }),
        },
      ]),
    ).toThrow('adapterId required');
    expect(() =>
      new VerificationEngine([
        {
          adapterId: 'empty',
          verificationTypes: [],
          verify: async () => ({ passed: true, evidence: {} }),
        },
      ]),
    ).toThrow('adapter empty has no verification types');
    expect(() =>
      new VerificationEngine([
        new CallbackVerificationAdapter('one', ['deterministic'], async () => ({
          passed: true,
          evidence: {},
        })),
        new CallbackVerificationAdapter('two', ['deterministic'], async () => ({
          passed: true,
          evidence: {},
        })),
      ]),
    ).toThrow('duplicate adapter for verification type: deterministic');
  });

  it('records adapter failure, thrown errors, timestamps, and freezes proof', async () => {
    const timestamps = [
      'start',
      'record-start',
      'record-end',
      'complete',
    ];
    const failed = new VerificationEngine(
      [
        new CallbackVerificationAdapter(
          'reviewer',
          ['semantic'],
          async () => ({
            passed: false,
            reason: 'review rejected',
            evidence: { score: 0 },
          }),
        ),
      ],
      () => timestamps.shift()!,
    );
    const report = await failed.verify(
      context(fixture('semantic', 'independent_verifier')),
    );
    expect(report).toMatchObject({
      started_at: 'start',
      completed_at: 'complete',
      all_passed: false,
      records: [
        {
          status: 'failed',
          reason: 'review rejected',
          started_at: 'record-start',
          completed_at: 'record-end',
          evidence: { score: 0 },
        },
      ],
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.records)).toBe(true);
    expect(Object.isFrozen(report.records[0]!.evidence)).toBe(true);

    for (const thrown of [new Error('adapter exploded'), 'non-error']) {
      const engine = new VerificationEngine([
        new CallbackVerificationAdapter(
          'thrower',
          ['semantic'],
          async () => {
            throw thrown;
          },
        ),
      ]);
      const thrownReport = await engine.verify(
        context(fixture('semantic', 'independent_verifier')),
      );
      expect(thrownReport.records[0]).toMatchObject({
        status: 'failed',
        reason:
          thrown instanceof Error ? 'adapter exploded' : 'adapter failed',
        evidence: {},
      });
    }
  });

  it('maps callback method aliases to exact graph verification types', () => {
    const adapter = new CallbackVerificationAdapter(
      'aliases',
      ['test', 'semantic', 'human_review', 'read_back', 'test'],
      async () => ({ passed: true, evidence: {} }),
    );
    expect(adapter.verificationTypes).toEqual([
      'test_execution',
      'independent_verifier',
      'human_review',
      'read_back',
    ]);
  });

  it('fails read-back verification for missing expectations and mismatches', async () => {
    writeFileSync(join(workspaceRoot, 'answer.txt'), 'actual');
    for (const adapter of [
      new ReadBackVerificationAdapter({}),
      new ReadBackVerificationAdapter({
        'criterion-0': {
          path: '/workspace/answer.txt',
          expectedSha256: '0'.repeat(64),
        },
      }),
    ]) {
      const report = await new VerificationEngine([adapter]).verify(
        context(fixture('deterministic', 'read_back')),
      );
      expect(report.all_passed).toBe(false);
      expect(report.records[0]!.reason).toMatch(
        /missing read-back expectation|read-back hash mismatch/u,
      );
    }
  });

  it('fails sandbox test verification for missing, nonzero, and timed-out commands', async () => {
    const cases = [
      new SandboxTestVerificationAdapter({}),
      new SandboxTestVerificationAdapter({
        'criterion-0': {
          argv: [node, '-e', 'process.exit(6)'],
        },
      }),
      new SandboxTestVerificationAdapter({
        'criterion-0': {
          argv: [node, '-e', 'setTimeout(()=>{}, 1000)'],
          timeoutMs: 10,
        },
      }),
    ];
    for (const adapter of cases) {
      const report = await new VerificationEngine([adapter]).verify(
        context(fixture('test', 'test_execution')),
      );
      expect(report.all_passed).toBe(false);
      expect(report.records[0]!.evidence).toEqual(
        expect.any(Object),
      );
    }
  });

  it('fails schema verification for missing expectations, invalid JSON, and mismatch', async () => {
    writeFileSync(join(workspaceRoot, 'invalid.json'), '{');
    writeFileSync(join(workspaceRoot, 'wrong.json'), '{"status":"wrong"}');
    const schema = {
      type: 'object',
      required: ['status'],
      properties: { status: { const: 'ok' } },
    };
    const cases = [
      new JsonSchemaVerificationAdapter({}),
      new JsonSchemaVerificationAdapter({
        'criterion-0': { path: '/workspace/invalid.json', schema },
      }),
      new JsonSchemaVerificationAdapter({
        'criterion-0': { path: '/workspace/wrong.json', schema },
      }),
    ];
    const reasons = [
      'missing schema expectation',
      'read-back is not valid JSON',
      'JSON schema validation failed',
    ];
    for (const [index, adapter] of cases.entries()) {
      const report = await new VerificationEngine([adapter!]).verify(
        context(fixture('deterministic', 'schema_validation')),
      );
      expect(report.records[0]!.reason).toBe(reasons[index]);
      expect(report.all_passed).toBe(false);
    }
  });

  it('fails workspace diff verification for absent, empty, and mismatched expectations', async () => {
    writeFileSync(join(workspaceRoot, 'changed.ts'), 'actual');
    const cases = [
      new WorkspaceDiffVerificationAdapter({}),
      new WorkspaceDiffVerificationAdapter({
        'criterion-0': { files: [] },
      }),
      new WorkspaceDiffVerificationAdapter({
        'criterion-0': {
          files: [
            {
              path: '/workspace/changed.ts',
              expectedSha256: '0'.repeat(64),
            },
          ],
        },
      }),
    ];
    for (const adapter of cases) {
      const report = await new VerificationEngine([adapter]).verify(
        context(fixture('deterministic', 'blind_verification')),
      );
      expect(report.all_passed).toBe(false);
    }
    const mismatch = await new VerificationEngine([cases[2]!]).verify(
      context(fixture('deterministic', 'blind_verification')),
    );
    expect(mismatch.records[0]).toMatchObject({
      reason: 'workspace diff expectation failed',
      evidence: { files: [expect.objectContaining({ passed: false })] },
    });
  });

  it('fails receipt verification for empty, malformed, failed, and denied receipts', async () => {
    const input = fixture('deterministic', 'deterministic');
    for (const expectation of [
      {},
      { 'criterion-0': { expectedTools: [] } },
    ]) {
      const report = await new VerificationEngine([
        new ReceiptPostconditionVerificationAdapter(expectation),
      ]).verify(context(input));
      expect(report.records[0]!.reason).toBe(
        'missing receipt expectation',
      );
    }
    const adapter = new ReceiptPostconditionVerificationAdapter({
      'criterion-0': { expectedTools: ['write_file'] },
    });
    const report = await new VerificationEngine([adapter]).verify(
      context(input, [
        null,
        {},
        { tool_name: 4, success: true },
        { tool_name: 'write_file', success: 'yes' },
        { tool_name: 'write_file', success: false },
        {
          tool_name: 'write_file',
          success: true,
          policy_decision: 'deny',
        },
      ]),
    );
    expect(report).toMatchObject({
      all_passed: false,
      records: [
        {
          reason: 'required successful receipt is missing',
          evidence: {
            expected_tools: ['write_file'],
            verified_tools: [],
            receipt_count: 2,
          },
        },
      ],
    });
  });
});
