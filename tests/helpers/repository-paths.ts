import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Package root in both the monorepo and a source-only checkout. */
export const PACKAGE_ROOT = resolve(import.meta.dirname, '../..');

/**
 * Resolve the Contract/spec bundle without assuming that Harness is nested
 * under a larger repository.
 */
export function resolveSpecRoot(): string {
  const configured = process.env.HARNESS_SPEC_ROOT?.trim();
  const candidates = [
    ...(configured ? [resolve(configured)] : []),
    resolve(PACKAGE_ROOT, 'spec'),
    resolve(PACKAGE_ROOT, '..', 'spec'),
  ];
  const found = candidates.find((candidate) =>
    existsSync(resolve(candidate, 'contracts')),
  );
  return found ?? candidates[0]!;
}

export const SPEC_ROOT = resolveSpecRoot();
