/* eslint-disable */
/** AUTO-GENERATED from spec/contracts/child-capability-request.schema.json. Do not modify by hand. */

/**
 * Parent sends this to Authorization Service. Authorization Service signs, NOT parent.
 */
export interface ChildCapabilityRequest {
  child_manifest_hash: string;
  parent_delegation_proof: string;
  budget_ceiling: {
    [k: string]: unknown;
  };
  tool_grants: unknown[];
  resource_grants: unknown[];
  delegation_depth: number;
}
