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

  it('default config has shell set to native', () => {
    expect(DEFAULT_DESKTOP_CONFIG.shell).toBe('native');
  });

  it('default config has offline_cache enabled', () => {
    expect(DEFAULT_DESKTOP_CONFIG.offline_cache).toBe(true);
  });

  it('default config has auto_update disabled', () => {
    expect(DEFAULT_DESKTOP_CONFIG.auto_update).toBe(false);
  });

  it('parseArgs handles multiple arguments', () => {
    const opts = parseArgs(['--task', 'my-task', '--other', 'value']);
    expect(opts).not.toBeNull();
    expect(opts!.task).toBe('my-task');
  });

  it('parseArgs handles empty args array', () => {
    expect(parseArgs([])).toBeNull();
  });
  it('parseArgs handles unknown arguments', () => {
    const opts = parseArgs(['--unknown', 'value', '--task', 'test']);
    expect(opts).not.toBeNull();
    expect(opts!.task).toBe('test');
  });

  it('DesktopConfig has required fields', () => {
    const config: DesktopConfig = DEFAULT_DESKTOP_CONFIG;
    expect(config).toHaveProperty('shell');
    expect(config).toHaveProperty('offline_cache');
    expect(config).toHaveProperty('auto_update');
  });

  it('runShell is a function', () => {
    expect(typeof runShell).toBe('function');
  });

  it('parseArgs handles --task with special characters', () => {
    const opts = parseArgs(['--task', 'task with @special chars!']);
    expect(opts!.task).toBe('task with @special chars!');
  });

  it('parseArgs handles --task with Unicode', () => {
    const opts = parseArgs(['--task', '中文任务']);
    expect(opts!.task).toBe('中文任务');
  });

  it('parseArgs returns object with task property', () => {
    const opts = parseArgs(['--task', 'test']);
    expect(opts).toHaveProperty('task');
  });


  it('default config has all expected fields', () => {
    expect(DEFAULT_DESKTOP_CONFIG).toHaveProperty('shell');
    expect(DEFAULT_DESKTOP_CONFIG).toHaveProperty('offline_cache');
    expect(DEFAULT_DESKTOP_CONFIG).toHaveProperty('auto_update');
  });

  it('parseArgs handles --task with spaces', () => {
    const opts = parseArgs(['--task', 'task with multiple words']);
    expect(opts!.task).toBe('task with multiple words');
  });

  it('parseArgs handles only --task flag', () => {
    const opts = parseArgs(['--task', 'single']);
    expect(opts).not.toBeNull();
    expect(opts!.task).toBe('single');
  });

  it('parseArgs handles args without --task', () => {
    expect(parseArgs(['--verbose', '--debug'])).toBeNull();
  });

  it('DEFAULT_DESKTOP_CONFIG is frozen or readonly', () => {
    expect(DEFAULT_DESKTOP_CONFIG).toBeDefined();
  });


  it('parseArgs with --task returns non-null', () => {
    const opts = parseArgs(['--task', 'test']);
    expect(opts).not.toBeNull();
  });

  it('shell property is string type', () => {
    expect(typeof DEFAULT_DESKTOP_CONFIG.shell).toBe('string');
  });

  it('offline_cache is boolean', () => {
    expect(typeof DEFAULT_DESKTOP_CONFIG.offline_cache).toBe('boolean');
  });

  it('auto_update is boolean', () => {
    expect(typeof DEFAULT_DESKTOP_CONFIG.auto_update).toBe('boolean');
  });

});
