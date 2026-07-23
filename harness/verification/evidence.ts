/** AH-EVIDENCE-001: Local Evidence - structured run records with hash chaining */
import { createHash } from 'node:crypto';

export interface EvidenceRecord {
  id: string;
  run_id: string;
  request_prompt: string;
  route_decision: string;
  route_reason: string;
  plan_revision: number | null;
  strategy: string;
  state_transitions: string[];
  action_digests: string[];
  policy_decisions: string[];
  observations: string[];
  result_digest: string;
  output: string;
  timing_ms: number;
  redacted_errors: string[];
  timestamp: string;
  prev_hash: string;
  record_hash: string;
}

export function createEvidence(data: Omit<EvidenceRecord, 'id' | 'timestamp' | 'prev_hash' | 'record_hash'> & { prev_hash?: string }): EvidenceRecord {
  const timestamp = new Date().toISOString();
  const prevHash = data.prev_hash ?? '';
  const id = createHash('sha256').update(`${data.run_id}:${timestamp}`).digest('hex').slice(0, 16);
  const record: EvidenceRecord = { ...data, id, timestamp, prev_hash: prevHash, record_hash: '' };
  record.record_hash = hashRecord(record);
  return record;
}

export function hashRecord(record: EvidenceRecord): string {
  const payload = JSON.stringify({
    id: record.id, run_id: record.run_id, strategy: record.strategy,
    result_digest: record.result_digest, timestamp: record.timestamp, prev_hash: record.prev_hash,
  });
  return createHash('sha256').update(payload).digest('hex');
}

export function verifyRecord(record: EvidenceRecord): boolean {
  return record.record_hash === hashRecord(record);
}

export function verifyChain(records: EvidenceRecord[]): { valid: boolean; broken_at: number | null } {
  for (let i = 1; i < records.length; i++) {
    if (records[i].prev_hash !== records[i - 1].record_hash) return { valid: false, broken_at: i };
    if (!verifyRecord(records[i])) return { valid: false, broken_at: i };
  }
  return { valid: true, broken_at: null };
}

export function redactSecrets(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escaped, 'g'), '[REDACTED]');
    }
  }
  return result;
}
