import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const schemaPath = path.resolve(__dirname, '../../../spec/contracts/provider-adapter.schema.json');

describe('AH-GATEWAY-TESTPROVIDER-001: ScriptedTestProvider', () => {
  it('provider-adapter schema exists and defines scripted_test type', () => {
    expect(fs.existsSync(schemaPath)).toBe(true);
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    expect(schema.properties.provider_type.enum).toContain('scripted_test');
  });

  it('schema requires all ProviderAdapter interface methods', () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    const required = schema.required;
    expect(required).toContain('normalize_request');
    expect(required).toContain('parse_response');
    expect(required).toContain('normalize_tool_call');
    expect(required).toContain('stream_events');
    expect(required).toContain('map_error');
    expect(required).toContain('meter_usage');
    expect(required).toContain('check_health');
    expect(required).toContain('validate_data_policy');
  });

  it('schema has additionalProperties: false', () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    expect(schema.additionalProperties).toBe(false);
  });

  it('valid fixture has all required fields', () => {
    const fixturePath = path.resolve(__dirname, '../../../spec/fixtures/phase-1/valid/provider-adapter.json');
    expect(fs.existsSync(fixturePath)).toBe(true);
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    for (const field of schema.required) {
      expect(fixture).toHaveProperty(field);
    }
  });

  it('invalid fixture is missing a required field', () => {
    const fixturePath = path.resolve(__dirname, '../../../spec/fixtures/phase-1/invalid/provider-adapter.json');
    expect(fs.existsSync(fixturePath)).toBe(true);
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    const missing = schema.required.filter((f: string) => !(f in fixture));
    expect(missing.length).toBeGreaterThan(0);
  });

  it('scripted_test provider_type is distinct from real providers', () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    const types = schema.properties.provider_type.enum;
    expect(types).toContain('scripted_test');
    expect(types).toContain('openai');
    expect(types).toContain('anthropic');
    expect(types.indexOf('scripted_test')).not.toBe(types.indexOf('openai'));
  });
});
