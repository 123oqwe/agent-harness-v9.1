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
});
