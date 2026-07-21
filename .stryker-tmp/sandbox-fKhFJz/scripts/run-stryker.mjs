// @ts-nocheck
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(harnessRoot, '..');
const executable = path.join(
  harnessRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'stryker.cmd' : 'stryker',
);
const result = spawnSync(executable, ['run', 'stryker.config.json', ...process.argv.slice(2)], {
  cwd: harnessRoot,
  env: {
    ...process.env,
    HARNESS_SPEC_ROOT: path.join(repositoryRoot, 'spec'),
  },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
