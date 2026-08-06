import type { ManagedGateway } from './managed-gateway.js';
import type { ModelTier } from './capability-registry.js';

export type DagNodeType = 'reasoning' | 'document' | 'reranking' | 'writing' | 'verification' | 'image_gen' | 'vision_verify' | 'code' | 'custom';

export interface DagNode {
  step_id: string;
  node_type: DagNodeType;
  tier: ModelTier;
  required_capabilities: string[];
  prompt: string;
  system_prompt?: string;
  estimated_output_tokens?: number;
  depends_on: string[];
}

export interface DagEdge {
  from: string;
  to: string;
}

export interface DagDefinition {
  nodes: DagNode[];
  edges: DagEdge[];
}

export interface DagNodeResult {
  step_id: string;
  node_type: DagNodeType;
  success: boolean;
  response: string;
  model_used: string;
  provider_used: string;
  cost_usd: number;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  fallback_triggered: boolean;
}

export interface DagExecutionResult {
  results: DagNodeResult[];
  total_cost_usd: number;
  total_tokens: number;
  successful_nodes: number;
  failed_nodes: number;
  execution_order: string[];
  parallel_batches: string[][];
}

export class DagExecutor {
  constructor(private readonly gateway: ManagedGateway) {}

  async execute(dag: DagDefinition, ctx: { userId: string; taskId: string }): Promise<DagExecutionResult> {
    const nodeMap = new Map<string, DagNode>();
    for (const node of dag.nodes) {
      nodeMap.set(node.step_id, node);
    }

    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const node of dag.nodes) {
      inDegree.set(node.step_id, 0);
      dependents.set(node.step_id, []);
    }
    for (const edge of dag.edges) {
      dependents.get(edge.from)?.push(edge.to);
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }

    // Validate no cycles
    const visited = new Set<string>();
    const inProgress = new Set<string>();
    const hasCycle = (id: string): boolean => {
      if (inProgress.has(id)) return true;
      if (visited.has(id)) return false;
      inProgress.add(id);
      visited.add(id);
      for (const dep of dependents.get(id) ?? []) {
        if (hasCycle(dep)) return true;
      }
      inProgress.delete(id);
      return false;
    };
    for (const node of dag.nodes) {
      if (hasCycle(node.step_id)) {
        throw new Error(`DAG contains a cycle involving node '${node.step_id}'`);
      }
    }

    // Execute in topological batches (parallel within batch)
    const results = new Map<string, DagNodeResult>();
    const executionOrder: string[] = [];
    const parallelBatches: string[][] = [];
    let ready = dag.nodes.filter(n => (inDegree.get(n.step_id) ?? 0) === 0).map(n => n.step_id);

    while (ready.length > 0) {
      const batch = [...ready];
      parallelBatches.push(batch);
      ready = [];

      // Execute all nodes in this batch in parallel
      const batchResults = await Promise.allSettled(
        batch.map(async (nodeId) => {
          const node = nodeMap.get(nodeId)!;
          // Collect inputs from dependencies
          const depResults = node.depends_on
            .map(depId => results.get(depId))
            .filter((r): r is DagNodeResult => r !== undefined && r.success);

          const depContext = depResults.length > 0
            ? depResults.map(r => `[${r.node_type}:${r.step_id}] ${r.response}`).join('\n\n')
            : '';

          const fullPrompt = depContext
            ? `Context from previous steps:\n${depContext}\n\n---\n\nTask: ${node.prompt}`
            : node.prompt;

          const result = await this.gateway.complete(fullPrompt, {
            userId: ctx.userId,
            taskId: ctx.taskId,
            stepId: node.step_id,
            tier: node.tier,
            requiredCapabilities: node.required_capabilities,
            ...(node.system_prompt !== undefined ? { systemPrompt: node.system_prompt } : {}),
            ...(node.estimated_output_tokens !== undefined ? { estimatedOutputTokens: node.estimated_output_tokens } : {}),
          });

          const dagResult: DagNodeResult = {
            step_id: nodeId,
            node_type: node.node_type,
            success: result.usage.success,
            response: result.response,
            model_used: result.model_used,
            provider_used: result.provider_used,
            cost_usd: result.usage.cost_usd,
            prompt_tokens: result.usage.prompt_tokens,
            completion_tokens: result.usage.completion_tokens,
            latency_ms: result.usage.latency_ms,
            fallback_triggered: result.fallback_triggered,
          };
          results.set(nodeId, dagResult);
          executionOrder.push(nodeId);
          return dagResult;
        }),
      );

      // Process batch results — only advance dependents of successful nodes
      for (let i = 0; i < batch.length; i++) {
        const nodeId = batch[i]!;
        const settled = batchResults[i]!;
        if (settled.status === 'fulfilled') {
          for (const dep of dependents.get(nodeId) ?? []) {
            const newDeg = (inDegree.get(dep) ?? 1) - 1;
            inDegree.set(dep, newDeg);
            if (newDeg === 0) ready.push(dep);
          }
        } else {
          // Node failed — mark its dependents as failed (won't execute)
          for (const dep of dependents.get(nodeId) ?? []) {
            if (!results.has(dep)) {
              const failedResult: DagNodeResult = {
                step_id: dep,
                node_type: nodeMap.get(dep)?.node_type ?? 'custom',
                success: false,
                response: `Skipped: dependency '${nodeId}' failed`,
                model_used: 'none',
                provider_used: 'none',
                cost_usd: 0,
                prompt_tokens: 0,
                completion_tokens: 0,
                latency_ms: 0,
                fallback_triggered: false,
              };
              results.set(dep, failedResult);
              executionOrder.push(dep);
            }
          }
        }
      }
    }

    const allResults = [...results.values()];
    const totalCost = allResults.reduce((s, r) => s + r.cost_usd, 0);
    const totalTokens = allResults.reduce((s, r) => s + r.prompt_tokens + r.completion_tokens, 0);
    const successful = allResults.filter(r => r.success).length;
    const failed = allResults.filter(r => !r.success).length;

    return {
      results: allResults,
      total_cost_usd: totalCost,
      total_tokens: totalTokens,
      successful_nodes: successful,
      failed_nodes: failed,
      execution_order: executionOrder,
      parallel_batches: parallelBatches,
    };
  }

  /**
   * Build a DAG from a high-level workflow description.
   * Example: "PDF Research" -> document model -> reasoning -> reranker -> writing -> verifier
   */
  static buildWorkflow(workflow: {
    name: string;
    steps: Array<{ type: DagNodeType; tier: ModelTier; capabilities: string[]; prompt: string; depends_on?: string[] }>;
  }): DagDefinition {
    const nodes: DagNode[] = workflow.steps.map((step, i) => ({
      step_id: `${workflow.name}-step-${i + 1}`,
      node_type: step.type,
      tier: step.tier,
      required_capabilities: step.capabilities,
      prompt: step.prompt,
      depends_on: step.depends_on ?? (i > 0 ? [`${workflow.name}-step-${i}`] : []),
    }));

    const edges: DagEdge[] = [];
    for (const node of nodes) {
      for (const dep of node.depends_on) {
        edges.push({ from: dep, to: node.step_id });
      }
    }

    return { nodes, edges };
  }
}
