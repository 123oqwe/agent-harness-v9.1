import { describe, it, expect } from 'vitest';
import { DurableSession } from '../../session/durable-session.js';

describe('AH-SESSION-001: crash restore', () => {
  it('restore produces same state as before crash', () => {
    const session1 = new DurableSession('run-001');
    session1.append({ type: 'run_started', run_id: 'run-001', data: {} });
    session1.append({
      type: 'action_executed',
      run_id: 'run-001',
      step_id: 'step-1',
      data: { tool_name: 'read_file' },
    });
    session1.append({
      type: 'action_executed',
      run_id: 'run-001',
      step_id: 'step-1',
      data: { tool_name: 'write_file' },
    });

    const stateBefore = session1.getState('executed_actions');
    const result = session1.restore(0);
    const stateAfter = result.state.executed_actions;

    expect(stateAfter).toEqual(stateBefore);
  });

  it('crash restore does not duplicate non-idempotent effects', () => {
    const session = new DurableSession('run-001');
    session.append({
      type: 'action_executed',
      run_id: 'run-001',
      step_id: 'step-1',
      data: { tool_name: 'write_file' },
    });

    // Restore
    const result = session.restore(0);
    const executedAfter = result.state.executed_actions as string[];

    // write_file should appear exactly once, not duplicated
    const writeCount = executedAfter.filter((t) => t === 'write_file').length;
    expect(writeCount).toBe(1);
  });

  it('multiple restores produce identical results', () => {
    const session = new DurableSession('run-001');
    session.append({ type: 'run_started', run_id: 'run-001', data: {} });
    session.append({
      type: 'action_executed',
      run_id: 'run-001',
      data: { tool_name: 'read_file' },
    });

    const r1 = session.restore(0);
    const r2 = session.restore(0);
    expect(r1.events_replayed).toBe(r2.events_replayed);
    expect(r1.state).toEqual(r2.state);
  });

  it('snapshot + restore works for long running session', () => {
    const session = new DurableSession('run-001');
    for (let i = 0; i < 10; i++) {
      session.append({
        type: 'action_executed',
        run_id: 'run-001',
        step_id: `step-${i}`,
        data: { tool_name: `tool_${i}` },
      });
    }
    const snap = session.snapshot();
    
    // More events after snapshot
    for (let i = 10; i < 15; i++) {
      session.append({
        type: 'action_executed',
        run_id: 'run-001',
        step_id: `step-${i}`,
        data: { tool_name: `tool_${i}` },
      });
    }

    const result = session.restore(snap.last_seq);
    // 5 action_executed events after snapshot (snapshot_created is also replayed)
    expect(result.events_replayed).toBe(6);
  });
});
