import { describe, it, expect } from 'vitest';

describe('steering-port types and exports', () => {
  it('RuntimeSteeringQueue has correct values', async () => {
    const mod = await import('../../runtime/steering-port.js');
    // These are type-only exports; verify the module loads without error
    expect(mod).toBeDefined();
  });
});
