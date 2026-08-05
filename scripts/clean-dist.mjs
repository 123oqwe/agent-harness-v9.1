#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distributionRoot = join(harnessRoot, 'dist');

// --post-build: strip private workspace artifacts that tsc emits when
// harness.ts imports from packages/*/src/.  The packed root must not
// ship those files.
if (process.argv.includes('--post-build')) {
  for (const leaked of [join(distributionRoot, 'packages'), join(distributionRoot, 'apps')]) {
    if (existsSync(leaked)) rmSync(leaked, { recursive: true, force: true });
  }
} else {
  rmSync(distributionRoot, { force: true, recursive: true });
}
