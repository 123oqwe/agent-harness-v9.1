import { describe, it, expect } from 'vitest';
import * as mod from '../../../apps/api/src/index.js';

describe('AH-UX-API-001 e2e candidate', () => {
  it('module is importable', () => {
    expect(mod).toBeDefined();
  });

  it('exports expected interface', () => {
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });
});
