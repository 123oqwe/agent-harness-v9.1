/* eslint-disable */
/** AUTO-GENERATED from spec/contracts/release-approval.schema.json. Do not modify by hand. */

/**
 * Human-signed production release authorization. No AI agent may approve its own release.
 */
export interface ReleaseApproval {
  release_id: string;
  build_digest: string;
  release_manifest_hash: string;
  target_environment: "production";
  /**
   * Authorized human principal
   */
  approved_by: string;
  approved_at: string;
  /**
   * Approval TTL, e.g., 24h
   */
  expires_at: string;
  /**
   * Unforgeable human signature
   */
  webauthn_signature: string;
}
