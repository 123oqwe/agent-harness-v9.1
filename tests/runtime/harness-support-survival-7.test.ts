import { describe, it, expect } from 'vitest';
import {
  buildRuntimeErrorEvent,
  buildPostTurnHookFailedEvent,
  buildProgressWriteFailedEvent,
  buildToolDispatchError,
  buildHookRestrictionReasonCode,
  buildPromptRestrictionReasonCode,
  buildNoResultError,
  buildWorkspaceFinalizeFailedMessage,
  buildSkillActivationFailure,
} from '../../runtime/harness-support.js';

describe('harness-support-survival-7: extracted error event builders', () => {
  describe('buildRuntimeErrorEvent', () => {
    it('builds event with Error instance', () => {
      const result = buildRuntimeErrorEvent('provider_failure', new Error('timeout'));
      expect(result).toEqual({
        event: 'runtime_error',
        classification: 'provider_failure',
        message: 'timeout',
      });
    });

    it('builds event with non-Error value', () => {
      const result = buildRuntimeErrorEvent('internal_error', 'string error');
      expect(result.message).toBe('unknown runtime error');
      expect(result.event).toBe('runtime_error');
      expect(result.classification).toBe('internal_error');
    });

    it('builds event with null', () => {
      const result = buildRuntimeErrorEvent('malformed_response', null);
      expect(result.message).toBe('unknown runtime error');
    });

    it('has exactly 3 keys', () => {
      const result = buildRuntimeErrorEvent('test', new Error('x'));
      expect(Object.keys(result).sort()).toEqual(['classification', 'event', 'message']);
    });

    it('preserves classification for all termination reasons', () => {
      for (const reason of ['user_cancel', 'budget_exhausted', 'deadline', 'provider_failure', 'internal_error']) {
        const result = buildRuntimeErrorEvent(reason, new Error('e'));
        expect(result.classification).toBe(reason);
      }
    });
  });

  describe('buildPostTurnHookFailedEvent', () => {
    it('builds event with Error instance', () => {
      const result = buildPostTurnHookFailedEvent(new Error('hook crashed'));
      expect(result).toEqual({
        event: 'post_turn_hook_failed',
        message: 'hook crashed',
      });
    });

    it('builds event with non-Error value', () => {
      const result = buildPostTurnHookFailedEvent(42);
      expect(result.message).toBe('unknown hook error');
      expect(result.event).toBe('post_turn_hook_failed');
    });

    it('has exactly 2 keys', () => {
      const result = buildPostTurnHookFailedEvent(new Error('x'));
      expect(Object.keys(result).sort()).toEqual(['event', 'message']);
    });
  });

  describe('buildProgressWriteFailedEvent', () => {
    it('builds event with Error instance', () => {
      const result = buildProgressWriteFailedEvent(new Error('EACCES'));
      expect(result).toEqual({
        event: 'progress_write_failed',
        message: 'EACCES',
      });
    });

    it('builds event with non-Error value', () => {
      const result = buildProgressWriteFailedEvent(undefined);
      expect(result.message).toBe('unknown');
      expect(result.event).toBe('progress_write_failed');
    });

    it('has exactly 2 keys', () => {
      const result = buildProgressWriteFailedEvent(new Error('x'));
      expect(Object.keys(result).sort()).toEqual(['event', 'message']);
    });
  });

  describe('buildToolDispatchError', () => {
    it('returns the error string when provided', () => {
      expect(buildToolDispatchError('custom error')).toBe('custom error');
    });

    it('returns default message when undefined', () => {
      expect(buildToolDispatchError(undefined)).toBe('tool dispatch failed');
    });

    it('returns empty string when empty string provided', () => {
      expect(buildToolDispatchError('')).toBe('');
    });
  });

  describe('buildHookRestrictionReasonCode', () => {
    it('returns the reason code when provided', () => {
      expect(buildHookRestrictionReasonCode('force_prompt')).toBe('force_prompt');
    });

    it('returns default when undefined', () => {
      expect(buildHookRestrictionReasonCode(undefined)).toBe('restricted');
    });

    it('returns empty string when empty string provided', () => {
      expect(buildHookRestrictionReasonCode('')).toBe('');
    });
  });

  describe('buildPromptRestrictionReasonCode', () => {
    it('returns the reason code when provided', () => {
      expect(buildPromptRestrictionReasonCode('denied')).toBe('denied');
    });

    it('returns default when undefined', () => {
      expect(buildPromptRestrictionReasonCode(undefined)).toBe('hook_restricted');
    });

    it('returns empty string when empty string provided', () => {
      expect(buildPromptRestrictionReasonCode('')).toBe('');
    });
  });

  describe('buildNoResultError', () => {
    it('returns the exact error message', () => {
      expect(buildNoResultError()).toBe('model dispatch returned no result after fallback');
    });

    it('returns a non-empty string', () => {
      expect(buildNoResultError().length).toBeGreaterThan(0);
    });
  });

  describe('buildWorkspaceFinalizeFailedMessage', () => {
    it('extracts message from Error instance', () => {
      expect(buildWorkspaceFinalizeFailedMessage(new Error('commit failed'))).toBe('commit failed');
    });

    it('returns unknown for non-Error', () => {
      expect(buildWorkspaceFinalizeFailedMessage('string')).toBe('unknown');
      expect(buildWorkspaceFinalizeFailedMessage(null)).toBe('unknown');
      expect(buildWorkspaceFinalizeFailedMessage(undefined)).toBe('unknown');
      expect(buildWorkspaceFinalizeFailedMessage(42)).toBe('unknown');
    });
  });

  describe('buildSkillActivationFailure', () => {
    it('builds failure with Error instance', () => {
      const result = buildSkillActivationFailure('my_skill', new Error('not found'));
      expect(result).toEqual({
        reason: 'skill_activation_failed',
        skill: 'my_skill',
        error: 'not found',
      });
    });

    it('builds failure with non-Error value', () => {
      const result = buildSkillActivationFailure('s', 'string error');
      expect(result.error).toBe('skill activation failed');
      expect(result.reason).toBe('skill_activation_failed');
      expect(result.skill).toBe('s');
    });

    it('builds failure with undefined skill name', () => {
      const result = buildSkillActivationFailure(undefined, new Error('e'));
      expect(result.skill).toBeUndefined();
      expect(result.reason).toBe('skill_activation_failed');
    });

    it('has exactly 3 keys', () => {
      const result = buildSkillActivationFailure('s', new Error('e'));
      expect(Object.keys(result).sort()).toEqual(['error', 'reason', 'skill']);
    });
  });
});
