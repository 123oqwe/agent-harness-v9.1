import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableSession } from '../../session/durable-session.js';
import { LoopEngine, type ModelTurn } from '../../runtime/loop.js';

describe('AH-RUNTIME-SESSION-001 crash restore', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'crash-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('loop writes progress.json after every turn', async () => {
    const session = new DurableSession('s1');
    const calls: ModelTurn[] = [
      { content: 'plan', decision_summary: 'plan' },
      { content: 'done', decision_summary: 'done' },
    ];
    const loop = new LoopEngine(
      { strategy: 'direct', max_iterations: 1, run_id: 'r1', goal: 'g', data_dir: dir },
      { session, modelCall: async () => calls[0]!, goalSatisfied: () => true },
    );
    await loop.run();
    expect(existsSync(join(dir, 'progress.json'))).toBe(true);
    const p = JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8'));
    expect(p.run_id).toBe('r1');
    expect(p.goal).toBe('g');
  });

  it('crash mid-task: restored session resumes without duplicate side effects', async () => {
    const session = new DurableSession('s2');
    // simulate: session had 2 events before crash
    session.acquireWriter();
    session.append('user', { text: 'fix bug' });
    session.append('assistant', { decision_summary: 'step1' });
    const exported = session.export_();
    // restore after crash
    const restored = DurableSession.restore(exported);
    expect(restored.eventCount()).toBe(2);
    expect(restored.resumeFrom()).toBe(3);
    // resuming does NOT replay events 1-2 (idempotent)
    const restored2 = DurableSession.restore(exported);
    expect(restored2.eventCount()).toBe(2);
  });

  it('progress.json contains run_id, current_step, goal, completed_steps, open_tasks, last_error, checkpoint_refs', async () => {
    const session = new DurableSession('s3');
    const loop = new LoopEngine(
      { strategy: 'direct', max_iterations: 1, run_id: 'r3', goal: 'goal-x', data_dir: dir },
      { session, modelCall: async () => ({ content: 'ok', decision_summary: 'decided' }), goalSatisfied: () => true },
    );
    await loop.run();
    const p = JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8'));
    expect(p.run_id).toBe('r3');
    expect(p.current_step).toBe(1);
    expect(p.goal).toBe('goal-x');
    expect(Array.isArray(p.completed_steps)).toBe(true);
    expect(Array.isArray(p.open_tasks)).toBe(true);
    expect(p.last_error).toBeNull();
    expect(Array.isArray(p.checkpoint_refs)).toBe(true);
  });
});
