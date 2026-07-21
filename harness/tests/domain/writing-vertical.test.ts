import { describe, it, expect } from 'vitest';
import { runWritingVertical } from '../../writing/ah_writing_vertical_001.js';

describe('AH-WRITING-VERTICAL-001 writing vertical', () => {
  it('reads brief, generates draft, self-checks, outputs', async () => {
    const r = await runWritingVertical({ brief: 'Write a product announcement', requirements: ['title', 'features', 'pricing'] });
    expect(r.draft).toContain('product announcement');
    expect(r.self_check).toHaveLength(3);
    expect(r.output).toContain('Draft');
  });
});
