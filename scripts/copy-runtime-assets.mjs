import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destinationRoot = join(harnessRoot, 'dist', 'resources');

rmSync(destinationRoot, { recursive: true, force: true });
mkdirSync(join(destinationRoot, 'skills'), { recursive: true });
cpSync(join(harnessRoot, 'resources'), destinationRoot, { recursive: true });

for (const filename of readdirSync(join(harnessRoot, 'skills'))) {
  if (!filename.endsWith('.json')) continue;
  cpSync(
    join(harnessRoot, 'skills', filename),
    join(destinationRoot, 'skills', filename),
  );
}
