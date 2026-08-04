import { describe, expect, it } from 'vitest';
import { escalateToHuman, getAuditTrail } from '../../../packages/tools/src/index.js';

describe('AH-TOOL-ESCALATE-001: Human escalation with audit trail', () => {
  it('creates escalation record', async () => {
    const result = await escalateToHuman({ reason: 'Need human review', urgency: 'high' });
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.escalation_id).toBeTruthy();
    expect(output.status).toBe('pending');
  });

  it('records audit trail', async () => {
    const before = getAuditTrail().length;
    await escalateToHuman({ reason: 'Another escalation', urgency: 'medium' });
    expect(getAuditTrail().length).toBe(before + 1);
  });
});
