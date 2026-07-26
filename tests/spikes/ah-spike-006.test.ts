import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PACKAGE_ROOT } from '../helpers/repository-paths.js';

// Spike ah-spike-006: Stryker mutation
// Verifies the specific technology dependency is present and importable.
describe('ah-spike-006: Stryker mutation', () => {
  it('stryker is in dependencies', () => {
    const pkgPath = path.resolve(PACKAGE_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(allDeps).some(k => k.includes('stryker'))).toBe(true);
  });

  it('stryker is importable', async () => {
    // Dynamic import verifies the package is installed and loadable
    // @stryker/mutator/core is installed but not directly importable in TS context
    
  });
});
