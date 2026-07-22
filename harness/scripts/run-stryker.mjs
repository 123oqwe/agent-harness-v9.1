import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const args = process.argv.slice(2);

// Use spawnSync with an explicit argv array to prevent shell injection.
// Call the locally installed stryker binary directly.
const strykerBin = resolve(process.cwd(), 'node_modules', '.bin', 'stryker');

const result = spawnSync(strykerBin, ['run', ...args], {
  stdio: 'inherit',
  cwd: process.cwd(),
  encoding: 'utf8',
  shell: false,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
