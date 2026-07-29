#!/usr/bin/env node
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distributionRoot = join(harnessRoot, 'dist');

rmSync(distributionRoot, { force: true, recursive: true });
