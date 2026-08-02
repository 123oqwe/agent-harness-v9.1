import { describe, expect, it, vi } from 'vitest';

import {
  HOOK_EVENTS,
  HookSystem,
  type HookAuditEntry,
  type HookAuditPort,
  type HookHandler,
  type HookJournalClaim,
  type HookJournalPort,
  type HookJournalRecord,
  type HookRegistration,
} from '../../../packages/runtime-core/src/index.js';

class MemoryJournal implements HookJournalPort {
  readonly records = new Map<string, HookJournalRecord>();
  readonly active = new Map<
    string,
    { token: string; done: Promise<void>; finish: () => void }
  >();
  nextToken = 0;

  async claim(input: {
    scope: HookJournalRecord['scope'];
    idempotency_key: string;
    event: HookJournalRecord['event'];
    input_hash: string;
  }): Promise<HookJournalClaim> {
    const record = this.records.get(input.idempotency_key);
    if (record) return { status: 'replay' as const, record };
    const active = this.active.get(input.idempotency_key);
    if (active) {
      await active.done;
      return this.claim(input);
    }
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const token = `claim-${++this.nextToken}`;
    this.active.set(input.idempotency_key, { token, done, finish });
    return { status: 'claimed' as const, claim_token: token };
  }

  async commit(claimToken: string, record: HookJournalRecord): Promise<void> {
    const active = this.active.get(record.idempotency_key);
    if (!active || active.token !== claimToken) {
      throw new Error('invalid journal claim');
    }
    this.records.set(record.idempotency_key, record);
    this.active.delete(record.idempotency_key);
    active.finish();
  }

  async release(claimToken: string): Promise<void> {
    for (const [key, active] of this.active) {
      if (active.token === claimToken) {
        this.active.delete(key);
        active.finish();
        return;
      }
    }
    throw new Error('invalid journal claim');
  }
}

class MemoryAudit implements HookAuditPort {
  readonly entries: HookAuditEntry[] = [];

  async record(entry: HookAuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

const scope = Object.freeze({
  tenant_id: 'tenant-1',
  run_id: 'run-1',
  session_id: 'session-1',
  operation_id: 'operation-1',
  attempt_id: 'attempt-1',
});

const allowAttenuation = Object.freeze({
  validate: () => ({ allowed: true as const }),
});

const registration = (
  id: string,
  event: (typeof HOOK_EVENTS)[number],
  handler: HookHandler,
  overrides: Record<string, unknown> = {},
): HookRegistration =>
  ({
    id,
    event,
    trust: 'managed',
  priority: 100,
    timeout_ms: 100,
    handler,
    ...overrides,
  }) as HookRegistration;

const request = (
  event: (typeof HOOK_EVENTS)[number],
  idempotencyKey: string,
  payload: unknown,
  signal?: AbortSignal,
) => ({
  event,
  invocation_id: `invocation-${idempotencyKey}`,
  idempotency_key: idempotencyKey,
  scope,
  payload,
  ...(signal === undefined ? {} : { signal }),
});

describe('AH-HOOK-001 HookSystem', () => {
  it('freezes the complete eleven-event catalog', () => {
    expect(HOOK_EVENTS).toEqual([
      'user_prompt_submit',
      'session_start',
      'before_provider_request',
      'pre_turn',
      'pre_tool_use',
      'post_tool_use',
      'after_response',
      'post_turn',
      'session_before_compact',
      'stop',
      'session_end',
    ]);
    expect(Object.isFrozen(HOOK_EVENTS)).toBe(true);
  });

  it.each(HOOK_EVENTS)(
    'dispatches %s with its exact decision or observational authority',
    async (event) => {
      const decisionEvents = new Set([
        'user_prompt_submit',
        'before_provider_request',
        'pre_turn',
        'pre_tool_use',
        'session_before_compact',
      ]);
      const decision = decisionEvents.has(event);
      const legal = new HookSystem([
        registration(`legal-${event}`, event, {
          handle: async () =>
            decision
              ? { action: 'continue' }
              : { action: 'observe', follow_up: { event } },
        }),
      ]);
      await expect(
        legal.dispatch(request(event, `legal-${event}`, { event })),
      ).resolves.toMatchObject({
        action: 'continue',
        payload: { event },
        follow_ups: decision ? [] : [{ event }],
        replayed: false,
      });

      const invalid = new HookSystem([
        registration(`invalid-${event}`, event, {
          handle: async () => ({ action: 'grant' }) as never,
        }),
      ]);
      await expect(
        invalid.dispatch(request(event, `invalid-${event}`, { event })),
      ).resolves.toMatchObject(
        decision
          ? {
              action: 'deny',
              reason_code: 'invalid_hook_result',
              replayed: false,
            }
          : { action: 'continue', payload: { event }, replayed: false },
      );

      const failed = new HookSystem([
        registration(`failed-${event}`, event, {
          handle: async () => {
            throw new Error(`failed-${event}`);
          },
        }),
      ]);
      await expect(
        failed.dispatch(request(event, `failed-${event}`, { event })),
      ).resolves.toMatchObject(
        decision
          ? { action: 'deny', reason_code: 'hook_error', replayed: false }
          : { action: 'continue', payload: { event }, replayed: false },
      );
    },
  );

  it('runs hooks deterministically and passes only attenuated payload forward', async () => {
    const calls: string[] = [];
    const first: HookHandler = {
      handle: vi.fn(async ({ payload }) => {
        calls.push('first');
        expect(payload).toEqual({
          path: '/workspace/original.txt',
          extra: true,
        });
        return {
          action: 'attenuate' as const,
          payload: { path: '/workspace/allowed.txt' },
        };
      }),
    };
    const second: HookHandler = {
      handle: vi.fn(async ({ payload }) => {
        calls.push('second');
        expect(payload).toEqual({ path: '/workspace/allowed.txt' });
        return { action: 'continue' as const };
      }),
    };
    const system = new HookSystem(
      [
        registration('second', 'pre_tool_use', second, { priority: 20 }),
        registration('first', 'pre_tool_use', first, { priority: 10 }),
      ],
      { attenuationPolicy: allowAttenuation },
    );

    const outcome = await system.dispatch(
      request('pre_tool_use', 'key-order', {
        path: '/workspace/original.txt',
        extra: true,
      }),
    );

    expect(calls).toEqual(['first', 'second']);
    expect(outcome).toMatchObject({
      action: 'continue',
      payload: { path: '/workspace/allowed.txt' },
      replayed: false,
    });
    expect(Object.isFrozen(outcome)).toBe(true);
  });

  it('preserves registration order when priorities tie', async () => {
    const calls: string[] = [];
    const system = new HookSystem([
      registration('z-first', 'pre_tool_use', {
        handle: async () => {
          calls.push('z-first');
          return { action: 'continue' };
        },
      }),
      registration('a-second', 'pre_tool_use', {
        handle: async () => {
          calls.push('a-second');
          return { action: 'continue' };
        },
      }),
    ]);
    await system.dispatch(request('pre_tool_use', 'tied-order', {}));
    expect(calls).toEqual(['z-first', 'a-second']);
  });

  it.each(['deny', 'skip', 'force_prompt'] as const)(
    'stops before later hooks on restrictive %s',
    async (action) => {
      const later = vi.fn(async () => ({ action: 'continue' as const }));
      const system = new HookSystem([
        registration('restrict', 'pre_tool_use', {
          handle: async () => ({ action, reason_code: `hook_${action}` }),
        }),
        registration(
          'later',
          'pre_tool_use',
          { handle: later },
          { priority: 200 },
        ),
      ]);

      const outcome = await system.dispatch(
        request('pre_tool_use', `key-${action}`, { path: '/workspace/a' }),
      );

      expect(outcome.action).toBe(action);
      expect(outcome.reason_code).toBe(`hook_${action}`);
      expect(outcome.replayed).toBe(false);
      expect(later).not.toHaveBeenCalled();
    },
  );

  it('fails closed when a decision hook tries to grant authority', async () => {
    const system = new HookSystem([
      registration('compromised', 'pre_tool_use', {
        handle: async () =>
          ({
            action: 'continue',
            capability: 'forged-token',
            permission: 'grant',
          }) as never,
      }),
    ]);

    const outcome = await system.dispatch(
      request('pre_tool_use', 'key-grant', { path: '/workspace/a' }),
    );

    expect(outcome).toMatchObject({
      action: 'deny',
      reason_code: 'invalid_hook_result',
      replayed: false,
    });
  });

  it('keeps observational PostToolUse unable to change or fail the effect', async () => {
    const audit = new MemoryAudit();
    const system = new HookSystem(
      [
        registration('observer', 'post_tool_use', {
          handle: async () => ({
            action: 'attenuate',
            payload: { forged: true },
          }),
        }),
      ],
      { audit },
    );
    const original = Object.freeze({ result: { bytes: 7 }, success: true });

    const outcome = await system.dispatch(
      request('post_tool_use', 'key-observer', original),
    );

    expect(outcome).toMatchObject({ action: 'continue', payload: original });
    expect(audit.entries.at(-1)).toMatchObject({
      outcome: 'ignored_invalid_observation',
      reason_code: 'observational_hook_cannot_mutate',
    });
  });

  it('fails closed on decision timeout and cancellation without waiting forever', async () => {
    const never: HookHandler = {
      handle: vi.fn(
        async (_input, signal) =>
          new Promise<{ action: 'continue' }>((resolve) => {
            signal.addEventListener(
              'abort',
              () => resolve({ action: 'continue' }),
              { once: true },
            );
          }),
      ),
    };
    const timeoutSystem = new HookSystem([
      registration('timeout', 'pre_tool_use', never, { timeout_ms: 5 }),
    ]);

    await expect(
      timeoutSystem.dispatch(
        request('pre_tool_use', 'key-timeout', { path: '/workspace/a' }),
      ),
    ).resolves.toMatchObject({
      action: 'deny',
      reason_code: 'hook_timeout',
    });

    const controller = new AbortController();
    controller.abort('user_cancel');
    const cancelled = vi.fn(async () => ({ action: 'continue' as const }));
    const cancelSystem = new HookSystem([
      registration('cancelled', 'pre_tool_use', { handle: cancelled }),
    ]);
    await expect(
      cancelSystem.dispatch(
        request(
          'pre_tool_use',
          'key-cancel',
          { path: '/workspace/a' },
          controller.signal,
        ),
      ),
    ).resolves.toMatchObject({
      action: 'deny',
      reason_code: 'hook_cancelled',
    });
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('blocks recursive dispatch in the same run scope', async () => {
    let system: HookSystem;
    const nested = vi.fn();
    system = new HookSystem([
      registration('recursive', 'pre_tool_use', {
        handle: async () => {
          const result = await system.dispatch(
            request('pre_tool_use', 'nested-key', {
              path: '/workspace/nested',
            }),
          );
          nested(result);
          return { action: 'continue' };
        },
      }),
    ]);

    const outcome = await system.dispatch(
      request('pre_tool_use', 'outer-key', { path: '/workspace/a' }),
    );

    expect(nested).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'deny',
        reason_code: 'recursive_hook_dispatch',
        replayed: false,
      }),
    );
    expect(outcome.action).toBe('continue');
  });

  it('blocks same-key recursion before consulting the in-flight replay', async () => {
    let system: HookSystem;
    let nestedOutcome: Awaited<ReturnType<HookSystem['dispatch']>> | undefined;
    system = new HookSystem([
      registration(
        'same-key-recursive',
        'pre_tool_use',
        {
          handle: async () => {
            nestedOutcome = await system.dispatch(
              request('pre_tool_use', 'recursive-key', {
                path: '/workspace/a',
              }),
            );
            return { action: 'continue' };
          },
        },
        { timeout_ms: 20 },
      ),
    ]);

    const outcome = await system.dispatch(
      request('pre_tool_use', 'recursive-key', { path: '/workspace/a' }),
    );
    await vi.waitFor(() => expect(nestedOutcome).toBeDefined());

    expect(nestedOutcome).toMatchObject({
      action: 'deny',
      reason_code: 'recursive_hook_dispatch',
      replayed: false,
    });
    expect(outcome.action).toBe('continue');
  });

  it('blocks nested dispatch on the same HookSystem even in a different scope', async () => {
    let system: HookSystem;
    let nestedOutcome: Awaited<ReturnType<HookSystem['dispatch']>> | undefined;
    const handler = vi.fn(
      async (input: Parameters<HookHandler['handle']>[0]) => {
        if (input.scope.session_id === 'session-1') {
          nestedOutcome = await system.dispatch({
            ...request('pre_tool_use', 'other-scope-key', { nested: true }),
          scope: { ...scope, session_id: 'session-2' },
          });
        }
        return { action: 'continue' as const };
      },
    );
    system = new HookSystem([
      registration('different-scope', 'pre_tool_use', { handle: handler }),
    ]);

    await expect(
      system.dispatch(
        request('pre_tool_use', 'original-scope-key', { nested: false }),
      ),
    ).resolves.toMatchObject({ action: 'continue' });
    expect(nestedOutcome).toMatchObject({
      action: 'deny',
      payload: { nested: true },
      reason_code: 'recursive_hook_dispatch',
      replayed: false,
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ignores recursive observational dispatch without escalating authority', async () => {
    let system: HookSystem;
    let nestedOutcome: Awaited<ReturnType<HookSystem['dispatch']>> | undefined;
    system = new HookSystem([
      registration('recursive-observer', 'post_tool_use', {
        handle: async () => {
          nestedOutcome = await system.dispatch(
            request('post_tool_use', 'nested-observer', { nested: true }),
          );
          return { action: 'observe' };
        },
      }),
    ]);

    const outcome = await system.dispatch(
      request('post_tool_use', 'outer-observer', { outer: true }),
    );

    expect(nestedOutcome).toMatchObject({
      action: 'continue',
      payload: { nested: true },
      replayed: false,
    });
    expect(outcome).toMatchObject({
      action: 'continue',
      payload: { outer: true },
    });
  });

  it('allows independent concurrent dispatches in the same run scope', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    let bothStarted!: () => void;
    const ready = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const handler = vi.fn(async () => {
      started += 1;
      if (started === 2) bothStarted();
      await gate;
      return { action: 'continue' as const };
    });
    const system = new HookSystem([
      registration('parallel', 'pre_tool_use', { handle: handler }),
    ]);

    const first = system.dispatch(
      request('pre_tool_use', 'parallel-a', { path: 'a' }),
    );
    const second = system.dispatch(
      request('pre_tool_use', 'parallel-b', { path: 'b' }),
    );
    const bothRan = await Promise.race([
      ready.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    release();

    expect(bothRan).toBe(true);
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { action: 'continue', payload: { path: 'a' } },
      { action: 'continue', payload: { path: 'b' } },
    ]);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('single-flights concurrent idempotency and rejects a concurrent payload collision', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const handler = vi.fn(async () => {
      markStarted();
      await gate;
      return {
        action: 'attenuate' as const,
        payload: { path: '/workspace/final' },
      };
    });
    const system = new HookSystem(
      [registration('single-flight', 'pre_tool_use', { handle: handler })],
      { attenuationPolicy: allowAttenuation },
    );
    const first = system.dispatch(
      request('pre_tool_use', 'same-key', { path: '/workspace/original' }),
    );
    await started;
    const replay = system.dispatch(
      request('pre_tool_use', 'same-key', { path: '/workspace/original' }),
    );
    const collision = system.dispatch(
      request('pre_tool_use', 'same-key', { path: '/workspace/other' }),
    );
    const eventCollision = system.dispatch(
      request('before_provider_request', 'same-key', {
        path: '/workspace/original',
      }),
    );

    release();
    await expect(collision).rejects.toThrow('hook idempotency key collision');
    await expect(eventCollision).rejects.toThrow(
      'hook idempotency key collision',
    );
    await expect(first).resolves.toMatchObject({
      payload: { path: '/workspace/final' },
      replayed: false,
    });
    await expect(replay).resolves.toMatchObject({
      payload: { path: '/workspace/final' },
      replayed: true,
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('preserves a restrictive result when replaying an in-flight call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const handler = vi.fn(async () => {
      markStarted();
      await gate;
      return { action: 'deny' as const, reason_code: 'concurrent_denial' };
    });
    const system = new HookSystem([
      registration('restrictive-flight', 'pre_tool_use', { handle: handler }),
    ]);
    const input = request('pre_tool_use', 'restrictive-key', { path: 'same' });

    const first = system.dispatch(input);
    await started;
    const replay = system.dispatch(input);
    release();

    await expect(first).resolves.toMatchObject({
      action: 'deny',
      reason_code: 'concurrent_denial',
      replayed: false,
    });
    await expect(replay).resolves.toMatchObject({
      action: 'deny',
      reason_code: 'concurrent_denial',
      follow_ups: [],
      replayed: true,
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('removes a completed in-flight entry before reusing its key', async () => {
    const handler = vi.fn(async () => ({ action: 'continue' as const }));
    const system = new HookSystem([
      registration('flight-cleanup', 'pre_tool_use', { handle: handler }),
    ]);

    await system.dispatch(
      request('pre_tool_use', 'reusable-key', { version: 1 }),
    );
    await expect(
      system.dispatch(request('pre_tool_use', 'reusable-key', { version: 2 })),
    ).resolves.toMatchObject({ payload: { version: 2 }, replayed: false });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid journal claims and releases a claim after commit failure', async () => {
    const invalidClaimJournal: HookJournalPort = {
      claim: vi.fn(async () => ({
        status: 'claimed' as const,
        claim_token: '   ',
      })),
      commit: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const handler = vi.fn(async () => ({ action: 'continue' as const }));
    const invalidClaimSystem = new HookSystem(
      [registration('invalid-claim', 'pre_tool_use', { handle: handler })],
      { journal: invalidClaimJournal },
    );
    await expect(
      invalidClaimSystem.dispatch(
        request('pre_tool_use', 'invalid-claim-key', {}),
      ),
    ).rejects.toThrow('hook journal returned an invalid claim token');
    expect(handler).not.toHaveBeenCalled();

    const release = vi.fn(async () => undefined);
    const failingCommitJournal: HookJournalPort = {
      claim: vi.fn(async () => ({
        status: 'claimed' as const,
        claim_token: 'claim-1',
      })),
      commit: vi.fn(async () => {
        throw new Error('commit failed');
      }),
      release,
    };
    const failingCommitSystem = new HookSystem(
      [registration('commit-failure', 'pre_tool_use', { handle: handler })],
      { journal: failingCommitJournal },
    );
    await expect(
      failingCommitSystem.dispatch(
        request('pre_tool_use', 'commit-failure-key', {}),
      ),
    ).rejects.toThrow('commit failed');
    expect(release).toHaveBeenCalledWith('claim-1');
  });

  it.each([
    [undefined, 'hook_attenuation_policy_required'],
    [
      {
        validate: () => {
          throw new Error('policy unavailable');
        },
      },
      'hook_attenuation_policy_failed',
    ],
  ] as const)(
    'fails closed when attenuation policy resolves to %s',
    async (attenuationPolicy, reasonCode) => {
      const system = new HookSystem(
        [
          registration('policy-required', 'pre_tool_use', {
            handle: async () => ({
              action: 'attenuate',
              payload: { path: '/workspace/reduced' },
            }),
          }),
        ],
        attenuationPolicy === undefined ? {} : { attenuationPolicy },
      );
      await expect(
        system.dispatch(
          request('pre_tool_use', `policy-${reasonCode}`, {
            path: '/workspace/original',
            extra: true,
          }),
        ),
      ).resolves.toMatchObject({
        action: 'deny',
        reason_code: reasonCode,
        payload: { path: '/workspace/original', extra: true },
        replayed: false,
      });
    },
  );

  it.each([
    ['pre_tool_use', 'deny'],
    ['post_tool_use', 'continue'],
  ] as const)(
    'maps journal reconciliation for %s to %s without executing hooks',
    async (event, action) => {
      const handler = vi.fn(async () => ({ action: 'continue' as const }));
      const journal: HookJournalPort = {
        claim: vi.fn(async () => ({
          status: 'reconciliation' as const,
          reason_code: 'hook_claim_abandoned' as const,
        })),
        commit: vi.fn(async () => undefined),
        release: vi.fn(async () => undefined),
      };
      const system = new HookSystem(
        [registration('reconciliation', event, { handle: handler })],
        { journal },
      );
      const outcome = await system.dispatch(
        request(event, `reconciliation-${event}`, { unchanged: true }),
      );
      expect(outcome).toMatchObject({
        event,
        action,
        payload: { unchanged: true },
        follow_ups: [],
        replayed: false,
      });
      if (event === 'pre_tool_use') {
        expect(outcome.reason_code).toBe('hook_claim_abandoned');
      } else {
        expect(outcome).not.toHaveProperty('reason_code');
      }
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('uses atomic journal claims across HookSystem instances', async () => {
    const journal = new MemoryJournal();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const handler = vi.fn(async () => {
      markStarted();
      await gate;
      return { action: 'continue' as const };
    });
    const firstSystem = new HookSystem(
      [registration('first-process', 'pre_tool_use', { handle: handler })],
      { journal },
    );
    const secondSystem = new HookSystem(
      [registration('second-process', 'pre_tool_use', { handle: handler })],
      { journal },
    );
    const input = request('pre_tool_use', 'durable-key', { path: 'same' });

    const first = firstSystem.dispatch(input);
    await started;
    const replay = secondSystem.dispatch(input);
    release();

    await expect(first).resolves.toMatchObject({ replayed: false });
    await expect(replay).resolves.toMatchObject({ replayed: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(journal.records.get('durable-key')).toMatchObject({
      input_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      outcome: { action: 'continue' },
    });
  });

  it('replays the same idempotent outcome and rejects key collisions', async () => {
    const journal = new MemoryJournal();
    const handler = vi.fn(async () => ({
      action: 'attenuate' as const,
      payload: { path: '/workspace/final' },
    }));
    const system = new HookSystem(
      [registration('once', 'pre_tool_use', { handle: handler })],
      { journal, attenuationPolicy: allowAttenuation },
    );

    const first = await system.dispatch(
      request('pre_tool_use', 'stable-key', { path: '/workspace/original' }),
    );
    const replay = await system.dispatch(
      request('pre_tool_use', 'stable-key', { path: '/workspace/original' }),
    );

    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({
      action: 'continue',
      payload: { path: '/workspace/final' },
      replayed: true,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(
      system.dispatch(
        request('pre_tool_use', 'stable-key', { path: '/workspace/different' }),
      ),
    ).rejects.toThrow(/idempotency key collision/u);
    await expect(
      system.dispatch(
        request('before_provider_request', 'stable-key', {
          path: '/workspace/original',
        }),
      ),
    ).rejects.toThrow(/idempotency key collision/u);
  });

  it('writes secret-safe audit metadata without raw payloads or outputs', async () => {
    const audit = new MemoryAudit();
    const system = new HookSystem(
      [
        registration('safe-audit', 'pre_tool_use', {
          handle: async () => ({
            action: 'attenuate',
            payload: { token: 'output-secret', path: '/workspace/final' },
          }),
        }),
      ],
      {
        audit,
        attenuationPolicy: allowAttenuation,
        now: () => '2026-08-02T00:00:00.000Z',
      },
    );

    await system.dispatch(
      request('pre_tool_use', 'key-secret', {
        token: 'input-secret',
        path: '/workspace/original',
      }),
    );

    expect(audit.entries).toHaveLength(1);
    const serialized = JSON.stringify(audit.entries);
    expect(serialized).not.toContain('input-secret');
    expect(serialized).not.toContain('output-secret');
    expect(audit.entries[0]).toMatchObject({
      hook_id: 'safe-audit',
      event: 'pre_tool_use',
      outcome: 'attenuated',
      input_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      output_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      timestamp: '2026-08-02T00:00:00.000Z',
    });
  });

  it('validates trust provenance, unique ids, priorities, and timeouts', () => {
    const noop: HookHandler = {
      handle: async () => ({ action: 'continue' }),
    };
    expect(
      () =>
        new HookSystem([
          registration('reviewed', 'pre_tool_use', noop, {
            trust: 'hash_reviewed',
          }),
        ]),
    ).toThrow(/content_hash/u);
    expect(
      () =>
        new HookSystem([
          registration('same', 'pre_tool_use', noop),
          registration('same', 'post_tool_use', noop),
        ]),
    ).toThrow(/duplicate hook id/u);
    expect(
      () =>
        new HookSystem([
          registration('priority', 'pre_tool_use', noop, {
            priority: Number.NaN,
          }),
        ]),
    ).toThrow(/priority/u);
    expect(
      () =>
        new HookSystem([
          registration('timeout', 'pre_tool_use', noop, { timeout_ms: 0 }),
        ]),
    ).toThrow(/timeout_ms/u);
  });

  it('validates every registration and invocation trust boundary', async () => {
    const noop: HookHandler = {
      handle: async () => ({ action: 'continue' }),
    };
    const validHash = 'a'.repeat(64);
    expect(
      () =>
        new HookSystem([
          {
            id: 'reviewed',
            event: 'pre_tool_use',
            trust: 'hash_reviewed',
            content_hash: validHash,
            priority: 1,
            timeout_ms: 100,
            execution: {
              executable_path: '/usr/bin/true',
              argv: [],
              source_path: '/usr/bin/true',
            },
          },
        ]),
    ).not.toThrow();
    for (const [invalid, message] of [
      [null, 'hook registration must be an object'],
      [registration('', 'pre_tool_use', noop), 'hook id is required'],
      [registration('   ', 'pre_tool_use', noop), 'hook id is required'],
      [
        registration('bad-event', 'not-an-event' as never, noop),
        'unknown hook event',
      ],
      [
        registration('bad-trust', 'pre_tool_use', noop, {
          trust: 'root' as never,
        }),
        'invalid hook trust',
      ],
      [
        registration('bad-hash-suffix', 'pre_tool_use', noop, {
          trust: 'hash_reviewed',
          content_hash: `${validHash}x`,
        }),
        'hash_reviewed hook requires a SHA-256 content_hash',
      ],
      [
        registration('bad-handler', 'pre_tool_use', null as never),
        'managed hook handler is required',
      ],
      [
        {
          ...registration('bad-handle', 'pre_tool_use', noop),
          handler: {},
        },
        'managed hook handler is required',
      ],
      [
        {
          ...registration('managed-external', 'pre_tool_use', noop),
          execution: {
            executable_path: '/usr/bin/true',
            argv: [],
            source_path: '/usr/bin/true',
          },
        },
        'managed hooks cannot use external execution',
      ],
      [
        registration('fractional-priority', 'pre_tool_use', noop, {
          priority: 1.5,
        }),
        'hook priority must be a safe integer',
      ],
      [
        registration('fractional-timeout', 'pre_tool_use', noop, {
          timeout_ms: 1.5,
        }),
        'hook timeout_ms must be a positive safe integer',
      ],
    ] as const) {
      expect(() => new HookSystem([invalid as never])).toThrow(message);
    }

    const reviewedBase = {
      id: 'reviewed-invalid-execution',
      event: 'pre_tool_use',
      trust: 'hash_reviewed',
      content_hash: validHash,
      priority: 1,
      timeout_ms: 100,
    } as const;
    for (const execution of [
      undefined,
      null,
      {},
      { executable_path: '', argv: [], source_path: '/hook.mjs' },
      { executable_path: 1, argv: [], source_path: '/hook.mjs' },
      { executable_path: '/usr/bin/node', argv: null, source_path: '/hook.mjs' },
      { executable_path: '/usr/bin/node', argv: [1], source_path: '/hook.mjs' },
      { executable_path: '/usr/bin/node', argv: [], source_path: '' },
      { executable_path: '/usr/bin/node', argv: [], source_path: 1 },
    ]) {
      expect(
        () =>
          new HookSystem([
            { ...reviewedBase, execution } as never,
          ]),
      ).toThrow('external hook execution descriptor is required');
    }

    const system = new HookSystem([]);
    for (const [invalid, message] of [
      [
        { ...request('pre_tool_use', 'valid', {}), event: 'bad' },
        'unknown hook event',
      ],
      [
        { ...request('pre_tool_use', 'valid', {}), invocation_id: ' ' },
        'invocation_id is required',
      ],
      [
        { ...request('pre_tool_use', 'valid', {}), idempotency_key: '' },
        'idempotency_key is required',
      ],
      [
        {
          ...request('pre_tool_use', 'valid', {}),
          scope: { ...scope, tenant_id: null },
        },
        'tenant_id is required',
      ],
      [
        {
          ...request('pre_tool_use', 'valid', {}),
          scope: { ...scope, run_id: 1 },
        },
        'run_id is required',
      ],
      [
        {
          ...request('pre_tool_use', 'valid', {}),
          scope: { ...scope, session_id: null },
        },
        'session_id is required',
      ],
      [
        {
          ...request('pre_tool_use', 'valid', {}),
          scope: { ...scope, operation_id: '' },
        },
        'operation_id must be non-empty when provided',
      ],
      [
        {
          ...request('pre_tool_use', 'valid', {}),
          scope: { ...scope, attempt_id: 1 },
        },
        'attempt_id must be non-empty when provided',
      ],
    ] as const) {
      await expect(system.dispatch(invalid as never)).rejects.toThrow(message);
    }
  });

  it('rejects non-JSON values and freezes nested handler inputs and outcomes', async () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const empty = new HookSystem([]);
    await expect(
      empty.dispatch(request('pre_tool_use', 'cyclic', cyclic)),
    ).rejects.toThrow('hook input payload must be JSON-serializable');
    await expect(
      empty.dispatch(request('pre_tool_use', 'undefined', undefined)),
    ).rejects.toThrow('hook input payload must be JSON-serializable');

    let nestedFrozen = false;
    const system = new HookSystem(
      [
        registration('freeze', 'pre_tool_use', {
          handle: async (input) => {
            nestedFrozen =
            Object.isFrozen(input) &&
            Object.isFrozen(input.scope) &&
            Object.isFrozen(input.payload) &&
            Object.isFrozen((input.payload as { nested: object }).nested);
          return {
            action: 'attenuate',
            payload: { nested: { accepted: true } },
            };
          },
        }),
      ],
      { attenuationPolicy: allowAttenuation },
    );
    const outcome = await system.dispatch(
      request('pre_tool_use', 'freeze', { nested: { accepted: false } }),
    );
    expect(nestedFrozen).toBe(true);
    expect(Object.isFrozen(outcome.payload)).toBe(true);
    expect(
      Object.isFrozen((outcome.payload as { nested: object }).nested),
    ).toBe(true);
  });

  it.each([null, 0, 'primitive', true] as const)(
    'accepts and preserves JSON primitive payload %j',
    async (payload) => {
      const outcome = await new HookSystem([]).dispatch(
        request('pre_tool_use', `primitive-${String(payload)}`, payload),
      );
      expect(outcome).toMatchObject({
        event: 'pre_tool_use',
        action: 'continue',
        payload,
        follow_ups: [],
        replayed: false,
      });
      expect(Object.isFrozen(outcome)).toBe(true);
    },
  );

  it('fails closed for malformed decision results and ignores malformed observations', async () => {
    const malformed = [
      null,
      {},
      { action: 'continue', extra: true },
      { action: 'continue', [Symbol('hidden')]: true },
      { action: 'attenuate' },
      { action: 'attenuate', payload: {}, extra: true },
      { action: 'deny', reason_code: '' },
      { action: 'deny', reason_code: '   ' },
      { action: 'deny', reason_code: 42 },
      { action: 'deny', reason_code: 'blocked', extra: true },
      { action: 'grant' },
    ];
    for (const [index, result] of malformed.entries()) {
      const decision = new HookSystem([
        registration(`decision-${index}`, 'pre_tool_use', {
          handle: async () => result as never,
        }),
      ]);
      await expect(
        decision.dispatch(request('pre_tool_use', `decision-${index}`, {})),
      ).resolves.toMatchObject({
        action: 'deny',
        reason_code: 'invalid_hook_result',
        replayed: false,
      });

      const audit = new MemoryAudit();
      const observer = new HookSystem(
        [
          registration(`observer-${index}`, 'post_tool_use', {
            handle: async () => result as never,
          }),
        ],
        { audit },
      );
      await expect(
        observer.dispatch(request('post_tool_use', `observer-${index}`, {})),
      ).resolves.toMatchObject({ action: 'continue', payload: {} });
      expect(audit.entries.at(-1)).toMatchObject({
        outcome: 'ignored_invalid_observation',
      });
    }
  });

  it('supports observational continue/follow-up and isolates handler errors', async () => {
    const audit = new MemoryAudit();
    const system = new HookSystem(
      [
        registration('observe', 'post_tool_use', {
          handle: async () => ({
            action: 'observe',
            follow_up: { queue: 'later' },
          }),
        }),
        registration(
          'continue-observer',
          'post_tool_use',
          { handle: async () => ({ action: 'continue' }) },
          { priority: 101 },
        ),
        registration(
          'throw-observer',
          'post_tool_use',
          {
            handle: async () => {
              throw new TypeError('observer failed');
            },
          },
          { priority: 102 },
        ),
      ],
      { audit },
    );
    const outcome = await system.dispatch(
      request('post_tool_use', 'observe-all', { ok: true }),
    );
    expect(outcome).toMatchObject({
      action: 'continue',
      payload: { ok: true },
      follow_ups: [{ queue: 'later' }],
    });
    expect(audit.entries.map((entry) => entry.outcome)).toEqual([
      'observed',
      'observed',
      'ignored_invalid_observation',
    ]);

    const decision = new HookSystem([
      registration('throw-decision', 'pre_tool_use', {
        handle: async () => {
          throw 'not-an-error';
        },
      }),
    ]);
    await expect(
      decision.dispatch(request('pre_tool_use', 'throw-decision', {})),
    ).resolves.toMatchObject({ action: 'deny', reason_code: 'hook_error' });
  });

  it('handles pre-aborted observational events and in-flight cancellation', async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      new HookSystem([]).dispatch(
        request(
          'post_tool_use',
          'pre-aborted-observer',
          { done: true },
          preAborted.signal,
        ),
      ),
    ).resolves.toMatchObject({
      action: 'continue',
      payload: { done: true },
      replayed: false,
    });

    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const system = new HookSystem([
      registration('in-flight', 'pre_tool_use', {
        handle: async () => {
          markStarted();
          return new Promise(() => undefined);
        },
      }),
    ]);
    const pending = system.dispatch(
      request('pre_tool_use', 'in-flight', {}, controller.signal),
    );
    await started;
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      action: 'deny',
      reason_code: 'hook_cancelled',
    });
  });

  it('hashes canonical inputs for replay and preserves restrictive replay metadata', async () => {
    const journal = new MemoryJournal();
    const system = new HookSystem(
      [
        registration('deny-once', 'pre_tool_use', {
          handle: async () => ({ action: 'deny', reason_code: 'policy_hook' }),
        }),
      ],
      { journal },
    );
    const first = await system.dispatch(
      request('pre_tool_use', 'canonical', { b: [2, 3], a: 1 }),
    );
    const replay = await system.dispatch(
      request('pre_tool_use', 'canonical', { a: 1, b: [2, 3] }),
    );
    expect(first).toMatchObject({
      action: 'deny',
      reason_code: 'policy_hook',
      replayed: false,
    });
    expect(replay).toMatchObject({
      action: 'deny',
      reason_code: 'policy_hook',
      replayed: true,
    });
    expect(replay.follow_ups).toEqual([]);
    await expect(
      system.dispatch(request('pre_tool_use', 'canonical', { a: 1, b: [23] })),
    ).rejects.toThrow(/collision/u);

    const nestedKey = 'canonical-nested';
    await system.dispatch(
      request('pre_tool_use', nestedKey, { rows: [{ z: 2, a: 1 }] }),
    );
    await expect(
      system.dispatch(
        request('pre_tool_use', nestedKey, { rows: [{ a: 1, z: 2 }] }),
      ),
    ).resolves.toMatchObject({ replayed: true });
  });

  it('records exact audit outcomes, timing, and rejects an invalid clock', async () => {
    let monotonic = 10;
    const audit = new MemoryAudit();
    const system = new HookSystem(
      [
        registration('audited-deny', 'pre_tool_use', {
          handle: async () => ({ action: 'deny', reason_code: 'denied' }),
        }),
      ],
      {
        audit,
        now: () => '2026-08-02T00:00:00.000Z',
        monotonicNow: () => {
          monotonic += 2;
          return monotonic;
        },
      },
    );
    await system.dispatch(request('pre_tool_use', 'audit-deny', {}));
    expect(audit.entries[0]).toMatchObject({
      outcome: 'denied',
      reason_code: 'denied',
      duration_ms: 2,
    });

    const invalidClock = new HookSystem(
      [
        registration('clock', 'pre_tool_use', {
          handle: async () => ({ action: 'continue' }),
        }),
      ],
      { audit: new MemoryAudit(), now: () => 'not-a-time' },
    );
    await expect(
      invalidClock.dispatch(request('pre_tool_use', 'bad-clock', {})),
    ).rejects.toThrow(/audit clock/u);
  });

  it.each([
    ['deny', 'denied'],
    ['skip', 'skipped'],
    ['force_prompt', 'forced_prompt'],
  ] as const)('audits restrictive %s as %s', async (action, auditOutcome) => {
    const audit = new MemoryAudit();
    const system = new HookSystem(
      [
        registration(`audit-${action}`, 'pre_tool_use', {
          handle: async () => ({ action, reason_code: `reason-${action}` }),
        }),
      ],
      { audit },
    );
    await system.dispatch(request('pre_tool_use', `audit-${action}`, {}));
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      outcome: auditOutcome,
      reason_code: `reason-${action}`,
    });
  });

  it('removes the external abort listener and clears timeout after completion', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, 'addEventListener');
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const system = new HookSystem([
        registration('cleanup', 'pre_tool_use', {
          handle: async () => ({ action: 'continue' }),
        }),
      ]);

      await system.dispatch(
        request('pre_tool_use', 'cleanup', {}, controller.signal),
      );

      expect(add).toHaveBeenCalledWith('abort', expect.any(Function), {
        once: true,
      });
      const listener = add.mock.calls[0]![1];
      expect(remove).toHaveBeenCalledWith('abort', listener);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
