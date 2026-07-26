import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SPEC_ROOT } from '../helpers/repository-paths.js';

const apiPath = path.resolve(SPEC_ROOT, 'api/asyncapi.yaml');

describe('AH-SPEC-API-001: asyncapi spec', () => {
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
