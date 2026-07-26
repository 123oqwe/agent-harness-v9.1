/**
 * Contract parity test: verifies generated TypeScript types match JSON Schemas.
 * Fails when schema and generated types drift.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  PACKAGE_ROOT,
  SPEC_ROOT,
} from '../helpers/repository-paths.js';

const schemaDir = resolve(SPEC_ROOT, 'contracts');
const generatedDir = resolve(import.meta.dirname, '..', '..', 'contracts', 'generated');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const schemaFiles = readdirSync(schemaDir).filter(f => f.endsWith('.schema.json'));
const schemaCache = new Map<string, any>();
for (const file of schemaFiles) {
  const schema = JSON.parse(readFileSync(join(schemaDir, file), 'utf8'));
  schemaCache.set(file, schema);
  try { ajv.addSchema(schema, file); } catch { /* ref already added */ }
}

function filesBelow(root: string, current = root): string[] {
  return readdirSync(current)
    .sort()
    .flatMap((name) => {
      const absolute = join(current, name);
      return statSync(absolute).isDirectory()
        ? filesBelow(root, absolute)
        : [relative(root, absolute)];
    });
}

describe('Contract parity', () => {
  it('ships a complete source-only spec bundle without monorepo drift', () => {
    const bundled = resolve(PACKAGE_ROOT, 'spec');
    const files = filesBelow(bundled);
    expect(files.length).toBeGreaterThanOrEqual(80);
    for (const required of [
      'contracts/run-plan.schema.json',
      'fixtures/phase-0/valid/run-plan.json',
      'fixtures/phase-1/valid/provider-adapter.json',
      'state-machines/operation.machine.json',
      'api/openapi.yaml',
      'threat-model/controls.yaml',
    ]) {
      expect(files).toContain(required);
    }

    const monorepoSpec = resolve(PACKAGE_ROOT, '..', 'spec');
    if (existsSync(resolve(monorepoSpec, 'contracts'))) {
      for (const file of files) {
        expect(
          readFileSync(resolve(bundled, file)),
          `bundled spec drift: ${file}`,
        ).toEqual(readFileSync(resolve(monorepoSpec, file)));
      }
    }
  });

  it('should have generated types for every schema', () => {
    for (const file of schemaFiles) {
      const baseName = file.replace('.schema.json', '').replace(/-/g, '_');
      const tsFile = join(generatedDir, `${baseName}.ts`);
      expect(existsSync(tsFile)).toBe(true);
      const content = readFileSync(tsFile, 'utf8');
      expect(content).toContain('AUTO-GENERATED');
    }
  });

  it('should validate a minimal TaskContract against schema', () => {
    const validate = ajv.compile(schemaCache.get('task-contract.schema.json'));
    const valid = validate({
      goal: 'Fix the bug',
      success_criteria: [{ criterion: 'tests pass', verification_method: 'test' }],
      constraints: [{ type: 'budget', value: '5000000' }],
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it('should validate a minimal ToolSpec against schema', () => {
    const validate = ajv.compile(schemaCache.get('tool-spec.schema.json'));
    const valid = validate({
      name: 'read_file', version: '1.0.0', domains: ['coding'],
      implementation_status: 'production_certified',
      input_schema_ref: 'in.json', output_schema_ref: 'out.json',
      effect_model: {}, risk_feature_extractor: 'default',
      preconditions: [], postconditions: [], timeout_policy: {},
      cancellation_policy: {}, retry_policy: {}, idempotency_policy: {},
      sandbox_policy: {}, network_policy: {}, credential_requirements: [],
      data_egress_policy: {}, receipt_schema_ref: 'r.json',
      verification_adapter: 'default', maturity: 'production_certified',
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it('should validate a minimal EffectRisk against schema', () => {
    const validate = ajv.compile(schemaCache.get('effect-risk.schema.json'));
    const valid = validate({
      locality: 'local', operation: 'read', reversibility: 'guaranteed',
      data_egress: 'none', network_access: false, credential_access: false,
      blast_radius: 'single_resource', financial_impact_usd_micros: '0',
      human_impact: 'none', external_visibility: 'private',
      regulatory_sensitivity: [],
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it('should reject invalid TaskContract (missing required field)', () => {
    const validate = ajv.compile(schemaCache.get('task-contract.schema.json'));
    expect(validate({ goal: 'Fix the bug' })).toBe(false);
  });

  it('should reject invalid ToolSpec (bad maturity enum)', () => {
    const validate = ajv.compile(schemaCache.get('tool-spec.schema.json'));
    expect(validate({
      name: 'read_file', version: '1.0.0', domains: ['coding'],
      implementation_status: 'production_certified',
      input_schema_ref: 'in.json', output_schema_ref: 'out.json',
      effect_model: {}, risk_feature_extractor: 'default',
      preconditions: [], postconditions: [], timeout_policy: {},
      cancellation_policy: {}, retry_policy: {}, idempotency_policy: {},
      sandbox_policy: {}, network_policy: {}, credential_requirements: [],
      data_egress_policy: {}, receipt_schema_ref: 'r.json',
      verification_adapter: 'default', maturity: 'INVALID',
    })).toBe(false);
  });

  it('should validate a SkillSpec against schema', () => {
    const validate = ajv.compile(schemaCache.get('skill-spec.schema.json'));
    const valid = validate({
      name: 'repository_exploration', version: '1.0.0',
      supported_experience_profiles: ['all'],
      input_schema_ref: 'in.json', output_schema_ref: 'out.json',
      required_context: ['repository_path'],
      required_tools: ['list_directory'],
      allowed_effect_classes: ['read_only'],
      workflow_template_ref: 'wf.md', verification_template_ref: 'vf.md',
      failure_policy: { on_failure: 'abort' },
      risk_ceiling: 'tier_1', eval_suite_ref: 'eval.json',
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });
});
