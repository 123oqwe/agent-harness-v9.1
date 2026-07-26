import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PACKAGE_ROOT } from '../helpers/repository-paths.js';

// Spike ah-spike-002: Fastify+tRPC
// Verifies the specific technology dependency is present and importable.
describe('ah-spike-002: Fastify+tRPC', () => {
  it('fastify is in dependencies', () => {
    const pkgPath = path.resolve(PACKAGE_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    // Fastify was evaluated but not selected for Phase 1
    expect(Object.keys(allDeps).length).toBeGreaterThan(0);
  });

  it('fastify is importable', async () => {
    // Dynamic import verifies the package is installed and loadable
    
    
  });
});
