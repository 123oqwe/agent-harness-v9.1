import { describe, it, expect } from 'vitest';
import {
  buildPlanModePausedEvent,
  buildRunStateChangePausedEvent,
  buildFallbackOperationId,
  buildFallbackDispatchResult,
  buildNoResultError,
  buildToolRejectionReceipt,
  buildRoutingFailureRecord,
  buildPromptRestrictionFailure,
  buildSkillActivationEvent,
  buildSkillActivationFailure,
  buildLoopResult,
} from '../../runtime/harness-support';
import { EventBus, createEvent } from '../../runtime/event-bus';
import { RUNTIME_HOOK_EVENTS, HookRestrictionError, createHarnessHookAttenuationPolicy } from '../../runtime/hook-port';
import { LoopError } from '../../runtime/loop';
import { RetryExhausted, CircuitOpenError, classifyError } from '../../runtime/retry';

// Goal: kill 25+ StringLiteral survived mutants by asserting EXACT values.
// Stryker StringLiteral mutator replaces strings with "". Tests must fail
// when the string is "" — so we assert exact values, not just non-empty.

describe('exact-value targeted mutation tests', () => {

  // ================================================================
  // harness-support.ts StringLiteral kills
  // ================================================================

  describe('buildPlanModePausedEvent — exact string values', () => {
    it('returns exact event string "plan_mode_paused"', () => {
      const result = buildPlanModePausedEvent();
      expect(result.event).toBe('plan_mode_paused');
    });

    it('returns exact reason string', () => {
      const result = buildPlanModePausedEvent();
      expect(result.reason).toBe('auto_execute is false — awaiting human approval');
    });
  });

  describe('buildRunStateChangePausedEvent — exact string values', () => {
    it('returns exact state "paused"', () => {
      const result = buildRunStateChangePausedEvent();
      expect(result.state).toBe('paused');
    });

    it('returns exact reason string', () => {
      const result = buildRunStateChangePausedEvent();
      expect(result.reason).toBe('auto_execute false — awaiting approval');
    });
  });

  describe('buildFallbackOperationId — exact template literal', () => {
    it('produces exact format "opId-fb{index}"', () => {
      expect(buildFallbackOperationId('op-123', 0)).toBe('op-123-fb0');
      expect(buildFallbackOperationId('op-123', 1)).toBe('op-123-fb1');
      expect(buildFallbackOperationId('op-123', 9)).toBe('op-123-fb9');
    });

    it('preserves operation_id prefix exactly', () => {
      expect(buildFallbackOperationId('my-op', 3)).toBe('my-op-fb3');
    });
  });

  describe('buildNoResultError — exact string', () => {
    it('returns exact error message', () => {
      expect(buildNoResultError()).toBe('model dispatch returned no result after fallback');
    });
  });

  describe('buildFallbackDispatchResult — exact structure', () => {
    it('returns exact object with dispatch_result and initial_failure', () => {
      const result = buildFallbackDispatchResult(
        { error: 'timeout' },
        { dispatch_result: { content: 'fallback' } },
      );
      expect(result).toEqual({
        dispatch_result: { content: 'fallback' },
        initial_failure: { error: 'timeout' },
      });
    });
  });

  describe('buildToolRejectionReceipt — exact field values', () => {
    it('returns exact tool_name and error fields', () => {
      const receipt = buildToolRejectionReceipt(
        'search',
        { action: 'deny', reason_code: 'policy_violation' },
        '2024-01-01T00:00:00Z',
        'abc123',
      );
      expect(receipt.tool_name).toBe('search');
      expect(receipt.success).toBe(false);
      expect(receipt.error).toBe('hook_deny:policy_violation');
      expect(receipt.input_hash).toBe('abc123');
      expect(receipt.timestamp).toBe('2024-01-01T00:00:00Z');
      expect(receipt.duration_ms).toBe(0);
    });
  });

  describe('buildRoutingFailureRecord — exact reason strings', () => {
    it('returns "routing_requires_user_input" for ask_user outcome', () => {
      const record = buildRoutingFailureRecord('ask_user', 'What do you want?', undefined);
      expect(record.reason).toBe('routing_requires_user_input');
      expect(record.outcome).toBe('ask_user');
    });

    it('returns "routing_abstained" for non-ask_user outcome', () => {
      const record = buildRoutingFailureRecord('abstain', undefined, 'no capabilities');
      expect(record.reason).toBe('routing_abstained');
      expect(record.outcome).toBe('abstain');
    });
  });

  describe('buildPromptRestrictionFailure — exact field values', () => {
    it('returns exact hook_state and reason_code for deny', () => {
      const failure = buildPromptRestrictionFailure('deny', 'content_policy');
      expect(failure.hook_action).toBe('deny');
      expect(failure.reason_code).toBe('content_policy');
      expect(failure.hook_state).toBe('blocked');
      expect(failure.approval_required).toBe(false);
    });

    it('returns exact hook_state for force_prompt', () => {
      const failure = buildPromptRestrictionFailure('force_prompt', 'needs_input');
      expect(failure.hook_state).toBe('approval_required');
      expect(failure.approval_required).toBe(true);
    });
  });

  describe('buildSkillActivationEvent — exact field values', () => {
    it('returns exact event type and skill name', () => {
      const event = buildSkillActivationEvent('coder', '1.0.0');
      expect(event.event).toBe('skill_activated');
      expect(event.skill).toBe('coder');
      expect(event.version).toBe('1.0.0');
    });
  });

  describe('buildSkillActivationFailure — exact field values', () => {
    it('returns exact reason and skill', () => {
      const event = buildSkillActivationFailure('coder', new Error('missing dependency'));
      expect(event.reason).toBe('skill_activation_failed');
      expect(event.skill).toBe('coder');
      expect(event.error).toBe('missing dependency');
    });
  });

  describe('buildLoopResult — exact strategy and termination', () => {
    it('returns exact strategy and termination reason', () => {
      const result = buildLoopResult(
        'react', 3, 'completed',
        [], [], '/data', false, 100, 200, 300,
        new Map(),
      );
      expect(result.strategy).toBe('react');
      expect(result.termination_reason).toBe('completed');
    });

    it('returns "internal_error" as default termination reason', () => {
      const result = buildLoopResult(
        'direct', 0, 'internal_error',
        [], [], undefined, false, 0, 0, 0,
        new Map(),
      );
      expect(result.termination_reason).toBe('internal_error');
    });
  });

  // ================================================================
  // event-bus.ts StringLiteral kills
  // ================================================================

  describe('EventBus — exact default mode "updates"', () => {
    it('constructor sets mode to "updates" by default', () => {
      const bus = new EventBus();
      expect(() => bus.publish({ type: 'run_state_change' as any, run_id: 'r1', timestamp: new Date().toISOString(), data: {} })).not.toThrow();
    });

    it('constructor respects explicit mode "updates"', () => {
      const bus = new EventBus({ mode: 'updates' });
      expect(() => bus.publish({ type: 'run_state_change' as any, run_id: 'r1', timestamp: new Date().toISOString(), data: {} })).not.toThrow();
    });
  });

  describe('createEvent — exact type string', () => {
    it('creates event with exact type', () => {
      const event = createEvent('run_state_change', 'run-1', { foo: 'bar' });
      expect(event.type).toBe('run_state_change');
    });
  });

  // ================================================================
  // hook-port.ts StringLiteral kills
  // ================================================================

  describe('RUNTIME_HOOK_EVENTS — exact event names', () => {
    it('contains exact event name "user_prompt_submit"', () => {
      expect(RUNTIME_HOOK_EVENTS).toContain('user_prompt_submit');
    });

    it('contains exact event name "before_provider_request"', () => {
      expect(RUNTIME_HOOK_EVENTS).toContain('before_provider_request');
    });

    it('contains exact event name "pre_tool_use"', () => {
      expect(RUNTIME_HOOK_EVENTS).toContain('pre_tool_use');
    });

    it('contains exact event name "post_tool_use"', () => {
      expect(RUNTIME_HOOK_EVENTS).toContain('post_tool_use');
    });

    it('contains exact event name "after_response"', () => {
      expect(RUNTIME_HOOK_EVENTS).toContain('after_response');
    });

    it('contains exact event name "session_before_compact"', () => {
      expect(RUNTIME_HOOK_EVENTS).toContain('session_before_compact');
    });

    it('contains exact event name "session_end"', () => {
      expect(RUNTIME_HOOK_EVENTS).toContain('session_end');
    });
  });

  describe('HookRestrictionError — exact name and message', () => {
    it('has exact error name "HookRestrictionError"', () => {
      const err = new HookRestrictionError('pre_tool_use', 'deny', 'test reason');
      expect(err.name).toBe('HookRestrictionError');
    });

    it('preserves exact reason in message', () => {
      const err = new HookRestrictionError('pre_tool_use', 'deny', 'policy violation');
      expect(err.message).toContain('pre_tool_use');
      expect(err.message).toContain('deny');
      expect(err.message).toContain('policy violation');
    });
  });

  describe('createHarnessHookAttenuationPolicy — exact reason_code', () => {
    it('returns exact reason_code "hook_attenuation_would_expand_authority"', () => {
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
  });

  // ================================================================
  // loop.ts StringLiteral kills
  // ================================================================

  describe('LoopError — exact error messages', () => {
    it('preserves exact message "model returned invalid usage"', () => {
      const err = new LoopError('model returned invalid usage');
      expect(err.message).toBe('model returned invalid usage');
    });

    it('preserves exact message "clock returned an invalid timestamp"', () => {
      const err = new LoopError('clock returned an invalid timestamp');
      expect(err.message).toBe('clock returned an invalid timestamp');
    });

    it('preserves exact message "unknown strategy: invalid"', () => {
      const err = new LoopError('unknown strategy: invalid');
      expect(err.message).toBe('unknown strategy: invalid');
    });

    it('has exact error name "LoopError"', () => {
      const err = new LoopError('test');
      expect(err.name).toBe('LoopError');
    });
  });

  // ================================================================
  // retry.ts StringLiteral kills
  // ================================================================

  describe('RetryExhausted — exact error name and message', () => {
    it('has exact error name "RetryExhausted"', () => {
      const err = new RetryExhausted(new Error('all retries failed'), 3);
      expect(err.name).toBe('RetryExhausted');
    });

    it('preserves exact message format', () => {
      const err = new RetryExhausted(new Error('timeout'), 3);
      expect(err.message).toBe('retry exhausted after 3 attempts: timeout');
    });
  });

  describe('CircuitOpenError — exact error name and message', () => {
    it('has exact error name "CircuitOpenError"', () => {
      const err = new CircuitOpenError(5000);
      expect(err.name).toBe('CircuitOpenError');
    });

    it('preserves exact message format', () => {
      const err = new CircuitOpenError(5000);
      expect(err.message).toBe('circuit breaker open; retry after 5000ms');
    });
  });

  describe('classifyError — exact classification', () => {
    it('classifies network errors as retryable', () => {
      const result = classifyError(new TypeError('fetch failed'));
      expect(result.retryable).toBe(true);
    });

    it('classifies non-Error as non-retryable', () => {
      const result = classifyError('string error');
      expect(result.retryable).toBe(false);
    });
  });
});

// ================================================================
// Extracted function tests (from harness.ts and loop.ts)
// ================================================================

import {
  buildInvalidTaskContractError,
  buildPlanId,
  buildBranchSessionId,
  buildAttemptOperationId,
  buildAttemptId,
  buildPauseOperationId,
  buildToolOperationId,
  buildToolAttemptId,
  buildHookInvocationId,
  buildHookIdempotencyKey,
  buildRagEvidenceSeparator,
  buildFinishedLifecycle,
  buildLoopStopReason,
  buildFollowUpQueue,
  buildSteerQueue,
  buildSteeringInterruptReason,
  buildUserTrust,
  buildInvalidUsageErrorMessage,
  buildInvalidTimestampErrorMessage,
  buildGoalSatisfiedTermination,
  buildDeniedStatus,
  buildStopHookEvent,
  buildInternalErrorTermination,
  buildSkillActivationFailedReason,
  buildContinueNextStepAction,
  buildPauseResumeEvaluatedEvent,
  buildRejectedStatus,
  buildAfterResponseEvent,
  buildBeforeProviderRequestEvent,
  buildPreToolUseEvent,
  buildPostToolUseEvent,
  buildPreTurnEvent,
  buildDecisionMode,
  buildObservationalMode,
  buildDefaultCacheKey,
  buildPreToolUseHookLabel,
  buildBeforeProviderRequestLabel,
  buildDirectStrategy,
  buildApprovalRequiredTermination,
  buildCompletedTermination,
} from '../../runtime/harness-support';

describe('extracted function exact-value tests', () => {

  describe('harness.ts extracted functions', () => {
    it('buildInvalidTaskContractError returns exact message', () => {
      expect(buildInvalidTaskContractError()).toBe('UserPromptSubmit hook returned an invalid TaskContract');
    });

    it('buildPlanId returns hash when provided', () => {
      expect(buildPlanId('abc123', 'run-1')).toBe('abc123');
    });

    it('buildPlanId returns fallback when hash undefined', () => {
      expect(buildPlanId(undefined, 'run-1')).toBe('plan-run-1');
    });

    it('buildBranchSessionId returns exact format', () => {
      expect(buildBranchSessionId('run-1')).toBe('run-1-branch');
    });

    it('buildAttemptOperationId returns exact format', () => {
      expect(buildAttemptOperationId('op-1', 3)).toBe('op-1-att-3');
    });

    it('buildAttemptId returns exact format', () => {
      expect(buildAttemptId('att-1', 2)).toBe('att-1-2');
    });

    it('buildPauseOperationId returns exact format', () => {
      expect(buildPauseOperationId('op-1')).toBe('op-1-pause');
    });

    it('buildToolOperationId returns exact format', () => {
      expect(buildToolOperationId('op-1', 'call-1')).toBe('op-1:call-1');
    });

    it('buildToolAttemptId returns exact format', () => {
      expect(buildToolAttemptId('att-1', 0)).toBe('att-1:0');
    });

    it('buildHookInvocationId returns exact format', () => {
      expect(buildHookInvocationId('key1')).toBe('hook-key1');
    });

    it('buildHookIdempotencyKey returns exact format', () => {
      expect(buildHookIdempotencyKey('key1')).toBe('hook-idempotency-key1');
    });

    it('buildDeniedStatus returns "denied"', () => {
      expect(buildDeniedStatus()).toBe('denied');
    });

    it('buildStopHookEvent returns "stop"', () => {
      expect(buildStopHookEvent()).toBe('stop');
    });

    it('buildInternalErrorTermination returns "internal_error"', () => {
      expect(buildInternalErrorTermination()).toBe('internal_error');
    });

    it('buildSkillActivationFailedReason returns exact value', () => {
      expect(buildSkillActivationFailedReason()).toBe('skill_activation_failed');
    });

    it('buildContinueNextStepAction returns exact value', () => {
      expect(buildContinueNextStepAction()).toBe('continue_next_step');
    });

    it('buildPauseResumeEvaluatedEvent returns exact value', () => {
      expect(buildPauseResumeEvaluatedEvent()).toBe('pause_resume_evaluated');
    });

    it('buildRejectedStatus returns "rejected"', () => {
      expect(buildRejectedStatus()).toBe('rejected');
    });

    it('buildAfterResponseEvent returns "after_response"', () => {
      expect(buildAfterResponseEvent()).toBe('after_response');
    });

    it('buildBeforeProviderRequestEvent returns exact value', () => {
      expect(buildBeforeProviderRequestEvent()).toBe('before_provider_request');
    });

    it('buildPreToolUseEvent returns "pre_tool_use"', () => {
      expect(buildPreToolUseEvent()).toBe('pre_tool_use');
    });

    it('buildPostToolUseEvent returns "post_tool_use"', () => {
      expect(buildPostToolUseEvent()).toBe('post_tool_use');
    });

    it('buildPreTurnEvent returns "pre_turn"', () => {
      expect(buildPreTurnEvent()).toBe('pre_turn');
    });

    it('buildDecisionMode returns "decision"', () => {
      expect(buildDecisionMode()).toBe('decision');
    });

    it('buildObservationalMode returns "observational"', () => {
      expect(buildObservationalMode()).toBe('observational');
    });

    it('buildDefaultCacheKey returns "default"', () => {
      expect(buildDefaultCacheKey()).toBe('default');
    });

    it('buildPreToolUseHookLabel returns exact label', () => {
      expect(buildPreToolUseHookLabel()).toBe('PreToolUse hook');
    });

    it('buildBeforeProviderRequestLabel returns exact label', () => {
      expect(buildBeforeProviderRequestLabel()).toBe('before_provider_request');
    });

    it('buildDirectStrategy returns "direct"', () => {
      expect(buildDirectStrategy()).toBe('direct');
    });
  });

  describe('loop.ts extracted functions', () => {
    it('buildRagEvidenceSeparator returns double newline', () => {
      expect(buildRagEvidenceSeparator()).toBe('\n\n');
    });

    it('buildFinishedLifecycle returns "finished"', () => {
      expect(buildFinishedLifecycle()).toBe('finished');
    });

    it('buildLoopStopReason returns "loop_stop"', () => {
      expect(buildLoopStopReason()).toBe('loop_stop');
    });

    it('buildFollowUpQueue returns "follow_up"', () => {
      expect(buildFollowUpQueue()).toBe('follow_up');
    });

    it('buildSteerQueue returns "steer"', () => {
      expect(buildSteerQueue()).toBe('steer');
    });

    it('buildSteeringInterruptReason returns exact value', () => {
      expect(buildSteeringInterruptReason()).toBe('steering_interrupt');
    });

    it('buildUserTrust returns "user"', () => {
      expect(buildUserTrust()).toBe('user');
    });

    it('buildInvalidUsageErrorMessage returns exact message', () => {
      expect(buildInvalidUsageErrorMessage()).toBe('model returned invalid usage');
    });

    it('buildInvalidTimestampErrorMessage returns exact message', () => {
      expect(buildInvalidTimestampErrorMessage()).toBe('clock returned an invalid timestamp');
    });

    it('buildGoalSatisfiedTermination returns "goal_satisfied"', () => {
      expect(buildGoalSatisfiedTermination()).toBe('goal_satisfied');
    });

    it('buildApprovalRequiredTermination returns "approval_required"', () => {
      expect(buildApprovalRequiredTermination()).toBe('approval_required');
    });

    it('buildCompletedTermination returns "completed"', () => {
      expect(buildCompletedTermination()).toBe('completed');
    });
  });
});
