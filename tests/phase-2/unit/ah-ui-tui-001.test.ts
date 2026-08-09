import { describe, expect, it } from 'vitest';
import { renderDiff } from '../../../apps/tui/src/index.js';

describe('AH-UI-TUI-001: Terminal UI with diff rendering', () => {
  it('renders added lines when content changes', () => {
    const diff = renderDiff(['a', 'b'], ['a', 'c']);
    expect(diff.added).toContain('c');
    expect(diff.removed).toContain('b');
    expect(diff.unchanged).toContain('a');
  });

  it('handles empty old content as all added', () => {
    const diff = renderDiff([], ['new']);
    expect(diff.added).toEqual(['new']);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it('handles empty new content as all removed', () => {
    const diff = renderDiff(['old'], []);
    expect(diff.removed).toEqual(['old']);
    expect(diff.added).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it('identifies unchanged lines when both sides match', () => {
    const diff = renderDiff(['same', 'also'], ['same', 'also']);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toEqual(['same', 'also']);
  });

  it('handles both additions and removals simultaneously', () => {
    const diff = renderDiff(['keep', 'remove'], ['keep', 'add']);
    expect(diff.added).toEqual(['add']);
    expect(diff.removed).toEqual(['remove']);
    expect(diff.unchanged).toEqual(['keep']);
  });

  it('handles completely different content', () => {
    const diff = renderDiff(['a', 'b', 'c'], ['x', 'y', 'z']);
    expect(diff.added).toEqual(['x', 'y', 'z']);
    expect(diff.removed).toEqual(['a', 'b', 'c']);
    expect(diff.unchanged).toEqual([]);
  });

  it('handles both empty inputs', () => {
    const diff = renderDiff([], []);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it('handles duplicate lines correctly', () => {
    const diff = renderDiff(['a', 'a', 'b'], ['a', 'c']);
    expect(diff.added).toContain('c');
    expect(diff.removed).toContain('b');
    // 'a' appears in both so it is unchanged
    expect(diff.unchanged).toContain('a');
  });
  it('handles single line addition', () => {
    const diff = renderDiff(['same'], ['same', 'added']);
    expect(diff.added).toContain('added');
    expect(diff.unchanged).toContain('same');
  });

  it('handles single line removal', () => {
    const diff = renderDiff(['keep', 'remove'], ['keep']);
    expect(diff.removed).toContain('remove');
    expect(diff.unchanged).toContain('keep');
  });


  it('handles empty old content', () => {
    const diff = renderDiff([], ['new line']);
    expect(diff.added).toContain('new line');
  });

  it('handles empty new content', () => {
    const diff = renderDiff(['old line'], []);
    expect(diff.removed).toContain('old line');
  });

  it('handles both empty', () => {
    const diff = renderDiff([], []);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('handles identical content', () => {
    const diff = renderDiff(['same'], ['same']);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('handles Unicode content', () => {
    const diff = renderDiff(['旧的'], ['新的']);
    expect(diff.added).toContain('新的');
    expect(diff.removed).toContain('旧的');
  });

  it('handles multiple line changes', () => {
    const diff = renderDiff(['a', 'b', 'c'], ['a', 'x', 'y']);
    expect(diff.added).toContain('x');
    expect(diff.added).toContain('y');
    expect(diff.removed).toContain('b');
    expect(diff.removed).toContain('c');
  });

  it('handles line insertion', () => {
    const diff = renderDiff(['a', 'c'], ['a', 'b', 'c']);
    expect(diff.added).toContain('b');
  });

  it('handles line deletion', () => {
    const diff = renderDiff(['a', 'b', 'c'], ['a', 'c']);
    expect(diff.removed).toContain('b');
  });

  it('returns diff object with added and removed arrays', () => {
    const diff = renderDiff(['old'], ['new']);
    expect(diff).toHaveProperty('added');
    expect(diff).toHaveProperty('removed');
    expect(Array.isArray(diff.added)).toBe(true);
    expect(Array.isArray(diff.removed)).toBe(true);
  });


  it('handles very long lines', () => {
    const longLine = 'A'.repeat(1000);
    const diff = renderDiff([longLine], ['B'.repeat(1000)]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
  });

  it('handles lines with special characters', () => {
    const diff = renderDiff(['line @with #chars'], ['line @with #different']);
    expect(diff.added).toContain('line @with #different');
  });

  it('handles lines with tabs', () => {
    const diff = renderDiff(['\ttabbed'], ['\tnew']);
    expect(diff.added).toContain('\tnew');
  });

  it('preserves line order in diff', () => {
    const diff = renderDiff(['a', 'b', 'c'], ['a', 'x', 'c']);
    expect(diff.added[0]).toBe('x');
  });

});
