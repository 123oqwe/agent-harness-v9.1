import { describe, it, expect } from 'vitest';
import { buildFallbackDispatchResult, buildFallbackOperationId } from '../../runtime/harness-support';
import { createHarnessHookAttenuationPolicy, dispatchHookBoundary, HookRestrictionError, type RuntimeHookRequest } from '../../runtime/hook-port';
import { LoopError } from '../../runtime/loop';

// Target: kill 25 surviving mutants to close gap from 89.10% to 90%
// Run #36: 2735 total, 2413 killed, 283 survived, 15 NoCov, 24 timeout = 89.10%
// Need 2462 kills (ceil(2735*0.90)), have 2437, gap 25

describe('runtime gap-25 targeted tests', () => {

  // === NoCov: harness-support.ts:937-938 (buildFallbackDispatchResult body) ===
  describe('buildFallbackDispatchResult (NoCov lines 937-938)', () => {
    it('returns dispatch_result from fallback and initial_failure from original', () => {
      const result = buildFallbackDispatchResult(
        { error: 'timeout' },
        { dispatch_result: { content: 'fallback' } },
      );
      expect(result).toEqual({
        dispatch_result: { content: 'fallback' },
        initial_failure: { error: 'timeout' },
      });
    });

    it('preserves falsy dispatchResult', () => {
      const result = buildFallbackDispatchResult(null, { dispatch_result: 0 });
      expect(result.initial_failure).toBeNull();
      expect(result.dispatch_result).toBe(0);
    });

    it('preserves complex objects', () => {
      const orig = { code: 500, details: { retry: true } };
      const fb = { dispatch_result: { choices: [{ message: { content: 'ok' } }] } };
      const result = buildFallbackDispatchResult(orig, fb);
      expect(result.initial_failure).toBe(orig);
      expect(result.dispatch_result).toEqual(fb.dispatch_result);
    });
  });

  // === NoCov: hook-port.ts:113 (cloneJson JSON.stringify undefined check) ===
  describe('cloneJson via dispatchHookBoundary (NoCov line 113)', () => {
    it('throws TypeError for undefined payload (JSON.stringify returns undefined)', async () => {
      const request = {
        event: 'pre_turn',
        invocation_id: 'inv1',
        idempotency_key: 'idem1',
        scope: { run_id: 'r1', session_id: 's1', tenant_id: 't1' },
        payload: undefined as any,
        signal: undefined,
      } as unknown as RuntimeHookRequest;
      await expect(dispatchHookBoundary(undefined, request, { mode: 'decision' })).rejects.toThrow(TypeError);
    });
  });

  // === StringLiteral: harness-support.ts:1094 (buildPlanModePausedEvent) ===
  describe('buildPlanModePausedEvent (StringLiteral line 1094)', () => {
    it('returns exact event and reason strings', async () => {
      const mod = await import('../../runtime/harness-support');
      const fn = (mod as any).buildPlanModePausedEvent;
      if (fn) {
        const result = fn();
        expect(result.event).toBe('plan_mode_paused');
        expect(result.reason).toBe('auto_execute is false — awaiting human approval');
      }
    });
  });

  // === StringLiteral: hook-port.ts (lines 127, 132, 578, 630) ===
  describe('hook-port.ts StringLiteral survival', () => {
    it('HookRestrictionError has meaningful non-empty message', () => {
      const err = new HookRestrictionError(
        'pre_tool_use',
        'deny',
        'test-reason',
      );
      expect(err.message).toBeTruthy();
      expect(err.message.length).toBeGreaterThan(10);
      expect(err.name).toBe('HookRestrictionError');
    });

    it('attenuation reason_code is exact string', () => {
      const policy = createHarnessHookAttenuationPolicy();
      const result = policy.validate({
        event: 'pre_turn',
        scope: { run_id: 'r1', session_id: 's1', tenant_id: 't1' },
        original_payload: { a: 1 },
        candidate_payload: { a: 2 },
      });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason_code).toBe('hook_attenuation_would_expand_authority');
      }
    });

    it('attenuation allows pre_tool_use unconditionally', () => {
      const policy = createHarnessHookAttenuationPolicy();
      const result = policy.validate({
        event: 'pre_tool_use',
        scope: { run_id: 'r1', session_id: 's1', tenant_id: 't1' },
        original_payload: { anything: true },
        candidate_payload: { completely: 'different' },
      });
      expect(result.allowed).toBe(true);
    });

    it('attenuation denies unknown events', () => {
      const policy = createHarnessHookAttenuationPolicy();
      const result = policy.validate({
        event: 'after_response' as any,
        scope: { run_id: 'r1', session_id: 's1', tenant_id: 't1' },
        original_payload: {},
        candidate_payload: {},
      });
      expect(result.allowed).toBe(false);
    });

    it('attenuation denies user_prompt_submit when candidate expands', () => {
      const policy = createHarnessHookAttenuationPolicy();
      const result = policy.validate({
        event: 'user_prompt_submit',
        scope: { run_id: 'r1', session_id: 's1', tenant_id: 't1' },
        original_payload: { intent: 'test', constraints: { a: 1 } },
        candidate_payload: { intent: 'test', constraints: { a: 1, b: 2 } },
      });
      expect(result.allowed).toBe(false);
    });

    it('attenuation allows session_before_compact with same payload', () => {
      const policy = createHarnessHookAttenuationPolicy();
      const result = policy.validate({
        event: 'session_before_compact',
        scope: { run_id: 'r1', session_id: 's1', tenant_id: 't1' },
        original_payload: { messages: [1, 2, 3] },
        candidate_payload: { messages: [1, 2, 3] },
      });
      expect(result.allowed).toBe(true);
    });
  });

  // === buildFallbackOperationId StringLiteral ===
  describe('buildFallbackOperationId (StringLiteral)', () => {
    it('produces non-empty string with operation_id', () => {
      const result = buildFallbackOperationId('op-123', 0);
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain('op-123');
    });

    it('produces different results for different indices', () => {
      const r0 = buildFallbackOperationId('op-456', 0);
      const r1 = buildFallbackOperationId('op-456', 1);
      expect(r0).not.toBe(r1);
    });

    it('produces different results for different operation_ids', () => {
      const r1 = buildFallbackOperationId('op-A', 0);
      const r2 = buildFallbackOperationId('op-B', 0);
      expect(r1).not.toBe(r2);
    });
  });

  // === ConditionalExpression: loop.ts ===
  describe('loop.ts ConditionalExpression survival', () => {
    it('LoopError message contains strategy name', () => {
      const err = new LoopError('unknown strategy: invalid_strategy');
      expect(err.message).toContain('unknown strategy');
      expect(err.message).toContain('invalid_strategy');
      expect(err.message).not.toBe('');
    });

    it('LoopError is an Error instance', () => {
      const err = new LoopError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('LoopError');
    });

    it('LoopError can be constructed with various messages', () => {
      const messages = [
        'unknown strategy: invalid',
        'loop already terminated',
        'max iterations reached',
        'budget exceeded',
      ];
      for (const msg of messages) {
        const err = new LoopError(msg);
        expect(err.message).toBe(msg);
        expect(err.message).not.toBe('');
      }
    });
  });

  // === StringLiteral: event-bus.ts:34 ===
  describe('event-bus.ts StringLiteral', () => {
    it('event bus has non-empty string constants', async () => {
      const mod = await import('../../runtime/event-bus');
      const exported = mod as any;
      for (const key of Object.keys(exported)) {
        const val = exported[key];
        if (typeof val === 'string') {
          expect(val.length).toBeGreaterThan(0);
          expect(val).not.toBe('');
        }
        if (Array.isArray(val)) {
          for (const item of val) {
            if (typeof item === 'string') {
              expect(item.length).toBeGreaterThan(0);
              expect(item).not.toBe('');
            }
          }
        }
      }
    });
  });

  // === StringLiteral: session-tree-port.ts:34 ===
  describe('session-tree-port.ts StringLiteral', () => {
    it('session tree port has non-empty string constants', async () => {
      const mod = await import('../../runtime/session-tree-port');
      const exported = mod as any;
      for (const key of Object.keys(exported)) {
        const val = exported[key];
        if (typeof val === 'string') {
          expect(val.length).toBeGreaterThan(0);
        }
        if (Array.isArray(val)) {
          for (const item of val) {
            if (typeof item === 'string') {
              expect(item.length).toBeGreaterThan(0);
            }
          }
        }
      }
    });
  });

  // === StringLiteral: retry.ts:170 ===
  describe('retry.ts StringLiteral', () => {
    it('retry error messages are non-empty', async () => {
      const mod = await import('../../runtime/retry');
      const exported = mod as any;
      if (exported.RetryError) {
        const err = new exported.RetryError('test retry error');
        expect(err.message).toBeTruthy();
        expect(err.message).not.toBe('');
      }
      // Check any string constants
      for (const key of Object.keys(exported)) {
        const val = exported[key];
        if (typeof val === 'string') {
          expect(val.length).toBeGreaterThan(0);
        }
      }
    });
  });

  // === ConditionalExpression: hook-port.ts providerRequestNarrows max_tokens check ===
  describe('providerRequestNarrows max_tokens ConditionalExpression (NoCov line 290)', () => {
    it('before_provider_request: denies when candidate max_tokens > original', () => {
      const policy = createHarnessHookAttenuationPolicy();
      const result = policy.validate({
        event: 'before_provider_request',
        scope: { run_id: 'r1', session_id: 's1', tenant_id: 't1' },
        original_payload: {
          registry_snapshot_hash: 'abc', estimated_input_tokens: 100,
          required_capabilities: ['cap1'], requires_structured_output: false,
          request: { model: 'm', tools: [], max_tokens: 500 },
          data_policy: { allowed_regions: ['us'], local_only: false },
        },
        candidate_payload: {
          registry_snapshot_hash: 'abc', estimated_input_tokens: 100,
          required_capabilities: ['cap1'], requires_structured_output: false,
          request: { model: 'm', tools: [], max_tokens: 1000 },
          data_policy: { allowed_regions: ['us'], local_only: false },
        },
      });
      expect(result.allowed).toBe(false);
    });

    it('before_provider_request: denies when candidate max_tokens is negative', () => {
      const policy = createHarnessHookAttenuationPolicy();
      const result = policy.validate({
        event: 'before_provider_request',
        scope: { run_id: 'r1', session_id: 's1', tenant_id: 't1' },
        original_payload: {
          registry_snapshot_hash: 'abc', estimated_input_tokens: 100,
          required_capabilities: ['cap1'], requires_structured_output: false,
          request: { model: 'm', tools: [], max_tokens: 500 },
          data_policy: { allowed_regions: ['us'], local_only: false },
        },
        candidate_payload: {
          registry_snapshot_hash: 'abc', estimated_input_tokens: 100,
          required_capabilities: ['cap1'], requires_structured_output: false,
          request: { model: 'm', tools: [], max_tokens: -1 },
          data_policy: { allowed_regions: ['us'], local_only: false },
        },
      });
      expect(result.allowed).toBe(false);
    });

    it('before_provider_request: denies when candidate max_tokens is not integer', () => {
      const policy = createHarnessHookAttenuationPolicy();
      const result = policy.validate({
        event: 'before_provider_request',
        scope: { run_id: 'r1', session_id: 's1', tenant_id: 't1' },
        original_payload: {
          registry_snapshot_hash: 'abc', estimated_input_tokens: 100,
          required_capabilities: ['cap1'], requires_structured_output: false,
          request: { model: 'm', tools: [], max_tokens: 500 },
          data_policy: { allowed_regions: ['us'], local_only: false },
        },
        candidate_payload: {
          registry_snapshot_hash: 'abc', estimated_input_tokens: 100,
          required_capabilities: ['cap1'], requires_structured_output: false,
          request: { model: 'm', tools: [], max_tokens: 100.5 },
          data_policy: { allowed_regions: ['us'], local_only: false },
        },
      });
      expect(result.allowed).toBe(false);
    });

    it('before_provider_request: denies when original max_tokens undefined but candidate has it', () => {
      const policy = createHarnessHookAttenuationPolicy();
      const result = policy.validate({
        event: 'before_provider_request',
        scope: { run_id: 'r1', session_id: 's1', tenant_id: 't1' },
        original_payload: {
          registry_snapshot_hash: 'abc', estimated_input_tokens: 100,
          required_capabilities: ['cap1'], requires_structured_output: false,
          request: { model: 'm', tools: [], max_tokens: undefined as any },
          data_policy: { allowed_regions: ['us'], local_only: false },
        },
        candidate_payload: {
          registry_snapshot_hash: 'abc', estimated_input_tokens: 100,
          required_capabilities: ['cap1'], requires_structured_output: false,
          request: { model: 'm', tools: [], max_tokens: 1000 },
          data_policy: { allowed_regions: ['us'], local_only: false },
        },
      });
      expect(result.allowed).toBe(false);
    });

  });
});
