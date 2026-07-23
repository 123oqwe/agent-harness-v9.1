/* eslint-disable */
/** AUTO-GENERATED from spec/contracts/run-defaults.schema.json. Do not modify by hand. */

/**
 * Default values for RunPlan fields. NOT an execution contract. RunPlan is the only normative execution contract. These defaults feed into Router as input.
 */
export interface RunDefaults {
  default_model: {
    provider: string;
    model_id: string;
    /**
     * Ordered fallback list
     */
    fallback_model_ids?: string[];
  };
  default_tools: {
    tool_name: string;
    enabled: boolean;
    /**
     * Max risk tier for this tool
     */
    risk_ceiling?: string;
  }[];
  default_budget: {
    /**
     * Decimal string
     */
    token_limit: string;
    /**
     * Decimal string, e.g., '5000000' = $5.00
     */
    usd_micros: string;
  };
  default_reasoning_strategy?: "direct" | "react" | "plan_execute" | "rewoo" | "iterative_refinement";
  default_agent_topology?: "single_agent" | "supervisor_workers" | "planner_executor_verifier";
  default_context_topology?: "shared_selective" | "isolated" | "parent_child";
}
