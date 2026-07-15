import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const apiPath = path.resolve(__dirname, '../../../spec/api/openapi.yaml');

describe('AH-SPEC-API-001: openapi spec', () => {
  it('spec file exists and is non-empty', () => {
    expect(fs.existsSync(apiPath)).toBe(true);
    const content = fs.readFileSync(apiPath, 'utf-8');
    expect(content.length).toBeGreaterThan(100);
  });

  it('spec has openapi/asyncapi version field', () => {
    const content = fs.readFileSync(apiPath, 'utf-8');
    expect(content).toMatch(/(openapi|asyncapi):\s*['"]?\d/);
  });

  it('spec defines at least one path or channel', () => {
    const content = fs.readFileSync(apiPath, 'utf-8');
    expect(content).toMatch(/(paths|channels):/);
  });
});
