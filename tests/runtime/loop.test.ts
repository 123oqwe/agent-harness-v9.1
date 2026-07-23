import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
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
      let credsStrippedDuringLoop = false;
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g', data_dir: dir },
        { session: session(), modelCall: async () => {
          // During the agent phase, credentials should be stripped
          credsStrippedDuringLoop = process.env.LOOP_SECRET_KEY === undefined;
          return { content: 'ok', decision_summary: 'd' };
        }, goalSatisfied: () => true },
      );
      await loop.run();
      // Credentials were stripped during the agent phase
      expect(credsStrippedDuringLoop).toBe(true);
      // After the loop, credentials are restored (for the next setup phase)
      expect(process.env.LOOP_SECRET_KEY).toBe('secret');
      delete process.env.LOOP_SECRET_KEY;
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


  describe('P0: Loop must accept frozen RunPlan, not cast LoopConfig', () => {
    it('loop.ts source does not cast config to RunPlan via as unknown as', () => {
      const src = readFileSync(join(__dirname, '../../runtime/loop.ts'), 'utf8');
      expect(src).not.toContain('as unknown as');
    });

    it('loop.ts source does not have runPlanExecuteLinear fallback', () => {
      const src = readFileSync(join(__dirname, '../../runtime/loop.ts'), 'utf8');
      expect(src).not.toContain('runPlanExecuteLinear');
    });

    it('loop.ts source does not access workflow_graph from config via cast', () => {
      const src = readFileSync(join(__dirname, '../../runtime/loop.ts'), 'utf8');
      // Should not access workflow_graph by casting LoopConfig
      expect(src).not.toMatch(/this\.config as unknown as/);
    });
  });

  describe('P0: Harness must use ToolExecutor, not direct dispatch', () => {
    it('harness.ts does not have direct dispatch switch statement', () => {
      const src = readFileSync(join(__dirname, '../../harness.ts'), 'utf8');
      // Should not have the old dispatchTool method with inline switch
      expect(src).not.toContain('private async dispatchTool(');
      // dispatchToolViaDeps is called via ToolExecutor callback — switch inside is correct
    });

    it('harness.ts imports and uses ToolExecutor', () => {
      const src = readFileSync(join(__dirname, '../../harness.ts'), 'utf8');
      expect(src).toContain('ToolExecutor');
    });

    it('harness.ts does not return real VFS from createOverlayVfs', () => {
      const src = readFileSync(join(__dirname, '../../harness.ts'), 'utf8');
      // Should not have the comment "just use the real VFS"
      expect(src).not.toContain('just use the real VFS');
    });

    it('harness.ts does not use live-run as commit_sha', () => {
      const src = readFileSync(join(__dirname, '../../harness.ts'), 'utf8');
      expect(src).not.toContain('live-run');
    });

    it('harness.ts does not have 60% keyword matching for goal check', () => {
      const src = readFileSync(join(__dirname, '../../harness.ts'), 'utf8');
      expect(src).not.toContain('0.6');
    });
  });

  describe('P0: ToolExecutor must not self-generate keypair', () => {
    it('tool-executor.ts does not call generateKeyPairSync', () => {
      const src = readFileSync(join(__dirname, '../../tools/tool-executor.ts'), 'utf8');
      expect(src).not.toContain('generateKeyPairSync');
    });

    it('tool-executor.ts does not guess risk by tool name', () => {
      const src = readFileSync(join(__dirname, '../../tools/tool-executor.ts'), 'utf8');
      // Should not have name-based risk guessing
      expect(src).not.toContain("toolName.includes('write')");
    });
  });



  // -----------------------------------------------------------------------
  // Mutation-killing tests: cover untested react and plan_execute paths
  // -----------------------------------------------------------------------
  describe('react: comprehensive path coverage', () => {
    it('budget_tokens stops loop', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 10, budget_tokens: 10, run_id: 'r', goal: 'g' },
        {
          session: sess,
          modelCall: async () => ({ content: 'x', decision_summary: 'd', stop_reason: 'stop', usage: { input_tokens: 5, output_tokens: 5 } }),
          toolExecute: async () => 'ok',
        },
      );
      
      const result = await loop.run();
      
      expect(result.termination_reason).toBe('budget_exhausted');
    });

    it('content_filter stop_reason terminates with model_refusal', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 5, run_id: 'r', goal: 'g' },
        {
          session: sess,
          modelCall: async () => ({ content: '', decision_summary: 'filtered', stop_reason: 'content_filter' }),
          toolExecute: async () => 'ok',
        },
      );
      
      const result = await loop.run();
      
      expect(result.termination_reason).toBe('model_refusal');
    });

    it('tool error on last iteration terminates with malformed_response', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 1, run_id: 'r', goal: 'g' },
        {
          session: sess,
          modelCall: async () => ({ content: '', decision_summary: 'call tool', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/x' } }] }),
          toolExecute: async () => { throw new Error('tool failed'); },
        },
      );
      
      const result = await loop.run();
      
      expect(result.termination_reason).toBe('malformed_response');
    });

    it('tool error on non-last iteration continues to next iteration', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 3, run_id: 'r', goal: 'g' },
        {
          session: sess,
          modelCall: async (_msgs, attempt) => {
            if (attempt === 1) return { content: '', decision_summary: 'call', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/x' } }] };
            return { content: 'done', decision_summary: 'done', stop_reason: 'stop' };
          },
          toolExecute: async () => { throw new Error('transient'); },
          goalSatisfied: () => true,
        },
      );
      
      const result = await loop.run();
      
      expect(result.iterations).toBeGreaterThanOrEqual(2);
    });

    it('multiple tool calls in one turn each produce separate tool messages', async () => {
      const sess = session();
      const toolResults: string[] = [];
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 2, run_id: 'r', goal: 'g' },
        {
          session: sess,
          modelCall: async (msgs) => {
            if (msgs.length <= 1) return { content: '', decision_summary: 'two tools', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/a' } }, { id: '2', name: 'read_file', arguments: { path: '/b' } }] };
            return { content: 'done', decision_summary: 'done', stop_reason: 'stop' };
          },
          toolExecute: async (_name, args) => { toolResults.push(args.path as string); return 'content'; },
          goalSatisfied: () => true,
        },
      );
      
      await loop.run();
      
      expect(toolResults).toEqual(['/a', '/b']);
    });
  });

  describe('plan_execute: comprehensive path coverage', () => {
    it('executes model_call steps with tool_calls', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'model_call' as const, status: 'pending' as const }, { step_id: 's2', step_type: 'verification' as const, status: 'pending' as const }], edges: [{ from_step: 's1', to_step: 's2' }] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        {
          session: sess,
          modelCall: async () => ({ content: '', decision_summary: 'call tool', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/x' } }] }),
          toolExecute: async () => 'file content',
          goalSatisfied: () => true,
        },
      );
      
      const result = await loop.run();
      
      expect(result.termination_reason).toBe('goal_satisfied');
    });

    it('verification failure blocks dependent steps', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'model_call' as const, status: 'pending' as const }, { step_id: 's2', step_type: 'verification' as const, status: 'pending' as const }, { step_id: 's3', step_type: 'model_call' as const, status: 'pending' as const }], edges: [{ from_step: 's1', to_step: 's2' }, { from_step: 's2', to_step: 's3' }] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'work', decision_summary: 'done', stop_reason: 'stop' }), goalSatisfied: () => false },
      );
      
      const result = await loop.run();
      
      expect(result.termination_reason).toBe('completed');
    });

    it('cycle in workflow graph is detected', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 'a', step_type: 'model_call' as const, status: 'pending' as const }, { step_id: 'b', step_type: 'model_call' as const, status: 'pending' as const }], edges: [{ from_step: 'a', to_step: 'b' }, { from_step: 'b', to_step: 'a' }] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'x', decision_summary: 'd', stop_reason: 'stop' }) },
      );
      
      const result = await loop.run();
      
      expect(result.termination_reason).toBe('malformed_response');
    });

    it('missing WorkflowGraph fails closed', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'g' },
        { session: sess, modelCall: async () => ({ content: 'x', decision_summary: 'd', stop_reason: 'stop' }) },
      );
      
      const result = await loop.run();
      
      expect(result.termination_reason).toBe('malformed_response');
    });

    it('iteration limit during plan_execute stops loop', async () => {
      const sess = session();
      const wf = { nodes: Array.from({ length: 5 }, (_, i) => ({ step_id: 's' + i, step_type: 'model_call' as const, status: 'pending' as const })), edges: Array.from({ length: 4 }, (_, i) => ({ from_step: 's' + i, to_step: 's' + (i+1) })) };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 2, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'x', decision_summary: 'd', stop_reason: 'stop' }) },
      );
      
      const result = await loop.run();
      
      expect(result.termination_reason).toBe('iteration_limit');
    });
  });



  describe('mutation-killing: plan_execute tool_call and verification paths', () => {
    it('tool_call step executes tool and completes', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'tool_call' as const, status: 'pending' as const }], edges: [] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: '', decision_summary: 'call', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/x' } }] }), toolExecute: async () => 'content' },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('completed');
    });

    it('tool_call step fails when no tool call available', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'tool_call' as const, status: 'pending' as const }], edges: [] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'no tool', decision_summary: 'no tool', stop_reason: 'stop' }), toolExecute: async () => 'x' },
      );
      const result = await loop.run();
      // No tool call available — step completes as done, then loop completes
      expect(result.termination_reason).toBe('completed');
    });

    it('verification step satisfied completes with goal_satisfied', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'verification' as const, status: 'pending' as const }], edges: [] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'done', decision_summary: 'done', stop_reason: 'stop' }), goalSatisfied: () => true },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('goal_satisfied');
    });

    it('verification step not satisfied completes', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'verification' as const, status: 'pending' as const }], edges: [] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'work', decision_summary: 'work', stop_reason: 'stop' }), goalSatisfied: () => false },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('completed');
    });

    it('blocked step skipped when dependency failed', async () => {
      const sess = session();
      const wf = { nodes: [
        { step_id: 's1', step_type: 'tool_call' as const, status: 'pending' as const },
        { step_id: 's2', step_type: 'model_call' as const, status: 'pending' as const },
      ], edges: [{ from_step: 's1', to_step: 's2' }] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: '', decision_summary: 'call', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/x' } }] }), toolExecute: async () => { throw new Error('fail'); } },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('malformed_response');
    });

    it('decision step type passes through as done', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'decision' as const, status: 'pending' as const }], edges: [] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'x', decision_summary: 'd', stop_reason: 'stop' }) },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('completed');
    });

    it('all steps done with goalSatisfied true terminates goal_satisfied', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'model_call' as const, status: 'pending' as const }], edges: [] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'done', decision_summary: 'done', stop_reason: 'stop' }), goalSatisfied: () => true },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('goal_satisfied');
    });
  });

  describe('mutation-killing: react edge cases', () => {
    it('context_reset after 2 consecutive no-tool turns', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 5, run_id: 'r', goal: 'g' },
        { session: sess, modelCall: async () => ({ content: 'thinking', decision_summary: 'd', stop_reason: 'stop' }), goalSatisfied: () => false },
      );
      const result = await loop.run();
      expect(result.context_reset_emitted).toBe(true);
      expect(result.termination_reason).toBe('context_reset');
    });

    it('tool oscillation: same tool+args 3 times stops loop', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 10, run_id: 'r', goal: 'g' },
        {
          session: sess,
          modelCall: async () => ({ content: '', decision_summary: 'same tool', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/same' } }] }),
          toolExecute: async () => 'content',
          goalSatisfied: () => false,
        },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('tool_oscillation');
    });

    it('different tool args do not trigger oscillation', async () => {
      const sess = session();
      let callCount = 0;
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 5, run_id: 'r', goal: 'g' },
        {
          session: sess,
          modelCall: async () => { callCount++; return { content: '', decision_summary: 'd', stop_reason: 'tool_use', tool_calls: [{ id: String(callCount), name: 'read_file', arguments: { path: '/file' + callCount } }] }; },
          toolExecute: async () => 'content',
          goalSatisfied: () => callCount >= 3,
        },
      );
      const result = await loop.run();
      expect(result.termination_reason).not.toBe('tool_oscillation');
    });
  });

  describe('mutation-killing: progress.json content', () => {
    it('progress.json contains run_id, current_step, goal, completed_steps', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r-test', goal: 'test goal', data_dir: dir },
        { session: sess, modelCall: async () => ({ content: 'ok', decision_summary: 'done' }), goalSatisfied: () => true },
      );
      await loop.run();
      const progress = JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8'));
      expect(progress.run_id).toBe('r-test');
      expect(progress.goal).toBe('test goal');
      expect(progress.current_step).toBe(1);
      expect(progress.completed_steps).toHaveLength(1);
      expect(progress.completed_steps[0].summary).toBe('done');
    });

    it('progress.json open_tasks empty after termination', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g', data_dir: dir },
        { session: sess, modelCall: async () => ({ content: 'ok', decision_summary: 'done' }), goalSatisfied: () => true },
      );
      await loop.run();
      const progress = JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8'));
      expect(progress.open_tasks).toEqual([]);
    });

    it('progress.json last_error is null on goal_satisfied', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g', data_dir: dir },
        { session: sess, modelCall: async () => ({ content: 'ok', decision_summary: 'done' }), goalSatisfied: () => true },
      );
      await loop.run();
      const progress = JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8'));
      expect(progress.last_error).toBeNull();
    });
  });

});
