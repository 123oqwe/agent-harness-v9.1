/* eslint-disable */
/** AUTO-GENERATED from spec/contracts/capability-token.schema.json. Do not modify by hand. */

/**
 * Authorization token. Child tokens signed by Authorization Service, NOT parent.
 */
export interface CapabilityToken {
  token_id: string;
  operation_id: string;
  attempt_id: string;
  manifest_hash: string;
  policy_decision_hash: string;
  tool_effect_contract_hash: string;
  subject_workload: string;
  tenant_id: string;
  audience: string;
  tool_grant_hash: string;
  resource_grant_hash: string;
  budget_ceiling_hash: string;
  /**
   * Required for child tokens. Signed by Authorization Service.
   */
  parent_delegation_proof?: string | null;
  issued_at: string;
  not_before: string;
  expires_at: string;
  execution_epoch: string;
  /**
   * Atomic single-use enforced
   */
  use_limit: 1;
  confirmation_key_thumbprint: string;
}
