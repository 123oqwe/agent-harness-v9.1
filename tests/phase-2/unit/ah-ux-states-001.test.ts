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

  it('all screens include success state', () => {
    for (const screen of PHASE2_SCREENS) {
      expect(screen.states).toContain('success');
    }
  });

  it('web screens include offline state', () => {
    const webScreens = PHASE2_SCREENS.filter(s => s.id !== 'tui');
    for (const screen of webScreens) {
      expect(screen.states).toContain('offline');
    }
  });

  it('web screens include blocked and approval states', () => {
    const webScreens = PHASE2_SCREENS.filter(s => s.id !== 'tui');
    for (const screen of webScreens) {
      expect(screen.states).toContain('blocked');
      expect(screen.states).toContain('approval');
    }
  });

  it('tui screen has minimal states without offline', () => {
    const tui = PHASE2_SCREENS.find(s => s.id === 'tui');
    expect(tui).toBeDefined();
    expect(tui!.states).not.toContain('offline');
    expect(tui!.states).toContain('loading');
    expect(tui!.states).toContain('error');
  });

  it('accessibility check detects missing labels', () => {
    const issues = checkAccessibility({ role: 'button' });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some(i => i.includes('aria-label'))).toBe(true);
  });

  it('accessibility check detects missing tabindex', () => {
    const issues = checkAccessibility({ role: 'button', aria_label: 'Submit' });
    expect(issues.some(i => i.includes('tabindex'))).toBe(true);
  });

  it('accessibility check detects negative tabindex', () => {
    const issues = checkAccessibility({ role: 'button', aria_label: 'Submit', tabindex: -1 });
    expect(issues.some(i => i.includes('tabindex'))).toBe(true);
  });

  it('accessibility check passes with proper labels and tabindex', () => {
    const issues = checkAccessibility({ role: 'button', aria_label: 'Submit', tabindex: 0 });
    expect(issues).toHaveLength(0);
  });

  it('accessibility check accepts aria_description instead of aria_label', () => {
    const issues = checkAccessibility({ role: 'link', aria_description: 'Navigate to settings', tabindex: 0 });
    expect(issues).toHaveLength(0);
  });
});
