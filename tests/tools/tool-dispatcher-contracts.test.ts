import { describe, expect, it, vi } from 'vitest';
import {
  ToolDispatcher,
  ToolDispatcherError,
  type ToolDispatcherClock,
  type ToolImplementation,
} from '../../tools/tool-dispatcher.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import type {
  ToolExecutor,
  ToolExecutorDeps,
  ToolReceipt,
} from '../../tools/tool-executor.js';
import { createPhase1ToolDefinitions } from '../../tools/tool-definitions.js';

const fixedReceipt = Object.freeze({
  tool_name: 'read_file',
  timestamp: '2026-01-01T00:00:00.000Z',
  success: true,
  duration_ms: 2,
  input_hash: '0123456789abcdef',
  output_hash: 'fedcba9876543210',
} satisfies ToolReceipt);

function setup(options: {
  result?: unknown;
  executeError?: unknown;
  implementation?: ToolImplementation;
  clock?: ToolDispatcherClock;
} = {}) {
  const registry = new ToolRegistry();
  const readFile = createPhase1ToolDefinitions().find(
    (definition) => definition.name === 'read_file',
  )!;
  registry.register(readFile);
  const snapshot = registry.freezeSnapshot();
  const implementation =
    options.implementation ??
    (async () =>
      options.result ?? {
        path: '/workspace/a.txt',
        content: 'hello',
        bytes: 5,
        truncated: false,
      });
  const execute = vi.fn(
    async <T>(
      _toolName: string,
      _input: unknown,
      invoke: (dependencies: ToolExecutorDeps) => Promise<T>,
      verify?: (result: T) => Promise<void> | void,
    ) => {
      if (options.executeError !== undefined) throw options.executeError;
      const result = await invoke({} as ToolExecutorDeps);
      await verify?.(result);
      return { result, receipt: fixedReceipt };
    },
  );
  const executor = { execute } as unknown as ToolExecutor;
  const dispatcher = new ToolDispatcher(
    registry,
    snapshot,
    executor,
    new Map([['read_file', implementation]]),
    options.clock,
  );
  return { dispatcher, execute, registry, snapshot, executor };
}

describe('ToolDispatcher exact boundary contracts', () => {
  it('has stable error identity and validates both implementation directions', () => {
    const error = new ToolDispatcherError('reason');
    expect(error.name).toBe('ToolDispatcherError');
    expect(error.message).toBe('reason');
    expect(error).toBeInstanceOf(Error);

    const { registry, snapshot, executor } = setup();
    expect(
      () => new ToolDispatcher(registry, snapshot, executor, new Map()),
    ).toThrowError('tool implementation not registered: read_file');
    expect(
      () =>
        new ToolDispatcher(
          registry,
          snapshot,
          executor,
          new Map([
            ['read_file', async () => ({})],
            ['outside_snapshot', async () => ({})],
          ]),
        ),
    ).toThrowError('implementation not in frozen snapshot: outside_snapshot');
  });

  it('returns an immutable exact success envelope after output validation', async () => {
    const { dispatcher, execute } = setup();
    const input = { path: '/workspace/a.txt' };
    const result = await dispatcher.dispatch({ tool_name: 'read_file', input });
    expect(result).toEqual({
      success: true,
      result: {
        path: '/workspace/a.txt',
        content: 'hello',
        bytes: 5,
        truncated: false,
      },
      receipt: fixedReceipt,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0]).toBe('read_file');
    expect(execute.mock.calls[0]![1]).toBe(input);
    expect(execute.mock.calls[0]![3]).toBeTypeOf('function');
  });

  it.each([
    [undefined, 'undefined', 'eb045d78d2731073'],
    [null, 'null', '74234e98afe7498f'],
  ])(
    'returns an exact immutable failure for %s input',
    async (input, label, inputHash) => {
      const times = [10, 12.2];
      const clock: ToolDispatcherClock = {
        monotonicNow: () => times.shift()!,
        isoNow: () => '2026-01-02T03:04:05.000Z',
      };
      const { dispatcher, execute } = setup({ clock });
      const result = await dispatcher.dispatch({
        tool_name: 'read_file',
        input,
      });
      const error = `invalid input for tool read_file: input is ${label}`;
      expect(result).toEqual({
        success: false,
        error,
        receipt: {
          tool_name: 'read_file',
          timestamp: '2026-01-02T03:04:05.000Z',
          success: false,
          error,
          duration_ms: 3,
          input_hash: inputHash,
        },
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.receipt)).toBe(true);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('reports exact input schema diagnostics without executing an effect', async () => {
    const { dispatcher, execute } = setup();
    const result = await dispatcher.dispatch({
      tool_name: 'read_file',
      input: {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "input schema validation failed for read_file: : must have required property 'path'",
    );
    expect(result.receipt.input_hash).toBe('44136fa355b3678a');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects undefined and schema-invalid output inside executor verification', async () => {
    const undefinedResult = setup({
      implementation: async () => undefined,
    });
    await expect(
      undefinedResult.dispatcher.dispatch({
        tool_name: 'read_file',
        input: { path: '/workspace/a.txt' },
      }),
    ).resolves.toMatchObject({
      success: false,
      error: 'tool returned undefined result',
    });

    const invalidResult = setup({ implementation: async () => ({}) });
    const result = await invalidResult.dispatcher.dispatch({
      tool_name: 'read_file',
      input: { path: '/workspace/a.txt' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('output schema validation failed for read_file:');
    expect(result.error).toContain("must have required property 'path'");
    expect(result.error).toContain("must have required property 'content'");
    expect(result.error).toContain("must have required property 'bytes'");
    expect(result.error).toContain("must have required property 'truncated'");
  });

  it('normalizes Error and non-Error executor failures', async () => {
    const withError = setup({ executeError: new Error('executor failed') });
    await expect(
      withError.dispatcher.dispatch({
        tool_name: 'read_file',
        input: { path: '/workspace/a.txt' },
      }),
    ).resolves.toMatchObject({
      success: false,
      error: 'executor failed',
      receipt: { error: 'executor failed' },
    });

    const withString = setup({ executeError: 'string failure' });
    await expect(
      withString.dispatcher.dispatch({
        tool_name: 'read_file',
        input: { path: '/workspace/a.txt' },
      }),
    ).resolves.toMatchObject({
      success: false,
      error: 'string failure',
      receipt: { error: 'string failure' },
    });
  });

  it('compiles packaged schemas once per tool and reuses the cached validators', async () => {
    const { dispatcher, registry } = setup();
    const load = vi.spyOn(registry, 'loadJsonResource');
    await dispatcher.dispatch({
      tool_name: 'read_file',
      input: { path: '/workspace/a.txt' },
    });
    await dispatcher.dispatch({
      tool_name: 'read_file',
      input: { path: '/workspace/b.txt' },
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls).toEqual([
      ['schemas/read-file-input.json'],
      ['schemas/read-file-output.json'],
    ]);
  });

  it('fails with stable identity when a selected packaged schema is unavailable', async () => {
    const registry = new ToolRegistry();
    const definition = createPhase1ToolDefinitions().find(
      (candidate) => candidate.name === 'read_file',
    )!;
    registry.register({
      ...definition,
      input_schema_ref: 'schemas/missing.json',
    });
    const snapshot = registry.freezeSnapshot();
    const executor = { execute: vi.fn() } as unknown as ToolExecutor;
    const dispatcher = new ToolDispatcher(
      registry,
      snapshot,
      executor,
      new Map([['read_file', async () => ({})]]),
    );
    await expect(
      dispatcher.dispatch({
        tool_name: 'read_file',
        input: { path: '/workspace/a.txt' },
      }),
    ).rejects.toThrowError(
      'tool schema unavailable for read_file: packaged tool resource not found: schemas/missing.json',
    );
  });
});
