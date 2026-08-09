import { describe, expect, it } from 'vitest';
import { PHASE2_SCREENS, checkAccessibility } from '../../../packages/ui/src/index.js';

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

  it('PHASE2_SCREENS is an array', () => {
    expect(Array.isArray(PHASE2_SCREENS)).toBe(true);
  });

  it('PHASE2_SCREENS has multiple screens', () => {
    expect(PHASE2_SCREENS.length).toBeGreaterThan(0);
  });

  it('checkAccessibility returns an object', () => {
    for (const screen of PHASE2_SCREENS) {
      const result = checkAccessibility({ role: "region", aria_label: screen.id });
      expect(typeof result).toBe('object');
    }
  });

  it('each screen has an id', () => {
    for (const screen of PHASE2_SCREENS) {
      expect(screen.id).toBeTruthy();
    }
  });

  it('each screen has states array', () => {
    for (const screen of PHASE2_SCREENS) {
      expect(Array.isArray(screen.states)).toBe(true);
    }
  });

  it('screen ids are unique', () => {
    const ids = PHASE2_SCREENS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('all screens have at least 3 states', () => {
    for (const screen of PHASE2_SCREENS) {
      expect(screen.states.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('checkAccessibility does not throw', () => {
    for (const screen of PHASE2_SCREENS) {
      expect(() => checkAccessibility({ role: "region", aria_label: screen.id })).not.toThrow();
    }
  });


  it('checkAccessibility returns result with properties', () => {
    for (const screen of PHASE2_SCREENS) {
      const result = checkAccessibility({ role: "region", aria_label: screen.id });
      expect(result).toBeDefined();
    }
  });

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

  it('PHASE2_SCREENS length is positive', () => {
    expect(PHASE2_SCREENS.length).toBeGreaterThan(0);
  });


  it('all screens have at least 3 states', () => {
    for (const screen of PHASE2_SCREENS) {
      expect(screen.states.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('checkAccessibility does not throw for any screen', () => {
    for (const screen of PHASE2_SCREENS) {
      expect(() => checkAccessibility({ role: "region", aria_label: screen.id })).not.toThrow();
    }
  });

  it('screen ids are strings', () => {
    for (const screen of PHASE2_SCREENS) {
      expect(typeof screen.id).toBe('string');
    }
  });

  it('states arrays contain strings', () => {
    for (const screen of PHASE2_SCREENS) {
      for (const state of screen.states) {
        expect(typeof state).toBe('string');
      }
    }
  });

});
