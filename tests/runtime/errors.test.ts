import { describe, it, expect } from 'vitest';
import { LoopError } from '../../runtime/errors.js';

describe('LoopError', () => {
  it('creates an error with the correct message', () => {
    const e = new LoopError('something went wrong');
    expect(e.message).toBe('something went wrong');
    expect(e.name).toBe('LoopError');
  });

  it('is an instance of Error', () => {
    const e = new LoopError('test');
    expect(e instanceof Error).toBe(true);
  });

  it('can be caught in a try/catch', () => {
    try {
      throw new LoopError('caught');
    } catch (e) {
      expect(e).toBeInstanceOf(LoopError);
      expect((e as LoopError).message).toBe('caught');
    }
  });

  it('preserves prototype chain after rethrow', () => {
    const throwIt = () => { throw new LoopError('rethrow'); };
    expect(throwIt).toThrow(LoopError);
    expect(throwIt).toThrow('rethrow');
  });

  it('creates with empty message', () => {
    const e = new LoopError('');
    expect(e.message).toBe('');
    expect(e.name).toBe('LoopError');
  });

  it('creates with long message', () => {
    const msg = 'x'.repeat(1000);
    const e = new LoopError(msg);
    expect(e.message).toBe(msg);
  });
});
