import { describe, it, expect } from 'vitest';
import * as mod from '../../../packages/multimodal/src/image-gen.js';

describe('AH-TOOL-IMAGE-GEN-001', () => {
  it('module is importable', () => {
    expect(mod).toBeDefined();
  });

  it('exports at least one symbol', () => {
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });
});
