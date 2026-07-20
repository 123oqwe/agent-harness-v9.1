import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const harnessRoot = path.resolve(import.meta.dirname, '../..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(harnessRoot, relativePath), 'utf8')) as Record<
    string,
    unknown
  >;
}

function runNpm(args: string[]) {
  return spawnSync(npmCommand, args, {
    cwd: harnessRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 120_000,
  });
}

describe('AH-GATEWAY-TESTPROVIDER-001: build and gate configuration', () => {
  it('defines real, separate build, typecheck and test gate scripts', () => {
    const pkg = readJson('package.json') as {
      scripts: Record<string, string>;
      exports: Record<string, unknown>;
      files: string[];
    };
    const required = [
      'typecheck',
      'build',
      'lint',
      'test:contract',
      'test:unit',
      'test:integration',
      'test:security',
      'test:e2e',
      'test:coverage',
      'test:mutation',
    ];

    expect(Object.keys(pkg.scripts)).toEqual(expect.arrayContaining(required));
    expect(pkg.scripts.typecheck).toContain('tsc --noEmit');
    expect(pkg.scripts.build).not.toContain('--noEmit');
    expect(pkg.scripts.lint).not.toMatch(/echo|test -d|\|\|/u);
    expect(pkg.scripts['test:security']).toContain('tests/gateway');
    expect(pkg.scripts['test:security']).toContain('tests/policy');
    for (const name of required.filter((entry) => entry.startsWith('test:'))) {
      expect(pkg.scripts[name]).not.toMatch(/passWithNoTests|echo|\|\|\s*true/u);
    }
    expect(pkg.exports).toHaveProperty('.');
    expect(pkg.files).toEqual(['dist']);
  });

  it('limits mutation to product source and cleans the sandbox even after failure', () => {
    const config = readJson('stryker.config.json') as {
      mutate: string[];
      testFiles: string[];
      cleanTempDir: string | boolean;
      concurrency: number;
      vitest: { configFile: string; related: boolean };
    };
    const mutationText = config.mutate.join('\n');

    expect(config.mutate.length).toBeGreaterThan(0);
    expect(mutationText).toMatch(/gateway/u);
    expect(mutationText).toMatch(/security/u);
    expect(mutationText).not.toMatch(/tests|\.config|spec\/types/u);
    expect(config.testFiles).toEqual(['tests/gateway/*.test.ts', 'tests/policy/*.test.ts']);
    expect(config.cleanTempDir).toBe('always');
    expect(config.concurrency).toBeGreaterThan(0);
    expect(config.concurrency).toBeLessThanOrEqual(4);
    expect(config.vitest).toEqual({ configFile: 'vitest.config.ts', related: true });
    expect(fs.existsSync(path.join(harnessRoot, 'scripts/run-stryker.mjs'))).toBe(true);
    const coverageConfig = fs.readFileSync(path.join(harnessRoot, 'vitest.config.ts'), 'utf8');
    expect(coverageConfig).toContain("'security/**/*.ts'");
  });

  it('builds importable JavaScript and declarations from the public entrypoint', async () => {
    const result = runNpm(['run', 'build']);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const jsEntry = path.join(harnessRoot, 'dist/harness/index.js');
    const typeEntry = path.join(harnessRoot, 'dist/harness/index.d.ts');
    expect(fs.existsSync(jsEntry)).toBe(true);
    expect(fs.existsSync(typeEntry)).toBe(true);
    const built = (await import(`${jsEntry}?test=${Date.now()}`)) as Record<string, unknown>;
    expect(built).toHaveProperty('ScriptedTestProvider');
    expect(built).toHaveProperty('ModelGateway');
    expect(built).toHaveProperty('PolicyEngine');
    expect(built).toHaveProperty('PolicyEnforcementPoint');
    expect(fs.readFileSync(path.join(harnessRoot, 'gateway/model-gateway.ts'), 'utf8')).not.toContain(
      'process.env',
    );
  });

  it('packs only the manifest and necessary dist artifacts', () => {
    const build = runNpm(['run', 'build']);
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    const packed = runNpm(['pack', '--dry-run', '--json', '--ignore-scripts']);
    expect(packed.status, `${packed.stdout}\n${packed.stderr}`).toBe(0);
    const report = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>;
    const paths = report[0]!.files.map((file) => file.path).sort();

    expect(paths).toContain('package.json');
    expect(paths).toContain('dist/harness/index.js');
    expect(paths).toContain('dist/harness/index.d.ts');
    expect(paths.every((entry) => entry === 'package.json' || entry.startsWith('dist/'))).toBe(
      true,
    );
    expect(paths.some((entry) => /node_modules|coverage|stryker|tests|secret/iu.test(entry))).toBe(
      false,
    );
  });
});
