import { describe, it, expect, vi } from 'vitest';
import { processStreamEvents } from '../../runtime/harness-support.js';
import type { StreamEvent } from '../../gateway/scripted-provider.js';

async function* fromEvents(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const ev of events) yield ev;
}

describe('processStreamEvents', () => {
  it('returns empty content and zero usage for empty stream', async () => {
    const onDelta = vi.fn();
    const result = await processStreamEvents(fromEvents([]), 'p1', onDelta);
    expect(result.provider_id).toBe('p1');
    expect(result.response.content).toBe('');
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(onDelta).not.toHaveBeenCalled();
  });

  it('accumulates text from text_delta events and calls onDelta', async () => {
    const onDelta = vi.fn();
    const result = await processStreamEvents(
      fromEvents([
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' World' },
      ]),
      'p1',
      onDelta,
    );
    expect(result.response.content).toBe('Hello World');
    expect(onDelta).toHaveBeenCalledWith('Hello');
    expect(onDelta).toHaveBeenCalledWith(' World');
    expect(onDelta).toHaveBeenCalledTimes(2);
  });

  it('collects tool_calls from tool_call events', async () => {
    const result = await processStreamEvents(
      fromEvents([
        { type: 'tool_call', tool_call: { id: 'tc1', name: 'read_file', arguments: { path: '/a' } } },
        { type: 'tool_call', tool_call: { id: 'tc2', name: 'write_file', arguments: { path: '/b' } } },
      ]),
      'p1',
      vi.fn(),
    );
    expect(result.response.tool_calls).toHaveLength(2);
    expect(result.response.tool_calls?.[0]).toEqual({ id: 'tc1', name: 'read_file', arguments: { path: '/a' } });
    expect(result.response.tool_calls?.[1]).toEqual({ id: 'tc2', name: 'write_file', arguments: { path: '/b' } });
  });

  it('extracts usage from message_stop event', async () => {
    const result = await processStreamEvents(
      fromEvents([
        { type: 'text_delta', text: 'Hi' },
        { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 10, output_tokens: 5 } },
      ]),
      'p1',
      vi.fn(),
    );
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(result.response.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it('defaults to zero usage when message_stop has no usage', async () => {
    const result = await processStreamEvents(
      fromEvents([
        { type: 'text_delta', text: 'Hi' },
        { type: 'message_stop', stop_reason: 'stop' },
      ]),
      'p1',
      vi.fn(),
    );
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('does not call onDelta for empty text_delta', async () => {
    const onDelta = vi.fn();
    const result = await processStreamEvents(
      fromEvents([
        { type: 'text_delta', text: '' },
        { type: 'text_delta', text: 'Hello' },
      ]),
      'p1',
      onDelta,
    );
    expect(result.response.content).toBe('Hello');
    expect(onDelta).toHaveBeenCalledTimes(1);
    expect(onDelta).toHaveBeenCalledWith('Hello');
  });

  it('handles mixed events correctly', async () => {
    const onDelta = vi.fn();
    const result = await processStreamEvents(
      fromEvents([
        { type: 'text_delta', text: 'Let me read' },
        { type: 'tool_call', tool_call: { id: 'tc1', name: 'read_file', arguments: { path: '/a' } } },
        { type: 'text_delta', text: ' the file' },
        { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 100, output_tokens: 20 } },
      ]),
      'p1',
      onDelta,
    );
    expect(result.response.content).toBe('Let me read the file');
    expect(result.response.tool_calls).toHaveLength(1);
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
  });

  it('sets provider_id from parameter', async () => {
    const result = await processStreamEvents(fromEvents([]), 'my-provider', vi.fn());
    expect(result.provider_id).toBe('my-provider');
  });

  it('does not include tool_calls when none received', async () => {
    const result = await processStreamEvents(
      fromEvents([{ type: 'text_delta', text: 'Hi' }]),
      'p1',
      vi.fn(),
    );
    expect(result.response.tool_calls).toBeUndefined();
  });

  it('does not include usage in response when no message_stop', async () => {
    const result = await processStreamEvents(
      fromEvents([{ type: 'text_delta', text: 'Hi' }]),
      'p1',
      vi.fn(),
    );
    expect(result.response.usage).toBeUndefined();
  });

  it('handles task_progress events (ignored)', async () => {
    const result = await processStreamEvents(
      fromEvents([
        { type: 'text_delta', text: 'Working' },
        { type: 'task_progress', progress: 50, task_id: 't1', status: 'running' },
        { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 5, output_tokens: 3 } },
      ]),
      'p1',
      vi.fn(),
    );
    expect(result.response.content).toBe('Working');
    expect(result.usage).toEqual({ input_tokens: 5, output_tokens: 3 });
  });

  it('handles media_complete events (ignored)', async () => {
    const result = await processStreamEvents(
      fromEvents([
        { type: 'media_complete', media_url: 'http://example.com/img.png', media_type: 'image' },
        { type: 'message_stop', stop_reason: 'stop' },
      ]),
      'p1',
      vi.fn(),
    );
    expect(result.response.content).toBe('');
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('uses last message_stop usage when multiple received', async () => {
    const result = await processStreamEvents(
      fromEvents([
        { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 10, output_tokens: 5 } },
        { type: 'message_stop', stop_reason: 'stop', usage: { input_tokens: 20, output_tokens: 10 } },
      ]),
      'p1',
      vi.fn(),
    );
    expect(result.usage).toEqual({ input_tokens: 20, output_tokens: 10 });
  });

  it('preserves exact tool_call arguments', async () => {
    const args = { path: '/a/b/c', mode: 'rw', encoding: 'utf-8', nested: { key: 'val' } };
    const result = await processStreamEvents(
      fromEvents([
        { type: 'tool_call', tool_call: { id: 'tc1', name: 'edit', arguments: args } },
      ]),
      'p1',
      vi.fn(),
    );
    expect(result.response.tool_calls?.[0]?.arguments).toEqual(args);
  });
});
