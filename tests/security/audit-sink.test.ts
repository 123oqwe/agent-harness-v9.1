import { describe, it, expect } from 'vitest';
import { AuditSink } from '../../security/audit-sink.js';

describe('Audit Sink', () => {
  it('records audit entries', () => {
    const sink = new AuditSink();
    sink.record({ tool_name: 'read_file', verdict: 'allow', risk_tier: 0, manifest_hash_match: true, reason: 'ok' });
    sink.record({ tool_name: 'write_file', verdict: 'deny', risk_tier: 3, manifest_hash_match: false, reason: 'policy denied' });
    expect(sink.count).toBe(2);
  });

  it('separates allowed and denied', () => {
    const sink = new AuditSink();
    sink.record({ tool_name: 'read_file', verdict: 'allow', risk_tier: 0, manifest_hash_match: true, reason: 'ok' });
    sink.record({ tool_name: 'write_file', verdict: 'deny', risk_tier: 3, manifest_hash_match: false, reason: 'denied' });
    expect(sink.getAllowed()).toHaveLength(1);
    expect(sink.getDenied()).toHaveLength(1);
  });

  it('filters by tool name', () => {
    const sink = new AuditSink();
    sink.record({ tool_name: 'read_file', verdict: 'allow', risk_tier: 0, manifest_hash_match: true, reason: 'ok' });
    sink.record({ tool_name: 'write_file', verdict: 'allow', risk_tier: 1, manifest_hash_match: true, reason: 'ok' });
    expect(sink.getByTool('read_file')).toHaveLength(1);
    expect(sink.getByTool('write_file')).toHaveLength(1);
  });

  it('entries are immutable (readonly array)', () => {
    const sink = new AuditSink();
    sink.record({ tool_name: 'read_file', verdict: 'allow', risk_tier: 0, manifest_hash_match: true, reason: 'ok' });
    const entries = sink.all;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.tool_name).toBe('read_file');
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries[0])).toBe(true);
    expect(() => {
      (entries[0] as { tool_name: string }).tool_name = 'tampered';
    }).toThrow();
    expect(sink.all[0]!.tool_name).toBe('read_file');
  });
});
