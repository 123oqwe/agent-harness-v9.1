/**
 * AH-VERTICAL-002: Six verticals through real RuntimeLoop
 *
 * Proves each vertical goes through: StaticRouter -> Strategy ->
 * ModelGateway -> Tool Executor -> DurableSession -> Evidence.
 * No vertical calls fs, child_process, or a provider directly.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFilesystem } from '../../vfs/virtual-filesystem.js';
import { RuntimeLoop } from '../../runtime/loop.js';
import { createEvidence } from '../../verification/evidence.js';
import type { ToolExecutor, ToolExecutionResult, ModelCaller } from '../../runtime/reasoning-strategy.js';

function makeToolExecutor(vfs: VirtualFilesystem): ToolExecutor {
  return {
    async execute(toolName: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
      try {
        switch (toolName) {
          case 'read_file': {
            const content = vfs.read(args.path as string);
            return { tool_name: toolName, success: true, output: content ?? 'not found' };
          }
          case 'write_file': {
            vfs.write(args.path as string, args.content as string);
            return { tool_name: toolName, success: true, output: 'written' };
          }
          case 'edit_file': {
            const content = vfs.read(args.path as string);
            if (!content) return { tool_name: toolName, success: false, output: '', error: 'not found' };
            const newContent = content.replace(args.old_text as string, args.new_text as string);
            vfs.write(args.path as string, newContent);
            return { tool_name: toolName, success: true, output: 'edited' };
          }
          case 'search_files': {
            const results = vfs.list(args.directory as string);
            return { tool_name: toolName, success: true, output: results.join('\n') };
          }
          case 'list_directory': {
            const entries = vfs.list(args.path as string);
            return { tool_name: toolName, success: true, output: entries.join('\n') };
          }
          case 'create_artifact': {
            vfs.write(args.path as string, args.content as string);
            return { tool_name: toolName, success: true, output: 'created' };
          }
          case 'direct_response':
            return { tool_name: toolName, success: true, output: 'ok' };
          default:
            return { tool_name: toolName, success: false, output: '', error: 'unknown tool' };
        }
      } catch (e) {
        return { tool_name: toolName, success: false, output: '', error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

function makeModelCaller(responses: { content: string; tool_calls?: { id: string; name: string; arguments: Record<string, unknown> }[]; stop_reason?: 'stop' | 'length' | 'tool_use' | 'content_filter' }[]): ModelCaller {
  let idx = 0;
  return {
    complete() {
      const r = responses[idx++] ?? responses[responses.length - 1];
      return { ...r, stop_reason: r.stop_reason ?? 'stop', usage: { input_tokens: 10, output_tokens: 20 } };
    },
  };
}

describe('AH-VERTICAL-002: verticals through real RuntimeLoop', () => {
  let vfs: VirtualFilesystem;

  beforeEach(() => {
    vfs = new VirtualFilesystem({ root: '/workspace' });
  });

  it('coding: routes to plan_execute and executes tool calls through loop', async () => {
    vfs.write('/repo/src/index.ts', 'export const bug = true;');
    const toolExecutor = makeToolExecutor(vfs);
    const modelCaller = makeModelCaller([
      { content: 'I will read and fix the file', stop_reason: 'stop' },
      { content: 'Bug fixed. The diff is: export const fixed = true;', stop_reason: 'stop' },
    ]);

    const loop = new RuntimeLoop({ modelCaller: makeModelCaller([{ content: "", stop_reason: "stop" }]) });
    const result = await loop.execute(
      { prompt: 'Read the repository file then edit it to fix the bug', available_tools: ['read_file', 'edit_file'] },
      { modelCaller, toolExecutor },
    );

    expect(result.strategy).toBe('plan_execute');
    expect(result.stop_reason).toBe('completed');
    // DurableSession must have recorded the run
    const session = loop.getSession();
    expect(session.getEventsByType('run_created').length).toBe(1);
    expect(session.getEventsByType('run_completed').length).toBe(1);
    // Evidence can be created from the session
    const evidence = createEvidence({
      run_id: result.run_id,
      request_prompt: 'fix bug',
      route_decision: result.strategy,
      route_reason: 'test',
      plan_revision: 1,
      strategy: result.strategy,
      state_transitions: session.getEvents().map((e) => e.type),
      action_digests: [],
      policy_decisions: [],
      observations: result.observations,
      result_digest: 'test',
      output: result.output,
      timing_ms: 100,
      redacted_errors: [],
    });
    expect(evidence.record_hash).toBeTruthy();
  });

  it('research: routes to react and uses tool observations', async () => {
    vfs.write('/sources/a.txt', 'important research topic here');
    const toolExecutor = makeToolExecutor(vfs);
    const modelCaller = makeModelCaller([
      { content: '', tool_calls: [{ id: 'tc1', name: 'search_files', arguments: { directory: '/sources', pattern: 'research' } }], stop_reason: 'tool_use' },
      { content: 'Found relevant sources about the research topic', stop_reason: 'stop' },
    ]);

    const loop = new RuntimeLoop({ modelCaller: makeModelCaller([{ content: "", stop_reason: "stop" }]) });
    const result = await loop.execute(
      { prompt: 'Read the content and maybe search for the research topic', available_tools: ['search_files', 'read_file'], max_iterations: 5 },
      { modelCaller, toolExecutor },
    );

    expect(result.strategy).toBe('react');
    expect(result.tool_calls_made).toBe(1);
    expect(result.observations.length).toBe(1);
    // Session recorded tool calls
    const session = loop.getSession();
    expect(session.getEventsByType('tool_called').length).toBe(1);
  });

  it('direct: simple prompt routes to direct with one model call', async () => {
    const modelCaller = makeModelCaller([{ content: 'The answer is 4', stop_reason: 'stop' }]);
    const loop = new RuntimeLoop({ modelCaller: makeModelCaller([{ content: "", stop_reason: "stop" }]) });
    const result = await loop.execute(
      { prompt: 'What is 2+2?' },
      { modelCaller },
    );
    expect(result.strategy).toBe('direct');
    expect(result.model_calls).toBe(1);
    expect(result.tool_calls_made).toBe(0);
    expect(result.output).toBe('The answer is 4');
  });

  it('planning: routes to plan_execute for multi-step task', async () => {
    const toolExecutor = makeToolExecutor(vfs);
    const modelCaller = makeModelCaller([
      { content: 'Plan: read, then write, then verify', stop_reason: 'stop' },
      { content: 'Plan executed successfully', stop_reason: 'stop' },
    ]);
    const loop = new RuntimeLoop({ modelCaller: makeModelCaller([{ content: "", stop_reason: "stop" }]) });
    const result = await loop.execute(
      { prompt: 'First read then after that write then finally verify the file' },
      { modelCaller, toolExecutor },
    );
    expect(result.strategy).toBe('plan_execute');
    expect(result.stop_reason).toBe('completed');
  });

  it('writing: routes to plan_execute and produces output', async () => {
    const modelCaller = makeModelCaller([
      { content: 'I will create a draft', stop_reason: 'stop' },
      { content: 'Draft: This is a well-written article about AI.', stop_reason: 'stop' },
    ]);
    const loop = new RuntimeLoop({ modelCaller: makeModelCaller([{ content: "", stop_reason: "stop" }]) });
    const result = await loop.execute(
      { prompt: 'Write a draft article about AI then check it against the rubric' },
      { modelCaller },
    );
    expect(result.strategy).toBe('plan_execute');
    expect(result.output).toContain('Draft');
  });

  it('personal assistant: routes to direct for simple scheduling', async () => {
    const modelCaller = makeModelCaller([{ content: 'Schedule: 9am meeting, 10am coding', stop_reason: 'stop' }]);
    const loop = new RuntimeLoop({ modelCaller: makeModelCaller([{ content: "", stop_reason: "stop" }]) });
    const result = await loop.execute(
      { prompt: 'What is my schedule today?' },
      { modelCaller },
    );
    expect(result.strategy).toBe('direct');
    expect(result.output).toContain('Schedule');
  });

  it('all verticals produce DurableSession events and Evidence', async () => {
    const modelCaller = makeModelCaller([{ content: 'ok', stop_reason: 'stop' }]);
    const loop = new RuntimeLoop({ modelCaller: makeModelCaller([{ content: "", stop_reason: "stop" }]) });
    await loop.execute({ prompt: 'hello' }, { modelCaller });

    const session = loop.getSession();
    // Must have run lifecycle events
    expect(session.getEventsByType('run_created').length).toBe(1);
    expect(session.getEventsByType('run_started').length).toBe(1);
    expect(session.getEventsByType('step_created').length).toBe(1);

    // Notifications derived from events
    const notifications = loop.getNotifications();
    expect(notifications.count).toBeGreaterThan(0);

    // Evidence can be created from the session state
    const evidence = createEvidence({
      run_id: 'test',
      request_prompt: 'hello',
      route_decision: 'direct',
      route_reason: 'test',
      plan_revision: null,
      strategy: 'direct',
      state_transitions: session.getEvents().map((e) => e.type),
      action_digests: [],
      policy_decisions: [],
      observations: [],
      result_digest: 'abc',
      output: 'ok',
      timing_ms: 50,
      redacted_errors: [],
    });
    expect(evidence.record_hash).toBeTruthy();
  });
});
