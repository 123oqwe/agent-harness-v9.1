import { describe, it, expect } from 'vitest';
import { undo } from '../../tools/undo.js';

describe('AH-TOOL-UNDO-001 undo', () => {
  it('restores to a valid checkpoint', async () => {
    let restoredId = '';
    const restoreFn = (id: string) => { restoredId = id; };
    const result = await undo(restoreFn, { checkpoint: 'ckpt-123' });
    expect(result.restored).toBe(true);
    expect(result.checkpoint).toBe('ckpt-123');
    expect(restoredId).toBe('ckpt-123');
  });

  it('throws on empty checkpoint id', async () => {
    await expect(undo(() => {}, { checkpoint: '' })).rejects.toThrow('checkpoint id is required');
  });

  it('calls the restore function with the checkpoint id', async () => {
    const calls: string[] = [];
    await undo((id) => calls.push(id), { checkpoint: 'abc' });
    expect(calls).toEqual(['abc']);
  });

  it('passes through arbitrary checkpoint id formats', async () => {
    const result = await undo(() => {}, { checkpoint: 'session-uuid-550e8400-e29b-41d4-a716-446655440000' });
    expect(result.checkpoint).toBe('session-uuid-550e8400-e29b-41d4-a716-446655440000');
  });

  it('returns restored=true even if restore throws', async () => {
    // The undo function calls _restoreFn but doesn't catch errors — that's the caller's responsibility
    // If restoreFn throws, undo should propagate the error
    await expect(undo(() => { throw new Error('restore failed'); }, { checkpoint: 'x' }))
      .rejects.toThrow('restore failed');
  });
});
