/* eslint-disable */
/** AUTO-GENERATED from spec/contracts/skill-spec.schema.json. Do not modify by hand. */

export interface SkillSpec {
  name: string;
  version: string;
  supported_experience_profiles: unknown[];
  input_schema_ref: string;
  output_schema_ref: string;
  required_context: unknown[];
  required_tools: unknown[];
  allowed_effect_classes: unknown[];
  workflow_template_ref: string;
  verification_template_ref: string;
  failure_policy: {
    [k: string]: unknown;
  };
  risk_ceiling: string;
  eval_suite_ref: string;
}
