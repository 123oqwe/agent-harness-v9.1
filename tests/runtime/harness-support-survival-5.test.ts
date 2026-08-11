import { describe, it, expect } from 'vitest';
import {
  combineAbortSignals,
  hookActionToState,
  buildRoutingFailureRecord,
  buildPromptRestrictionFailure,
  buildSessionBranchScope,
} from '../../runtime/harness-support.js';

describe('harness-support-survival-5: combineAbortSignals', () => {
  it('returns undefined when both signals are undefined', () => {
    expect(combineAbortSignals(undefined, undefined)).toBeUndefined();
  });

  it('returns modelSignal when only modelSignal is defined', () => {
    const ms = new AbortController().signal;
    expect(combineAbortSignals(undefined, ms)).toBe(ms);
  });

  it('returns configSignal when only configSignal is defined', () => {
    const cs = new AbortController().signal;
    expect(combineAbortSignals(cs, undefined)).toBe(cs);
  });

  it('returns combined signal when both are different', () => {
    const cs = new AbortController().signal;
    const ms = new AbortController().signal;
    const result = combineAbortSignals(cs, ms);
    expect(result).toBeDefined();
    expect(result).not.toBe(cs);
    expect(result).not.toBe(ms);
  });

  it('returns modelSignal when both are the same signal', () => {
    const s = new AbortController().signal;
    expect(combineAbortSignals(s, s)).toBe(s);
  });
});

describe('harness-support-survival-5: hookActionToState', () => {
  it('maps force_prompt to approval_required', () => {
    expect(hookActionToState('force_prompt')).toBe('approval_required');
  });

  it('maps skip to skipped', () => {
    expect(hookActionToState('skip')).toBe('skipped');
  });

  it('maps deny to blocked', () => {
    expect(hookActionToState('deny')).toBe('blocked');
  });

  it('maps unknown action to blocked', () => {
    expect(hookActionToState('unknown')).toBe('blocked');
  });
});

describe('harness-support-survival-5: buildRoutingFailureRecord', () => {
  it('builds record for ask_user outcome', () => {
    const r = buildRoutingFailureRecord('ask_user', 'please clarify', undefined);
    expect(r.reason).toBe('routing_requires_user_input');
    expect(r.outcome).toBe('ask_user');
    expect(r.ask_user_message).toBe('please clarify');
    expect(r.abstain_reason).toBeUndefined();
  });

  it('builds record for abstain outcome', () => {
    const r = buildRoutingFailureRecord('abstain', undefined, 'no capable provider');
    expect(r.reason).toBe('routing_abstained');
    expect(r.outcome).toBe('abstain');
    expect(r.ask_user_message).toBeUndefined();
    expect(r.abstain_reason).toBe('no capable provider');
  });

  it('has exactly 4 keys', () => {
    const r = buildRoutingFailureRecord('ask_user', 'msg', 'reason');
    expect(Object.keys(r).sort()).toEqual(['abstain_reason', 'ask_user_message', 'outcome', 'reason']);
  });
});

describe('harness-support-survival-5: buildPromptRestrictionFailure', () => {
  it('builds failure for force_prompt action', () => {
    const f = buildPromptRestrictionFailure('force_prompt', 'needs_approval');
    expect(f.reason).toBe('user_prompt_hook_restricted');
    expect(f.hook_action).toBe('force_prompt');
    expect(f.hook_state).toBe('approval_required');
    expect(f.reason_code).toBe('needs_approval');
    expect(f.approval_required).toBe(true);
  });

  it('builds failure for skip action', () => {
    const f = buildPromptRestrictionFailure('skip', 'not_allowed');
    expect(f.hook_state).toBe('skipped');
    expect(f.approval_required).toBe(false);
  });

  it('builds failure for deny action', () => {
    const f = buildPromptRestrictionFailure('deny', 'policy_violation');
    expect(f.hook_state).toBe('blocked');
    expect(f.approval_required).toBe(false);
  });

  it('has exactly 5 keys', () => {
    const f = buildPromptRestrictionFailure('deny', 'r');
    expect(Object.keys(f).sort()).toEqual(['approval_required', 'hook_action', 'hook_state', 'reason', 'reason_code']);
  });
});

describe('harness-support-survival-5: buildSessionBranchScope', () => {
  it('builds scope with tenant_id and root_session_id', () => {
    const s = buildSessionBranchScope('tenant1', 'run1');
    expect(s.tenant_id).toBe('tenant1');
    expect(s.root_session_id).toBe('run1');
  });

  it('has exactly 2 keys', () => {
    const s = buildSessionBranchScope('t', 'r');
    expect(Object.keys(s).sort()).toEqual(['root_session_id', 'tenant_id']);
  });
});
