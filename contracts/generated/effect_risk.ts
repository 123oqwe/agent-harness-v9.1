/* eslint-disable */
/** AUTO-GENERATED from spec/contracts/effect-risk.schema.json. Do not modify by hand. */

/**
 * Dynamic risk features. Replaces static tool risk classification.
 */
export interface EffectRisk {
  locality: "local" | "remote" | "external";
  operation: "read" | "create" | "write" | "delete" | "execute" | "publish" | "communicate" | "purchase";
  reversibility: "guaranteed" | "best_effort" | "none";
  data_egress: "none" | "metadata" | "content" | "sensitive";
  /**
   * Summary boolean. Authoritative network control lives in egress_policy. Kept for backward-compatible risk scoring.
   */
  network_access: boolean;
  /**
   * Authoritative network policy (FG3). Replaces boolean network_access as the enforcement target. network_access remains as a derived summary for risk scoring.
   */
  egress_policy?: {
    mode?: "disabled" | "allowlist" | "denylist" | "open";
    /**
     * Ordered allow/deny rules. deny always wins. Supports exact hosts, scoped wildcards (*.example.com), and global *.
     */
    domain_rules?: {
      action: "allow" | "deny";
      host: string;
    }[];
    unix_sockets?: "denied" | "allowlist";
    /**
     * Default false: blocks local/private-network destinations unless explicitly allowed.
     */
    allow_local_binding?: boolean;
    socks5?: boolean;
  };
  /**
   * Screen/desktop operation risk dimensions (FG1 Computer Use). Absent = no screen access.
   */
  screen_access?: {
    surface?: "none" | "browser" | "native_app" | "desktop" | "fullscreen";
    input_modes?: ("screenshot" | "click" | "type" | "key" | "clipboard")[];
    app_scope?: "per_app_approved" | "workspace" | "system";
  };
  credential_access: boolean;
  blast_radius: "single_resource" | "bounded_set" | "workspace" | "organization" | "public" | "unbounded";
  /**
   * Decimal string, e.g. '5000000' for $5.00
   */
  financial_impact_usd_micros: string;
  human_impact: "none" | "self" | "internal_people" | "external_people" | "public";
  external_visibility: "private" | "shared" | "public";
  regulatory_sensitivity: string[];
}
