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
  it('all screen titles are non-empty strings', () => {
    for (const screen of WEB_SCREENS) {
      expect(typeof screen.title).toBe('string');
      expect(screen.title.length).toBeGreaterThan(0);
    }
  });

  it('all screen components are non-empty strings', () => {
    for (const screen of WEB_SCREENS) {
      expect(typeof screen.component).toBe('string');
      expect(screen.component.length).toBeGreaterThan(0);
    }
  });


  it('WEB_SCREENS is an array', () => {
    expect(Array.isArray(WEB_SCREENS)).toBe(true);
  });

  it('WEB_SCREENS has multiple screens', () => {
    expect(WEB_SCREENS.length).toBeGreaterThan(0);
  });

  it('getScreen returns undefined for non-existent id', () => {
    expect(getScreen('nonexistent')).toBeUndefined();
  });

  it('each screen has unique id', () => {
    const ids = WEB_SCREENS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('each screen has accessible property', () => {
    for (const screen of WEB_SCREENS) {
      expect(screen).toHaveProperty('accessible');
    }
  });

  it('getScreen returns correct screen for each id', () => {
    for (const screen of WEB_SCREENS) {
      const found = getScreen(screen.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(screen.id);
    }
  });

  it('handles empty string as screen id', () => {
    expect(getScreen('')).toBeUndefined();
  });

  it('all screens have accessible=true', () => {
    for (const screen of WEB_SCREENS) {
      expect(screen.accessible).toBe(true);
    }
  });

  it('getScreen returns object with id property', () => {
    const first = WEB_SCREENS[0]!;
    const found = getScreen(first.id);
    expect(found).toHaveProperty('id');
  });


  it('all screens have non-empty id', () => {
    for (const screen of WEB_SCREENS) {
      expect(screen.id.length).toBeGreaterThan(0);
    }
  });

  it('getScreen returns defined screen for known id', () => {
    const first = WEB_SCREENS[0]!;
    expect(getScreen(first.id)).toBeDefined();
  });


  it('all screens have non-empty id', () => {
    for (const screen of WEB_SCREENS) {
      expect(screen.id.length).toBeGreaterThan(0);
    }
  });

  it('getScreen returns defined screen for known id', () => {
    const first = WEB_SCREENS[0]!;
    expect(getScreen(first.id)).toBeDefined();
  });

  it('handles screen lookup with whitespace id', () => {
    expect(getScreen(' ')).toBeUndefined();
  });

  it('screen objects have accessible property', () => {
    for (const screen of WEB_SCREENS) {
      expect(screen).toHaveProperty('accessible');
    }
  });

});
