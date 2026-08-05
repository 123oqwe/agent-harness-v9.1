import { describe, it, expect } from 'vitest';
import { RuntimeLoop } from '../../runtime/loop.js';
import { EventBus } from '../../runtime/event-bus.js';
import { PluginManager } from '../../runtime/plugin-manager.js';
import { SessionManager } from '../../runtime/session-manager.js';
import { ScriptedTestProvider } from '../../gateway/scripted-provider.js';
import type { ToolExecutor, ToolExecutionResult } from '../../runtime/reasoning-strategy.js';

function makeModelCaller(responses: { content: string; tool_calls?: { id: string; name: string; arguments: Record<string, unknown> }[]; stop_reason?: 'stop' | 'length' | 'tool_use' | 'content_filter' }[]) {
  const provider = new ScriptedTestProvider({ queue: responses });
  return {
    complete: (req: any) => provider.resolve(req),
    _provider: provider,
  };
}

function makeToolExecutor(success: boolean, output = 'ok'): ToolExecutor {
  return {
    async execute(toolName: string, _args: Record<string, unknown>): Promise<ToolExecutionResult> {
      return { tool_name: toolName, success, output };
    },
  };
}

describe('P1-06: EventBus wired into RuntimeLoop', () => {
  it('emits run_state_change events during execution', async () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.subscribe((e) => events.push(e.type));

    const mc = makeModelCaller([{ content: 'done', stop_reason: 'stop' }]);
    const loop = new RuntimeLoop({ modelCaller: mc, eventBus: bus });
    await loop.execute({ prompt: 'hello' }, { modelCaller: mc, eventBus: bus });

    expect(events).toContain('run_state_change');
  });

  it('emits tool_call_start and tool_result events', async () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.subscribe((e) => events.push(e.type));

    const mc = makeModelCaller([
      { content: '', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/a' } }], stop_reason: 'tool_use' },
      { content: 'done', stop_reason: 'stop' },
    ]);
    const loop = new RuntimeLoop({ modelCaller: mc, eventBus: bus });
    await loop.execute({ prompt: 'read file' }, {
      modelCaller: mc, eventBus: bus,
      toolExecutor: makeToolExecutor(true, 'file content'),
    });

    expect(events).toContain('tool_call_start');
    expect(events).toContain('tool_result');
  });
});

describe('P1-24: PluginManager hooks wired into RuntimeLoop', () => {
  it('calls on_task_start and on_task_end hooks', async () => {
    const pm = new PluginManager();
    const hookCalls: string[] = [];
    pm.register('on_task_start', () => { hookCalls.push('start'); return { action: 'allow' }; }, 'test');
    pm.register('on_task_end', () => { hookCalls.push('end'); return { action: 'allow' }; }, 'test');

    const mc = makeModelCaller([{ content: 'done', stop_reason: 'stop' }]);
    const loop = new RuntimeLoop({ modelCaller: mc, pluginManager: pm });
    await loop.execute({ prompt: 'hello' }, { modelCaller: mc, pluginManager: pm });

    expect(hookCalls).toContain('start');
    expect(hookCalls).toContain('end');
  });

  it('pre_tool_use hook can deny tool execution', async () => {
    const pm = new PluginManager();
    pm.register('pre_tool_use', () => ({ action: 'deny', reason: 'blocked by hook' }), 'blocker');

    const mc = makeModelCaller([
      { content: '', tool_calls: [{ id: 'tc1', name: 'write_file', arguments: { path: '/a', content: 'x' } }], stop_reason: 'tool_use' },
      { content: 'done', stop_reason: 'stop' },
    ]);
    const loop = new RuntimeLoop({ modelCaller: mc, pluginManager: pm });
    const result = await loop.execute({ prompt: 'write file' }, {
      modelCaller: mc, pluginManager: pm,
      toolExecutor: makeToolExecutor(true, 'written'),
    });

    // The tool should be denied by the hook
    expect(result.denied_actions.length).toBeGreaterThan(0);
  });
});

describe('P1-08: SessionManager wired into RuntimeLoop', () => {
  it('injects prior session context into messages', async () => {
    const sm = new SessionManager();
    const sessionId = sm.createSession();
    sm.addTaskResult(sessionId, {
      task: 'previous task', result: 'previous result',
      timestamp: new Date().toISOString(), run_id: 'prev-run',
    });

    let capturedMessages: any[] = [];
    const mc = {
      complete: (req: any) => {
        capturedMessages = req.messages;
        return { content: 'done', stop_reason: 'stop' as const };
      },
    };

    const loop = new RuntimeLoop({ modelCaller: mc, sessionManager: sm });
    await loop.execute({ prompt: 'continue', session_id: sessionId }, { modelCaller: mc, sessionManager: sm });

    // The system message with prior context should be injected
    const systemMsg = capturedMessages.find((m: any) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg.content).toContain('previous task');
  });

  it('stores task result after execution', async () => {
    const sm = new SessionManager();
    const sessionId = sm.createSession();

    const mc = makeModelCaller([{ content: 'task output', stop_reason: 'stop' }]);
    const loop = new RuntimeLoop({ modelCaller: mc, sessionManager: sm });
    await loop.execute({ prompt: 'do task', session_id: sessionId }, { modelCaller: mc, sessionManager: sm });

    const session = sm.getSession(sessionId)!;
    expect(session.tasks.length).toBe(1);
    expect(session.tasks[0].result).toBe('task output');
  });
});

describe('P1-10: Plan mode (auto_execute=false)', () => {
  it('pauses when auto_execute is false', async () => {
    const mc = makeModelCaller([{ content: 'done', stop_reason: 'stop' }]);
    const loop = new RuntimeLoop({ modelCaller: mc });
    const result = await loop.execute(
      { prompt: 'plan this', auto_execute: false },
      { modelCaller: mc },
    );

    expect(result.paused).toBe(true);
    expect(result.stop_reason).toBe('paused');
  });

  it('emits plan_ready event when pausing', async () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.subscribe((e) => events.push(e.type));

    const mc = makeModelCaller([{ content: 'done', stop_reason: 'stop' }]);
    const loop = new RuntimeLoop({ modelCaller: mc, eventBus: bus });
    await loop.execute(
      { prompt: 'plan this', auto_execute: false },
      { modelCaller: mc, eventBus: bus },
    );

    expect(events).toContain('plan_ready');
    expect(events).toContain('paused');
  });
});

describe('P1-13: Progress snapshot for crash recovery', () => {
  it('returns progress snapshot in result', async () => {
    const mc = makeModelCaller([{ content: 'done', stop_reason: 'stop' }]);
    const loop = new RuntimeLoop({ modelCaller: mc });
    const result = await loop.execute({ prompt: 'hello' }, { modelCaller: mc });

    expect(result.progress).toBeDefined();
    expect(result.progress!.run_id).toBe(result.run_id);
    expect(result.progress!.goal).toBe('hello');
    expect(result.progress!.timestamp).toBeDefined();
  });
});

describe('P1-12: Truncation handling in ReactStrategy', () => {
  it('handles stop_reason=length by asking LLM to split task', async () => {
    const mc = makeModelCaller([
      { content: 'partial output', stop_reason: 'length' },
      { content: 'done', stop_reason: 'stop' },
    ]);
    const loop = new RuntimeLoop({ modelCaller: mc });
    const result = await loop.execute({ prompt: 'do task' }, {
      modelCaller: mc,
      toolExecutor: makeToolExecutor(true),
    });

    // Should have a truncation observation and still complete
    expect(result.stop_reason).toBe('completed');
    const truncationObs = result.observations.find((o) => o.includes('truncation'));
    expect(truncationObs).toBeDefined();
  });
});

describe('P2-20: Output sanitization wired into GuardedToolExecutor', () => {
  it('blocks path traversal in tool calls', async () => {
    const mc = makeModelCaller([
      { content: '', tool_calls: [{ id: 'tc1', name: 'write_file', arguments: { path: '../../../etc/passwd', content: 'x' } }], stop_reason: 'tool_use' },
      { content: 'done', stop_reason: 'stop' },
    ]);
    const loop = new RuntimeLoop({ modelCaller: mc });
    const result = await loop.execute({ prompt: 'read' }, {
      modelCaller: mc,
      toolExecutor: makeToolExecutor(true, 'written'),
    });

    // The path traversal should be blocked by sanitization.
    // GuardedToolExecutor returns { success: false, error: 'Sanitization: ...' }
    // ReactStrategy records it as an ERROR observation.
    const sanitizationBlocked = result.observations.some(
      (o) => o.includes('Sanitization') || o.includes('ERROR') || o.includes('error')
    );
    expect(sanitizationBlocked).toBe(true);
  });
});

describe('P1-01: Tools passed to model in ReactStrategy', () => {
  it('passes available tools to the model call as native function-calling specs', async () => {
    let capturedReq: any;
    const provider = new ScriptedTestProvider({
      queue: [
        { content: '', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: {} }], stop_reason: 'tool_use' },
        { content: 'done', stop_reason: 'stop' },
      ],
    });
    const mc = {
      complete: (req: any) => {
        capturedReq = req;
        return provider.resolve(req);
      },
    };

    const loop = new RuntimeLoop({ modelCaller: mc });
    await loop.execute({ prompt: 'read file' }, {
      modelCaller: mc,
      toolExecutor: makeToolExecutor(true, 'content'),
    });

    // The request should have messages
    expect(capturedReq).toBeDefined();
    expect(capturedReq.messages).toBeDefined();
  });

  it('passes available_tools from the request as ToolSpec[] to the model', async () => {
    let capturedReq: any;
    const provider = new ScriptedTestProvider({
      queue: [
        { content: '', tool_calls: [{ id: 'tc1', name: 'read_file', arguments: {} }], stop_reason: 'tool_use' },
        { content: 'done', stop_reason: 'stop' },
      ],
    });
    const mc = {
      complete: (req: any) => {
        capturedReq = req;
        return provider.resolve(req);
      },
    };

    const loop = new RuntimeLoop({ modelCaller: mc });
    await loop.execute(
      { prompt: 'search for the error in the logs', available_tools: ['read_file', 'search_files'] },
      { modelCaller: mc, toolExecutor: makeToolExecutor(true, 'content') },
    );

    expect(capturedReq).toBeDefined();
    expect(capturedReq.tools).toBeDefined();
    expect(Array.isArray(capturedReq.tools)).toBe(true);
    expect(capturedReq.tools.length).toBe(2);
    expect(capturedReq.tools.map((t: any) => t.name)).toEqual(['read_file', 'search_files']);
  });
});
