import { describe, it, expect, vi } from 'vitest';
import { EventBus, createEvent } from '../../runtime/event-bus.js';

describe('EventBus', () => {
  it('subscribe receives events in updates mode', () => {
    const bus = new EventBus();
    const received: any[] = [];
    bus.subscribe((e) => received.push(e));
    bus.publish(createEvent('tool_call_start', 'run-1', { tool: 'read_file' }));
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('tool_call_start');
    expect(received[0].run_id).toBe('run-1');
  });

  it('unsubscribe stops receiving', () => {
    const bus = new EventBus();
    const received: any[] = [];
    const unsub = bus.subscribe((e) => received.push(e));
    bus.publish(createEvent('tool_result', 'r1', {}));
    unsub();
    bus.publish(createEvent('tool_result', 'r1', {}));
    expect(received).toHaveLength(1);
  });

  it('values mode buffers events', () => {
    const bus = new EventBus({ mode: 'values', batchMs: 1000 });
    bus.publish(createEvent('tool_call_start', 'r1', {}));
    bus.publish(createEvent('tool_result', 'r1', {}));
    expect(bus.events).toHaveLength(2);
  });

  it('flush sends buffered events to subscribers', () => {
    const bus = new EventBus({ mode: 'values', batchMs: 1000 });
    const received: any[] = [];
    bus.subscribe((e) => received.push(e));
    bus.publish(createEvent('tool_call_start', 'r1', {}));
    bus.publish(createEvent('tool_result', 'r1', {}));
    expect(received).toHaveLength(0);
    bus.flush();
    expect(received).toHaveLength(2);
    expect(bus.events).toHaveLength(0);
  });

  it('values mode auto-flushes after batchMs on next publish', () => {
    const bus = new EventBus({ mode: 'values', batchMs: 1 });
    const received: any[] = [];
    bus.subscribe((e) => received.push(e));
    bus.publish(createEvent('tool_call_start', 'r1', {}));
    // First publish buffers, auto-flush only triggers on next publish after batchMs
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        bus.publish(createEvent('tool_result', 'r1', {}));
        expect(received).toHaveLength(2);
        resolve();
      }, 10);
    });
  }, 5000);

  it('subscriber errors are swallowed', () => {
    const bus = new EventBus();
    bus.subscribe(() => { throw new Error('subscriber error'); });
    expect(() => bus.publish(createEvent('tool_result', 'r1', {}))).not.toThrow();
  });

  it('multiple subscribers all receive events', () => {
    const bus = new EventBus();
    let count1 = 0, count2 = 0;
    bus.subscribe(() => count1++);
    bus.subscribe(() => count2++);
    bus.publish(createEvent('tool_result', 'r1', {}));
    expect(count1).toBe(1);
    expect(count2).toBe(1);
  });

  it('default mode is updates', () => {
    const bus = new EventBus();
    const received: any[] = [];
    bus.subscribe((e) => received.push(e));
    bus.publish(createEvent('tool_result', 'r1', {}));
    expect(received).toHaveLength(1);
  });
});

describe('createEvent', () => {
  it('creates event with type and run_id', () => {
    const e = createEvent('tool_call_start', 'run-1', { tool: 'read_file' });
    expect(e.type).toBe('tool_call_start');
    expect(e.run_id).toBe('run-1');
    expect(e.data.tool).toBe('read_file');
    expect(e.timestamp).toBeDefined();
  });

  it('creates event with optional step_id', () => {
    const e = createEvent('tool_result', 'run-1', {}, 'step-5');
    expect(e.step_id).toBe('step-5');
  });

  it('creates event without step_id when not provided', () => {
    const e = createEvent('tool_result', 'run-1', {});
    expect(e.step_id).toBeUndefined();
  });

  it('timestamp is ISO format', () => {
    const e = createEvent('tool_result', 'r1', {});
    expect(e.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
