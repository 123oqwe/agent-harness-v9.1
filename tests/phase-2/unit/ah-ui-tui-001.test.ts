import { describe, expect, it } from 'vitest';
import { renderDiff } from '../../../apps/tui/src/index.js';

describe('AH-UI-TUI-001: Terminal UI with diff rendering', () => {
  it('renders added lines', () => {
    const diff = renderDiff(['a', 'b'], ['a', 'c']);
    expect(diff.added).toContain('c');
    expect(diff.removed).toContain('b');
    expect(diff.unchanged).toContain('a');
  });

  it('handles empty old content', () => {
    const diff = renderDiff([], ['new']);
    expect(diff.added).toEqual(['new']);
    expect(diff.removed).toEqual([]);
  });

  it('handles empty new content', () => {
    const diff = renderDiff(['old'], []);
    expect(diff.removed).toEqual(['old']);
    expect(diff.added).toEqual([]);
  });
});
