import { describe, it, expect } from 'vitest';
import * as mod from '../../../packages/tools/src/oci-sandbox.js';

describe('AH-SANDBOX-OCI-001 security', () => {
  it('exports are defined and typed', () => {
    expect(mod).toBeDefined();
  });

  it('does not expose sensitive data in module exports', () => {
    const exported = Object.keys(mod);
    expect(exported).not.toContain('password');
    expect(exported).not.toContain('secret');
    expect(exported).not.toContain('apiKey');
  });
});
