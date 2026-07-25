import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isTerminalRun,
  openRunSession,
  type OpenRunSession,
} from '../../session/run-session.js';

const CLOCK = '2026-07-25T00:00:00.000Z';
const KEY = Buffer.alloc(32, 0x44);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), 'run-session-'));
  roots.push(value);
  return value;
}

describe('openRunSession', () => {
  it('opens a locked in-memory session without creating persistence', () => {
    const opened = openRunSession({
      runId: 'memory-run',
      goal: 'answer',
      strategy: undefined,
      clock: () => CLOCK,
      dataDir: undefined,
      masterKey: undefined,
    });
    expect(opened.store).toBeNull();
    expect(opened.existingEvents).toEqual([]);
    expect(Object.isFrozen(opened.existingEvents)).toBe(true);
    expect(opened.persistedRun).toBeNull();
    opened.session.append('user', { content: 'hello' });
    expect(opened.session.eventCount()).toBe(1);
    expect(opened.session.session_id).toBe('memory-run');
    opened.session.releaseWriter();
  });

  it.each([
    undefined,
    Buffer.alloc(0),
    Buffer.alloc(31),
    Buffer.alloc(33),
  ])('requires an exact 32-byte key for durable sessions: %j', (masterKey) => {
    expect(() =>
      openRunSession({
        runId: 'invalid-key',
        goal: 'answer',
        strategy: 'direct',
        clock: () => CLOCK,
        dataDir: directory(),
        masterKey,
      }),
    ).toThrow('32-byte sessionMasterKey is required for durable sessions');
  });

  it('creates, restores, and identifies a terminal durable run exactly', () => {
    const dataDir = directory();
    const first = openRunSession({
      runId: 'durable-run',
      goal: 'answer',
      strategy: 'react',
      clock: () => CLOCK,
      dataDir,
      masterKey: KEY,
    });
    expect(first.existingEvents).toEqual([]);
    expect(first.persistedRun).toMatchObject({
      run_id: 'durable-run',
      goal: 'answer',
      strategy: 'react',
      status: 'running',
    });
    expect(isTerminalRun(first)).toBe(false);
    first.session.append('assistant', { decision_summary: 'done' });
    first.session.append('system', {
      event: 'run_terminated',
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    });
    first.session.snapshot_({ status: 'goal_satisfied' });
    first.session.releaseWriter();
    first.store!.updateRunStatus('durable-run', 'goal_satisfied');
    const expectedEvents = first.session.getEvents();
    const expectedSnapshot = first.session.export_().snapshot;
    first.store!.close();

    const restored = openRunSession({
      runId: 'durable-run',
      goal: 'answer',
      strategy: 'react',
      clock: () => CLOCK,
      dataDir,
      masterKey: KEY,
    });
    expect(restored.existingEvents).toEqual(expectedEvents);
    expect(restored.session.getEvents()).toEqual(expectedEvents);
    expect(restored.session.export_().snapshot).toEqual(expectedSnapshot);
    expect(restored.persistedRun?.status).toBe('goal_satisfied');
    expect(isTerminalRun(restored)).toBe(true);
    restored.session.releaseWriter();
    restored.store!.close();
  });

  it('rejects a stale snapshot and rebuilds only from the event chain', () => {
    const dataDir = directory();
    const first = openRunSession({
      runId: 'stale-run',
      goal: 'answer',
      strategy: 'direct',
      clock: () => CLOCK,
      dataDir,
      masterKey: KEY,
    });
    first.session.append('assistant', { decision_summary: 'done' });
    first.session.snapshot_({ status: 'done' });
    first.session.releaseWriter();
    first.store!.updateRunStatus('stale-run', 'goal_satisfied');
    const expectedEvents = first.session.getEvents();
    first.store!.close();
    const database = new Database(join(dataDir, 'session.db'));
    try {
      database
        .prepare('UPDATE snapshots SET last_hash = ? WHERE run_id = ?')
        .run('stale', 'stale-run');
    } finally {
      database.close();
    }
    const restored = openRunSession({
      runId: 'stale-run',
      goal: 'answer',
      strategy: 'direct',
      clock: () => CLOCK,
      dataDir,
      masterKey: KEY,
    });
    expect(restored.session.getEvents()).toEqual(expectedEvents);
    expect(restored.session.export_().snapshot).toBeNull();
    expect(isTerminalRun(restored)).toBe(true);
    restored.session.releaseWriter();
    restored.store!.close();
  });

  it('does not classify empty, missing, or running records as terminal', () => {
    const base = openRunSession({
      runId: 'predicate',
      goal: 'answer',
      strategy: undefined,
      clock: () => CLOCK,
      dataDir: undefined,
      masterKey: undefined,
    });
    const event = {
      seq: 1,
      type: 'user' as const,
      timestamp: CLOCK,
      data: {},
      hash: 'hash',
      prev_hash: '',
    };
    const record = {
      run_id: 'predicate',
      goal: 'answer',
      strategy: null,
      status: 'goal_satisfied',
      created_at: CLOCK,
    };
    expect(isTerminalRun(base)).toBe(false);
    expect(
      isTerminalRun({
        ...base,
        existingEvents: [],
        persistedRun: record,
      }),
    ).toBe(false);
    expect(
      isTerminalRun({
        ...base,
        existingEvents: [event],
        persistedRun: null,
      }),
    ).toBe(false);
    expect(
      isTerminalRun({
        ...base,
        existingEvents: [event],
        persistedRun: { ...record, status: 'running' },
      }),
    ).toBe(false);
    expect(
      isTerminalRun({
        ...base,
        existingEvents: [event],
        persistedRun: record,
      } as OpenRunSession),
    ).toBe(true);
    base.session.releaseWriter();
  });

  it('closes an opened database when later restoration fails', () => {
    const dataDir = directory();
    const first = openRunSession({
      runId: 'conflict',
      goal: 'first goal',
      strategy: 'direct',
      clock: () => CLOCK,
      dataDir,
      masterKey: KEY,
    });
    first.session.releaseWriter();
    first.store!.close();
    expect(() =>
      openRunSession({
        runId: 'conflict',
        goal: 'different goal',
        strategy: 'direct',
        clock: () => CLOCK,
        dataDir,
        masterKey: KEY,
      }),
    ).toThrow('run identity conflict: conflict');
    const database = new Database(join(dataDir, 'session.db'));
    expect(
      database
        .prepare('SELECT goal FROM runs WHERE run_id = ?')
        .get('conflict'),
    ).toBeDefined();
    database.close();
  });
});
