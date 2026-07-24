/**
 * Phase 1 VerificationGraph executor.
 *
 * Runtime/model output is never accepted as proof by itself. Each declared
 * success criterion must be bound to one explicit adapter and one graph node.
 */
import { createHash } from 'node:crypto';
import Ajv from 'ajv/dist/2020.js';
import type {
  RunPlan,
  TaskContract,
} from '../contracts/index.js';
import type {
  LoopResult,
  LoopTurn,
} from '../runtime/loop.js';
import type { SandboxProfile } from '../runtime/sandbox.js';
import { executeCommand } from '../tools/execute-command.js';
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import type { SessionEvent } from '../session/durable-session.js';

export type VerificationMethod =
  TaskContract['success_criteria'][number]['verification_method'];
export type VerificationType =
  RunPlan['verification_graph']['nodes'][number]['verification_type'];

export interface VerificationContext {
  task: TaskContract;
  runPlan: RunPlan;
  loopResult: LoopResult;
  vfs: VirtualFilesystem;
  sandbox: SandboxProfile;
  sessionEvents: readonly SessionEvent[];
  toolReceipts: readonly unknown[];
}

export interface CriterionVerificationRequest
  extends VerificationContext {
  verificationId: string;
  criterionIndex: number;
  criterion: TaskContract['success_criteria'][number];
  turns: readonly LoopTurn[];
}

export interface AdapterVerificationResult {
  passed: boolean;
  evidence: Readonly<Record<string, unknown>>;
  reason?: string;
}

export interface VerificationAdapter {
  readonly adapterId: string;
  readonly verificationTypes: readonly VerificationType[];
  verify(
    request: CriterionVerificationRequest,
  ): Promise<AdapterVerificationResult>;
}

export interface VerificationRecord {
  verification_id: string;
  criterion_index: number;
  criterion: string;
  method: VerificationMethod;
  adapter_id: string | null;
  status: 'passed' | 'failed' | 'blocked';
  reason?: string;
  evidence: Readonly<Record<string, unknown>>;
  started_at: string;
  completed_at: string;
}

export interface VerificationReport {
  plan_revision: number;
  all_passed: boolean;
  records: readonly VerificationRecord[];
  started_at: string;
  completed_at: string;
}

export class VerificationEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationEngineError';
    Object.setPrototypeOf(this, VerificationEngineError.prototype);
  }
}

type VerificationNode =
  RunPlan['verification_graph']['nodes'][number];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function compatibleGraphTypes(
  method: VerificationMethod,
): readonly VerificationType[] {
  switch (method) {
    case 'deterministic':
      return [
        'deterministic',
        'schema_validation',
        'read_back',
        'blind_verification',
      ];
    case 'test':
      return ['test_execution'];
    case 'human_review':
      return ['human_review'];
    case 'semantic':
      return ['independent_verifier'];
  }
}

function defaultType(method: VerificationMethod): VerificationType {
  return compatibleGraphTypes(method)[0]!;
}

function validateGraph(
  task: TaskContract,
  runPlan: RunPlan,
): { order: VerificationNode[]; dependencies: Map<string, string[]> } {
  const workflowIds = new Set<string>();
  for (const node of runPlan.workflow_graph.nodes) {
    if (node.step_id.trim() === '' || workflowIds.has(node.step_id)) {
      throw new VerificationEngineError(
        `duplicate or empty workflow step_id: ${node.step_id}`,
      );
    }
    workflowIds.add(node.step_id);
  }

  const nodes = runPlan.verification_graph.nodes;
  if (nodes.length === 0 && task.success_criteria.length > 0) {
    throw new VerificationEngineError('VerificationGraph has no nodes');
  }
  const nodeMap = new Map<string, VerificationNode>();
  const criterionOwners = new Map<number, string>();
  for (const node of nodes) {
    if (
      node.verification_id.trim() === '' ||
      nodeMap.has(node.verification_id)
    ) {
      throw new VerificationEngineError(
        `duplicate or empty verification_id: ${node.verification_id}`,
      );
    }
    if (!workflowIds.has(node.step_id_ref)) {
      throw new VerificationEngineError(
        `verification references missing workflow step: ${node.step_id_ref}`,
      );
    }
    if (
      !node.acceptance_criteria_refs ||
      node.acceptance_criteria_refs.length === 0
    ) {
      throw new VerificationEngineError(
        `verification ${node.verification_id} has no acceptance criteria`,
      );
    }
    for (const ref of node.acceptance_criteria_refs) {
      if (!/^(0|[1-9]\d*)$/.test(ref)) {
        throw new VerificationEngineError(`invalid criterion ref: ${ref}`);
      }
      const index = Number(ref);
      const criterion = task.success_criteria[index];
      if (!criterion) {
        throw new VerificationEngineError(`criterion ref out of range: ${ref}`);
      }
      if (criterionOwners.has(index)) {
        throw new VerificationEngineError(
          `criterion ${index} has multiple verification owners`,
        );
      }
      if (
        !compatibleGraphTypes(criterion.verification_method).includes(
          node.verification_type,
        )
      ) {
        throw new VerificationEngineError(
          `verification type mismatch for criterion ${index}`,
        );
      }
      criterionOwners.set(index, node.verification_id);
    }
    nodeMap.set(node.verification_id, node);
  }
  if (criterionOwners.size !== task.success_criteria.length) {
    throw new VerificationEngineError(
      'every success criterion must have exactly one verification owner',
    );
  }

  const dependencies = new Map<string, string[]>(
    nodes.map((node) => [node.verification_id, []]),
  );
  const outgoing = new Map<string, string[]>(
    nodes.map((node) => [node.verification_id, []]),
  );
  const inDegree = new Map<string, number>(
    nodes.map((node) => [node.verification_id, 0]),
  );
  const edges = new Set<string>();
  for (const edge of runPlan.verification_graph.edges) {
    if (
      !nodeMap.has(edge.from_verification) ||
      !nodeMap.has(edge.to_verification)
    ) {
      throw new VerificationEngineError(
        'VerificationGraph edge references a missing node',
      );
    }
    const edgeKey = `${edge.from_verification}\0${edge.to_verification}`;
    if (
      edges.has(edgeKey) ||
      edge.from_verification === edge.to_verification
    ) {
      throw new VerificationEngineError(
        'VerificationGraph has a duplicate or self edge',
      );
    }
    edges.add(edgeKey);
    outgoing.get(edge.from_verification)!.push(edge.to_verification);
    dependencies.get(edge.to_verification)!.push(edge.from_verification);
    inDegree.set(
      edge.to_verification,
      inDegree.get(edge.to_verification)! + 1,
    );
  }
  const queue = nodes
    .filter((node) => inDegree.get(node.verification_id) === 0)
    .map((node) => node.verification_id)
    .sort();
  const order: VerificationNode[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(nodeMap.get(id)!);
    for (const next of outgoing.get(id)!.sort()) {
      const degree = inDegree.get(next)! - 1;
      inDegree.set(next, degree);
      if (degree === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }
  if (order.length !== nodes.length) {
    throw new VerificationEngineError('VerificationGraph contains a cycle');
  }
  return { order, dependencies };
}

export class VerificationEngine {
  private readonly adapters = new Map<
    VerificationType,
    VerificationAdapter
  >();
  private readonly clock: () => string;

  constructor(
    adapters: readonly VerificationAdapter[],
    clock: () => string = () => new Date().toISOString(),
  ) {
    this.clock = clock;
    for (const adapter of adapters) {
      if (adapter.adapterId.trim() === '') {
        throw new VerificationEngineError('adapterId required');
      }
      for (const verificationType of adapter.verificationTypes) {
        if (this.adapters.has(verificationType)) {
          throw new VerificationEngineError(
            `duplicate adapter for verification type: ${verificationType}`,
          );
        }
        this.adapters.set(verificationType, adapter);
      }
    }
  }

  async verify(context: VerificationContext): Promise<VerificationReport> {
    const startedAt = this.clock();
    const graph = validateGraph(context.task, context.runPlan);
    const records: VerificationRecord[] = [];
    const statusById = new Map<string, VerificationRecord['status']>();

    for (const node of graph.order) {
      const refs = node.acceptance_criteria_refs!.map(Number);
      for (const criterionIndex of refs) {
        const criterion = context.task.success_criteria[criterionIndex]!;
        const recordStartedAt = this.clock();
        const blocked = graph.dependencies
          .get(node.verification_id)!
          .some((id) => statusById.get(id) !== 'passed');
        if (blocked) {
          const record = deepFreeze<VerificationRecord>({
            verification_id: node.verification_id,
            criterion_index: criterionIndex,
            criterion: criterion.criterion,
            method: criterion.verification_method,
            adapter_id: null,
            status: 'blocked',
            reason: 'dependency verification failed',
            evidence: Object.freeze({}),
            started_at: recordStartedAt,
            completed_at: this.clock(),
          });
          records.push(record);
          statusById.set(node.verification_id, record.status);
          continue;
        }
        const adapter = this.adapters.get(node.verification_type);
        if (!adapter) {
          const record = deepFreeze<VerificationRecord>({
            verification_id: node.verification_id,
            criterion_index: criterionIndex,
            criterion: criterion.criterion,
            method: criterion.verification_method,
            adapter_id: null,
            status: 'failed',
            reason: `missing adapter for ${node.verification_type}`,
            evidence: Object.freeze({}),
            started_at: recordStartedAt,
            completed_at: this.clock(),
          });
          records.push(record);
          statusById.set(node.verification_id, record.status);
          continue;
        }
        try {
          const result = await adapter.verify({
            ...context,
            verificationId: node.verification_id,
            criterionIndex,
            criterion,
            turns: context.loopResult.turns,
          });
          const record = deepFreeze<VerificationRecord>({
            verification_id: node.verification_id,
            criterion_index: criterionIndex,
            criterion: criterion.criterion,
            method: criterion.verification_method,
            adapter_id: adapter.adapterId,
            status: result.passed ? 'passed' : 'failed',
            ...(result.reason === undefined ? {} : { reason: result.reason }),
            evidence: { ...result.evidence },
            started_at: recordStartedAt,
            completed_at: this.clock(),
          });
          records.push(record);
          statusById.set(node.verification_id, record.status);
        } catch (error) {
          const record = deepFreeze<VerificationRecord>({
            verification_id: node.verification_id,
            criterion_index: criterionIndex,
            criterion: criterion.criterion,
            method: criterion.verification_method,
            adapter_id: adapter.adapterId,
            status: 'failed',
            reason: error instanceof Error ? error.message : 'adapter failed',
            evidence: Object.freeze({}),
            started_at: recordStartedAt,
            completed_at: this.clock(),
          });
          records.push(record);
          statusById.set(node.verification_id, record.status);
        }
      }
    }
    return deepFreeze({
      plan_revision: context.runPlan.revision,
      all_passed:
        records.length === context.task.success_criteria.length &&
        records.every((record) => record.status === 'passed'),
      records,
      started_at: startedAt,
      completed_at: this.clock(),
    });
  }
}

export class CallbackVerificationAdapter implements VerificationAdapter {
  readonly verificationTypes: readonly VerificationType[];

  constructor(
    readonly adapterId: string,
    methodsOrTypes: readonly (VerificationMethod | VerificationType)[],
    private readonly callback: (
      request: CriterionVerificationRequest,
    ) => Promise<AdapterVerificationResult>,
  ) {
    this.verificationTypes = Object.freeze([
      ...new Set(
        methodsOrTypes.map((entry) =>
          entry === 'test' ||
          entry === 'semantic' ||
          entry === 'human_review'
            ? defaultType(entry)
            : entry,
        ),
      ),
    ]);
  }

  verify(
    request: CriterionVerificationRequest,
  ): Promise<AdapterVerificationResult> {
    return this.callback(request);
  }
}

export interface ReadBackExpectation {
  path: string;
  expectedSha256: string;
}

export class ReadBackVerificationAdapter implements VerificationAdapter {
  readonly adapterId = 'read-back-sha256.v1';
  readonly verificationTypes = ['deterministic', 'read_back'] as const;

  constructor(
    private readonly expectations: Readonly<
      Record<string, ReadBackExpectation>
    >,
  ) {}

  async verify(
    request: CriterionVerificationRequest,
  ): Promise<AdapterVerificationResult> {
    const expectation = this.expectations[request.criterion.criterion];
    if (!expectation) {
      return {
        passed: false,
        reason: 'missing read-back expectation',
        evidence: {},
      };
    }
    const content = request.vfs.read(expectation.path);
    const sha256 = createHash('sha256').update(content).digest('hex');
    return {
      passed: sha256 === expectation.expectedSha256,
      ...(sha256 === expectation.expectedSha256
        ? {}
        : { reason: 'read-back hash mismatch' }),
      evidence: {
        path: expectation.path,
        sha256,
        bytes: content.length,
      },
    };
  }
}

export interface SandboxTestExpectation {
  argv: readonly string[];
  timeoutMs?: number;
}

export class SandboxTestVerificationAdapter implements VerificationAdapter {
  readonly adapterId = 'sandbox-test-exit.v1';
  readonly verificationTypes = ['test_execution'] as const;

  constructor(
    private readonly expectations: Readonly<
      Record<string, SandboxTestExpectation>
    >,
  ) {}

  async verify(
    request: CriterionVerificationRequest,
  ): Promise<AdapterVerificationResult> {
    const expectation = this.expectations[request.criterion.criterion];
    if (!expectation) {
      return {
        passed: false,
        reason: 'missing sandbox test command',
        evidence: {},
      };
    }
    const result = await executeCommand(request.sandbox, {
      argv: [...expectation.argv],
      cwd: request.sandbox.workspaceRoot,
      ...(expectation.timeoutMs === undefined
        ? {}
        : { timeout_ms: expectation.timeoutMs }),
    });
    return {
      passed: result.exit_code === 0 && !result.timed_out,
      ...(result.exit_code === 0 && !result.timed_out
        ? {}
        : { reason: `test exit ${String(result.exit_code)}` }),
      evidence: {
        argv: [...expectation.argv],
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        truncated: result.truncated,
        stdout_sha256: createHash('sha256')
          .update(result.stdout)
          .digest('hex'),
        stderr_sha256: createHash('sha256')
          .update(result.stderr)
          .digest('hex'),
      },
    };
  }
}

export interface JsonSchemaExpectation {
  path: string;
  schema: Readonly<Record<string, unknown>>;
}

export class JsonSchemaVerificationAdapter implements VerificationAdapter {
  readonly adapterId = 'json-schema.v1';
  readonly verificationTypes = ['schema_validation'] as const;

  constructor(
    private readonly expectations: Readonly<
      Record<string, JsonSchemaExpectation>
    >,
  ) {}

  async verify(
    request: CriterionVerificationRequest,
  ): Promise<AdapterVerificationResult> {
    const expectation = this.expectations[request.criterion.criterion];
    if (!expectation) {
      return {
        passed: false,
        reason: 'missing schema expectation',
        evidence: {},
      };
    }
    const bytes = request.vfs.read(expectation.path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      return {
        passed: false,
        reason: 'read-back is not valid JSON',
        evidence: {
          path: expectation.path,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      };
    }
    const validate = new Ajv({ allErrors: true, strict: false }).compile(
      expectation.schema,
    );
    const passed = validate(parsed);
    return {
      passed,
      ...(passed
        ? {}
        : {
            reason: 'JSON schema validation failed',
          }),
      evidence: {
        path: expectation.path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        errors: validate.errors ?? [],
      },
    };
  }
}

export interface WorkspaceDiffExpectation {
  files: readonly {
    path: string;
    expectedSha256: string;
  }[];
}

export class WorkspaceDiffVerificationAdapter
  implements VerificationAdapter
{
  readonly adapterId = 'workspace-diff.v1';
  readonly verificationTypes = ['blind_verification'] as const;

  constructor(
    private readonly expectations: Readonly<
      Record<string, WorkspaceDiffExpectation>
    >,
  ) {}

  async verify(
    request: CriterionVerificationRequest,
  ): Promise<AdapterVerificationResult> {
    const expectation = this.expectations[request.criterion.criterion];
    if (!expectation || expectation.files.length === 0) {
      return {
        passed: false,
        reason: 'missing workspace diff expectation',
        evidence: {},
      };
    }
    const files = expectation.files.map((file) => {
      const content = request.vfs.read(file.path);
      const actualSha256 = createHash('sha256')
        .update(content)
        .digest('hex');
      return {
        path: file.path,
        expected_sha256: file.expectedSha256,
        actual_sha256: actualSha256,
        passed: actualSha256 === file.expectedSha256,
      };
    });
    const passed = files.every((file) => file.passed);
    return {
      passed,
      ...(passed ? {} : { reason: 'workspace diff expectation failed' }),
      evidence: { files },
    };
  }
}

export interface ReceiptExpectation {
  expectedTools: readonly string[];
}

export class ReceiptPostconditionVerificationAdapter
  implements VerificationAdapter
{
  readonly adapterId = 'receipt-postcondition.v1';
  readonly verificationTypes = ['deterministic'] as const;

  constructor(
    private readonly expectations: Readonly<
      Record<string, ReceiptExpectation>
    >,
  ) {}

  async verify(
    request: CriterionVerificationRequest,
  ): Promise<AdapterVerificationResult> {
    const expectation = this.expectations[request.criterion.criterion];
    if (!expectation) {
      return {
        passed: false,
        reason: 'missing receipt expectation',
        evidence: {},
      };
    }
    const receipts = request.toolReceipts.filter(
      (candidate): candidate is {
        tool_name: string;
        success: boolean;
        policy_decision?: string;
      } =>
        typeof candidate === 'object' &&
        candidate !== null &&
        typeof (candidate as { tool_name?: unknown }).tool_name === 'string' &&
        typeof (candidate as { success?: unknown }).success === 'boolean',
    );
    const verifiedTools = expectation.expectedTools.filter((tool) =>
      receipts.some(
        (receipt) =>
          receipt.tool_name === tool &&
          receipt.success &&
          (receipt.policy_decision === undefined ||
            receipt.policy_decision === 'allow'),
      ),
    );
    const passed =
      new Set(verifiedTools).size === new Set(expectation.expectedTools).size;
    return {
      passed,
      ...(passed ? {} : { reason: 'required successful receipt is missing' }),
      evidence: {
        expected_tools: [...expectation.expectedTools],
        verified_tools: verifiedTools,
        receipt_count: receipts.length,
      },
    };
  }
}
