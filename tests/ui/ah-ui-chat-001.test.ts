import { describe, expect, it, vi } from 'vitest';
import type { TaskContract } from '../../contracts/index.js';
import type { HarnessOutcome } from '../../harness.js';
import { ChatController } from '../../ui/ah_ui_chat_001.js';

function outcome(
  success: boolean,
  content = 'verified reply',
): HarnessOutcome {
  return {
    success,
    loop_result: {
      termination_reason: success ? 'goal_satisfied' : 'verification_failed',
      turns: [
        {
          iteration: 1,
          model: { content, decision_summary: 'reply' },
          tool_observations: [],
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  } as unknown as HarnessOutcome;
}

describe('AH-UI-CHAT-001 Harness-backed chat', () => {
  it('executes the user message through Harness without responder callbacks', async () => {
    const run = vi.fn(
      async (_task: TaskContract, _runId?: string) => outcome(true),
    );
    const controller = new ChatController(
      { run } as never,
      () => '2026-01-01T00:00:00.000Z',
    );
    const result = await controller.send('hello');
    expect(result).toMatchObject({
      state: 'success',
      data: { role: 'assistant', content: 'verified reply' },
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0]).toMatchObject({ goal: 'hello' });
    expect(controller.list().data).toHaveLength(2);
  });

  it('rejects empty messages without running Harness', async () => {
    const run = vi.fn();
    const controller = new ChatController({ run } as never);
    expect(await controller.send('  ')).toMatchObject({ state: 'error' });
    expect(run).not.toHaveBeenCalled();
  });

  it('does not display an unverified model response as success', async () => {
    const controller = new ChatController({
      run: async () => outcome(false, 'I claim success'),
    } as never);
    const result = await controller.send('perform task');
    expect(result.state).toBe('error');
    expect(controller.list().data).toHaveLength(1);
  });

  it('normalizes Harness failures and clears loading state', async () => {
    const controller = new ChatController({
      run: async () => {
        throw new Error('gateway unavailable');
      },
    } as never);
    expect(await controller.send('hello')).toMatchObject({
      state: 'error',
      error: 'gateway unavailable',
    });
    expect(controller.isLoading()).toBe(false);
  });
});
