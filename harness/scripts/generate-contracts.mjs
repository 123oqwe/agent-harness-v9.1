#!/usr/bin/env node
/**
 * Generate TypeScript types from spec/contracts/*.schema.json.
 * Output: harness/contracts/generated/*.ts
 */
import { writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFromFile } from 'json-schema-to-typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(__dirname, '..');
const schemaDir = resolve(harnessRoot, '..', 'spec', 'contracts');
const outDir = join(harnessRoot, 'contracts', 'generated');

mkdirSync(outDir, { recursive: true });

const schemaFiles = readdirSync(schemaDir).filter(f => f.endsWith('.schema.json'));

for (const file of schemaFiles) {
  const schemaPath = join(schemaDir, file);
  const baseName = file.replace('.schema.json', '').replace(/-/g, '_');
  const outPath = join(outDir, `${baseName}.ts`);

  try {
    const code = await compileFromFile(schemaPath, {
      bannerComment: '/* eslint-disable */\n/** AUTO-GENERATED from spec/contracts/' + file + '. Do not modify by hand. */',
      cwd: schemaDir,
    });
    writeFileSync(outPath, code);
    console.log(`Generated: ${outPath}`);
  } catch (err) {
    console.error(`Failed to generate ${file}: ${err.message}`);
    process.exit(1);
  }
}

console.log(`\nDone: ${schemaFiles.length} contract types generated.`);
