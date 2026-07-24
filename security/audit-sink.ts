/**
 * AH-AUDIT-001: Audit Sink
 *
 * Immutable audit event log. Every action (allowed or denied) is recorded
 * with a timestamp, capability token ID, tool name, verdict, and risk tier.
 * Audit events are append-only and never deleted.
 *
 * The audit sink is the step 12 of the 12-step Action Control pipeline.
 */

export interface AuditEntry {
  readonly timestamp: string;
  readonly tool_name: string;
  readonly token_id?: string;
  readonly verdict: 'allow' | 'deny';
  readonly risk_tier: number;
  readonly manifest_hash_match: boolean;
  readonly reason: string;
  readonly operation_id?: string;
  readonly duration_ms?: number;
}

export class AuditSink {
  private readonly entries: AuditEntry[] = [];

  record(entry: Omit<AuditEntry, 'timestamp'> & { timestamp?: string }): AuditEntry {
    const full: AuditEntry = Object.freeze({
      ...entry,
      timestamp: entry.timestamp ?? new Date().toISOString(),
    });
    this.entries.push(full);
    return full;
  }

  get all(): readonly AuditEntry[] {
    return Object.freeze([...this.entries]);
  }

  get count(): number {
    return this.entries.length;
  }

  getAllowed(): readonly AuditEntry[] {
    return Object.freeze(this.entries.filter((e) => e.verdict === 'allow'));
  }

  getDenied(): readonly AuditEntry[] {
    return Object.freeze(this.entries.filter((e) => e.verdict === 'deny'));
  }

  getByTool(toolName: string): readonly AuditEntry[] {
    return Object.freeze(this.entries.filter((e) => e.tool_name === toolName));
  }
}
