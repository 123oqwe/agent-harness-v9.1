import { describe, expect, it } from 'vitest';
import { PHASE2_SCREENS, checkAccessibility, type ScreenState } from '../../../packages/ui/src/index.js';

describe('AH-UX-STATES-001: All screens have loading/error/offline/accessibility states', () => {
  it('all screens include loading state', () => {
    for (const screen of PHASE2_SCREENS) {
      expect(screen.states).toContain('loading');
    }
  });

  it('all screens include error state', () => {
    for (const screen of PHASE2_SCREENS) {
      expect(screen.states).toContain('error');
    }
  });

  it('web screens include offline state', () => {
    const webScreens = PHASE2_SCREENS.filter(s => s.id !== 'tui');
    for (const screen of webScreens) {
      expect(screen.states).toContain('offline');
    }
  });

  it('accessibility check detects missing labels', () => {
    const issues = checkAccessibility({ role: 'button' });
    expect(issues.length).toBeGreaterThan(0);
  });

  it('accessibility check passes with proper labels', () => {
    const issues = checkAccessibility({ role: 'button', aria_label: 'Submit', tabindex: 0 });
    expect(issues).toHaveLength(0);
  });
});
