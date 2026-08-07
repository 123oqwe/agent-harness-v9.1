import { describe, expect, it } from 'vitest';
import { escalateToHuman, getAuditTrail } from '../../../packages/tools/src/index.js';

describe('AH-TOOL-ESCALATE-001: Asynchronous human escalation with audit trail', () => {
  it('creates escalation record with pending status', async () => {
    const result = await escalateToHuman({ reason: 'Need human review', urgency: 'high' });
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.escalation_id).toBeTruthy();
    expect(typeof output.escalation_id).toBe('string');
    expect(output.status).toBe('pending');
    expect(output.message).toContain('human will review');
  });

  it('records audit trail with each escalation', async () => {
    const before = getAuditTrail().length;
    await escalateToHuman({ reason: 'Another escalation', urgency: 'medium' });
    expect(getAuditTrail().length).toBe(before + 1);
  });

  it('stores reason and urgency in the audit record', async () => {
    await escalateToHuman({ reason: 'Critical failure detected', urgency: 'critical' });
    const trail = getAuditTrail();
    const record = trail[trail.length - 1]!;
    expect(record.reason).toBe('Critical failure detected');
    expect(record.urgency).toBe('critical');
    expect(record.status).toBe('pending');
  });

  it('records context and requested_action when provided', async () => {
    await escalateToHuman({
      reason: 'Uncertain about deployment',
      urgency: 'low',
      context: { service: 'api', version: '1.2.3' },
      requested_action: 'Review and approve rollback',
    });
    const trail = getAuditTrail();
    const record = trail[trail.length - 1]!;
    expect(record.context).toMatchObject({ service: 'api', version: '1.2.3' });
    expect(record.requested_action).toBe('Review and approve rollback');
  });

  it('generates unique escalation IDs', async () => {
    const r1 = await escalateToHuman({ reason: 'First', urgency: 'low' });
    const r2 = await escalateToHuman({ reason: 'Second', urgency: 'low' });
    const id1 = (r1.output as Record<string, unknown>).escalation_id;
    const id2 = (r2.output as Record<string, unknown>).escalation_id;
    expect(id1).not.toBe(id2);
  });

  it('computes audit hash from the record fields', async () => {
    await escalateToHuman({ reason: 'Hash test', urgency: 'high' });
    const trail = getAuditTrail();
    const record = trail[trail.length - 1]!;
    expect(record.audit_hash).toHaveLength(64);
    expect(record.audit_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('includes audit trail length in metadata', async () => {
    const result = await escalateToHuman({ reason: 'Metadata check', urgency: 'medium' });
    expect(result.metadata?.audit_trail_length).toBeGreaterThan(0);
  });

  it('supports all urgency levels', async () => {
    for (const urgency of ['low', 'medium', 'high', 'critical'] as const) {
      const result = await escalateToHuman({ reason: `Test ${urgency}`, urgency });
      expect(result.success).toBe(true);
    }
  });
  it('handles default context when not provided', async () => {
    const result = await escalateToHuman({ reason: 'No context', urgency: 'low' });
    expect(result.success).toBe(true);
  });

  it('audit trail records are ordered by creation time', async () => {
    const before = getAuditTrail().length;
    await escalateToHuman({ reason: 'First ordered', urgency: 'low' });
    await escalateToHuman({ reason: 'Second ordered', urgency: 'low' });
    const trail = getAuditTrail();
    expect(trail.length).toBe(before + 2);
    const last = trail[trail.length - 1]!;
    const secondLast = trail[trail.length - 2]!;
    expect(last.reason).toBe('Second ordered');
    expect(secondLast.reason).toBe('First ordered');
  });

});
