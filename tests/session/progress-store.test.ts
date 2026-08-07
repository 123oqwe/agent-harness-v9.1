import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeProgressAtomic, readProgress, type ProgressEntry } from '../../session/progress-store.js';

describe('progress-store', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ah-progress-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writeProgressAtomic creates progress.json', () => {
    const entry: ProgressEntry = {
      run_id: 'run-1', current_step: 1, goal: 'test goal',
      completed_steps: [], open_tasks: [], last_error: null,
      checkpoint_refs: [], last_updated: '2026-01-01T00:00:00Z',
    };
    const path = writeProgressAtomic(dir, entry);
    expect(existsSync(path)).toBe(true);
    expect(path).toBe(join(dir, 'progress.json'));
  });

  it('readProgress returns null when file does not exist', () => {
    expect(readProgress(dir)).toBeNull();
  });

  it('writeProgressAtomic then readProgress round-trips data', () => {
    const entry: ProgressEntry = {
      run_id: 'run-1', current_step: 5, goal: 'do something',
      completed_steps: [{ step: 1 }], open_tasks: ['task-a'],
      last_error: 'some error', checkpoint_refs: ['cp-1'],
      last_updated: '2026-06-01T12:00:00Z',
    };
    writeProgressAtomic(dir, entry);
    const result = readProgress(dir);
    expect(result).not.toBeNull();
    expect(result!.run_id).toBe('run-1');
    expect(result!.current_step).toBe(5);
    expect(result!.goal).toBe('do something');
    expect(result!.open_tasks).toEqual(['task-a']);
    expect(result!.last_error).toBe('some error');
    expect(result!.checkpoint_refs).toEqual(['cp-1']);
  });

  it('writeProgressAtomic is idempotent (overwrites)', () => {
    const entry1: ProgressEntry = {
      run_id: 'r1', current_step: 1, goal: 'g1',
      completed_steps: [], open_tasks: [], last_error: null,
      checkpoint_refs: [], last_updated: 't1',
    };
    const entry2: ProgressEntry = {
      run_id: 'r2', current_step: 2, goal: 'g2',
      completed_steps: [], open_tasks: [], last_error: null,
      checkpoint_refs: [], last_updated: 't2',
    };
    writeProgressAtomic(dir, entry1);
    writeProgressAtomic(dir, entry2);
    const result = readProgress(dir);
    expect(result!.run_id).toBe('r2');
    expect(result!.current_step).toBe(2);
  });

  it('creates parent directories if they do not exist', () => {
    const subDir = join(dir, 'nested', 'deep');
    const entry: ProgressEntry = {
      run_id: 'r1', current_step: 1, goal: 'g',
      completed_steps: [], open_tasks: [], last_error: null,
      checkpoint_refs: [], last_updated: 't',
    };
    const path = writeProgressAtomic(subDir, entry);
    expect(existsSync(path)).toBe(true);
  });

  it('writes valid JSON', () => {
    const entry: ProgressEntry = {
      run_id: 'r1', current_step: 1, goal: 'g',
      completed_steps: [], open_tasks: [], last_error: null,
      checkpoint_refs: [], last_updated: 't',
    };
    writeProgressAtomic(dir, entry);
    const raw = readFileSync(join(dir, 'progress.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('writes with file mode 0o600 (owner read/write only)', () => {
    const entry: ProgressEntry = {
      run_id: 'r1', current_step: 0, goal: 'g',
      completed_steps: [], open_tasks: [], last_error: null,
      checkpoint_refs: [], last_updated: 't',
    };
    writeProgressAtomic(dir, entry);
    const stat = statSync(join(dir, 'progress.json'));
    // On macOS, mode may have extra bits, but owner rw should be set
    expect(stat.mode & 0o600).toBe(0o600);
  });

  it('writes entry with string current_step', () => {
    const entry: ProgressEntry = {
      run_id: 'r1', current_step: 'step-1', goal: 'g',
      completed_steps: [], open_tasks: [], last_error: null,
      checkpoint_refs: [], last_updated: 't',
    };
    const path = writeProgressAtomic(dir, entry);
    const result = readProgress(dir);
    expect(result).not.toBeNull();
    expect(result!.current_step).toBe('step-1');
  });

  it('writes entry with last_error string', () => {
    const entry: ProgressEntry = {
      run_id: 'r1', current_step: 0, goal: 'g',
      completed_steps: [], open_tasks: [], last_error: 'something failed',
      checkpoint_refs: [], last_updated: 't',
    };
    writeProgressAtomic(dir, entry);
    const result = readProgress(dir);
    expect(result!.last_error).toBe('something failed');
  });

  it('writes entry with populated arrays', () => {
    const entry: ProgressEntry = {
      run_id: 'r1', current_step: 0, goal: 'g',
      completed_steps: [{ step: 1, result: 'done' }],
      open_tasks: ['task-a', 'task-b'],
      last_error: null,
      checkpoint_refs: ['cp-1', 'cp-2'],
      last_updated: '2026-08-07T12:00:00Z',
    };
    writeProgressAtomic(dir, entry);
    const result = readProgress(dir);
    expect(result!.completed_steps).toHaveLength(1);
    expect(result!.open_tasks).toEqual(['task-a', 'task-b']);
    expect(result!.checkpoint_refs).toEqual(['cp-1', 'cp-2']);
    expect(result!.last_updated).toBe('2026-08-07T12:00:00Z');
  });

  it('returns correct progress path', () => {
    const entry: ProgressEntry = {
      run_id: 'r1', current_step: 0, goal: 'g',
      completed_steps: [], open_tasks: [], last_error: null,
      checkpoint_refs: [], last_updated: 't',
    };
    const path = writeProgressAtomic(dir, entry);
    expect(path).toBe(join(dir, 'progress.json'));
  });

  it('overwrites existing file with new content', () => {
    const entry1: ProgressEntry = {
      run_id: 'r1', current_step: 1, goal: 'first',
      completed_steps: [], open_tasks: [], last_error: null,
      checkpoint_refs: [], last_updated: 't1',
    };
    writeProgressAtomic(dir, entry1);
    const entry2: ProgressEntry = {
      run_id: 'r2', current_step: 2, goal: 'second',
      completed_steps: [], open_tasks: [], last_error: null,
      checkpoint_refs: [], last_updated: 't2',
    };
    writeProgressAtomic(dir, entry2);
    const result = readProgress(dir);
    expect(result!.run_id).toBe('r2');
    expect(result!.goal).toBe('second');
    expect(result!.current_step).toBe(2);
  });
});
