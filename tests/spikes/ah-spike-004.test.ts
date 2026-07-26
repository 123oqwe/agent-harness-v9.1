import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PACKAGE_ROOT } from '../helpers/repository-paths.js';

// Spike ah-spike-004: Vitest
// Verifies the specific technology dependency is present and importable.
describe('ah-spike-004: Vitest', () => {
  it('vitest is in dependencies', () => {
    const pkgPath = path.resolve(PACKAGE_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(allDeps).toHaveProperty('vitest');
  });

  it('vitest is importable', async () => {
    // Dynamic import verifies the package is installed and loadable
    const mod = await import('vitest');
    expect(mod).toBeDefined();
  });
});
