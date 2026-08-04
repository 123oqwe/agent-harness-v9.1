import { describe, expect, it } from 'vitest';
import { DEFAULT_DESKTOP_CONFIG } from '../../../apps/desktop/src/index.js';

describe('AH-UX-DESKTOP-001: Desktop/local shell application', () => {
  it('provides default configuration', () => {
    expect(DEFAULT_DESKTOP_CONFIG.shell).toBeTruthy();
    expect(DEFAULT_DESKTOP_CONFIG.offline_cache).toBe(true);
  });
});
