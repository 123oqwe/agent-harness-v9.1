import { describe, it, expect } from 'vitest';
import type {
  RuntimeSteeringQueue,
  RuntimeSteeringPriority,
  RuntimeSteeringCommand,
  RuntimeSteeringScope,
  RuntimeSteeringEvent,
  RuntimeSteeringPort,
} from '../../runtime/steering-port.js';

describe('steering-port types', () => {
  it('RuntimeSteeringQueue accepts all valid queue values', () => {
    const queues: RuntimeSteeringQueue[] = ['steer', 'follow_up', 'next_turn'];
    expect(queues).toHaveLength(3);
    expect(queues.includes('steer')).toBe(true);
    expect(queues.includes('follow_up')).toBe(true);
    expect(queues.includes('next_turn')).toBe(true);
  });

  it('RuntimeSteeringPriority accepts all valid priority values', () => {
    const priorities: RuntimeSteeringPriority[] = [
      'kill', 'security', 'human_cancel', 'human_correction',
      'admin', 'user', 'supervisor', 'agent',
    ];
    expect(priorities).toHaveLength(8);
  });

  it('RuntimeSteeringCommand has required fields', () => {
    const cmd: RuntimeSteeringCommand = {
      command_id: 'cmd-1',
      queue: 'steer',
      priority: 'user',
      content: { message: 'change direction' },
    };
    expect(cmd.command_id).toBe('cmd-1');
    expect(cmd.queue).toBe('steer');
    expect(cmd.priority).toBe('user');
    expect(cmd.content).toEqual({ message: 'change direction' });
  });

  it('RuntimeSteeringCommand content can be any type', () => {
    const cmd1: RuntimeSteeringCommand = { command_id: 'c1', queue: 'steer', priority: 'admin', content: 'string content' };
    const cmd2: RuntimeSteeringCommand = { command_id: 'c2', queue: 'follow_up', priority: 'user', content: { nested: true } };
    const cmd3: RuntimeSteeringCommand = { command_id: 'c3', queue: 'next_turn', priority: 'kill', content: [1, 2, 3] };
    expect(typeof cmd1.content).toBe('string');
    expect(typeof cmd2.content).toBe('object');
    expect(Array.isArray(cmd3.content)).toBe(true);
  });

  it('RuntimeSteeringScope has required fields', () => {
    const scope: RuntimeSteeringScope = {
      tenant_id: 'tenant-1',
      run_id: 'run-1',
      session_id: 'session-1',
    };
    expect(scope.tenant_id).toBe('tenant-1');
    expect(scope.run_id).toBe('run-1');
    expect(scope.session_id).toBe('session-1');
  });

  it('RuntimeSteeringEvent enqueued kind has command with scope, ordinal, fingerprint', () => {
    const event: RuntimeSteeringEvent = {
      schema_version: 'steering-event/v1',
      kind: 'enqueued',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      command: {
        command_id: 'cmd-1',
        queue: 'steer',
        priority: 'user',
        content: {},
        scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
        ordinal: 1,
        fingerprint: 'abc123',
      },
    };
    expect(event.kind).toBe('enqueued');
    expect(event.command.ordinal).toBe(1);
    expect(event.command.fingerprint).toBe('abc123');
    expect(event.command.scope.tenant_id).toBe('t1');
  });

  it('RuntimeSteeringEvent consumed kind has command_id', () => {
    const event: RuntimeSteeringEvent = {
      schema_version: 'steering-event/v1',
      kind: 'consumed',
      scope: { tenant_id: 't1', run_id: 'r1', session_id: 's1' },
      command_id: 'cmd-1',
    };
    expect(event.kind).toBe('consumed');
    expect(event.command_id).toBe('cmd-1');
  });

  it('RuntimeSteeringPort interface has drain and subscribe', () => {
    const port: RuntimeSteeringPort = {
      drain: (_queue: RuntimeSteeringQueue) => [],
      subscribe: (_listener: (cmd: RuntimeSteeringCommand) => void) => () => {},
    };
    expect(port.drain('steer')).toEqual([]);
    expect(typeof port.subscribe).toBe('function');
  });

  it('RuntimeSteeringPort drain returns commands for queue', () => {
    const cmds: RuntimeSteeringCommand[] = [
      { command_id: 'c1', queue: 'steer', priority: 'user', content: {} },
      { command_id: 'c2', queue: 'follow_up', priority: 'admin', content: {} },
    ];
    const port: RuntimeSteeringPort = {
      drain: (queue) => cmds.filter(c => c.queue === queue),
      subscribe: () => () => {},
    };
    expect(port.drain('steer')).toHaveLength(1);
    expect(port.drain('follow_up')).toHaveLength(1);
    expect(port.drain('next_turn')).toHaveLength(0);
  });

  it('RuntimeSteeringPort subscribe returns unsubscribe function', () => {
    let called = false;
    const port: RuntimeSteeringPort = {
      drain: () => [],
      subscribe: (listener) => {
        listener({ command_id: 'c1', queue: 'steer', priority: 'user', content: 'test' });
        return () => { called = true; };
      },
    };
    let received: RuntimeSteeringCommand | null = null;
    const unsub = port.subscribe((cmd) => { received = cmd; });
    expect(received).not.toBeNull();
    expect(received!.content).toBe('test');
    unsub();
    expect(called).toBe(true);
  });

  it('priority ordering: kill > security > human_cancel > human_correction > admin > user > supervisor > agent', () => {
    const order: RuntimeSteeringPriority[] = [
      'kill', 'security', 'human_cancel', 'human_correction',
      'admin', 'user', 'supervisor', 'agent',
    ];
    // Verify that kill is the highest priority and agent is the lowest
    expect(order.indexOf('kill')).toBe(0);
    expect(order.indexOf('agent')).toBe(7);
  });
});
