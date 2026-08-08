import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, chmodSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeProgressAtomic, readProgress, type ProgressEntry } from '../../session/progress-store.js';

function makeEntry(overrides: Partial<ProgressEntry> = {}): ProgressEntry {
  return {
    run_id: 'run-1', current_step: 1, goal: 'test goal',
    completed_steps: [], open_tasks: [], last_error: null,
    checkpoint_refs: [], last_updated: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('progress-store: mutation-targeted', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ah-prog-mut-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes file with 0o600 permissions', () => {
    writeProgressAtomic(dir, makeEntry());
    const stat = statSync(join(dir, 'progress.json'));
    // On macOS, mode includes file type bits, so mask with 0o777
    const perms = stat.mode & 0o777;
    expect(perms).toBe(0o600);
  });

  it('writes to .tmp file then renames to progress.json', () => {
    writeProgressAtomic(dir, makeEntry());
    // After write, .tmp should not exist (renamed to progress.json)
    expect(existsSync(join(dir, 'progress.json'))).toBe(true);
    expect(existsSync(join(dir, 'progress.json.tmp'))).toBe(false);
  });

  it('file path is exactly dataDir/progress.json', () => {
    const path = writeProgressAtomic(dir, makeEntry());
    expect(path).toBe(join(dir, 'progress.json'));
  });

  it('JSON content is pretty-printed with 2-space indent', () => {
    writeProgressAtomic(dir, makeEntry({ run_id: 'check-indent' }));
    const content = readFileSync(join(dir, 'progress.json'), 'utf8');
    // Pretty-printed JSON has newlines and 2-space indentation
    expect(content).toContain('\n  "run_id"');
  });

  it('JSON contains exact field names', () => {
    writeProgressAtomic(dir, makeEntry());
    const content = readFileSync(join(dir, 'progress.json'), 'utf8');
    expect(content).toContain('"run_id"');
    expect(content).toContain('"current_step"');
    expect(content).toContain('"goal"');
    expect(content).toContain('"completed_steps"');
    expect(content).toContain('"open_tasks"');
    expect(content).toContain('"last_error"');
    expect(content).toContain('"checkpoint_refs"');
    expect(content).toContain('"last_updated"');
  });

  it('readProgress returns exact data types', () => {
    const entry = makeEntry({
      run_id: 'type-check', current_step: 'step-5', goal: 'type test',
      completed_steps: [{ id: 1 }], open_tasks: ['a', 'b'],
      last_error: 'error msg', checkpoint_refs: ['cp1', 'cp2'],
      last_updated: '2026-06-01T12:00:00Z',
    });
    writeProgressAtomic(dir, entry);
    const result = readProgress(dir)!;
    expect(typeof result.run_id).toBe('string');
    expect(typeof result.current_step).toBe('string');
    expect(Array.isArray(result.completed_steps)).toBe(true);
    expect(Array.isArray(result.open_tasks)).toBe(true);
    expect(Array.isArray(result.checkpoint_refs)).toBe(true);
    expect(result.last_error).toBeTypeOf('string');
  });

  it('readProgress returns null for missing directory', () => {
    expect(readProgress(join(dir, 'nonexistent'))).toBeNull();
  });

  it('writeProgressAtomic creates nested directories', () => {
    const nestedDir = join(dir, 'a', 'b', 'c');
    writeProgressAtomic(nestedDir, makeEntry());
    expect(existsSync(join(nestedDir, 'progress.json'))).toBe(true);
  });

  it('writeProgressAtomic overwrites existing file', () => {
    writeProgressAtomic(dir, makeEntry({ run_id: 'first' }));
    writeProgressAtomic(dir, makeEntry({ run_id: 'second' }));
    const result = readProgress(dir)!;
    expect(result.run_id).toBe('second');
  });

  it('writeProgressAtomic handles current_step as number', () => {
    writeProgressAtomic(dir, makeEntry({ current_step: 42 }));
    const result = readProgress(dir)!;
    expect(result.current_step).toBe(42);
  });

  it('writeProgressAtomic handles current_step as string', () => {
    writeProgressAtomic(dir, makeEntry({ current_step: 'step-42' }));
    const result = readProgress(dir)!;
    expect(result.current_step).toBe('step-42');
  });

  it('writeProgressAtomic handles null last_error', () => {
    writeProgressAtomic(dir, makeEntry({ last_error: null }));
    const result = readProgress(dir)!;
    expect(result.last_error).toBeNull();
  });

  it('writeProgressAtomic handles empty arrays', () => {
    writeProgressAtomic(dir, makeEntry({ completed_steps: [], open_tasks: [], checkpoint_refs: [] }));
    const result = readProgress(dir)!;
    expect(result.completed_steps).toEqual([]);
    expect(result.open_tasks).toEqual([]);
    expect(result.checkpoint_refs).toEqual([]);
  });
});
