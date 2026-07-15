import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const schemaPath = path.resolve(__dirname, '../../../spec/contracts/tool-spec.schema.json');
const validFixturePath = path.resolve(__dirname, '../../../spec/fixtures/phase-0/valid/tool-spec.json');
const invalidFixturePath = path.resolve(__dirname, '../../../spec/fixtures/phase-0/invalid/tool-spec.json');

describe('AH-CONTRACT-TOOLSPEC-001: tool-spec schema', () => {
  it('schema file exists and parses as JSON', () => {
    expect(fs.existsSync(schemaPath)).toBe(true);
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
  });

  it('schema has required fields: ...', () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    const required = [];
    for (const field of required) {
      expect(schema.required).toContain(field);
    }
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
