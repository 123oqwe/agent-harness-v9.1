import { describe, it, expect } from 'vitest';
import * as mod from '../../../packages/documents/src/parsers/html-parser.js';

describe('AH-DOC-INGEST-WEB-001', () => {
  it('module is importable', () => {
    expect(mod).toBeDefined();
  });

  it('exports at least one symbol', () => {
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });
});
