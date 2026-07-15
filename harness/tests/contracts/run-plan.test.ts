import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const schemaPath = path.resolve(__dirname, '../../../spec/contracts/run-plan.schema.json');
const validFixturePath = path.resolve(__dirname, '../../../spec/fixtures/phase-0/valid/run-plan.json');
const invalidFixturePath = path.resolve(__dirname, '../../../spec/fixtures/phase-0/invalid/run-plan.json');

describe('AH-CONTRACT-RUNPLAN-001: run-plan schema', () => {
  it('schema file exists and parses as JSON', () => {
    expect(fs.existsSync(schemaPath)).toBe(true);
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
  });

  it('schema has required fields: schema_version, run_id, revision...', () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    const required = ["schema_version", "run_id", "revision", "run_plan_hash", "task", "workflow_graph", "agent_graph", "context_graph", "verification_graph", "model_bindings", "tool_grants", "derived_risk_assessment"];
    for (const field of required) {
      expect(schema.required).toContain(field);
    }
  });
  it('schema enforces const on schema_version', () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    expect(schema.properties.schema_version.const).toBe("run-plan.v1");
  });

  it('valid fixture has all required fields', () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    const fixture = JSON.parse(fs.readFileSync(validFixturePath, 'utf-8'));
    for (const field of schema.required) {
      expect(fixture).toHaveProperty(field);
    }
  });

  it('invalid fixture is missing a required field', () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    const fixture = JSON.parse(fs.readFileSync(invalidFixturePath, 'utf-8'));
    const missing = schema.required.filter((f: string) => !(f in fixture));
    expect(missing.length).toBeGreaterThan(0);
  });
});
