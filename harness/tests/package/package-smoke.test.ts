import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const harnessRoot = resolve(__dirname, '..', '..');
const distDir = join(harnessRoot, 'dist');

describe('package smoke: build artifacts', () => {
  it('dist/ directory exists and is non-empty', () => {
    expect(existsSync(distDir)).toBe(true);
    const entries = readdirSync(distDir);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('dist/ contains compiled JavaScript', () => {
    const jsFiles = collectFiles(distDir, '.js');
    expect(jsFiles.length).toBeGreaterThan(0);
  });

  it('dist/ contains TypeScript declarations', () => {
    const dtsFiles = collectFiles(distDir, '.d.ts');
    expect(dtsFiles.length).toBeGreaterThan(0);
  });

  it('dist/ contains source maps', () => {
    const mapFiles = collectFiles(distDir, '.js.map');
    expect(mapFiles.length).toBeGreaterThan(0);
  });

  it('dist/index.js exists and is non-trivial', () => {
    const entry = join(distDir, 'index.js');
    expect(existsSync(entry)).toBe(true);
    const size = statSync(entry).size;
    expect(size).toBeGreaterThan(0);
  });
});

describe('package smoke: public API import', () => {
  it('imports the built entry point without error', async () => {
    const mod = await import(join(distDir, 'index.js'));
    expect(mod).toBeDefined();
    expect(typeof mod).toBe('object');
  });

  it('Exports ScriptedTestProvider class', async () => {
    const mod = await import(join(distDir, 'index.js'));
    expect(mod.ScriptedTestProvider).toBeDefined();
    expect(typeof mod.ScriptedTestProvider).toBe('function');
  });

  it('Exports ModelGateway class', async () => {
    const mod = await import(join(distDir, 'index.js'));
    expect(mod.ModelGateway).toBeDefined();
    expect(typeof mod.ModelGateway).toBe('function');
  });

  it('Exports PolicyEngine class', async () => {
    const mod = await import(join(distDir, 'index.js'));
    expect(mod.PolicyEngine).toBeDefined();
    expect(typeof mod.PolicyEngine).toBe('function');
  });

  it('Can instantiate and use ScriptedTestProvider', async () => {
    const mod = await import(join(distDir, 'index.js'));
    const provider = new mod.ScriptedTestProvider({
      queue: [{ content: 'hello', stop_reason: 'stop' }],
    });
    expect(provider.callCount).toBe(0);
    const res = provider.resolve({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('hello');
    expect(provider.callCount).toBe(1);
  });

  it('Can instantiate ModelGateway and register provider', async () => {
    const mod = await import(join(distDir, 'index.js'));
    const provider = new mod.ScriptedTestProvider({
      queue: [{ content: 'gw-test', stop_reason: 'stop' }],
    });
    const gateway = new mod.ModelGateway([provider]);
    expect(gateway.list()).toContain('scripted_test');
    const res = gateway.complete('scripted_test', {
      messages: [{ role: 'user', content: 'test' }],
    });
    expect(res.content).toBe('gw-test');
  });

  it('Can instantiate PolicyEngine with deny-by-default policy', async () => {
    const mod = await import(join(distDir, 'index.js'));
    const engine = new mod.PolicyEngine({
      rules: [{ tool: 'read_file', allow: true }],
      default_decision: 'deny',
    });
    expect(engine.rules.length).toBe(1);
  });
});

function collectFiles(dir: string, ext: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...collectFiles(fullPath, ext));
    } else if (entry.endsWith(ext)) {
      results.push(fullPath);
    }
  }
  return results;
}
