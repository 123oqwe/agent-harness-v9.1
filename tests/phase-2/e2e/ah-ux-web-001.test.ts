import { describe, it, expect } from 'vitest';
import { WEB_SCREENS, getScreen } from '../../../apps/web/src/index.js';
import { createWebClient, renderScreen } from '../../../apps/web/src/app.js';

describe('AH-UX-WEB-001: Web application with Phase 2 screens', () => {
  it('registers all 7 Phase 2 screens', () => {
    expect(WEB_SCREENS.length).toBe(7);
    const ids = WEB_SCREENS.map(s => s.id);
    expect(ids).toContain('doc');
    expect(ids).toContain('mm');
    expect(ids).toContain('notify');
    expect(ids).toContain('planning');
    expect(ids).toContain('reconcile');
    expect(ids).toContain('research');
    expect(ids).toContain('writing');
  });

  it('all screens are accessible', () => {
    for (const screen of WEB_SCREENS) {
      expect(screen.accessible).toBe(true);
    }
  });

  it('getScreen returns correct screen by id', () => {
    const screen = getScreen('doc');
    expect(screen).toBeDefined();
    expect(screen!.path).toBe('/documents');
  });

  it('web client can navigate to screens', () => {
    const client = createWebClient({ apiBaseUrl: 'http://localhost:3000' });
    expect(() => client.navigate('doc')).not.toThrow();
    expect(() => client.navigate('unknown')).toThrow();
  });

  it('renderScreen produces accessible HTML', () => {
    const html = renderScreen('doc', 'loading');
    expect(html).toContain('role="main"');
    expect(html).toContain('aria-label');
    expect(html).toContain('aria-live="polite"');
  });
});
