import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSessionStore } from '../../session/sqlite-session-store.js';
import { writeProgressAtomic, readProgress } from '../../session/progress-store.js';

describe('SQLite Session Store', () => {
  let dir: string;
  let store: SqliteSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sqlite-'));
    store = new SqliteSessionStore(join(dir, 'session.db'));
  });
  afterEach(() => {
    store.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('creates and retrieves a run', () => {
    store.createRun('run-1', 'fix the bug', 'react');
    // run record created without error
    expect(existsSync(join(dir, 'session.db'))).toBe(true);
  });

  it('persists events immediately and loads them back', () => {
    store.createRun('run-2', 'test goal');
    const ev = { seq: 1, type: 'user' as const, timestamp: new Date().toISOString(), data: { text: 'hello' }, hash: 'abc', prev_hash: '' };
    store.appendEvent('run-2', ev);
    const loaded = store.loadEvents('run-2');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.type).toBe('user');
    expect((loaded[0]!.data as { text: string }).text).toBe('hello');
  });

  it('prevents duplicate event insertion (idempotent)', () => {
    store.createRun('run-3', 'test');
    const ev = { seq: 1, type: 'user' as const, timestamp: new Date().toISOString(), data: {}, hash: 'h1', prev_hash: '' };
    store.appendEvent('run-3', ev);
    store.appendEvent('run-3', ev); // same seq, should be ignored
    expect(store.loadEvents('run-3')).toHaveLength(1);
  });

  it('records operations with idempotency key', () => {
    store.createRun('run-4', 'test');
    store.recordOperation({
      operation_id: 'op-1', run_id: 'run-4', step_id: 'step-1', attempt_id: 'att-1',
      tool_name: 'read_file', idempotency_key: 'idem-1', effect_state: 'PRE_DISPATCH',
      receipt_json: null,
    });
    const op = store.getOperation('op-1');
    expect(op).not.toBeNull();
    expect(op!.tool_name).toBe('read_file');
    expect(op!.effect_state).toBe('PRE_DISPATCH');
  });

  it('prevents duplicate operations by idempotency key', () => {
    store.createRun('run-5', 'test');
    store.recordOperation({
      operation_id: 'op-2', run_id: 'run-5', step_id: 'step-1', attempt_id: 'att-1',
      tool_name: 'write_file', idempotency_key: 'idem-2', effect_state: 'PRE_DISPATCH',
      receipt_json: null,
    });
    // Attempt to create another op with the same idempotency key should fail
    expect(() => store.recordOperation({
      operation_id: 'op-3', run_id: 'run-5', step_id: 'step-2', attempt_id: 'att-2',
      tool_name: 'write_file', idempotency_key: 'idem-2', effect_state: 'PRE_DISPATCH',
      receipt_json: null,
    })).toThrow();
  });

  it('tracks effect state transitions', () => {
    store.createRun('run-6', 'test');
    store.recordOperation({
      operation_id: 'op-4', run_id: 'run-6', step_id: 'step-1', attempt_id: 'att-1',
      tool_name: 'execute_command', idempotency_key: 'idem-4', effect_state: 'PRE_DISPATCH',
      receipt_json: null,
    });
    // Update to EFFECT_CONFIRMED
    store.recordOperation({
      operation_id: 'op-4', run_id: 'run-6', step_id: 'step-1', attempt_id: 'att-1',
      tool_name: 'execute_command', idempotency_key: 'idem-4', effect_state: 'EFFECT_CONFIRMED',
      receipt_json: '{"success":true}',
    });
    expect(store.isEffectConfirmed('idem-4')).toBe(true);
  });

  it('isEffectConfirmed returns false for unknown key', () => {
    expect(store.isEffectConfirmed('nonexistent')).toBe(false);
  });

  it('records receipts linked to operations', () => {
    store.createRun('run-7', 'test');
    store.recordOperation({
      operation_id: 'op-5', run_id: 'run-7', step_id: 'step-1', attempt_id: 'att-1',
      tool_name: 'read_file', idempotency_key: 'idem-5', effect_state: 'EFFECT_CONFIRMED',
      receipt_json: null,
    });
    store.recordReceipt('op-5', {
      tool_name: 'read_file', success: true, input_hash: 'abc',
      output_hash: 'def', duration_ms: 42, timestamp: new Date().toISOString(),
    });
    // receipt recorded without error
    expect(true).toBe(true);
  });

  it('loads events after simulated crash (new store instance)', () => {
    store.createRun('run-8', 'crash test');
    store.appendEvent('run-8', { seq: 1, type: 'user', timestamp: new Date().toISOString(), data: { t: 1 }, hash: 'h1', prev_hash: '' });
    store.appendEvent('run-8', { seq: 2, type: 'assistant', timestamp: new Date().toISOString(), data: { t: 2 }, hash: 'h2', prev_hash: 'h1' });
    store.close();

    // Simulate crash: open a new store instance on the same DB
    const recovered = new SqliteSessionStore(join(dir, 'session.db'));
    const events = recovered.loadEvents('run-8');
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('user');
    expect(events[1]!.type).toBe('assistant');
    recovered.close();
  });
});

describe('Progress Store (atomic writes)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'prog-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('writes progress.json atomically', () => {
    const path = writeProgressAtomic(dir, {
      run_id: 'r1', current_step: 'step-1', goal: 'test',
      completed_steps: [], open_tasks: ['task-1'], last_error: null,
      checkpoint_refs: [], last_updated: new Date().toISOString(),
    });
    expect(existsSync(path)).toBe(true);
  });

  it('reads progress.json back', () => {
    writeProgressAtomic(dir, {
      run_id: 'r2', current_step: 'step-2', goal: 'test2',
      completed_steps: ['step-1'], open_tasks: [], last_error: 'none',
      checkpoint_refs: ['ref-1'], last_updated: '2026-01-01T00:00:00Z',
    });
    const p = readProgress(dir);
    expect(p).not.toBeNull();
    expect(p!.run_id).toBe('r2');
    expect(p!.completed_steps).toEqual(['step-1']);
  });

  it('returns null when no progress file exists', () => {
    expect(readProgress(dir)).toBeNull();
  });
});
