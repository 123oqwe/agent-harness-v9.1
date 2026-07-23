/* eslint-disable */
/** AUTO-GENERATED from spec/contracts/verification-graph.schema.json. Do not modify by hand. */

/**
 * Verification plan. Defines how each step's output is verified.
 */
export interface VerificationGraph {
  nodes: {
    verification_id: string;
    /**
     * Which WorkflowGraph step this verifies
     */
    step_id_ref: string;
    verification_type:
      | "deterministic"
      | "schema_validation"
      | "test_execution"
      | "read_back"
      | "blind_verification"
      | "independent_verifier"
      | "human_review";
    /**
     * Agent can tune: fast=skip optional checks, paranoid=independent verifier + human review
     */
    strictness: "fast" | "standard" | "strict" | "paranoid";
    /**
     * For independent_verifier: which agent verifies
     */
    verifier_agent_id?: string | null;
    /**
     * Which acceptance criteria this verification checks
     */
    acceptance_criteria_refs?: string[];
  }[];
  edges: {
    from_verification: string;
    to_verification: string;
    /**
     * True if this edge represents verification escalation (e.g., deterministic → blind → independent)
     */
    escalation?: boolean;
  }[];
}
