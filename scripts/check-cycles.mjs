#!/usr/bin/env node
import { readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const productionRoots = [
  'contracts',
  'domains',
  'gateway',
  'ingestion',
  'router',
  'runtime',
  'sandbox',
  'security',
  'session',
  'skills',
  'tools',
  'ui',
  'verification',
  'vfs',
];

function sourceFiles(path) {
  if (statSync(path).isFile()) return extname(path) === '.ts' ? [path] : [];
  return readdirSync(path, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() || entry.name.endsWith('.ts')
        ? sourceFiles(join(path, entry.name))
        : [],
    );
}

const files = [
  resolve(root, 'harness.ts'),
  resolve(root, 'index.ts'),
  ...productionRoots.flatMap((directory) => sourceFiles(resolve(root, directory))),
];
const knownFiles = new Set(files);

function isValueImport(statement) {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause?.isTypeOnly) return false;
    if (clause?.name || clause?.namedBindings === undefined) return true;
    if (ts.isNamespaceImport(clause.namedBindings)) return true;
    return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
  }
  if (ts.isExportDeclaration(statement)) {
    if (statement.isTypeOnly) return false;
    if (!statement.exportClause) return true;
    return statement.exportClause.elements.some((element) => !element.isTypeOnly);
  }
  return false;
}

function resolveImport(sourceFile, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const candidate = resolve(dirname(sourceFile), specifier);
  const options = specifier.endsWith('.js')
    ? [candidate.slice(0, -3) + '.ts']
    : [candidate + '.ts', join(candidate, 'index.ts')];
  return options.find((path) => knownFiles.has(path));
}

const graph = new Map(
  files.map((file) => {
    const parsed = ts.createSourceFile(
      file,
      ts.sys.readFile(file) ?? '',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const dependencies = parsed.statements.flatMap((statement) => {
      if (
        !isValueImport(statement) ||
        !('moduleSpecifier' in statement) ||
        statement.moduleSpecifier === undefined ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        return [];
      }
      const dependency = resolveImport(file, statement.moduleSpecifier.text);
      return dependency === undefined ? [] : [dependency];
    });
    return [file, [...new Set(dependencies)]];
  }),
);

const visited = new Set();
const active = new Set();
const stack = [];
const cycles = [];

function visit(file) {
  if (active.has(file)) {
    const start = stack.indexOf(file);
    cycles.push([...stack.slice(start), file]);
    return;
  }
  if (visited.has(file)) return;
  visited.add(file);
  active.add(file);
  stack.push(file);
  for (const dependency of graph.get(file) ?? []) visit(dependency);
  stack.pop();
  active.delete(file);
}

for (const file of files) visit(file);

if (cycles.length > 0) {
  for (const cycle of cycles) {
    console.error(
      `Production import cycle: ${cycle.map((file) => relative(root, file)).join(' -> ')}`,
    );
  }
  process.exitCode = 1;
} else {
  console.log(`No production import cycles found across ${files.length} TypeScript files.`);
}
