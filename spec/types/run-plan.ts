import { TaskContract } from "./task-contract";
import { WorkflowGraph } from "./workflow-graph";
import { AgentGraph } from "./agent-graph";
import { ContextGraph } from "./context-graph";
import { VerificationGraph } from "./verification-graph";
import { ModelBinding } from "./model-binding";

export interface RunPlan {
  schema_version: "run-plan.v1";
  run_id: string;
  revision: number;
 run_plan_hash: string;
 previous_revision_hash?: string | null;
 task: TaskContract;
  experience_profile: string;
  workflow_graph: WorkflowGraph;
  agent_graph: AgentGraph;
  context_graph: ContextGraph;
  verification_graph: VerificationGraph;
  model_bindings: ModelBinding[];
  tool_grants: object[];
  skill_bindings: object[];
 environment_bindings: object[];
 schedule_binding?: object | null;
 policy_snapshot_ref: string;
  registry_snapshot_refs: string[];
  derived_risk_assessment: object;
  required_consent: object;
  budget_allocation: object;
 persistence_policy: object;
 cancellation_policy: object;
 fallback_policy: object;
 /**
  * FG2 two-phase runtime configuration.
  */
 run_phase?: {
   setup?: object;
   agent?: object;
 };
 /**
  * FG5/FG10/FG11 context engineering knobs.
  */
 context_strategy?: {
   cache_breakpoints?: string[];
   offload_token_threshold?: number;
   summarize_at_window_ratio?: number;
   tool_masking?: boolean;
  active_plan_injection?: boolean;
 };
}
