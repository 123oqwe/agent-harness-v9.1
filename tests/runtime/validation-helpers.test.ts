import { describe, expect, it } from 'vitest';
import {
  assertValidHookPayload,
  assertValidPreTurnMessages,
  assertNoToolSetExpansion,
} from '../../runtime/harness-support.js';

describe('assertValidHookPayload', () => {
  it('throws for null payload', () => {
    expect(() => assertValidHookPayload(null, 'before_provider_request')).toThrow(
      'before_provider_request returned an invalid request',
    );
  });

  it('throws for undefined payload', () => {
    expect(() => assertValidHookPayload(undefined, 'pre_tool')).toThrow(
      'pre_tool returned an invalid request',
    );
  });

  it('throws for string payload', () => {
    expect(() => assertValidHookPayload('string', 'before_provider_request')).toThrow(
      'before_provider_request returned an invalid request',
    );
  });

  it('throws for number payload', () => {
    expect(() => assertValidHookPayload(42, 'before_provider_request')).toThrow(
      'before_provider_request returned an invalid request',
    );
  });

  it('throws for array payload', () => {
    expect(() => assertValidHookPayload([1, 2, 3], 'before_provider_request')).toThrow(
      'before_provider_request returned an invalid request',
    );
  });

  it('throws for boolean payload', () => {
    expect(() => assertValidHookPayload(true, 'before_provider_request')).toThrow(
      'before_provider_request returned an invalid request',
    );
  });

  it('accepts valid object payload', () => {
    expect(() => assertValidHookPayload({ key: 'value' }, 'before_provider_request')).not.toThrow();
  });

  it('accepts empty object payload', () => {
    expect(() => assertValidHookPayload({}, 'before_provider_request')).not.toThrow();
  });

  it('uses exact context string in error message', () => {
    expect(() => assertValidHookPayload(null, 'PreToolUse hook')).toThrow(
      'PreToolUse hook returned an invalid request',
    );
  });
});

describe('assertValidPreTurnMessages', () => {
  it('throws for null payload', () => {
    expect(() => assertValidPreTurnMessages(null)).toThrow('pre_turn returned invalid messages');
  });

  it('throws for undefined payload', () => {
    expect(() => assertValidPreTurnMessages(undefined)).toThrow('pre_turn returned invalid messages');
  });

  it('throws for payload with null messages', () => {
    expect(() => assertValidPreTurnMessages({ messages: null })).toThrow(
      'pre_turn returned invalid messages',
    );
  });

  it('throws for payload with non-array messages', () => {
    expect(() => assertValidPreTurnMessages({ messages: 'not-array' })).toThrow(
      'pre_turn returned invalid messages',
    );
  });

  it('throws for payload with number messages', () => {
    expect(() => assertValidPreTurnMessages({ messages: 42 })).toThrow(
      'pre_turn returned invalid messages',
    );
  });

  it('throws for payload with missing messages field', () => {
    expect(() => assertValidPreTurnMessages({})).toThrow('pre_turn returned invalid messages');
  });

  it('throws for null message in array', () => {
    expect(() => assertValidPreTurnMessages({ messages: [null] })).toThrow(
      'pre_turn returned a message with invalid role',
    );
  });

  it('throws for non-object message in array', () => {
    expect(() => assertValidPreTurnMessages({ messages: ['string-not-object'] })).toThrow(
      'pre_turn returned a message with invalid role',
    );
  });

  it('throws for message with non-string role', () => {
    expect(() => assertValidPreTurnMessages({ messages: [{ role: 123 }] })).toThrow(
      'pre_turn returned a message with invalid role',
    );
  });

  it('throws for message with missing role', () => {
    expect(() => assertValidPreTurnMessages({ messages: [{ content: 'test' }] })).toThrow(
      'pre_turn returned a message with invalid role',
    );
  });

  it('accepts valid messages array with user role', () => {
    expect(() =>
      assertValidPreTurnMessages({ messages: [{ role: 'user', content: 'test' }] }),
    ).not.toThrow();
  });

  it('accepts valid messages array with assistant role', () => {
    expect(() =>
      assertValidPreTurnMessages({ messages: [{ role: 'assistant', content: 'response' }] }),
    ).not.toThrow();
  });

  it('accepts empty messages array', () => {
    expect(() => assertValidPreTurnMessages({ messages: [] })).not.toThrow();
  });
});

describe('assertNoToolSetExpansion', () => {
  it('throws when effective tools contain a tool not in original set', () => {
    expect(() =>
      assertNoToolSetExpansion(
        [{ name: 'read_file' }],
        [{ name: 'read_file' }, { name: 'write_file' }],
      ),
    ).toThrow('before_provider_request expanded tool set beyond policy: write_file');
  });

  it('does not throw when effective tools are a subset of original', () => {
    expect(() =>
      assertNoToolSetExpansion(
        [{ name: 'read_file' }, { name: 'write_file' }],
        [{ name: 'read_file' }],
      ),
    ).not.toThrow();
  });

  it('does not throw when effective tools equal original tools', () => {
    expect(() =>
      assertNoToolSetExpansion(
        [{ name: 'read_file' }, { name: 'write_file' }],
        [{ name: 'read_file' }, { name: 'write_file' }],
      ),
    ).not.toThrow();
  });

  it('does not throw when both sets are empty', () => {
    expect(() => assertNoToolSetExpansion([], [])).not.toThrow();
  });

  it('throws for the first expanded tool found', () => {
    expect(() =>
      assertNoToolSetExpansion(
        [{ name: 'read_file' }],
        [{ name: 'write_file' }, { name: 'delete_file' }],
      ),
    ).toThrow('before_provider_request expanded tool set beyond policy: write_file');
  });

  it('includes exact tool name in error message', () => {
    expect(() =>
      assertNoToolSetExpansion([], [{ name: 'dangerous_tool' }]),
    ).toThrow('before_provider_request expanded tool set beyond policy: dangerous_tool');
  });
});
