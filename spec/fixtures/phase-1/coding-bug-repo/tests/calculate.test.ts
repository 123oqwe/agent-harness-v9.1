import { describe, it, expect } from 'vitest';
import { average } from '../src/calculate';

describe('average', () => {
  it('returns average of numbers', () => {
    expect(average([1, 2, 3, 4, 5])).toBe(3);
  });
  it('handles single element', () => {
    expect(average([42])).toBe(42);
  });
  it('handles empty array', () => {
    expect(average([])).toBe(0);
  });
});
