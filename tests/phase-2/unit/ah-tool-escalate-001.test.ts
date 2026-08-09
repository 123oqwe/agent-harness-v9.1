import { describe, expect, it } from 'vitest';
import { escalateToHuman, getAuditTrail } from '../../../packages/tools/src/index.js';

describe('AH-TOOL-ESCALATE-001: Asynchronous human escalation with audit trail', () => {
  // --- AC4: Creates escalation ticket with id, timestamp, reason, urgency, context ---

  it('creates escalation record with pending status', async () => {
    const result = await escalateToHuman({ reason: 'Need human review', urgency: 'high' });
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.escalation_id).toBeTruthy();
    expect(typeof output.escalation_id).toBe('string');
    expect(output.status).toBe('pending');
    expect(output.message).toContain('human will review');
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

  it('records timestamp in ISO format', async () => {
    await escalateToHuman({ reason: 'Timestamp test', urgency: 'low' });
    const trail = getAuditTrail();
    const record = trail[trail.length - 1]!;
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const parsed = new Date(record.timestamp);
    expect(parsed.getTime()).not.toBeNaN();
  });

  it('generates unique escalation IDs', async () => {
    const r1 = await escalateToHuman({ reason: 'First', urgency: 'low' });
    const r2 = await escalateToHuman({ reason: 'Second', urgency: 'low' });
    const id1 = (r1.output as Record<string, unknown>).escalation_id;
    const id2 = (r2.output as Record<string, unknown>).escalation_id;
    expect(id1).not.toBe(id2);
  });

  it('escalation ID is a hex string', async () => {
    const result = await escalateToHuman({ reason: 'ID format', urgency: 'low' });
    const id = (result.output as Record<string, unknown>).escalation_id as string;
    expect(id).toMatch(/^[0-9a-f]+$/);
  });

  // --- AC10: Returns ticket_id immediately ---

  it('returns escalation_id immediately in output', async () => {
    const result = await escalateToHuman({ reason: 'Immediate return', urgency: 'medium' });
    expect(result.success).toBe(true);
    expect(result.output).toHaveProperty('escalation_id');
    expect(result.output).toHaveProperty('status');
    expect(result.output).toHaveProperty('message');
  });

  it('returns success immediately without blocking', async () => {
    const start = Date.now();
    await escalateToHuman({ reason: 'Speed test', urgency: 'low' });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });

  // --- AC12: All escalations logged for audit ---

  it('records audit trail with each escalation', async () => {
    const before = getAuditTrail().length;
    await escalateToHuman({ reason: 'Another escalation', urgency: 'medium' });
    expect(getAuditTrail().length).toBe(before + 1);
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

  it('computes audit hash from the record fields', async () => {
    await escalateToHuman({ reason: 'Hash test', urgency: 'high' });
    const trail = getAuditTrail();
    const record = trail[trail.length - 1]!;
    expect(record.audit_hash).toHaveLength(64);
    expect(record.audit_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('audit hash differs for different reasons', async () => {
    await escalateToHuman({ reason: 'Reason A', urgency: 'low' });
    await escalateToHuman({ reason: 'Reason B', urgency: 'low' });
    const trail = getAuditTrail();
    const hash1 = trail[trail.length - 2]!.audit_hash;
    const hash2 = trail[trail.length - 1]!.audit_hash;
    expect(hash1).not.toBe(hash2);
  });

  it('includes audit trail length in metadata', async () => {
    const result = await escalateToHuman({ reason: 'Metadata check', urgency: 'medium' });
    expect(result.metadata?.audit_trail_length).toBeGreaterThan(0);
  });

  it('getAuditTrail returns readonly array', async () => {
    const trail = getAuditTrail();
    expect(Array.isArray(trail)).toBe(true);
    expect(trail.length).toBeGreaterThan(0);
  });

  // --- Urgency levels ---

  it('supports all urgency levels', async () => {
    for (const urgency of ['low', 'medium', 'high', 'critical'] as const) {
      const result = await escalateToHuman({ reason: `Test ${urgency}`, urgency });
      expect(result.success).toBe(true);
    }
  });

  it('stores urgency level in audit record', async () => {
    for (const urgency of ['low', 'medium', 'high', 'critical'] as const) {
      await escalateToHuman({ reason: `Urgency test ${urgency}`, urgency });
      const trail = getAuditTrail();
      const record = trail[trail.length - 1]!;
      expect(record.urgency).toBe(urgency);
    }
  });

  // --- Context handling ---

  it('handles default context when not provided', async () => {
    const result = await escalateToHuman({ reason: 'No context', urgency: 'low' });
    expect(result.success).toBe(true);
  });

  it('stores undefined context in audit record when not provided', async () => {
    await escalateToHuman({ reason: 'No context test', urgency: 'low' });
    const trail = getAuditTrail();
    const record = trail[trail.length - 1]!;
    expect(record.context).toBeUndefined();
  });

  it('stores undefined requested_action when not provided', async () => {
    await escalateToHuman({ reason: 'No action test', urgency: 'low' });
    const trail = getAuditTrail();
    const record = trail[trail.length - 1]!;
    expect(record.requested_action).toBeUndefined();
  });

  it('handles complex context objects', async () => {
    const complexContext = {
      nested: { deep: { value: 42 } },
      array: [1, 2, 3],
      string: 'test',
      number: 100,
    };
    await escalateToHuman({ reason: 'Complex context', urgency: 'medium', context: complexContext });
    const trail = getAuditTrail();
    const record = trail[trail.length - 1]!;
    expect(record.context).toMatchObject(complexContext);
  });

  // --- Message format ---

  it('message includes escalation ID', async () => {
    const result = await escalateToHuman({ reason: 'Message test', urgency: 'low' });
    const output = result.output as Record<string, unknown>;
    const id = output.escalation_id as string;
    expect(output.message).toContain(id);
  });

  it('message mentions human review', async () => {
    const result = await escalateToHuman({ reason: 'Review test', urgency: 'low' });
    const output = result.output as Record<string, unknown>;
    expect(output.message).toContain('human');
    expect(output.message).toContain('review');
  });

  // --- Status ---

  it('initial status is always pending', async () => {
    for (const urgency of ['low', 'medium', 'high', 'critical'] as const) {
      await escalateToHuman({ reason: `Status test ${urgency}`, urgency });
      const trail = getAuditTrail();
      const record = trail[trail.length - 1]!;
      expect(record.status).toBe('pending');
    }
  });

  // --- Multiple escalations ---

  it('handles rapid sequential escalations', async () => {
    const before = getAuditTrail().length;
    for (let i = 0; i < 5; i++) {
      const result = await escalateToHuman({ reason: `Batch ${i}`, urgency: 'low' });
      expect(result.success).toBe(true);
    }
    expect(getAuditTrail().length).toBe(before + 5);
  });

  it('all records in audit trail have required fields', async () => {
    await escalateToHuman({ reason: 'Field validation', urgency: 'high' });
    const trail = getAuditTrail();
    for (const record of trail) {
      expect(record).toHaveProperty('id');
      expect(record).toHaveProperty('timestamp');
      expect(record).toHaveProperty('reason');
      expect(record).toHaveProperty('urgency');
      expect(record).toHaveProperty('status');
      expect(record).toHaveProperty('audit_hash');
    }
  });
});
