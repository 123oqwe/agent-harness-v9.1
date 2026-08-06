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
});
