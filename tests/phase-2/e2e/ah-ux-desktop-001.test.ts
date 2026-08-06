import { describe, it, expect } from 'vitest';
import { DEFAULT_DESKTOP_CONFIG } from '../../../apps/desktop/src/index.js';
import { parseArgs, runShell } from '../../../apps/desktop/src/shell.js';

describe('AH-UX-DESKTOP-001: Desktop/local shell application', () => {
  it('exports default config', () => {
    expect(DEFAULT_DESKTOP_CONFIG.shell).toBe('native');
    expect(DEFAULT_DESKTOP_CONFIG.offline_cache).toBe(true);
  });

  it('parses --task argument', () => {
    const opts = parseArgs(['node', 'shell.ts', '--task', 'do something']);
    expect(opts).not.toBeNull();
    expect(opts!.task).toBe('do something');
  });

  it('returns null when --task is missing', () => {
    expect(parseArgs(['node', 'shell.ts'])).toBeNull();
  });

  it('runs shell and returns success', async () => {
    const result = await runShell({ task: 'test task' });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('completed successfully');
  });

  it('rejects empty task', async () => {
    const result = await runShell({ task: '' });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('error');
  });

  it('calls onOutput callback', async () => {
    const outputs: string[] = [];
    await runShell({ task: 'test', onOutput: (text) => outputs.push(text) });
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs[0]).toContain('starting task');
  });
});
