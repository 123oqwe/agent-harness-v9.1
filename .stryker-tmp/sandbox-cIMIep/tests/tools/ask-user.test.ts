// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { askUser } from '../../tools/ask-user.js';

describe('AH-TOOL-ASK-001 ask_user', () => {
  it('asks a question and returns the answer', async () => {
    const r = await askUser(async (q) => `answer to ${q}`, { question: 'Continue?' });
    expect(r.question).toBe('Continue?');
    expect(r.answer).toBe('answer to Continue?');
  });
  it('passes options to the handler', async () => {
    let received: string[] | undefined;
    await askUser(async (_q, opts) => { received = opts; return 'yes'; }, { question: 'Pick', options: ['yes', 'no'] });
    expect(received).toEqual(['yes', 'no']);
  });
});
