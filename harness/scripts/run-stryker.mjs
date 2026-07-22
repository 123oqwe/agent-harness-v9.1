import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
try {
  execSync(`npx stryker run ${args.join(' ')}`, {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  process.exit(0);
} catch (e) {
  process.exit(e.status ?? 1);
}
