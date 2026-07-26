import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const harnessRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);

export function resolveSpecRoot(environment = process.env) {
  const configured = environment.HARNESS_SPEC_ROOT?.trim();
  const candidates = [
    ...(configured ? [resolve(configured)] : []),
    resolve(harnessRoot, 'spec'),
    resolve(harnessRoot, '..', 'spec'),
  ];
  const found = candidates.find((candidate) =>
    existsSync(resolve(candidate, 'contracts')),
  );
  if (!found) {
    throw new Error(
      `Harness spec bundle not found; checked: ${candidates.join(', ')}`,
    );
  }
  return found;
}
