/** Plan+Execute: validate a frozen DAG, then execute immutable step state. */
import type {
  RunPlan,
  WorkflowGraph,
} from '../contracts/index.js';
import type {
  LoopTurn,
  ModelTurn,
  RuntimeStepState,
} from './loop.js';
import { LoopError } from './loop.js';
import type { StrategyContext } from './reasoning-strategy.js';

type WorkflowNode = WorkflowGraph['nodes'][number];
type ToolCall = NonNullable<ModelTurn['tool_calls']>[number];

interface ValidatedWorkflow {
  order: readonly string[];
  nodes: ReadonlyMap<string, WorkflowNode>;
  incoming: ReadonlyMap<string, readonly string[]>;
  outgoing: ReadonlyMap<string, readonly string[]>;
}

function taskPaths(goal: string): string[] {
  return [
    ...new Set(
      [
        ...goal.matchAll(
          /(?:[\p{L}\p{N}_-]+\/)*[\p{L}\p{N}_-]+\.[a-z0-9]+/giu,
        ),
      ].map((match) => match[0]!),
    ),
  ];
}

function outputPaths(goal: string): Set<string> {
  const paths = new Set<string>();
  for (const match of goal.matchAll(
    /(?:\b(?:write|create)\s+|\b(?:into|as)\s+|(?:写入|创建|新建)\s*)((?:[\p{L}\p{N}_-]+\/)*[\p{L}\p{N}_-]+\.[a-z0-9]+)/giu,
  )) {
    paths.add(match[1]!);
  }
  return paths;
}

function isTestPath(path: string): boolean {
  return /(?:^|\/)(?:test|spec|[^/]*(?:test|spec)[^/]*)\.[a-z0-9]+$/iu.test(
    path,
  );
}

function planningJsonInstruction(goal: string, target: string): string {
  if (
    !target.toLowerCase().endsWith('.json') ||
    !/\bdepends_on\b/iu.test(goal)
  ) {
    return '';
  }
  const list = goal.match(
    /\bfor\s+([a-z0-9_-]+(?:\s*,\s*[a-z0-9_-]+)*(?:\s*,?\s+and\s+[a-z0-9_-]+)?)\s+so\b/iu,
  );
  if (!list) {
    return ' The JSON must be a top-level array of task objects, or an object with a tasks array; every task object must have a string id and a depends_on string array.';
  }
  const ids = list[1]!
    .replace(/\s*,?\s+and\s+/giu, ',')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const dependencies = new Map(ids.map((id) => [id, [] as string[]]));
  for (const relation of goal.matchAll(
    /\b([a-z0-9_-]+)\s+after\s+([a-z0-9_-]+)\b/giu,
  )) {
    const task = relation[1]!;
    const dependency = relation[2]!;
    if (!dependencies.has(task)) dependencies.set(task, []);
    if (!dependencies.has(dependency)) dependencies.set(dependency, []);
    dependencies.get(task)!.push(dependency);
  }
  const tasks = [...dependencies].map(([id, depends_on]) => ({
    id,
    depends_on: [...new Set(depends_on)],
  }));
  return ` The JSON content must have this exact structural shape: ${JSON.stringify({ tasks })}.`;
}

/**
 * Narrow the current frozen tool node without putting untrusted task prose in
 * a system message. These are routing hints, not capabilities; Dispatcher,
 * Policy and VFS remain the execution authorities.
 */
export function planActionInstruction(
  runPlan: Readonly<RunPlan>,
  requiredTool: string,
  targetStep: string,
): string {
  const goal = runPlan.task?.goal ?? '';
  const paths = taskPaths(goal);
  const outputs = outputPaths(goal);
  const sources = paths.filter((path) => !outputs.has(path));
  const toolNodes = runPlan.workflow_graph.nodes.filter(
    (node) => node.step_type === 'tool_call',
  );
  const currentIndex = toolNodes.findIndex(
    (node) => node.step_id === targetStep,
  );
  const sameToolIndex = toolNodes
    .slice(0, Math.max(0, currentIndex))
    .filter((node) => node.tool_name === requiredTool).length;

  if (requiredTool === 'read_file') {
    const target = sources[sameToolIndex];
    return target === undefined
      ? ''
      : ` The read path must be ${JSON.stringify(target)}.`;
  }
  if (requiredTool === 'edit_file') {
    const target =
      sources.find((path) => !isTestPath(path)) ?? sources[0];
    return target === undefined
      ? ''
      : ` Edit only ${JSON.stringify(target)} using the content returned by the prior read; never edit a test/spec file and never submit a no-op replacement.`;
  }
  if (requiredTool === 'write_file') {
    const target = [...outputs][0];
    return target === undefined
      ? ''
      : ` The write path must be ${JSON.stringify(target)}.${planningJsonInstruction(goal, target)}`;
  }
  if (requiredTool === 'execute_command') {
    const command = goal.match(
      /(?:\b(?:run|execute)\s+|运行\s*)(node|python3)\s+((?:[\p{L}\p{N}_-]+\/)*[\p{L}\p{N}_-]+\.[a-z0-9]+)/iu,
    );
    const absoluteCommand = goal.match(
      /\b(?:run|execute)\s+(\/[a-z0-9_./-]+(?:\s+[a-z0-9_./-]+)*)\s*$/iu,
    );
    const argv =
      command === null
        ? absoluteCommand?.[1]?.trim().split(/\s+/u)
        : [command[1]!, command[2]!];
    return argv === undefined
      ? ''
      : ` Run exactly argv ${JSON.stringify(argv)} with cwd "/workspace"; do not substitute a discovery command.`;
  }
  return '';
}

const SUPPORTED_STEP_TYPES = new Set<WorkflowNode['step_type']>([
  'model_call',
  'tool_call',
  'verification',
  'decision',
]);
const VALID_STATUSES = new Set<WorkflowNode['status']>([
  'pending',
  'dispatched',
  'executing',
  'verifying',
  'done',
  'failed',
  'blocked',
  'skipped',
]);

function validateWorkflow(runPlan: Readonly<RunPlan>): ValidatedWorkflow {
  const graph = runPlan.workflow_graph;
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    throw new LoopError('plan_execute requires a non-empty WorkflowGraph');
  }
  if (!Array.isArray(graph.edges)) {
    throw new LoopError('WorkflowGraph edges must be an array');
  }
  if (!Array.isArray(runPlan.tool_grants)) {
    throw new LoopError('RunPlan tool_grants must be an array');
  }
  const nodes = new Map<string, WorkflowNode>();
  for (const node of graph.nodes) {
    if (node.step_id.trim() === '' || nodes.has(node.step_id)) {
      throw new LoopError(`duplicate or empty step_id: ${node.step_id}`);
    }
    if (!VALID_STATUSES.has(node.status)) {
      throw new LoopError(`invalid step status: ${String(node.status)}`);
    }
    if (!SUPPORTED_STEP_TYPES.has(node.step_type)) {
      throw new LoopError(
        `step type has no Phase 1 implementation: ${node.step_type}`,
      );
    }
    nodes.set(node.step_id, node);
  }

  const incoming = new Map<string, string[]>(
    graph.nodes.map((node) => [node.step_id, []]),
  );
  const outgoing = new Map<string, string[]>(
    graph.nodes.map((node) => [node.step_id, []]),
  );
  const inDegree = new Map<string, number>(
    graph.nodes.map((node) => [node.step_id, 0]),
  );
  const edgeKeys = new Set<string>();
  for (const edge of graph.edges) {
    if (!nodes.has(edge.from_step) || !nodes.has(edge.to_step)) {
      throw new LoopError('workflow edge references a missing step');
    }
    const edgeKey = `${edge.from_step}\0${edge.to_step}`;
    if (edgeKeys.has(edgeKey) || edge.from_step === edge.to_step) {
      throw new LoopError('duplicate or self-referential workflow edge');
    }
    edgeKeys.add(edgeKey);
    outgoing.get(edge.from_step)!.push(edge.to_step);
    incoming.get(edge.to_step)!.push(edge.from_step);
    inDegree.set(edge.to_step, inDegree.get(edge.to_step)! + 1);
  }

  const allowedTools = new Set(runPlan.tool_grants.map((grant) => grant.tool));
  for (const node of graph.nodes) {
    if (node.step_type === 'tool_call') {
      if (!node.tool_name || !allowedTools.has(node.tool_name)) {
        throw new LoopError(
          `tool step is missing or unauthorized: ${String(node.tool_name)}`,
        );
      }
      const predecessors = incoming.get(node.step_id)!;
      if (
        predecessors.length !== 1 ||
        nodes.get(predecessors[0]!)!.step_type !== 'model_call'
      ) {
        throw new LoopError(
          `tool step ${node.step_id} requires one model proposal predecessor`,
        );
      }
    }
    if (
      node.step_type === 'verification' &&
      outgoing.get(node.step_id)!.length > 0
    ) {
      throw new LoopError('Phase 1 verification steps must be terminal');
    }
    if (
      node.step_type === 'model_call' &&
      outgoing
        .get(node.step_id)!
        .filter((id) => nodes.get(id)!.step_type === 'tool_call').length > 1
    ) {
      throw new LoopError('one model proposal cannot bind multiple tool nodes');
    }
  }

  const queue = graph.nodes
    .filter((node) => inDegree.get(node.step_id) === 0)
    .map((node) => node.step_id)
    .sort();
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of outgoing.get(id)!.sort()) {
      const degree = inDegree.get(next)! - 1;
      inDegree.set(next, degree);
      if (degree === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }
  if (order.length !== nodes.size) {
    throw new LoopError('WorkflowGraph contains a cycle');
  }
  return { order, nodes, incoming, outgoing };
}

function restoredStepStates(
  context: StrategyContext,
): Map<string, RuntimeStepState> {
  const states = new Map<string, RuntimeStepState>();
  for (const event of context.deps.session.getEvents()) {
    if (
      event.type === 'system' &&
      (event.data as { event?: string }).event === 'step_state'
    ) {
      const data = event.data as {
        step?: string;
        status?: RuntimeStepState;
      };
      if (data.step && data.status) states.set(data.step, data.status);
    }
  }
  return states;
}

function restoredPendingCalls(
  context: StrategyContext,
): Map<string, ToolCall> {
  const calls = new Map<string, ToolCall>();
  const completed = new Set<string>();
  for (const event of context.deps.session.getEvents()) {
    if (event.type === 'tool_call') {
      const data = event.data as {
        step?: string;
        tool_call_id?: string;
        tool?: string;
        arguments?: Record<string, unknown>;
      };
      if (
        data.step &&
        data.tool_call_id &&
        data.tool &&
        data.arguments
      ) {
        calls.set(data.step, {
          id: data.tool_call_id,
          name: data.tool,
          arguments: data.arguments,
        });
      }
    } else if (event.type === 'tool_result') {
      const data = event.data as { step?: string };
      if (data.step) completed.add(data.step);
    }
  }
  for (const step of completed) calls.delete(step);
  return calls;
}

export async function runPlanExecute(
  context: StrategyContext,
  messages: unknown[],
): Promise<void> {
  if (!context.config.run_plan) {
    throw new LoopError('plan_execute requires a frozen RunPlan');
  }
  const workflow = validateWorkflow(context.config.run_plan);
  const states = restoredStepStates(context);
  const pendingCalls = restoredPendingCalls(context);
  const pendingTurns = new Map<string, LoopTurn>();

  for (const stepId of workflow.order) {
    if (context.terminated) return;
    const previousState = states.get(stepId);
    if (
      previousState === 'done' ||
      previousState === 'awaiting_verification' ||
      previousState === 'failed' ||
      previousState === 'blocked'
    ) {
      continue;
    }
    const dependencyStates = workflow.incoming
      .get(stepId)!
      .map((dependency) => states.get(dependency));
    if (
      dependencyStates.some(
        (state) => state === 'failed' || state === 'blocked',
      )
    ) {
      states.set(stepId, 'blocked');
      context.setStepState(stepId, 'blocked', {
        reason: 'dependency failed',
      });
      continue;
    }
    const preflight = context.preflight();
    if (preflight) {
      context.terminate(preflight);
      return;
    }
    const node = workflow.nodes.get(stepId)!;

    if (node.step_type === 'verification') {
      states.set(stepId, 'awaiting_verification');
      context.setStepState(stepId, 'awaiting_verification');
      continue;
    }

    if (node.step_type === 'model_call' || node.step_type === 'decision') {
      const toolSuccessors = workflow.outgoing
        .get(stepId)!
        .filter(
          (successor) =>
            workflow.nodes.get(successor)!.step_type === 'tool_call',
        );
      const requiredTool =
        toolSuccessors.length === 1
          ? workflow.nodes.get(toolSuccessors[0]!)!.tool_name!
          : undefined;
      const actionInstruction =
        requiredTool === undefined
          ? ''
          : planActionInstruction(
              context.config.run_plan,
              requiredTool,
              toolSuccessors[0]!,
            );
      let turn: ModelTurn;
      let recorded: LoopTurn;
      let proposalAttempt = 0;
      for (;;) {
        if (context.iterations >= context.config.max_iterations) {
          states.set(stepId, 'failed');
          context.setStepState(stepId, 'failed', {
            reason: 'model proposal retry budget exhausted',
          });
          context.terminate('iteration_limit');
          return;
        }
        proposalAttempt += 1;
        context.iterations += 1;
        states.set(stepId, 'executing');
        context.setStepState(stepId, 'executing', {
          proposal_attempt: proposalAttempt,
        });
        turn = await context.deps.modelCall(
          messages,
          context.iterations,
          context.nextModelBudget(),
          requiredTool === undefined
            ? {
                system_instruction:
                  'Plan+Execute synthesis step: use the completed tool observations to return the concise final result. Do not call another tool and never claim an unverified effect.',
                allowed_tools: [],
              }
            : {
                system_instruction: `Plan+Execute action step: call ${requiredTool} exactly once with schema-valid arguments that advance the user task.${actionInstruction} Do not call any other tool and do not return a final completion claim yet.`,
                allowed_tools: [requiredTool],
                required_tool: requiredTool,
              },
        );
        if (context.terminated) return;
        recorded = context.recordTurn(turn);
        if (context.terminated) return;
        if (
          turn.stop_reason === 'length' &&
          (requiredTool !== undefined || turn.content.trim().length === 0)
        ) {
          states.set(stepId, 'failed');
          context.setStepState(stepId, 'failed', {
            reason: 'truncated model turn',
          });
          context.terminate('malformed_response');
          return;
        }
        if (turn.stop_reason === 'content_filter') {
          states.set(stepId, 'failed');
          context.setStepState(stepId, 'failed', {
            reason: 'model refusal',
          });
          context.terminate('model_refusal');
          return;
        }
        if (context.budgetExceeded()) {
          states.set(stepId, 'failed');
          context.setStepState(stepId, 'failed', {
            reason: 'budget exceeded',
          });
          context.terminate('budget_exhausted');
          return;
        }
        const validProposal =
          requiredTool === undefined
            ? !turn.tool_calls || turn.tool_calls.length === 0
            : turn.tool_calls?.length === 1 &&
              turn.tool_calls[0]!.name === requiredTool;
        if (validProposal) break;

        const calls = turn.tool_calls ?? [];
        messages.push({
          role: 'assistant',
          content: turn.content,
          ...(turn.reasoning_content === undefined
            ? {}
            : { reasoning_content: turn.reasoning_content }),
          decision_summary: turn.decision_summary,
          ...(calls.length === 0 ? {} : { tool_calls: calls }),
        });
        for (const call of calls) {
          context.recordToolCall(recorded, call, stepId);
          const observation = context.recordObservation(
            recorded,
            call,
            'rejected',
            requiredTool === undefined
              ? 'model step has no bound tool node'
              : `expected exactly one ${requiredTool} tool call`,
            stepId,
          );
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(observation),
          });
        }
        messages.push({
          role: 'system',
          content:
            requiredTool === undefined
              ? 'Correction: return the final answer without any tool call.'
              : `Correction: call ${requiredTool} exactly once, not zero or multiple times.`,
        });
        if (proposalAttempt >= 2) {
          states.set(stepId, 'failed');
          context.setStepState(stepId, 'failed', {
            reason:
              requiredTool === undefined
                ? 'model step has no bound tool node'
                : `expected exactly one ${requiredTool} tool call`,
          });
          context.terminate('malformed_response');
          return;
        }
      }
      if (toolSuccessors.length === 1) {
        const targetStep = toolSuccessors[0]!;
        const call = turn.tool_calls![0]!;
        context.recordToolCall(recorded, call, targetStep);
        pendingCalls.set(targetStep, call);
        pendingTurns.set(targetStep, recorded);
        messages.push({
          role: 'assistant',
          content: turn.content,
          ...(turn.reasoning_content === undefined
            ? {}
            : { reasoning_content: turn.reasoning_content }),
          decision_summary: turn.decision_summary,
          tool_calls: [call],
        });
      } else {
        messages.push({
          role: 'assistant',
          content: turn.content,
          ...(turn.reasoning_content === undefined
            ? {}
            : { reasoning_content: turn.reasoning_content }),
          decision_summary: turn.decision_summary,
        });
      }
      states.set(stepId, 'done');
      context.setStepState(stepId, 'done');
      continue;
    }

    const call = pendingCalls.get(stepId);
    if (!call || call.name !== node.tool_name) {
      states.set(stepId, 'failed');
      context.setStepState(stepId, 'failed', {
        reason: 'matching pending tool call missing',
      });
      context.terminate('malformed_response');
      return;
    }
    if (!context.deps.toolExecute) {
      states.set(stepId, 'failed');
      context.setStepState(stepId, 'failed', {
        reason: 'tool executor unavailable',
      });
      context.terminate('malformed_response');
      return;
    }
    states.set(stepId, 'executing');
    context.setStepState(stepId, 'executing');
    try {
      const result = await context.deps.toolExecute(
        call.name,
        call.arguments,
        {
          tool_call_id: call.id,
          step_id: stepId,
          attempt_index: 1,
        },
      );
      const recorded = pendingTurns.get(stepId) ?? context.turns.at(-1);
      if (!recorded) {
        throw new LoopError('restored tool call has no observation turn');
      }
      const observation = context.recordObservation(
        recorded,
        call,
        'ok',
        result,
        stepId,
      );
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(observation),
      });
      pendingCalls.delete(stepId);
      pendingTurns.delete(stepId);
      states.set(stepId, 'done');
      context.setStepState(stepId, 'done');
    } catch (error) {
      const recorded = pendingTurns.get(stepId) ?? context.turns.at(-1);
      const message =
        error instanceof Error ? error.message : 'tool execution failed';
      if (recorded) {
        context.recordObservation(
          recorded,
          call,
          'error',
          message,
          stepId,
        );
      }
      states.set(stepId, 'failed');
      context.setStepState(stepId, 'failed', { reason: message });
      context.terminate(
        error instanceof LoopError ? 'malformed_response' : 'tool_failure',
      );
      return;
    }
  }

  if (
    [...states.values()].some(
      (state) => state === 'failed' || state === 'blocked',
    )
  ) {
    context.terminate('tool_failure');
  } else {
    context.terminate('completed');
  }
}
