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
    expect(ids).toContain('notify');
    expect(ids).toContain('reconcile');
    expect(ids).toContain('research');
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

  it('getScreen returns undefined for unknown id', () => {
 expect(getScreen('nonexistent')).toBeUndefined();
  });

  it('each screen has id, title, path, and component', () => {
    for (const screen of WEB_SCREENS) {
      expect(screen.id.length).toBeGreaterThan(0);
      expect(screen.title.length).toBeGreaterThan(0);
      expect(screen.path).toMatch(/^\//);
      expect(screen.component.length).toBeGreaterThan(0);
    }
  });

  it('screen ids are unique', () => {
    const ids = WEB_SCREENS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('screen paths are unique', () => {
    const paths = WEB_SCREENS.map(s => s.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('documents screen has correct path and component', () => {
    const doc = getScreen('doc')!;
    expect(doc.path).toBe('/documents');
    expect(doc.component).toBe('DocumentWorkspace');
  });
});
