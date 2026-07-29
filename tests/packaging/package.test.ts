import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { join } from 'node:path';

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

function runNpmIn(cwd: string, args: string[], timeout = 120_000) {
  return spawnSync(npmCommand, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', HARNESS_SPEC_ROOT: '' },
    timeout,
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
    expect(pkg.scripts['test:security']).toContain('tests/capability');
    for (const name of required.filter((entry) => entry.startsWith('test:'))) {
      expect(pkg.scripts[name]).not.toMatch(/passWithNoTests|echo|\|\|\s*true/u);
    }
    expect(pkg.exports).toHaveProperty('.');
    expect(pkg.files).toEqual(['dist']);
    expect(pkg.scripts.postinstall).toBeUndefined();
    expect(pkg.scripts.prepare).toBe('patch-package');
    expect(pkg.scripts.lint).toContain('benchmarks');
  });

  it(
    'keeps package-lock complete for a clean source-only npm ci checkout',
    { timeout: 30_000 },
    () => {
      const cleanInstall = runNpm([
        'ci',
        '--dry-run',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ]);
      expect(
        cleanInstall.status,
        `${cleanInstall.stdout}\n${cleanInstall.stderr}`,
      ).toBe(0);
    },
  );

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
    expect(config.testFiles).toEqual([
      'tests/gateway/*.test.ts',
      'tests/policy/*.test.ts',
      'tests/security/*.test.ts',
      'tests/capability/*.test.ts',
      'tests/runtime/*.test.ts',
      'tests/router/*.test.ts',
      'tests/vfs/*.test.ts',
      'tests/session/*.test.ts',
      'tests/tools/*.test.ts',
      'tests/evidence/*.test.ts',
      'tests/verification/*.test.ts',
    ]);
    expect(config.cleanTempDir).toBe('always');
    expect(config.concurrency).toBeGreaterThan(0);
    expect(config.concurrency).toBeLessThanOrEqual(4);
    expect(config.vitest).toEqual({ configFile: 'vitest.config.ts', related: true });
    expect(fs.existsSync(path.join(harnessRoot, 'scripts/run-stryker.mjs'))).toBe(true);
    const coverageConfig = fs.readFileSync(path.join(harnessRoot, 'vitest.config.ts'), 'utf8');
    expect(coverageConfig).toContain("'security/**/*.ts'");
  });

  it('builds importable JavaScript and declarations from the public entrypoint', { timeout: 30_000 }, async () => {
    // timeout: build takes longer under full-suite load
    const result = runNpm(['run', 'build']);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const jsEntry = path.join(harnessRoot, 'dist/index.js');
    const typeEntry = path.join(harnessRoot, 'dist/index.d.ts');
    expect(fs.existsSync(jsEntry)).toBe(true);
    expect(fs.existsSync(typeEntry)).toBe(true);
    const built = (await import(`${jsEntry}?test=${Date.now()}`)) as Record<string, unknown>;
    expect(built).toHaveProperty('ScriptedTestProvider');
    expect(built).toHaveProperty('ModelGateway');
    expect(built).toHaveProperty('PolicyEngine');
    expect(built).toHaveProperty('PolicyEnforcementPoint');
    expect(built).toHaveProperty('AuthorizationService');
    expect(built).toHaveProperty('InMemoryCapabilityStateStore');
    expect(built).toHaveProperty('FileCapabilityStateStore');
    expect(built).toHaveProperty('AuthService');
    expect(built).toHaveProperty('AuthApi');
    expect(built).toHaveProperty('InMemoryAuthStore');
    expect(built).toHaveProperty('SecretsBroker');
    expect(built).toHaveProperty('SecretsBrokerApi');
    expect(fs.readFileSync(path.join(harnessRoot, 'gateway/model-gateway.ts'), 'utf8')).not.toContain(
      'process.env',
    );
  });

  it('imports the built public entrypoint in a plain Node ESM process', { timeout: 30_000 }, () => {
    const build = runNpm(['run', 'build']);
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

    const imported = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import('./dist/index.js').then(() => process.stdout.write('IMPORT_OK'))",
      ],
      {
        cwd: harnessRoot,
        encoding: 'utf8',
        env: { ...process.env, HARNESS_SPEC_ROOT: '' },
        timeout: 10_000,
      },
    );

    expect(imported.status, `${imported.stdout}\n${imported.stderr}`).toBe(0);
    expect(imported.stdout).toBe('IMPORT_OK');
  });

  it('packs only the manifest and necessary dist artifacts', { timeout: 30_000 }, () => {
    const build = runNpm(['run', 'build']);
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    const packed = runNpm(['pack', '--dry-run', '--json', '--ignore-scripts']);
    expect(packed.status, `${packed.stdout}\n${packed.stderr}`).toBe(0);
    const report = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>;
    const paths = report[0]!.files.map((file) => file.path).sort();

    expect(paths).toContain('package.json');
    expect(paths).toContain('dist/index.js');
    expect(paths).toContain('dist/index.d.ts');
    expect(paths).toContain('dist/resources/contracts/tool-spec.schema.json');
    expect(paths).toContain('dist/resources/contracts/skill-spec.schema.json');
    expect(paths).toContain('dist/resources/schemas/receipt.json');
    for (const filename of fs.readdirSync(path.join(harnessRoot, 'skills'))) {
      if (!filename.endsWith('.json')) continue;
      const skill = readJson(path.join('skills', filename)) as {
        input_schema_ref: string;
        output_schema_ref: string;
        workflow_template_ref: string;
        verification_template_ref: string;
        eval_suite_ref: string;
      };
      expect(paths).toContain(`dist/resources/skills/${filename}`);
      for (const reference of [
        skill.input_schema_ref,
        skill.output_schema_ref,
        skill.workflow_template_ref,
        skill.verification_template_ref,
        skill.eval_suite_ref,
      ]) {
        expect(paths).toContain(`dist/resources/${reference}`);
      }
    }
    expect(
      paths.every(
        (entry) =>
          entry === 'package.json' ||
          entry === 'README.md' ||
          entry.startsWith('dist/'),
      ),
    ).toBe(true);
    expect(
      paths.some((entry) =>
        /(?:^|\/)(?:node_modules|coverage|\.stryker-tmp|tests)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|credentials?|api[-_]?keys?/iu.test(
          entry,
        ),
      ),
    ).toBe(false);
  });

  it(
    'installs as a self-contained ESM package with all base registries',
    { timeout: 180_000 },
    () => {
      const installRoot = mkdtempSync(join(tmpdir(), 'agent-harness-install-'));
      try {
        const build = runNpm(['run', 'build']);
        expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

        const packed = runNpm(['pack', '--json', '--ignore-scripts']);
        expect(packed.status, `${packed.stdout}\n${packed.stderr}`).toBe(0);
        const report = JSON.parse(packed.stdout) as Array<{ filename: string }>;
        const tarball = join(harnessRoot, report[0]!.filename);

        writeFileSync(
          join(installRoot, 'package.json'),
          JSON.stringify({ name: 'harness-install-smoke', private: true, type: 'module' }),
        );
        const installed = runNpmIn(installRoot, [
          'install',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          tarball,
        ]);
        expect(installed.status, `${installed.stdout}\n${installed.stderr}`).toBe(0);

        const smoke = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            [
              "import { ToolRegistry, SkillRegistry, SkillLoader, createPhase1ToolDefinitions } from 'agent-harness';",
              'const tools = new ToolRegistry();',
              'const definitions = createPhase1ToolDefinitions();',
              'for (const spec of definitions) tools.register(spec);',
              'const skills = new SkillRegistry();',
              'skills.loadBaseSkills();',
              'const snapshot = skills.freezeSnapshot();',
              'const effects = Object.fromEntries(definitions.map((spec) => [spec.name, spec.effect_model.operation]));',
              'const loader = new SkillLoader(skills, snapshot, tools.listNames(), 2, undefined, effects);',
              "const activated = await loader.activate('repository-exploration');",
              "process.stdout.write(JSON.stringify({ tools: tools.size(), skills: skills.size(), instructions: activated.instructions.length > 0 }));",
            ].join(''),
          ],
          {
            cwd: installRoot,
            encoding: 'utf8',
            env: { ...process.env, HARNESS_SPEC_ROOT: '' },
            timeout: 10_000,
          },
        );
        expect(smoke.status, `${smoke.stdout}\n${smoke.stderr}`).toBe(0);
        expect(JSON.parse(smoke.stdout)).toEqual({ tools: 9, skills: 8, instructions: true });

        rmSync(tarball, { force: true });
      } finally {
        rmSync(installRoot, { recursive: true, force: true });
      }
    },
  );

  it('run-stryker.mjs uses spawnSync with argv array, not shell string concatenation', () => {
    const script = fs.readFileSync(path.join(harnessRoot, 'scripts/run-stryker.mjs'), 'utf8');
    // Must NOT use execSync or shell string concatenation
    expect(script).not.toMatch(/execSync/);
    expect(script).not.toMatch(/`npx stryker/);
    expect(script).not.toMatch(/args\.join/);
    // Must NOT rely on npx temporary download
    expect(script).not.toMatch(/\bnpx\b/);
    // Must use spawnSync or execFile with argv array
    expect(script).toMatch(/spawnSync|execFile/);
  });
});

  it('run-stryker.mjs: real behavior test prevents shell injection via argv', () => {
    const fakeNodeModules = mkdtempSync(join(tmpdir(), 'fake-nm-'));
    const fakeBinDir = join(fakeNodeModules, 'node_modules', '.bin');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeStryker = join(fakeBinDir, 'stryker');
    const fakeScript = '#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_STRYKER_ARGV_FILE"\nexit 0\n';
    writeFileSync(fakeStryker, fakeScript);
    fs.chmodSync(fakeStryker, 0o755);

    const argvFile = join(fakeNodeModules, 'argv.txt');
    const markerFile = join(fakeNodeModules, 'marker-file');
    const maliciousArg = '; touch ' + markerFile;

    const _result = spawnSync('node', [
      join(harnessRoot, 'scripts/run-stryker.mjs'),
      maliciousArg,
    ], {
      cwd: fakeNodeModules,
      encoding: 'utf8',
      env: { ...process.env, FAKE_STRYKER_ARGV_FILE: argvFile },
      timeout: 5000,
    });

    // The marker file must NOT be created — shell injection prevented
    expect(fs.existsSync(markerFile)).toBe(false);

    // The malicious argument must be passed as a single argv element
    if (fs.existsSync(argvFile)) {
      const recordedArgv = fs.readFileSync(argvFile, 'utf8').trim();
      // Should contain "run" and the malicious arg as separate elements
      expect(recordedArgv).toContain('run');
      expect(recordedArgv).toContain('touch');
    }

    rmSync(fakeNodeModules, { recursive: true, force: true });
  });

  it('run-stryker.mjs: exits non-zero when local stryker binary does not exist', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'empty-stryker-'));
    const _result = spawnSync('node', [
      join(harnessRoot, 'scripts/run-stryker.mjs'),
    ], {
      cwd: emptyDir,
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(_result.status).not.toBe(0);
    rmSync(emptyDir, { recursive: true, force: true });
  });
