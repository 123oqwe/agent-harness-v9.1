import { describe, it, expect } from 'vitest';
import { explicitOutputLimitInstruction } from '../../runtime/react.js';

describe('explicitOutputLimitInstruction', () => {
  it('returns empty string for goal without limit', () => {
    expect(explicitOutputLimitInstruction('write a summary')).toBe('');
  });

  it('parses numeric word limit', () => {
    const result = explicitOutputLimitInstruction('Write at most 100 words about X');
    expect(result).toContain('100');
    expect(result).toContain('words');
  });

  it('parses "no more than" word limit', () => {
    const result = explicitOutputLimitInstruction('Answer in no more than 50 words');
    expect(result).toContain('50');
    expect(result).toContain('words');
  });

  it('parses "maximum of" word limit', () => {
    const result = explicitOutputLimitInstruction('Maximum of 200 words please');
    expect(result).toContain('200');
    expect(result).toContain('words');
  });

  it('parses "maximum" word limit (without "of")', () => {
    const result = explicitOutputLimitInstruction('maximum 30 words');
    expect(result).toContain('30');
    expect(result).toContain('words');
  });

  it('parses word number words (one through twenty)', () => {
    expect(explicitOutputLimitInstruction('at most ten words')).toContain('10');
    expect(explicitOutputLimitInstruction('at most five words')).toContain('5');
    expect(explicitOutputLimitInstruction('at most twenty words')).toContain('20');
  });

  it('parses Chinese character limit', () => {
    const result = explicitOutputLimitInstruction('不超过100字');
    expect(result).toContain('100');
    expect(result).toContain('characters');
  });

  it('parses Chinese character limit with 个', () => {
    const result = explicitOutputLimitInstruction('至多200个字符');
    expect(result).toContain('200');
    expect(result).toContain('characters');
  });

  it('returns empty for word limit of 0', () => {
    expect(explicitOutputLimitInstruction('at most 0 words')).toBe('');
  });

  it('returns empty for word limit exceeding 10000', () => {
    expect(explicitOutputLimitInstruction('at most 20000 words')).toBe('');
  });

  it('returns empty for character limit of 0', () => {
    expect(explicitOutputLimitInstruction('不超过0字')).toBe('');
  });

  it('returns empty for character limit exceeding 100000', () => {
    expect(explicitOutputLimitInstruction('不超过200000字')).toBe('');
  });

  it('returns empty for unknown word number', () => {
    expect(explicitOutputLimitInstruction('at most hundred words')).toBe('');
  });

  it('handles case insensitive matching', () => {
    expect(explicitOutputLimitInstruction('AT MOST 100 WORDS')).toContain('100');
    expect(explicitOutputLimitInstruction('At Most 100 Words')).toContain('100');
  });
});
