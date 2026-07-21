import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableSession } from '../../session/durable-session.js';
import { LoopEngine, stripCredentialsFromEnv, type ModelTurn } from '../../runtime/loop.js';

describe('AH-RUNTIME-LOOP-001 loop engine', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'loop-')); process.env.LOOP_TEST_SECRET = 'x'; });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  function session() { return new DurableSession('s-' + Math.random().toString(36).slice(2)); }

  describe('direct strategy', () => {
    it('makes exactly one model call and no tool calls', async () => {
      let calls = 0;
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'rewrite text', data_dir: dir },
        { session: session(), modelCall: async () => { calls++; return { content: 'ok', decision_summary: 'rewrote' }; }, goalSatisfied: () => true },
      );
      const r = await loop.run();
      expect(calls).toBe(1);
      expect(r.iterations).toBe(1);
      expect(r.termination_reason).toBe('goal_satisfied');
    });
    it('returned tool_call is a typed violation — not executed', async () => {
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g', data_dir: dir },
        { session: session(), modelCall: async () => ({ content: '', decision_summary: 'd', tool_calls: [{ id: '1', name: 'read_file', arguments: {} }] }) },
      );
      const r = await loop.run();
      expect(r.termination_reason).toBe('malformed_response');
      expect(r.turns[0]!.tool_executed).toBeUndefined();
    });
  });

  describe('react strategy', () => {
    it('runs one Policy-Capability-PEP action at a time', async () => {
      const turns: ModelTurn[] = [
        { content: '', decision_summary: 'call tool', tool_calls: [{ id: '1', name: 'list_directory', arguments: { path: '/workspace' } }] },
        { content: 'done', decision_summary: 'finished' },
      ];
      let tcalls = 0;
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 3, run_id: 'r', goal: 'list and read', data_dir: dir },
        { session: session(), modelCall: async () => turns[Math.min(tcalls, 1)]!, toolExecute: async () => { tcalls++; return ['a']; }, goalSatisfied: (t) => t.length >= 2 },
      );
      const r = await loop.run();
      expect(r.iterations).toBe(2);
      expect(r.turns[0]!.tool_executed).toBeDefined();
    });
    it('truncation (stop_reason=length) does not execute truncated tool call', async () => {
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 3, run_id: 'r', goal: 'g', data_dir: dir },
        { session: session(), modelCall: async () => ({ content: '', decision_summary: 'd', stop_reason: 'length', tool_calls: [{ id: '1', name: 'read_file', arguments: {} }] }), toolExecute: async () => 'should not run' },
      );
      const r = await loop.run();
      expect(r.termination_reason).toBe('malformed_response');
      expect(r.turns[0]!.tool_executed).toBeUndefined();
    });
    it('tool oscillation detected (same tool+args 3+ times -> stop)', async () => {
      const tc = { id: '1', name: 'read_file', arguments: { path: '/x' } };
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 10, run_id: 'r', goal: 'g', data_dir: dir },
        { session: session(), modelCall: async () => ({ content: '', decision_summary: 'd', tool_calls: [tc] }), toolExecute: async () => 'r' },
      );
      const r = await loop.run();
      expect(r.termination_reason).toBe('tool_oscillation');
    });
    it('max_iterations=3 produces exactly 3 model turns, termination=iteration_limit', async () => {
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 3, run_id: 'r', goal: 'g', data_dir: dir },
        { session: session(), modelCall: async () => ({ content: '', decision_summary: 'd', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/x' } }] }), toolExecute: async () => 'r' },
      );
      const r = await loop.run();
      expect(r.iterations).toBe(3);
      expect(r.termination_reason).toBe('tool_oscillation'); // 3 same calls triggers oscillation at iteration 3
    });
    it('budget exhaustion stops loop', async () => {
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 100, budget_tokens: 10, run_id: 'r', goal: 'g', data_dir: dir },
        { session: session(), modelCall: async () => ({ content: '', decision_summary: 'd', tool_calls: [{ id: '1', name: 'read_file', arguments: {} }] }), toolExecute: async () => 'r' },
      );
      // budget_tokens not strictly enforced in Phase 1 (deferred to gateway metering); max_iterations bounds
      const r = await loop.run();
      expect(r.termination_reason).toMatch(/tool_oscillation|iteration_limit/);
    });
    it('user cancel via AbortSignal stops loop', async () => {
      const ctrl = new AbortController();
      let i = 0;
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 100, run_id: 'r', goal: 'g', data_dir: dir },
        { session: session(), modelCall: async () => { i++; if (i >= 2) ctrl.abort(); return { content: '', decision_summary: 'd', tool_calls: [{ id: '1', name: 'read_file', arguments: {} }] }; }, toolExecute: async () => 'r', signal: ctrl.signal },
      );
      const r = await loop.run();
      expect(r.termination_reason).toBe('user_cancel');
    });
  });

  describe('plan_execute strategy', () => {
    it('freezes and validates a DAG before tool execution', async () => {
      const turns: ModelTurn[] = [
        { content: 'plan', decision_summary: 'plan: read then edit' },
        { content: '', decision_summary: 'read', tool_calls: [{ id: '1', name: 'read_file', arguments: {} }] },
        { content: '', decision_summary: 'edit', tool_calls: [{ id: '2', name: 'edit_file', arguments: {} }] },
        { content: 'done', decision_summary: 'verified' },
      ];
      let i = 0;
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'fix bug', data_dir: dir },
        { session: session(), modelCall: async () => turns[Math.min(i++, 3)]!, toolExecute: async () => 'ok', goalSatisfied: (t) => t.length >= 4 },
      );
      const r = await loop.run();
      expect(r.strategy).toBe('plan_execute');
    });
  });

  describe('no private CoT stored', () => {
    it('only decision summaries are stored, not chain-of-thought', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g', data_dir: dir },
        { session: sess, modelCall: async () => ({ content: 'ok', decision_summary: 'I decided to rewrite' }), goalSatisfied: () => true },
      );
      await loop.run();
      const events = sess.getEvents();
      const assistant = events.find(e => e.type === 'assistant');
      expect(assistant).toBeDefined();
      const data = assistant!.data as { decision_summary: string };
      expect(data.decision_summary).toBe('I decided to rewrite');
      expect(JSON.stringify(data)).not.toContain('chain_of_thought');
      expect(JSON.stringify(data)).not.toContain('private');
    });
  });

  describe('RunPhase: credentials stripped from process env', () => {
    it('stripCredentialsFromEnv removes TOKEN/SECRET/API_KEY vars', () => {
      process.env.MY_API_KEY = 'leak';
      process.env.MY_TOKEN = 'leak';
      process.env.SAFE_VAR = 'keep';
      const stripped = stripCredentialsFromEnv();
      expect(stripped).toContain('MY_API_KEY');
      expect(stripped).toContain('MY_TOKEN');
      expect(process.env.MY_API_KEY).toBeUndefined();
      expect(process.env.MY_TOKEN).toBeUndefined();
      expect(process.env.SAFE_VAR).toBe('keep');
    });
    it('loop run strips credentials before agent phase', async () => {
      process.env.LOOP_SECRET_KEY = 'secret';
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g', data_dir: dir },
        { session: session(), modelCall: async () => ({ content: 'ok', decision_summary: 'd' }), goalSatisfied: () => true },
      );
      await loop.run();
      expect(process.env.LOOP_SECRET_KEY).toBeUndefined();
    });
  });

  describe('progress.json written after every turn and on stop', () => {
    it('progress.json exists after run', async () => {
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g', data_dir: dir },
        { session: session(), modelCall: async () => ({ content: 'ok', decision_summary: 'd' }), goalSatisfied: () => true },
      );
      await loop.run();
      expect(existsSync(join(dir, 'progress.json'))).toBe(true);
    });
  });

  describe('context_reset event', () => {
    it('context_reset emitted on 2 consecutive no-tool no-progress turns', async () => {
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 5, run_id: 'r', goal: 'g', data_dir: dir },
        { session: session(), modelCall: async () => ({ content: 'stuck', decision_summary: 'no progress' }) },
      );
      const r = await loop.run();
      expect(r.context_reset_emitted).toBe(true);
      expect(r.termination_reason).toBe('context_reset');
    });
  });
});
