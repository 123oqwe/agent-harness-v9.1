import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
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

describe('progress-store-survival: writeProgressAtomic exact behavior', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ah-prog-surv-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns exact path dataDir/progress.json', () => {
    const path = writeProgressAtomic(dir, makeEntry());
    expect(path).toBe(join(dir, 'progress.json'));
  });

  it('creates directory if it does not exist', () => {
    const nestedDir = join(dir, 'nested', 'subdir');
    writeProgressAtomic(nestedDir, makeEntry());
    expect(existsSync(join(nestedDir, 'progress.json'))).toBe(true);
  });

  it('temp file is cleaned up after rename', () => {
    writeProgressAtomic(dir, makeEntry());
    expect(existsSync(join(dir, 'progress.json'))).toBe(true);
    expect(existsSync(join(dir, 'progress.json.tmp'))).toBe(false);
  });

  it('file has 0o600 permissions', () => {
    writeProgressAtomic(dir, makeEntry());
    const stat = statSync(join(dir, 'progress.json'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('JSON is pretty-printed with 2-space indent', () => {
    writeProgressAtomic(dir, makeEntry({ run_id: 'indent-check' }));
    const content = readFileSync(join(dir, 'progress.json'), 'utf8');
    expect(content).toContain('\n  "run_id"');
  });

  it('contains exact field names in output', () => {
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

  it('overwrites existing file on second write', () => {
    writeProgressAtomic(dir, makeEntry({ run_id: 'first' }));
    writeProgressAtomic(dir, makeEntry({ run_id: 'second' }));
    const entry = readProgress(dir);
    expect(entry!.run_id).toBe('second');
  });

  it('preserves all field values exactly', () => {
    const entry = makeEntry({
      run_id: 'complex-run',
      current_step: 'step-5',
      goal: 'complex goal with special chars: <>!@#',
      completed_steps: [{ step: 1, status: 'done' }, { step: 2, status: 'done' }],
      open_tasks: ['task-a', 'task-b'],
      last_error: 'something failed',
      checkpoint_refs: ['ref-1', 'ref-2'],
      last_updated: '2026-08-09T00:00:00Z',
    });
    writeProgressAtomic(dir, entry);
    const read = readProgress(dir);
    expect(read).toEqual(entry);
  });

  it('handles null last_error', () => {
    writeProgressAtomic(dir, makeEntry({ last_error: null }));
    const entry = readProgress(dir);
    expect(entry!.last_error).toBeNull();
  });

  it('handles string last_error', () => {
    writeProgressAtomic(dir, makeEntry({ last_error: 'error message' }));
    const entry = readProgress(dir);
    expect(entry!.last_error).toBe('error message');
  });

  it('handles number current_step', () => {
    writeProgressAtomic(dir, makeEntry({ current_step: 42 }));
    const entry = readProgress(dir);
    expect(entry!.current_step).toBe(42);
  });

  it('handles string current_step', () => {
    writeProgressAtomic(dir, makeEntry({ current_step: 'step-3' }));
    const entry = readProgress(dir);
    expect(entry!.current_step).toBe('step-3');
  });

  it('handles empty arrays', () => {
    writeProgressAtomic(dir, makeEntry({ completed_steps: [], open_tasks: [], checkpoint_refs: [] }));
    const entry = readProgress(dir);
    expect(entry!.completed_steps).toEqual([]);
    expect(entry!.open_tasks).toEqual([]);
    expect(entry!.checkpoint_refs).toEqual([]);
  });

  it('handles complex nested data in completed_steps', () => {
    const complex = { step: 1, data: { nested: { arr: [1, 2, 3] } } };
    writeProgressAtomic(dir, makeEntry({ completed_steps: [complex] }));
    const entry = readProgress(dir);
    expect(entry!.completed_steps).toEqual([complex]);
  });
});

describe('progress-store-survival: readProgress', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ah-prog-read-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns null when file does not exist', () => {
    expect(readProgress(dir)).toBeNull();
  });

  it('returns parsed ProgressEntry when file exists', () => {
    writeProgressAtomic(dir, makeEntry({ run_id: 'test-read' }));
    const entry = readProgress(dir);
    expect(entry).not.toBeNull();
    expect(entry!.run_id).toBe('test-read');
  });

  it('returns exact entry that was written', () => {
    const original = makeEntry({
      run_id: 'exact-test',
      current_step: 5,
      goal: 'exact goal',
      completed_steps: [1, 2, 3],
      open_tasks: ['a', 'b'],
      last_error: 'err',
      checkpoint_refs: ['c1'],
      last_updated: '2026-01-01T12:00:00Z',
    });
    writeProgressAtomic(dir, original);
    const read = readProgress(dir);
    expect(read).toEqual(original);
  });
});
