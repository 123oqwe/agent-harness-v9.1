import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PACKAGE_ROOT } from '../helpers/repository-paths.js';

// Spike ah-spike-007: AJV schema validation
// Verifies the specific technology dependency is present and importable.
describe('ah-spike-007: AJV schema validation', () => {
  it('ajv is in dependencies', () => {
    const pkgPath = path.resolve(PACKAGE_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(allDeps).toHaveProperty('ajv');
  });

  it('ajv is importable', async () => {
    // Dynamic import verifies the package is installed and loadable
    const mod = await import('ajv');
    expect(mod).toBeDefined();
  });
});
