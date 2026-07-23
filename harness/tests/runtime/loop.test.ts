import { describe, it, expect } from 'vitest';
import { RuntimeLoop } from '../../runtime/loop.js';
import type { ToolExecutor, ModelCaller } from '../../runtime/reasoning-strategy.js';
import type { ProviderRequest, ParsedResponse } from '../../gateway/provider.js';

function makeModelCaller(response: string): ModelCaller {
  return {
    complete(_req: ProviderRequest): ParsedResponse {
      return { content: response, stop_reason: 'stop', usage: { input_tokens: 10, output_tokens: 20 } };
    },
  };
}

describe('AH-RUNTIME-001: runtime loop', () => {
  it('executes a direct strategy request end-to-end', async () => {
    const loop = new RuntimeLoop();
    const result = await loop.execute(
      { prompt: 'What is 2+2?' },
      { modelCaller: makeModelCaller('4') },
    );
    expect(result.strategy).toBe('direct');
    expect(result.stop_reason).toBe('completed');
    expect(result.output).toBe('4');
    expect(result.model_calls).toBe(1);
    expect(result.tool_calls_made).toBe(0);
  });

  it('records events in durable session', async () => {
    const loop = new RuntimeLoop();
    await loop.execute(
      { prompt: 'What is 2+2?' },
      { modelCaller: makeModelCaller('4') },
    );
    const session = loop.getSession();
    expect(session.eventCount).toBeGreaterThan(0);
    const runCreated = session.getEventsByType('run_created');
    expect(runCreated.length).toBe(1);
    const runCompleted = session.getEventsByType('run_completed');
    expect(runCompleted.length).toBe(1);
  });

  it('generates notifications from events', async () => {
    const loop = new RuntimeLoop();
    await loop.execute(
      { prompt: 'What is 2+2?' },
      { modelCaller: makeModelCaller('4') },
    );
    const notifications = loop.getNotifications();
    expect(notifications.count).toBeGreaterThan(0);
  });

  it('handles tool execution in react strategy', async () => {
    const toolExecutor: ToolExecutor = {
      async execute(toolName: string) {
        return { tool_name: toolName, success: true, output: 'result' };
      },
    };
    const modelCaller: ModelCaller = {
      complete(_req: ProviderRequest): ParsedResponse {
        return {
          content: '',
          tool_calls: [{ id: 'tc1', name: 'read_file', arguments: {} }],
          stop_reason: 'tool_use',
        };
      },
    };
    // Second call returns no tools
    const modelCaller2: ModelCaller = {
      complete(_req: ProviderRequest): ParsedResponse {
        return { content: 'Done', stop_reason: 'stop' };
      },
    };
    let callCount = 0;
    const combinedCaller: ModelCaller = {
      complete(req: ProviderRequest): ParsedResponse {
        callCount++;
        return callCount === 1 ? modelCaller.complete(req) : modelCaller2.complete(req);
      },
    };

    const loop = new RuntimeLoop();
    const result = await loop.execute(
      { prompt: 'Read the content and maybe search', max_iterations: 5 },
      { modelCaller: combinedCaller, toolExecutor },
    );
    expect(result.tool_calls_made).toBe(1);
  });

  it('stop conditions: max iterations', async () => {
    const modelCaller: ModelCaller = {
      complete(_req: ProviderRequest): ParsedResponse {
        return {
          content: '',
          tool_calls: [{ id: 'tc1', name: 'read_file', arguments: {} }],
          stop_reason: 'tool_use',
        };
      },
    };
    const toolExecutor: ToolExecutor = {
      async execute(toolName: string) {
        return { tool_name: toolName, success: true, output: 'data' };
      },
    };
    const loop = new RuntimeLoop();
    const result = await loop.execute(
      { prompt: 'Read the content and maybe search', max_iterations: 2 },
      { modelCaller, toolExecutor },
    );
    expect(result.stop_reason).toBe('max_iterations');
  });
});
