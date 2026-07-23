import { describe, it, expect } from 'vitest';
import { createEvidence, verifyRecord, verifyChain, redactSecrets } from '../../verification/evidence.js';

describe('AH-EVIDENCE-001: evidence generation', () => {
  it('creates an evidence record with hash', () => {
    const record = createEvidence({
      run_id: 'run-001',
      request_prompt: 'test',
      route_decision: 'direct',
      route_reason: 'SINGLE_STEP_NO_TOOLS',
      plan_revision: null,
      strategy: 'direct',
      state_transitions: ['created', 'running', 'completed'],
      action_digests: [],
      policy_decisions: [],
      observations: [],
      result_digest: 'abc123',
      output: 'result',
      timing_ms: 100,
      redacted_errors: [],
    });
    expect(record.id).toBeTruthy();
    expect(record.record_hash).toBeTruthy();
    expect(record.timestamp).toBeTruthy();
  });

  it('verifyRecord returns true for untampered record', () => {
    const record = createEvidence({
      run_id: 'run-001', request_prompt: 'test', route_decision: 'direct',
      route_reason: 'test', plan_revision: null, strategy: 'direct',
      state_transitions: [], action_digests: [], policy_decisions: [],
      observations: [], result_digest: 'abc', output: 'ok', timing_ms: 50, redacted_errors: [],
    });
    expect(verifyRecord(record)).toBe(true);
  });

  it('verifyChain detects broken chain', () => {
    const r1 = createEvidence({
      run_id: 'r1', request_prompt: 't', route_decision: 'd', route_reason: 'r',
      plan_revision: null, strategy: 'direct', state_transitions: [], action_digests: [],
      policy_decisions: [], observations: [], result_digest: 'a', output: 'o', timing_ms: 1, redacted_errors: [],
    });
    const r2 = createEvidence({
      run_id: 'r2', request_prompt: 't', route_decision: 'd', route_reason: 'r',
      plan_revision: null, strategy: 'direct', state_transitions: [], action_digests: [],
      policy_decisions: [], observations: [], result_digest: 'b', output: 'o', timing_ms: 1, redacted_errors: [],
      prev_hash: r1.record_hash,
    });
    expect(verifyChain([r1, r2]).valid).toBe(true);
    
    // Tamper r2
    const tampered = { ...r2, result_digest: 'tampered' };
    expect(verifyChain([r1, tampered]).valid).toBe(false);
  });

  it('redactSecrets removes known secret values', () => {
    const result = redactSecrets('error with key sk-secret-123', ['sk-secret-123']);
    expect(result).not.toContain('sk-secret-123');
    expect(result).toContain('[REDACTED]');
  });
});
