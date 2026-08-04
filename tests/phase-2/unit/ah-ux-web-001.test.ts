import { describe, expect, it } from 'vitest';
import { WEB_SCREENS, getScreen } from '../../../apps/web/src/index.js';

describe('AH-UX-WEB-001: Web application with Phase 2 screens', () => {
  it('includes all 7 core screens', () => {
    expect(WEB_SCREENS.length).toBeGreaterThanOrEqual(7);
    const ids = WEB_SCREENS.map(s => s.id);
    expect(ids).toContain('doc');
    expect(ids).toContain('mm');
    expect(ids).toContain('planning');
    expect(ids).toContain('writing');
  });

  it('all screens are accessible', () => {
    for (const screen of WEB_SCREENS) {
      expect(screen.accessible).toBe(true);
    }
  });

  it('getScreen returns screen by id', () => {
    const doc = getScreen('doc');
    expect(doc).toBeDefined();
    expect(doc!.title).toBe('Documents');
  });
});
