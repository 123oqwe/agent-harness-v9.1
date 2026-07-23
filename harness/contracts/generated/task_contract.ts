/* eslint-disable */
/** AUTO-GENERATED from spec/contracts/task-contract.schema.json. Do not modify by hand. */

/**
 * User's task definition. The root input to the Router.
 */
export interface TaskContract {
  /**
   * What the user wants to achieve
   */
  goal: string;
  success_criteria: {
    criterion: string;
    /**
     * How to verify this criterion is met
     */
    verification_method: "deterministic" | "test" | "human_review" | "semantic";
  }[];
  constraints: {
    type: "budget" | "time" | "risk_ceiling" | "privacy" | "tool_restriction" | "model_restriction";
    /**
     * Constraint value (e.g., '5000000' for $5 budget, 'local_only' for privacy)
     */
    value: string;
  }[];
  deadline?: string | null;
  /**
   * Agent can use for scheduling
   */
  priority?: "low" | "normal" | "high" | "urgent";
}
