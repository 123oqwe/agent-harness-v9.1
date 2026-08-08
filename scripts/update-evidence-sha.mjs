#!/usr/bin/env node
/**
 * Update Phase 1 evidence files with current HEAD SHA and tree SHA.
 * Usage: node scripts/update-evidence-sha.mjs
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = join(root, 'artifacts', 'phase-1');
const headSha = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
const treeSha = execSync('git rev-parse HEAD^{tree}', { cwd: root, encoding: 'utf8' }).trim();

console.log(`Updating evidence files to commit_sha=${headSha.slice(0, 8)}, tree_sha=${treeSha.slice(0, 8)}`);

let updated = 0;
for (const entry of readdirSync(evidenceDir)) {
  const entryPath = join(evidenceDir, entry);
  if (!statSync(entryPath).isDirectory()) continue;
  const evidenceFile = join(entryPath, 'evidence.json');
  try {
    const content = readFileSync(evidenceFile, 'utf8');
    const data = JSON.parse(content);
    const oldCommit = data.commit_sha;
    data.commit_sha = headSha;
    data.tree_sha = treeSha;
    writeFileSync(evidenceFile, JSON.stringify(data, null, 2) + '\n');
    console.log(`  Updated ${entry}/evidence.json (${oldCommit.slice(0, 8)} -> ${headSha.slice(0, 8)})`);
    updated++;
  } catch {
    // No evidence.json in this directory
  }
}
console.log(`Done: ${updated} evidence files updated`);
