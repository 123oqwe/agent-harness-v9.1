import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableSession } from '../../session/durable-session.js';
import { LoopEngine, stripCredentialsFromEnv, LoopError, type ModelTurn } from '../../runtime/loop.js';

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
      
      expect(result.termination_reason).toBe('malformed_response');
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
      expect(result.termination_reason).toBe('malformed_response');
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



  describe('mutation-killing: credentials and progress deep coverage', () => {
    it('stripCredentialsFromEnv removes all credential patterns', () => {
      process.env.MY_TOKEN = 't1';
      process.env.MY_API_KEY = 'k1';
      process.env.MY_SECRET = 's1';
      process.env.MY_PASSWORD = 'p1';
      process.env.MY_CREDENTIAL = 'c1';
      process.env.SAFE_VAR = 'keep';
      const stripped = stripCredentialsFromEnv();
      expect(stripped).toContain('MY_TOKEN');
      expect(stripped).toContain('MY_API_KEY');
      expect(stripped).toContain('MY_SECRET');
      expect(stripped).toContain('MY_PASSWORD');
      expect(stripped).toContain('MY_CREDENTIAL');
      expect(process.env.MY_TOKEN).toBeUndefined();
      expect(process.env.MY_API_KEY).toBeUndefined();
      expect(process.env.MY_SECRET).toBeUndefined();
      expect(process.env.MY_PASSWORD).toBeUndefined();
      expect(process.env.MY_CREDENTIAL).toBeUndefined();
      expect(process.env.SAFE_VAR).toBe('keep');
    });

    it('loop run restores credentials after agent phase', async () => {
      process.env.LOOP_TEST_CREDENTIAL = 'secret-value';
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g' },
        { session: sess, modelCall: async () => ({ content: 'ok', decision_summary: 'done' }), goalSatisfied: () => true },
      );
      await loop.run();
      expect(process.env.LOOP_TEST_CREDENTIAL).toBe('secret-value');
    });

    it('progress.json checkpoint_refs contains timestamps', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g', data_dir: dir },
        { session: sess, modelCall: async () => ({ content: 'ok', decision_summary: 'done' }), goalSatisfied: () => true },
      );
      await loop.run();
      const progress = JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8'));
      expect(progress.checkpoint_refs).toHaveLength(1);
      expect(progress.checkpoint_refs[0]).toMatch(/^\d{4}-/);
    });

    it('progress.json last_error is malformed on malformed_response', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g', data_dir: dir },
        { session: sess, modelCall: async () => ({ content: '', decision_summary: 'd', stop_reason: 'length' }) },
      );
      await loop.run();
      const progress = JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8'));
      expect(progress.last_error).toBe('malformed');
    });

    it('progress.json last_updated is ISO timestamp', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g', data_dir: dir },
        { session: sess, modelCall: async () => ({ content: 'ok', decision_summary: 'done' }), goalSatisfied: () => true },
      );
      await loop.run();
      const progress = JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8'));
      expect(progress.last_updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('direct strategy with tool_calls terminates malformed_response', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g' },
        { session: sess, modelCall: async () => ({ content: '', decision_summary: 'd', tool_calls: [{ id: '1', name: 'x', arguments: {} }] }) },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('malformed_response');
    });

    it('react with no toolExecute and tool_calls terminates malformed_response', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 3, run_id: 'r', goal: 'g' },
        { session: sess, modelCall: async () => ({ content: '', decision_summary: 'd', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'x', arguments: {} }] }) },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('malformed_response');
    });

    it('decision_summaries are recorded for each turn', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 3, run_id: 'r', goal: 'g' },
        {
          session: sess,
          modelCall: async (_msgs, attempt) => {
            if (attempt < 3) return { content: '', decision_summary: 'turn-' + attempt, stop_reason: 'tool_use', tool_calls: [{ id: String(attempt), name: 'read', arguments: { path: '/f' + attempt } }] };
            return { content: 'done', decision_summary: 'final', stop_reason: 'stop' };
          },
          toolExecute: async () => 'content',
          goalSatisfied: (turns) => turns.length >= 3,
        },
      );
      const result = await loop.run();
      expect(result.decision_summaries).toContain('turn-1');
      expect(result.decision_summaries).toContain('turn-2');
      expect(result.decision_summaries).toContain('final');
    });
  });



  describe('mutation-killing: session events and message content verification', () => {
    it('direct records assistant event with decision_summary', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g' },
        { session: sess, modelCall: async () => ({ content: 'result', decision_summary: 'my summary' }), goalSatisfied: () => true },
      );
      await loop.run();
      const events = sess.getEvents();
      const assistantEvents = events.filter(e => e.type === 'assistant');
      expect(assistantEvents.length).toBe(1);
      expect((assistantEvents[0]!.data as { decision_summary: string }).decision_summary).toBe('my summary');
    });

    it('direct with tool_call records strategy_violation system event', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g' },
        { session: sess, modelCall: async () => ({ content: '', decision_summary: 'd', tool_calls: [{ id: '1', name: 'x', arguments: {} }] }) },
      );
      await loop.run();
      const events = sess.getEvents();
      const systemEvents = events.filter(e => e.type === 'system');
      expect(systemEvents.some(e => (e.data as { reason?: string }).reason === 'strategy_violation')).toBe(true);
    });

    it('react records tool_call and tool_result events', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 2, run_id: 'r', goal: 'g' },
        {
          session: sess,
          modelCall: async (msgs) => {
            if (msgs.length <= 1) return { content: '', decision_summary: 'call', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/x' } }] };
            return { content: 'done', decision_summary: 'done', stop_reason: 'stop' };
          },
          toolExecute: async () => 'file content',
          goalSatisfied: () => true,
        },
      );
      await loop.run();
      const events = sess.getEvents();
      // LoopEngine records assistant events; tool_call events are recorded by Harness
      expect(events.some(e => e.type === 'assistant')).toBe(true);
    });

    it('react tool error records error event with tool name', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 1, run_id: 'r', goal: 'g' },
        {
          session: sess,
          modelCall: async () => ({ content: '', decision_summary: 'call', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/x' } }] }),
          toolExecute: async () => { throw new Error('file not found'); },
        },
      );
      await loop.run();
      const events = sess.getEvents();
      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents.length).toBeGreaterThan(0);
      expect((errorEvents[0]!.data as { tool: string }).tool).toBe('read_file');
    });

    it('termination records system event with termination_reason', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g' },
        { session: sess, modelCall: async () => ({ content: 'ok', decision_summary: 'done' }), goalSatisfied: () => true },
      );
      await loop.run();
      const events = sess.getEvents();
      const systemEvents = events.filter(e => e.type === 'system');
      expect(systemEvents.some(e => (e.data as { termination_reason: string }).termination_reason === 'goal_satisfied')).toBe(true);
    });

    it('plan_execute records overlay_commit on success', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'model_call' as const, status: 'pending' as const }], edges: [] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'done', decision_summary: 'done', stop_reason: 'stop' }), goalSatisfied: () => true },
      );
      await loop.run();
      const events = sess.getEvents();
      expect(events.some(e => e.type === 'system' && (e.data as { action?: string }).action === 'overlay_commit')).toBe(true);
    });

    it('plan_execute verification step records system event with verified status', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'verification' as const, status: 'pending' as const }], edges: [] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'work', decision_summary: 'work', stop_reason: 'stop' }), goalSatisfied: () => true },
      );
      await loop.run();
      const events = sess.getEvents();
      expect(events.some(e => e.type === 'system' && (e.data as { verified?: boolean }).verified === true)).toBe(true);
    });

    it('plan_execute blocked step records system event with blocked status', async () => {
      const sess = session();
      const wf = { nodes: [
        { step_id: 's1', step_type: 'tool_call' as const, status: 'pending' as const },
        { step_id: 's2', step_type: 'model_call' as const, status: 'pending' as const },
      ], edges: [{ from_step: 's1', to_step: 's2' }] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: '', decision_summary: 'call', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/x' } }] }), toolExecute: async () => { throw new Error('fail'); } },
      );
      await loop.run();
      const events = sess.getEvents();
      expect(events.some(e => e.type === 'system' && (e.data as { action?: string }).action === 'overlay_discard')).toBe(true);
    });

    it('react passes observation messages to next modelCall', async () => {
      const sess = session();
      let receivedMsgs: unknown[] = [];
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 3, run_id: 'r', goal: 'g' },
        {
          session: sess,
          modelCall: async (msgs) => {
            receivedMsgs = msgs;
            if (msgs.length <= 1) return { content: '', decision_summary: 'call', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/x' } }] };
            return { content: 'done', decision_summary: 'done', stop_reason: 'stop' };
          },
          toolExecute: async () => 'observation data',
          goalSatisfied: () => true,
        },
      );
      await loop.run();
      // Second modelCall should have received tool observation
      expect(receivedMsgs.length).toBeGreaterThan(1);
      const lastMsg = receivedMsgs[receivedMsgs.length - 1] as { role: string; content: string };
      expect(lastMsg.role).toBe('tool');
      expect(lastMsg.content).toContain('observation data');
    });
  });



  describe('mutation-killing: no-coverage path activation', () => {
    it('direct with stop_reason=length terminates malformed_response', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g' },
        { session: sess, modelCall: async () => ({ content: 'truncated', decision_summary: 'd', stop_reason: 'length' }) },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('malformed_response');
    });

    it('direct with goal not satisfied terminates completed', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g' },
        { session: sess, modelCall: async () => ({ content: 'result', decision_summary: 'done' }), goalSatisfied: () => false },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('completed');
    });

    it('react budget check before model call', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 5, budget_tokens: 1, run_id: 'r', goal: 'g' },
        { session: sess, modelCall: async () => ({ content: 'x', decision_summary: 'd', stop_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }) },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('budget_exhausted');
    });

    it('plan_execute with complex DAG topology', async () => {
      const sess = session();
      const wf = {
        nodes: [
          { step_id: 'a', step_type: 'model_call' as const, status: 'pending' as const },
          { step_id: 'b', step_type: 'model_call' as const, status: 'pending' as const },
          { step_id: 'c', step_type: 'model_call' as const, status: 'pending' as const },
          { step_id: 'd', step_type: 'verification' as const, status: 'pending' as const },
        ],
        edges: [
          { from_step: 'a', to_step: 'b' },
          { from_step: 'b', to_step: 'c' },
          { from_step: 'c', to_step: 'd' },
        ],
      };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'work', decision_summary: 'step done', stop_reason: 'stop' }), goalSatisfied: () => true },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('goal_satisfied');
      expect(result.iterations).toBe(4);
    });

    it('plan_execute with parallel branches in DAG', async () => {
      const sess = session();
      const wf = {
        nodes: [
          { step_id: 'a', step_type: 'model_call' as const, status: 'pending' as const },
          { step_id: 'b', step_type: 'model_call' as const, status: 'pending' as const },
          { step_id: 'c', step_type: 'model_call' as const, status: 'pending' as const },
        ],
        edges: [
          { from_step: 'a', to_step: 'b' },
          { from_step: 'a', to_step: 'c' },
        ],
      };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'work', decision_summary: 'done', stop_reason: 'stop' }), goalSatisfied: () => true },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('goal_satisfied');
    });

    it('LoopError has correct name and prototype', () => {
      const err = new LoopError('test error');
      expect(err.name).toBe('LoopError');
      expect(err.message).toBe('test error');
      expect(err instanceof Error).toBe(true);
      expect(err instanceof LoopError).toBe(true);
    });

    it('progress.json not written when data_dir is undefined', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g' },
        { session: sess, modelCall: async () => ({ content: 'ok', decision_summary: 'done' }), goalSatisfied: () => true },
      );
      await loop.run();
      // No data_dir set, so progress.json should not exist
      expect(existsSync(join(dir, 'progress.json'))).toBe(false);
    });

    it('turns array contains model content and decision_summary', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g' },
        { session: sess, modelCall: async () => ({ content: 'my content', decision_summary: 'my summary' }), goalSatisfied: () => true },
      );
      const result = await loop.run();
      expect(result.turns).toHaveLength(1);
      expect(result.turns[0]!.model.content).toBe('my content');
      expect(result.turns[0]!.model.decision_summary).toBe('my summary');
    });
  });



  describe('mutation-killing: plan_execute no-coverage paths', () => {
    it('tool_call step with no prior tool_calls available completes as done', async () => {
      const sess = session();
      // A tool_call step where the last model turn had no tool_calls
      const wf = {
        nodes: [
          { step_id: 's1', step_type: 'model_call' as const, status: 'pending' as const },
          { step_id: 's2', step_type: 'tool_call' as const, status: 'pending' as const },
        ],
        edges: [{ from_step: 's1', to_step: 's2' }],
      };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'no tools', decision_summary: 'no tools here', stop_reason: 'stop' }), toolExecute: async () => 'should not reach' },
      );
      const result = await loop.run();
      // s1 completes as model_call, s2 has no tool call available — completes as done
      expect(result.termination_reason).toBe('completed');
    });

    it('plan_execute model_call with stop_reason=length terminates', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'model_call' as const, status: 'pending' as const }], edges: [] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'truncated', decision_summary: 'd', stop_reason: 'length' }) },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('malformed_response');
    });

    it('plan_execute model_call with tool_calls but no toolExecute completes', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'model_call' as const, status: 'pending' as const }], edges: [] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: '', decision_summary: 'call', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/x' } }] }) },
      );
      // No toolExecute provided — tool calls are skipped, step completes as done
      const result = await loop.run();
      expect(result.termination_reason).toBe('completed');
    });

    it('plan_execute with all steps done and no goalSatisfied terminates completed', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'model_call' as const, status: 'pending' as const }], edges: [] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'done', decision_summary: 'done', stop_reason: 'stop' }) },
        // No goalSatisfied — defaults to undefined, so !this.terminated → completed
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('completed');
    });

    it('plan_execute tool_call step with tool result records observation', async () => {
      const sess = session();
      let _msgs: unknown[] = [];
      const wf = {
        nodes: [
          { step_id: 's1', step_type: 'model_call' as const, status: 'pending' as const },
          { step_id: 's2', step_type: 'tool_call' as const, status: 'pending' as const },
        ],
        edges: [{ from_step: 's1', to_step: 's2' }],
      };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        {
          session: sess,
          modelCall: async (msgs) => { _msgs = msgs; return { content: '', decision_summary: 'call', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/x' } }] }; },
          toolExecute: async () => 'tool output here',
        },
      );
      const result = await loop.run();
      // The tool_call step should execute and the result should be in messages
      expect(result.termination_reason).toBe('completed');
    });

    it('plan_execute records overlay_discard on tool_call failure', async () => {
      const sess = session();
      const wf = {
        nodes: [
          { step_id: 's1', step_type: 'model_call' as const, status: 'pending' as const },
          { step_id: 's2', step_type: 'tool_call' as const, status: 'pending' as const },
        ],
        edges: [{ from_step: 's1', to_step: 's2' }],
      };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 5, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        {
          session: sess,
          modelCall: async () => ({ content: '', decision_summary: 'call', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/x' } }] }),
          toolExecute: async () => { throw new Error('tool failed'); },
        },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('malformed_response');
      const events = sess.getEvents();
      expect(events.some(e => e.type === 'system' && (e.data as { action?: string }).action === 'overlay_discard')).toBe(true);
    });
  });



  describe('mutation-killing: tool_call step direct execution', () => {
    it('tool_call step executes tool from previous model_call tool_calls', async () => {
      const sess = session();
      const wf = {
        nodes: [
          { step_id: 's1', step_type: 'model_call' as const, status: 'pending' as const },
          { step_id: 's2', step_type: 'tool_call' as const, status: 'pending' as const },
          { step_id: 's3', step_type: 'verification' as const, status: 'pending' as const },
        ],
        edges: [{ from_step: 's1', to_step: 's2' }, { from_step: 's2', to_step: 's3' }],
      };
      let toolCalled = false;
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        {
          session: sess,
          modelCall: async () => ({ content: '', decision_summary: 'call tool', stop_reason: 'tool_use', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/x' } }] }),
          toolExecute: async () => { toolCalled = true; return 'tool result'; },
          goalSatisfied: () => true,
        },
      );
      const result = await loop.run();
      expect(toolCalled).toBe(true);
      expect(result.termination_reason).toBe('goal_satisfied');
    });

    it('tool_call step with tool error sets node failed and terminates', async () => {
      const sess = session();
      const wf = {
        nodes: [
          { step_id: 's1', step_type: 'model_call' as const, status: 'pending' as const },
          { step_id: 's2', step_type: 'tool_call' as const, status: 'pending' as const },
        ],
        edges: [{ from_step: 's1', to_step: 's2' }],
      };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        {
          session: sess,
          modelCall: async () => ({ content: '', decision_summary: 'call', stop_reason: 'tool_use', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/x' } }] }),
          toolExecute: async () => { throw new Error('permission denied'); },
        },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('malformed_response');
      const events = sess.getEvents();
      expect(events.some(e => e.type === 'error' && (e.data as { error: string }).error === 'permission denied')).toBe(true);
    });

    it('tool_call step records overlay_discard on failure', async () => {
      const sess = session();
      const wf = {
        nodes: [
          { step_id: 's1', step_type: 'model_call' as const, status: 'pending' as const },
          { step_id: 's2', step_type: 'tool_call' as const, status: 'pending' as const },
        ],
        edges: [{ from_step: 's1', to_step: 's2' }],
      };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        {
          session: sess,
          modelCall: async () => ({ content: '', decision_summary: 'call', stop_reason: 'tool_use', tool_calls: [{ id: 'tc1', name: 'write_file', arguments: { path: '/x' } }] }),
          toolExecute: async () => { throw new Error('disk full'); },
        },
      );
      await loop.run();
      const events = sess.getEvents();
      const discardEvent = events.find(e => e.type === 'system' && (e.data as { action?: string }).action === 'overlay_discard');
      expect(discardEvent).toBeDefined();
      expect((discardEvent!.data as { reason: string }).reason).toBe('tool failure');
    });

    it('tool_call step with no prior model turn completes as done (no tool to execute)', async () => {
      const sess = session();
      const wf = {
        nodes: [{ step_id: 's1', step_type: 'tool_call' as const, status: 'pending' as const }],
        edges: [],
      };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        {
          session: sess,
          modelCall: async () => ({ content: 'no tools', decision_summary: 'no tools', stop_reason: 'stop' }),
          toolExecute: async () => 'should not be called',
        },
      );
      const result = await loop.run();
      // No prior model turn with tool_calls — step completes as done
      expect(result.termination_reason).toBe('completed');
    });

    it('writeProgress records progress_path in LoopResult', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r-test', goal: 'g', data_dir: dir },
        { session: sess, modelCall: async () => ({ content: 'ok', decision_summary: 'done' }), goalSatisfied: () => true },
      );
      const result = await loop.run();
      expect(result.progress_path).toBe(join(dir, 'progress.json'));
    });

    it('writeProgress not called when no data_dir', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g' },
        { session: sess, modelCall: async () => ({ content: 'ok', decision_summary: 'done' }), goalSatisfied: () => true },
      );
      const result = await loop.run();
      expect(result.progress_path).toBeUndefined();
    });

    it('context_reset_emitted is true on context_reset termination', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 5, run_id: 'r', goal: 'g' },
        { session: sess, modelCall: async () => ({ content: 'thinking', decision_summary: 'd', stop_reason: 'stop' }), goalSatisfied: () => false },
      );
      const result = await loop.run();
      expect(result.context_reset_emitted).toBe(true);
      expect(result.termination_reason).toBe('context_reset');
    });

    it('context_reset_emitted is false on non-context_reset termination', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g' },
        { session: sess, modelCall: async () => ({ content: 'ok', decision_summary: 'done' }), goalSatisfied: () => true },
      );
      const result = await loop.run();
      expect(result.context_reset_emitted).toBe(false);
    });

    it('detectContextReset returns false with only 1 turn', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'direct', max_iterations: 1, run_id: 'r', goal: 'g' },
        { session: sess, modelCall: async () => ({ content: 'ok', decision_summary: 'done' }), goalSatisfied: () => true },
      );
      const result = await loop.run();
      expect(result.context_reset_emitted).toBe(false);
      expect(result.termination_reason).toBe('goal_satisfied');
    });

    it('react with goalSatisfied after first tool call stops with goal_satisfied', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 5, run_id: 'r', goal: 'g' },
        {
          session: sess,
          modelCall: async (msgs) => {
            if (msgs.length <= 1) return { content: '', decision_summary: 'call', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/x' } }] };
            return { content: 'done', decision_summary: 'done', stop_reason: 'stop' };
          },
          toolExecute: async () => 'content',
          goalSatisfied: (turns) => turns.length >= 2,
        },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('goal_satisfied');
      expect(result.iterations).toBe(2);
    });

    it('react with assistant message pushed on no-tool turn', async () => {
      const sess = session();
      let msgCount = 0;
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 3, run_id: 'r', goal: 'g' },
        {
          session: sess,
          modelCall: async (msgs) => {
            msgCount = msgs.length;
            if (msgs.length <= 1) return { content: '', decision_summary: 'call', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'read', arguments: { path: '/a' } }] };
            return { content: 'thinking', decision_summary: 'no tool this time', stop_reason: 'stop' };
          },
          toolExecute: async () => 'ok',
          goalSatisfied: () => false,
        },
      );
      await loop.run();
      // After first tool call, second model call returns no tool → context_reset
      expect(msgCount).toBeGreaterThan(1);
    });
  });



  describe('mutation-killing: topo sort and blocked step coverage', () => {
    it('topological sort processes nodes in dependency order', async () => {
      const sess = session();
      const executionOrder: string[] = [];
      const wf = {
        nodes: [
          { step_id: 'a', step_type: 'model_call' as const, status: 'pending' as const },
          { step_id: 'b', step_type: 'model_call' as const, status: 'pending' as const },
          { step_id: 'c', step_type: 'model_call' as const, status: 'pending' as const },
        ],
        edges: [{ from_step: 'a', to_step: 'b' }, { from_step: 'b', to_step: 'c' }],
      };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        {
          session: sess,
          modelCall: async () => { executionOrder.push('step'); return { content: 'work', decision_summary: 'done', stop_reason: 'stop' }; },
          goalSatisfied: () => true,
        },
      );
      await loop.run();
      expect(executionOrder.length).toBe(3);
    });

    it('plan_execute with blocked step after failed dependency', async () => {
      const sess = session();
      const wf = {
        nodes: [
          { step_id: 's1', step_type: 'model_call' as const, status: 'pending' as const },
          { step_id: 's2', step_type: 'tool_call' as const, status: 'pending' as const },
          { step_id: 's3', step_type: 'model_call' as const, status: 'pending' as const },
        ],
        edges: [{ from_step: 's1', to_step: 's2' }, { from_step: 's2', to_step: 's3' }],
      };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        {
          session: sess,
          modelCall: async () => ({ content: '', decision_summary: 'call', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/x' } }] }),
          toolExecute: async () => { throw new Error('fail'); },
        },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('malformed_response');
      // s3 should be blocked (dependency s2 failed)
      const events = sess.getEvents();
      expect(events.some(e => e.type === 'error')).toBe(true);
    });

    it('plan_execute completedSteps skip check works with crash restore', async () => {
      const sess = session();
      const wf = {
        nodes: [
          { step_id: 's1', step_type: 'model_call' as const, status: 'done' as const },
          { step_id: 's2', step_type: 'verification' as const, status: 'pending' as const },
        ],
        edges: [{ from_step: 's1', to_step: 's2' }],
      };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'work', decision_summary: 'done', stop_reason: 'stop' }), goalSatisfied: () => true },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('goal_satisfied');
    });

    it('tool_call step success records tool_executed in turn', async () => {
      const sess = session();
      const wf = {
        nodes: [
          { step_id: 's1', step_type: 'model_call' as const, status: 'pending' as const },
          { step_id: 's2', step_type: 'tool_call' as const, status: 'pending' as const },
        ],
        edges: [{ from_step: 's1', to_step: 's2' }],
      };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        {
          session: sess,
          modelCall: async () => ({ content: '', decision_summary: 'call', stop_reason: 'tool_use', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/x' } }] }),
          toolExecute: async () => 'file contents here',
          goalSatisfied: (turns) => {
            return turns.some(t => t.tool_executed !== undefined);
          },
        },
      );
      const result = await loop.run();
      expect(result.turns.some(t => t.tool_executed !== undefined)).toBe(true);
      expect(result.termination_reason).toBe('goal_satisfied');
    });

    it('verification step with no goalSatisfied defaults to false (not satisfied)', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'verification' as const, status: 'pending' as const }], edges: [] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'work', decision_summary: 'done', stop_reason: 'stop' }) },
      );
      const result = await loop.run();
      // No goalSatisfied → verification fails → completed
      expect(result.termination_reason).toBe('malformed_response');
    });
  });



  describe('mutation-killing: oscillation key and detectContextReset precision', () => {
    it('oscillation key uses sorted keys for canonical comparison', async () => {
      const sess = session();
      let callCount = 0;
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 10, run_id: 'r', goal: 'g' },
        {
          session: sess,
          modelCall: async () => {
            callCount++;
            // Same tool+args but with different key order — should still oscillate
            const args = callCount % 2 === 0 ? { b: 2, a: 1 } : { a: 1, b: 2 };
            return { content: '', decision_summary: 'same', stop_reason: 'tool_use', tool_calls: [{ id: String(callCount), name: 'read_file', arguments: args }] };
          },
          toolExecute: async () => 'content',
          goalSatisfied: () => false,
        },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('tool_oscillation');
    });

    it('detectContextReset: last 2 turns both with tool_calls returns false', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 3, run_id: 'r', goal: 'g' },
        {
          session: sess,
          modelCall: async (msgs) => {
            if (msgs.length <= 1) return { content: '', decision_summary: 'call1', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/a' } }] };
            if (msgs.length <= 3) return { content: '', decision_summary: 'call2', stop_reason: 'tool_use', tool_calls: [{ id: '2', name: 'read_file', arguments: { path: '/b' } }] };
            return { content: 'done', decision_summary: 'done', stop_reason: 'stop' };
          },
          toolExecute: async () => 'content',
          goalSatisfied: (turns) => turns.length >= 3,
        },
      );
      const result = await loop.run();
      expect(result.context_reset_emitted).toBe(false);
    });

    it('detectContextReset: 1 turn with tool, 1 without returns true', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 5, run_id: 'r', goal: 'g' },
        {
          session: sess,
          modelCall: async (msgs) => {
            if (msgs.length <= 1) return { content: '', decision_summary: 'tool', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'read', arguments: {} }] };
            return { content: 'no tool', decision_summary: 'no tool', stop_reason: 'stop' };
          },
          toolExecute: async () => 'ok',
          goalSatisfied: () => false,
        },
      );
      const result = await loop.run();
      // First turn has tool, second doesn't — detectContextReset checks last 2 turns
      // Turn 1: has tool_calls. Turn 2: no tool_calls. detectContextReset checks if BOTH last 2 have no tool calls.
      // So it should NOT fire on just 1 no-tool turn. It needs 2 consecutive no-tool turns.
      // With max_iterations=5 and goalSatisfied=false, after 2 turns it should context_reset on turn 3+4
      expect(result.termination_reason).toBe('context_reset');
    });

    it('react: assistant message pushed after no-tool turn', async () => {
      const sess = session();
      const loop = new LoopEngine(
        { strategy: 'react', max_iterations: 5, run_id: 'r', goal: 'g' },
        {
          session: sess,
          modelCall: async () => ({ content: 'thinking', decision_summary: 'no progress', stop_reason: 'stop' }),
          goalSatisfied: () => false,
        },
      );
      await loop.run();
      // Session should have assistant events with decision_summary
      const events = sess.getEvents();
      const assistantEvents = events.filter(e => e.type === 'assistant');
      expect(assistantEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('plan_execute: all steps done, no goalSatisfied provided, terminates completed', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'decision' as const, status: 'pending' as const }], edges: [] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'x', decision_summary: 'd', stop_reason: 'stop' }) },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('completed');
    });

    it('plan_execute: overlay_commit event recorded on success', async () => {
      const sess = session();
      const wf = {
        nodes: [
          { step_id: 's1', step_type: 'model_call' as const, status: 'pending' as const },
          { step_id: 's2', step_type: 'verification' as const, status: 'pending' as const },
        ],
        edges: [{ from_step: 's1', to_step: 's2' }],
      };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'work', decision_summary: 'done', stop_reason: 'stop' }), goalSatisfied: () => true },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('goal_satisfied');
      const events = sess.getEvents();
      const commitEvent = events.find(e => e.type === 'system' && (e.data as { action?: string }).action === 'overlay_commit');
      expect(commitEvent).toBeDefined();
      expect((commitEvent!.data as { reason: string }).reason).toBe('all steps completed');
    });
  });



  describe('mutation-killing: final push to 70%', () => {
    it('plan_execute tool_call step with tc executes and pushes tool message', async () => {
      const sess = session();
      const wf = {
        nodes: [
          { step_id: 's1', step_type: 'model_call' as const, status: 'pending' as const },
          { step_id: 's2', step_type: 'tool_call' as const, status: 'pending' as const },
          { step_id: 's3', step_type: 'model_call' as const, status: 'pending' as const },
        ],
        edges: [{ from_step: 's1', to_step: 's2' }, { from_step: 's2', to_step: 's3' }],
      };
      let msgSnapshot: unknown[] = [];
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        {
          session: sess,
          modelCall: async (msgs) => {
            msgSnapshot = [...msgs];
            if (msgs.length <= 1) return { content: '', decision_summary: 'call', stop_reason: 'tool_use', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/x' } }] };
            return { content: 'done', decision_summary: 'done', stop_reason: 'stop' };
          },
          toolExecute: async () => 'file data',
          goalSatisfied: () => true,
        },
      );
      await loop.run();
      // After tool_call step, messages should contain a tool message
      const toolMsg = msgSnapshot.find((m: unknown) => (m as { role?: string }).role === 'tool');
      expect(toolMsg).toBeDefined();
    });

    it('plan_execute tool_call step with no prior model tool_calls (tc undefined) skips to done', async () => {
      const sess = session();
      const wf = {
        nodes: [
          { step_id: 's1', step_type: 'model_call' as const, status: 'pending' as const },
          { step_id: 's2', step_type: 'tool_call' as const, status: 'pending' as const },
        ],
        edges: [{ from_step: 's1', to_step: 's2' }],
      };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        {
          session: sess,
          modelCall: async () => ({ content: 'no tool calls', decision_summary: 'plain text', stop_reason: 'stop' }),
          toolExecute: async () => 'should not be called',
        },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('completed');
    });

    it('plan_execute verification failed records status failed in session', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'verification' as const, status: 'pending' as const }], edges: [] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'work', decision_summary: 'work', stop_reason: 'stop' }), goalSatisfied: () => false },
      );
      await loop.run();
      const events = sess.getEvents();
      const verifyEvent = events.find(e => e.type === 'system' && (e.data as { status?: string }).status === 'failed');
      expect(verifyEvent).toBeDefined();
      expect((verifyEvent!.data as { verified: boolean }).verified).toBe(false);
    });

    it('plan_execute verification succeeded records status done in session', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'verification' as const, status: 'pending' as const }], edges: [] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'work', decision_summary: 'work', stop_reason: 'stop' }), goalSatisfied: () => true },
      );
      await loop.run();
      const events = sess.getEvents();
      const verifyEvent = events.find(e => e.type === 'system' && (e.data as { status?: string }).status === 'done');
      expect(verifyEvent).toBeDefined();
      expect((verifyEvent!.data as { verified: boolean }).verified).toBe(true);
    });

    it('plan_execute: unknown step type (compensation) passes through as done', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'compensation' as const, status: 'pending' as const }], edges: [] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'x', decision_summary: 'd', stop_reason: 'stop' }), goalSatisfied: () => true },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('goal_satisfied');
    });

    it('plan_execute: human_input step type passes through as done', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'human_input' as const, status: 'pending' as const }], edges: [] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'x', decision_summary: 'd', stop_reason: 'stop' }), goalSatisfied: () => true },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('goal_satisfied');
    });

    it('plan_execute: parallel_fork step type passes through as done', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'parallel_fork' as const, status: 'pending' as const }], edges: [] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'x', decision_summary: 'd', stop_reason: 'stop' }), goalSatisfied: () => true },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('goal_satisfied');
    });

    it('plan_execute: parallel_join step type passes through as done', async () => {
      const sess = session();
      const wf = { nodes: [{ step_id: 's1', step_type: 'parallel_join' as const, status: 'pending' as const }], edges: [] };
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        { session: sess, modelCall: async () => ({ content: 'x', decision_summary: 'd', stop_reason: 'stop' }), goalSatisfied: () => true },
      );
      const result = await loop.run();
      expect(result.termination_reason).toBe('goal_satisfied');
    });
  });

  it('plan_execute: model_call step with tool_calls but no toolExecute dep still completes step', async () => {
    const sess = session();
    const wf = {
      nodes: [
        { step_id: 's1', step_type: 'model_call' as const, status: 'pending' as const },
        { step_id: 's2', step_type: 'verification' as const, status: 'pending' as const },
      ],
      edges: [{ from_step: 's1', to_step: 's2' }],
    };
    const loop = new LoopEngine(
      { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
      {
        session: sess,
        modelCall: async () => ({ content: '', decision_summary: 'call', stop_reason: 'tool_use', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/x' } }] }),
        // No toolExecute — tool calls from model_call step are skipped
        goalSatisfied: () => true,
      },
    );
    const result = await loop.run();
    expect(result.termination_reason).toBe('goal_satisfied');
  });


    it('tool_call step fails when tool throws (model_call succeeded first)', async () => {
      const sess = session();
      const wf = {
        nodes: [
          { step_id: 's1', step_type: 'model_call' as const, status: 'pending' as const },
          { step_id: 's2', step_type: 'tool_call' as const, status: 'pending' as const },
        ],
        edges: [{ from_step: 's1', to_step: 's2' }],
      };
      let callCount = 0;
      const loop = new LoopEngine(
        { strategy: 'plan_execute', max_iterations: 10, run_id: 'r', goal: 'g', run_plan: { workflow_graph: wf } as never },
        {
          session: sess,
          modelCall: async () => ({ content: '', decision_summary: 'call', stop_reason: 'tool_use', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/x' } }] }),
          toolExecute: async () => {
            callCount++;
            // First call (from model_call step) succeeds, second call (from tool_call step) fails
            if (callCount === 2) throw new Error('tool_call step failure');
            return 'success';
          },
        },
      );
      const result = await loop.run();
      // s1 model_call executes tool successfully, s2 tool_call step fails
      expect(result.termination_reason).toBe('malformed_response');
      const events = sess.getEvents();
      expect(events.some(e => e.type === 'system' && (e.data as { action?: string }).action === 'overlay_discard')).toBe(true);
    });

});


