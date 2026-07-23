/* eslint-disable */
/** AUTO-GENERATED from spec/contracts/tool-spec.schema.json. Do not modify by hand. */

/**
 * Machine-readable tool specification. Replaces minimal v8 ToolDefinition.
 */
export interface ToolSpec {
  name: string;
  version: string;
  domains: string[];
  implementation_status:
    "interface_only" | "stub" | "mock" | "partial" | "implemented" | "verified" | "production_certified";
  input_schema_ref: string;
  output_schema_ref: string;
  effect_model: {
    [k: string]: unknown;
  };
  risk_feature_extractor: string;
  preconditions: {
    [k: string]: unknown;
  }[];
  postconditions: {
    [k: string]: unknown;
  }[];
  timeout_policy: {
    [k: string]: unknown;
  };
  cancellation_policy: {
    [k: string]: unknown;
  };
  retry_policy: {
    [k: string]: unknown;
  };
  idempotency_policy: {
    [k: string]: unknown;
  };
  sandbox_policy: {
    [k: string]: unknown;
  };
  network_policy: {
    [k: string]: unknown;
  };
  /**
   * Reference to EffectRisk.egress_policy binding used by this tool (FG3). The authoritative network policy; tool-spec.network_policy is kept as the declarative summary.
   */
  egress_policy_ref?: string;
  /**
   * Screen/desktop operation policy (FG1 Computer Use). Required only by tools whose effect_model involves screen_access.
   */
  display_policy?: {
    surface_scope?: "browser_only" | "native_app_approved" | "desktop" | "fullscreen";
    /**
     * Per-app approval list (bundle IDs / window titles). Sentinel apps (terminals, Finder, system settings) require escalated consent.
     */
    approved_apps?: string[];
    /**
     * exclude_self_output: agent's own UI/terminal never enters screenshots (prevents prompt-injection feedback). Default exclude_self_output.
     */
    screenshot_isolation?: "exclude_self_output" | "full";
    /**
     * If true, the global interrupt key is consumed so injected content cannot dismiss dialogs.
     */
    global_interrupt_consumed?: boolean;
    single_session_lock?: boolean;
  };
  /**
   * Which RunPlan phases may invoke this tool (FG2 two-phase runtime). setup = network-enabled dependency install; agent = offline execution. Tools requiring credentials must bind to agent phase only via broker single-exchange.
   */
  run_phase_binding?: ("setup" | "agent")[];
  credential_requirements: {
    [k: string]: unknown;
  }[];
  data_egress_policy: {
    [k: string]: unknown;
  };
  receipt_schema_ref: string;
  verification_adapter: string;
  reconciliation_adapter?: string | null;
  compensation_adapter?: string | null;
  unit_tests?: string[];
  integration_tests?: string[];
  adversarial_tests?: string[];
  maturity: "draft" | "mock" | "sandbox_verified" | "provider_sandbox_verified" | "production_certified";
}
