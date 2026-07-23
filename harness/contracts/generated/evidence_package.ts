/* eslint-disable */
/** AUTO-GENERATED from spec/contracts/evidence-package.schema.json. Do not modify by hand. */

export interface EvidencePackage {
  requirement_id: string;
  commit_sha: string;
  source_files: unknown[];
  tests_added: unknown[];
  commands_run: unknown[];
  exit_codes: number[];
  test_results: {
    [k: string]: unknown;
  };
  coverage: {
    [k: string]: unknown;
  };
  security_checks: {
    [k: string]: unknown;
  };
  verifier_result: "pass" | "fail";
  verifier_model?: string;
  /**
   * Raw stdout from running the test suite (npm test -- --run). Collected by evidence-collector when product code exists. Used by verifier Check 9/10.
   */
  test_output?: string | null;
  /**
   * SHA-256 hash of test_output (first 16 chars). Proves test output was not tampered.
   */
  test_output_hash?: string | null;
}
