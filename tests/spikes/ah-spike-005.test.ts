import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PACKAGE_ROOT } from '../helpers/repository-paths.js';

// Spike ah-spike-005: Drizzle ORM
// Verifies TypeScript type checking is configured (prerequisite for ORM types).
describe('ah-spike-005: Drizzle ORM', () => {
  it('tsconfig.json exists with strict mode', () => {
    const tsconfigPath = path.resolve(PACKAGE_ROOT, 'tsconfig.json');
    expect(fs.existsSync(tsconfigPath)).toBe(true);
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));
    expect(tsconfig.compilerOptions?.strict).toBe(true);
  });

  it('type definitions are available', () => {
    const typesDir = path.resolve(PACKAGE_ROOT, 'node_modules/@types');
    expect(fs.existsSync(typesDir)).toBe(true);
    const types = fs.readdirSync(typesDir);
    expect(types.length).toBeGreaterThan(0);
  });
});
