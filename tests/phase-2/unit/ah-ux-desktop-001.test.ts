import { describe, expect, it } from 'vitest';
import { DEFAULT_DESKTOP_CONFIG, type DesktopConfig } from '../../../apps/desktop/src/index.js';
import { parseArgs, runShell } from '../../../apps/desktop/src/shell.js';

describe('AH-UX-DESKTOP-001: Desktop/local shell application', () => {
  it('provides default configuration with native shell and offline cache', () => {
    expect(DEFAULT_DESKTOP_CONFIG.shell).toBe('native');
    expect(DEFAULT_DESKTOP_CONFIG.offline_cache).toBe(true);
    expect(DEFAULT_DESKTOP_CONFIG.auto_update).toBe(false);
  });

  it('parseArgs extracts --task argument', () => {
    const opts = parseArgs(['--task', 'build the feature']);
    expect(opts).not.toBeNull();
    expect(opts!.task).toBe('build the feature');
  });

  it('parseArgs returns null when --task is missing', () => {
    expect(parseArgs(['--other', 'value'])).toBeNull();
  });

  it('parseArgs returns null when --task has no value', () => {
    expect(parseArgs(['--task'])).toBeNull();
  });

  it('parseArgs returns null for empty task string', () => {
    expect(parseArgs(['--task', '   '])).toBeNull();
  });

  it('runShell completes successfully for valid task', async () => {
    const result = await runShell({ task: 'write a test' });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('starting task');
    expect(result.output).toContain('completed successfully');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('runShell calls onOutput callback', async () => {
    const outputs: string[] = [];
    await runShell({ task: 'test', onOutput: (text) => outputs.push(text) });
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs[0]).toContain('starting task');
  });

  it('runShell merges config overrides with defaults', async () => {
    const result = await runShell({
      task: 'test',
      config: { shell: 'electron', auto_update: true },
    });
    expect(result.output).toContain('shell=electron');
    expect(result.output).toContain('offline_cache=true');
  });

  it('runShell returns error for empty task', async () => {
    const result = await runShell({ task: '' });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('error');
  });

  it('runShell returns error for excessively long task', async () => {
    const result = await runShell({ task: 'x'.repeat(10001) });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('maximum length');
  });
});
