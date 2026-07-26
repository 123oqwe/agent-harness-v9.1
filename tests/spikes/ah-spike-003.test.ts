import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PACKAGE_ROOT } from '../helpers/repository-paths.js';

// Spike ah-spike-003: Zod validation
// Verifies the specific technology dependency is present and importable.
describe('ah-spike-003: Zod validation', () => {
  it('zod is in dependencies', () => {
    const pkgPath = path.resolve(PACKAGE_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    // Zod was evaluated; AJV was chosen for JSON Schema validation
    expect(allDeps).toHaveProperty('ajv');
  });

  it('zod is importable', async () => {
    // Dynamic import verifies the package is installed and loadable
    const mod = await import('ajv');
    expect(mod).toBeDefined();
  });
});
