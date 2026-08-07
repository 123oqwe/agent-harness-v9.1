import { describe, it, expect } from 'vitest';
import {
  InMemoryPauseResumeJournal,
  DefaultEffectReadBack,
  DefaultEffectReconciliation,
} from '../../runtime/pause-resume-port.js';

describe('InMemoryPauseResumeJournal', () => {
  it('returns null for unknown operation', () => {
    const j = new InMemoryPauseResumeJournal();
    expect(j.getOperation('unknown')).toBeNull();
  });

  it('records and retrieves an operation', () => {
    const j = new InMemoryPauseResumeJournal();
    const record = {
      operation_id: 'op-1',
      run_id: 'run-1',
      step_id: 'step-1',
      attempt_id: 'att-1',
      tool_name: 'read_file',
      idempotency_key: 'idem-1',
      effect_state: 'PRE_DISPATCH' as const,
      receipt_json: null,
    };
    j.recordOperation(record);
    const retrieved = j.getOperation('op-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.operation_id).toBe('op-1');
    expect(retrieved!.effect_state).toBe('PRE_DISPATCH');
  });

  it('records operation with spread copy', () => {
    const j = new InMemoryPauseResumeJournal();
    const record = {
      operation_id: 'op-1',
      run_id: 'run-1',
      step_id: 'step-1',
      attempt_id: 'att-1',
      tool_name: 'read_file',
      idempotency_key: 'idem-1',
      effect_state: 'PRE_DISPATCH' as const,
      receipt_json: null,
    };
    j.recordOperation(record);
    // Mutate original record; stored copy should be unaffected
    record.effect_state = 'IN_FLIGHT' as any;
    const retrieved = j.getOperation('op-1')!;
    expect(retrieved.effect_state).toBe('PRE_DISPATCH');
  });

  it('clear removes all records', () => {
    const j = new InMemoryPauseResumeJournal();
    j.recordOperation({
      operation_id: 'op-1', run_id: 'r1', step_id: 's1', attempt_id: 'a1',
      tool_name: 'read_file', idempotency_key: 'i1', effect_state: 'PRE_DISPATCH' as const, receipt_json: null,
    });
    j.clear();
    expect(j.getOperation('op-1')).toBeNull();
  });

  it('overwrites existing operation on re-record', () => {
    const j = new InMemoryPauseResumeJournal();
    j.recordOperation({
      operation_id: 'op-1', run_id: 'r1', step_id: 's1', attempt_id: 'a1',
      tool_name: 'read_file', idempotency_key: 'i1', effect_state: 'PRE_DISPATCH' as const, receipt_json: null,
    });
    j.recordOperation({
      operation_id: 'op-1', run_id: 'r1', step_id: 's1', attempt_id: 'a1',
      tool_name: 'read_file', idempotency_key: 'i1', effect_state: 'IN_FLIGHT' as const, receipt_json: null,
    });
    expect(j.getOperation('op-1')!.effect_state).toBe('IN_FLIGHT');
  });
});

describe('DefaultEffectReadBack', () => {
  it('returns confirmed for IN_FLIGHT operations', async () => {
    const rb = new DefaultEffectReadBack();
    const result = await rb.query({
      operation_id: 'op-1', run_id: 'r1', step_id: 's1', attempt_id: 'a1',
      tool_name: 'read_file', idempotency_key: 'i1', effect_state: 'IN_FLIGHT' as const, receipt_json: null,
    });
    expect(result.status).toBe('confirmed');
    expect(result).toBeDefined();
  });

  it('returns indeterminate for non-IN_FLIGHT operations', async () => {
    const rb = new DefaultEffectReadBack();
    const result = await rb.query({
      operation_id: 'op-1', run_id: 'r1', step_id: 's1', attempt_id: 'a1',
      tool_name: 'read_file', idempotency_key: 'i1', effect_state: 'PRE_DISPATCH' as const, receipt_json: null,
    });
    expect(result.status).toBe('indeterminate');
  });
});

describe('DefaultEffectReconciliation', () => {
  it('returns indeterminate for all operations', async () => {
    const rc = new DefaultEffectReconciliation();
    const result = await rc.reconcile({
      operation_id: 'op-1', run_id: 'r1', step_id: 's1', attempt_id: 'a1',
      tool_name: 'read_file', idempotency_key: 'i1', effect_state: 'EFFECT_UNKNOWN' as const, receipt_json: null,
    });
    expect(result.status).toBe('indeterminate');
  });
});
