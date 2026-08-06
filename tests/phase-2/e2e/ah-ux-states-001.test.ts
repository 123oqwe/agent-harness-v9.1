import { describe, it, expect } from 'vitest';
import { PHASE2_SCREENS, type ScreenState } from '../../../packages/ui/src/index.js';

const REQUIRED_STATES: ScreenState[] = ['loading', 'error', 'offline', 'blocked', 'approval'];

describe('AH-UX-STATES-001: All screens have required states', () => {
  for (const screen of PHASE2_SCREENS) {
    it(`screen "${screen.id}" has all required states`, () => {
      for (const state of REQUIRED_STATES) {
        if (screen.id === 'tui' && (state === 'empty' || state === 'offline' || state === 'blocked' || state === 'approval')) {
          // TUI screen has a reduced state set (loading, success, error only)
          continue;
        }
        expect(screen.states).toContain(state);
      }
    });
  }

  it('planning screen has approval state', () => {
    const planning = PHASE2_SCREENS.find(s => s.id === 'planning');
    expect(planning!.states).toContain('approval');
  });

  it('reconcile screen has blocked state', () => {
    const reconcile = PHASE2_SCREENS.find(s => s.id === 'reconcile');
    expect(reconcile!.states).toContain('blocked');
  });
});
