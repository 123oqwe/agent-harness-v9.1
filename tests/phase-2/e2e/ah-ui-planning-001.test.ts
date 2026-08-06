import { describe, it, expect } from 'vitest';
import { PHASE2_SCREENS, checkAccessibility } from '../../../packages/ui/src/index.js';

describe('AH-UI-PLANNING-001: Planning screen e2e', () => {
  const screen = PHASE2_SCREENS.find(s => s.id === 'planning');

  it('screen is registered with correct route', () => {
    expect(screen).toBeDefined();
    expect(screen!.path).toBe('/planning');
    expect(screen!.title).toBe('Planning');
  });

  it('has all required states including blocked and approval', () => {
    expect(screen!.states).toContain('loading');
    expect(screen!.states).toContain('error');
    expect(screen!.states).toContain('offline');
    expect(screen!.states).toContain('blocked');
    expect(screen!.states).toContain('approval');
  });

  it('passes accessibility check with proper attributes', () => {
    const issues = checkAccessibility({ role: 'main', aria_label: 'Planning screen', tabindex: 0 });
    expect(issues).toHaveLength(0);
  });
});
