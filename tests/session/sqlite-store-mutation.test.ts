import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SqliteSessionStore,
} from '../../session/sqlite-session-store.js';
import {
  createTrustedSessionStateRoot,
  type TrustedSessionStateRoot,
} from '../../session/session-state-root.js';

describe('SQLite Session Store mutation targets', () => {
  const MASTER_KEY = Buffer.alloc(32, 0x5a);
  let dir: string;
  let stateRoot: TrustedSessionStateRoot;
  let store: SqliteSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ah-sqlite-mut-'));
    stateRoot = createTrustedSessionStateRoot(dir);
    store = new SqliteSessionStore(join(dir, 'session.db'), {
      masterKey: MASTER_KEY,
      state_root: stateRoot,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('createScopedRun validation', () => {
    it('throws on empty tenant_id', () => {
      expect(() => store.createScopedRun({ tenant_id: '', root_session_id: 'run-1' } as any, 'run-1', 'goal', 'strategy')).toThrow('run scope is required');
    });

    it('throws on empty root_session_id', () => {
      expect(() => store.createScopedRun({ tenant_id: 'tenant-1', root_session_id: '  ' } as any, 'run-1', 'goal', 'strategy')).toThrow('run scope is required');
    });

    it('throws on null scope', () => {
      expect(() => store.createScopedRun(null as any, 'run-1', 'goal', 'strategy')).toThrow('run scope is required');
    });

    it('throws when run_id does not match root_session_id', () => {
      expect(() => store.createScopedRun({ tenant_id: 'tenant-1', root_session_id: 'different-run' }, 'run-1', 'goal', 'strategy')).toThrow('root run identity must equal root_session_id');
    });

    it('throws on scope conflict when tenant_id differs', () => {
      store.createScopedRun({ tenant_id: 'tenant-1', root_session_id: 'run-1' }, 'run-1', 'goal', 'strategy');
      expect(() => store.createScopedRun({ tenant_id: 'tenant-2', root_session_id: 'run-1' }, 'run-1', 'goal', 'strategy')).toThrow('run scope conflict: run-1');
    });

    it('throws when claiming a pre-existing generic run', () => {
      // Create a generic run first (without scope)
      store.createRun('run-generic', 'goal', 'strategy');
      expect(() => store.createScopedRun({ tenant_id: 'tenant-1', root_session_id: 'run-generic' }, 'run-generic', 'goal', 'strategy')).toThrow('pre-existing generic run cannot be claimed');
    });
  });

  describe('operation upsert validation', () => {
    it('throws on operation identity conflict', () => {
      const op = {
        operation_id: 'op-1',
        run_id: 'run-1',
        step_id: 'step-1',
        attempt_id: 'att-1',
        tool_name: 'tool-1',
        idempotency_key: 'idem-1',
        effect_state: 'PRE_DISPATCH' as const,
        receipt_json: null,
      };
      store.createRun('run-1', 'goal', 'strategy');
      store.recordOperation(op);
      // Try to upsert with different run_id
      expect(() => store.recordOperation({ ...op, run_id: 'run-2' })).toThrow('operation identity conflict: op-1');
    });

    it('throws on operation attempt conflict (non-retry)', () => {
      const op = {
        operation_id: 'op-1',
        run_id: 'run-1',
        step_id: 'step-1',
        attempt_id: 'att-1',
        tool_name: 'tool-1',
        idempotency_key: 'idem-1',
        effect_state: 'PRE_DISPATCH' as const,
        receipt_json: null,
      };
      store.createRun('run-1', 'goal', 'strategy');
      store.recordOperation(op);
      // Move to IN_FLIGHT
      store.recordOperation({ ...op, effect_state: 'IN_FLIGHT' as const });
      // Try with different attempt_id, not retrying
      expect(() => store.recordOperation({ ...op, attempt_id: 'att-2', effect_state: 'EFFECT_CONFIRMED' as const })).toThrow('operation attempt conflict: op-1');
    });

    it('throws on operation state replay conflict', () => {
      const op = {
        operation_id: 'op-1',
        run_id: 'run-1',
        step_id: 'step-1',
        attempt_id: 'att-1',
        tool_name: 'tool-1',
        idempotency_key: 'idem-1',
        effect_state: 'PRE_DISPATCH' as const,
        receipt_json: null,
      };
      store.createRun('run-1', 'goal', 'strategy');
      store.recordOperation(op);
      store.recordOperation({ ...op, effect_state: 'IN_FLIGHT' as const });
      // Same state + same attempt_id but different receipt_json = replay conflict
      expect(() => store.recordOperation({ ...op, effect_state: 'IN_FLIGHT' as const, receipt_json: '{"result":"different"}' })).toThrow('operation state replay conflict: op-1');
    });

    it('throws on invalid effect transition', () => {
      const op = {
        operation_id: 'op-1',
        run_id: 'run-1',
        step_id: 'step-1',
        attempt_id: 'att-1',
        tool_name: 'tool-1',
        idempotency_key: 'idem-1',
        effect_state: 'PRE_DISPATCH' as const,
        receipt_json: null,
      };
      store.createRun('run-1', 'goal', 'strategy');
      store.recordOperation(op);
      store.recordOperation({ ...op, effect_state: 'IN_FLIGHT' as const });
      // EFFECT_CONFIRMED -> PRE_DISPATCH is not valid from IN_FLIGHT
      // Actually IN_FLIGHT -> EFFECT_CONFIRMED is valid, but let's test invalid: PRE_DISPATCH -> EFFECT_CONFIRMED
      // Need to go PRE_DISPATCH -> IN_FLIGHT first, then try invalid
      store.recordOperation({ ...op, effect_state: 'EFFECT_CONFIRMED' as const });
      // EFFECT_CONFIRMED is terminal, any transition should be invalid
      expect(() => store.recordOperation({ ...op, effect_state: 'IN_FLIGHT' as const })).toThrow('invalid effect transition: EFFECT_CONFIRMED -> IN_FLIGHT');
    });

    it('throws on new operation not starting PRE_DISPATCH', () => {
      store.createRun('run-1', 'goal', 'strategy');
      expect(() => store.recordOperation({
        operation_id: 'op-1',
        run_id: 'run-1',
        step_id: 'step-1',
        attempt_id: 'att-1',
        tool_name: 'tool-1',
        idempotency_key: 'idem-1',
        effect_state: 'IN_FLIGHT' as const,
        receipt_json: null,
      })).toThrow('new operation must begin PRE_DISPATCH');
    });

    it('throws on idempotency key collision', () => {
      store.createRun('run-1', 'goal', 'strategy');
      store.recordOperation({
        operation_id: 'op-1',
        run_id: 'run-1',
        step_id: 'step-1',
        attempt_id: 'att-1',
        tool_name: 'tool-1',
        idempotency_key: 'idem-1',
        effect_state: 'PRE_DISPATCH' as const,
        receipt_json: null,
      });
      expect(() => store.recordOperation({
        operation_id: 'op-2',
        run_id: 'run-1',
        step_id: 'step-1',
        attempt_id: 'att-1',
        tool_name: 'tool-1',
        idempotency_key: 'idem-1',
        effect_state: 'PRE_DISPATCH' as const,
        receipt_json: null,
      })).toThrow('idempotency key collision: idem-1 already used by operation op-1');
    });
  });

  describe('receipt validation', () => {
    it('throws on receipt conflict with different tool_name', () => {
      store.createRun('run-1', 'goal', 'strategy');
      store.recordOperation({
        operation_id: 'op-1',
        run_id: 'run-1',
        step_id: 'step-1',
        attempt_id: 'att-1',
        tool_name: 'tool-1',
        idempotency_key: 'idem-1',
        effect_state: 'PRE_DISPATCH' as const,
        receipt_json: null,
      });
      const receipt = {
        tool_name: 'tool-1',
        success: true,
        input_hash: 'hash-1',
        output_hash: 'hash-2',
        duration_ms: 100,
        timestamp: '2026-01-01T00:00:00Z',
      };
      store.recordReceipt('op-1', receipt);
      expect(() => store.recordReceipt('op-1', { ...receipt, tool_name: 'tool-2' })).toThrow('receipt conflict for operation: op-1');
    });

    it('throws on receipt conflict with different success', () => {
      store.createRun('run-1', 'goal', 'strategy');
      store.recordOperation({
        operation_id: 'op-1',
        run_id: 'run-1',
        step_id: 'step-1',
        attempt_id: 'att-1',
        tool_name: 'tool-1',
        idempotency_key: 'idem-1',
        effect_state: 'PRE_DISPATCH' as const,
        receipt_json: null,
      });
      const receipt = {
        tool_name: 'tool-1',
        success: true,
        input_hash: 'hash-1',
        output_hash: 'hash-2',
        duration_ms: 100,
        timestamp: '2026-01-01T00:00:00Z',
      };
      store.recordReceipt('op-1', receipt);
      expect(() => store.recordReceipt('op-1', { ...receipt, success: false })).toThrow('receipt conflict for operation: op-1');
    });

    it('throws on receipt conflict with different input_hash', () => {
      store.createRun('run-1', 'goal', 'strategy');
      store.recordOperation({
        operation_id: 'op-1',
        run_id: 'run-1',
        step_id: 'step-1',
        attempt_id: 'att-1',
        tool_name: 'tool-1',
        idempotency_key: 'idem-1',
        effect_state: 'PRE_DISPATCH' as const,
        receipt_json: null,
      });
      const receipt = {
        tool_name: 'tool-1',
        success: true,
        input_hash: 'hash-1',
        output_hash: 'hash-2',
        duration_ms: 100,
        timestamp: '2026-01-01T00:00:00Z',
      };
      store.recordReceipt('op-1', receipt);
      expect(() => store.recordReceipt('op-1', { ...receipt, input_hash: 'different' })).toThrow('receipt conflict for operation: op-1');
    });

    it('throws on receipt conflict with different duration_ms', () => {
      store.createRun('run-1', 'goal', 'strategy');
      store.recordOperation({
        operation_id: 'op-1',
        run_id: 'run-1',
        step_id: 'step-1',
        attempt_id: 'att-1',
        tool_name: 'tool-1',
        idempotency_key: 'idem-1',
        effect_state: 'PRE_DISPATCH' as const,
        receipt_json: null,
      });
      const receipt = {
        tool_name: 'tool-1',
        success: true,
        input_hash: 'hash-1',
        output_hash: 'hash-2',
        duration_ms: 100,
        timestamp: '2026-01-01T00:00:00Z',
      };
      store.recordReceipt('op-1', receipt);
      expect(() => store.recordReceipt('op-1', { ...receipt, duration_ms: 200 })).toThrow('receipt conflict for operation: op-1');
    });

    it('allows idempotent receipt with identical fields', () => {
      store.createRun('run-1', 'goal', 'strategy');
      store.recordOperation({
        operation_id: 'op-1',
        run_id: 'run-1',
        step_id: 'step-1',
        attempt_id: 'att-1',
        tool_name: 'tool-1',
        idempotency_key: 'idem-1',
        effect_state: 'PRE_DISPATCH' as const,
        receipt_json: null,
      });
      const receipt = {
        tool_name: 'tool-1',
        success: true,
        input_hash: 'hash-1',
        output_hash: 'hash-2',
        duration_ms: 100,
        timestamp: '2026-01-01T00:00:00Z',
      };
      store.recordReceipt('op-1', receipt);
      // Same receipt should not throw
      expect(() => store.recordReceipt('op-1', receipt)).not.toThrow();
    });
  });

  describe('AWAITING_HUMAN terminal state', () => {
    it('rejects transition from AWAITING_HUMAN to any state', () => {
      store.createRun('run-1', 'goal', 'strategy');
      const op = {
        operation_id: 'op-1',
        run_id: 'run-1',
        step_id: 'step-1',
        attempt_id: 'att-1',
        tool_name: 'tool-1',
        idempotency_key: 'idem-1',
        effect_state: 'PRE_DISPATCH' as const,
        receipt_json: null,
      };
      store.recordOperation(op);
      store.recordOperation({ ...op, effect_state: 'IN_FLIGHT' as const });
      store.recordOperation({ ...op, effect_state: 'EFFECT_UNKNOWN' as const });
      store.recordOperation({ ...op, effect_state: 'RECONCILING' as const });
      store.recordOperation({ ...op, effect_state: 'AWAITING_HUMAN' as const });
      // AWAITING_HUMAN is terminal
      expect(() => store.recordOperation({ ...op, effect_state: 'EFFECT_CONFIRMED' as const })).toThrow('invalid effect transition: AWAITING_HUMAN -> EFFECT_CONFIRMED');
    });
  });

  describe('EFFECT_CONFIRMED terminal state', () => {
    it('rejects transition from EFFECT_CONFIRMED to any state', () => {
      store.createRun('run-1', 'goal', 'strategy');
      const op = {
        operation_id: 'op-1',
        run_id: 'run-1',
        step_id: 'step-1',
        attempt_id: 'att-1',
        tool_name: 'tool-1',
        idempotency_key: 'idem-1',
        effect_state: 'PRE_DISPATCH' as const,
        receipt_json: null,
      };
      store.recordOperation(op);
      store.recordOperation({ ...op, effect_state: 'IN_FLIGHT' as const });
      store.recordOperation({ ...op, effect_state: 'EFFECT_CONFIRMED' as const });
      expect(() => store.recordOperation({ ...op, effect_state: 'RECONCILING' as const })).toThrow('invalid effect transition: EFFECT_CONFIRMED -> RECONCILING');
    });
  });

  describe('RECONCILING transitions', () => {
    it('allows RECONCILING -> EFFECT_CONFIRMED', () => {
      store.createRun('run-1', 'goal', 'strategy');
      const op = {
        operation_id: 'op-1',
        run_id: 'run-1',
        step_id: 'step-1',
        attempt_id: 'att-1',
        tool_name: 'tool-1',
        idempotency_key: 'idem-1',
        effect_state: 'PRE_DISPATCH' as const,
        receipt_json: null,
      };
      store.recordOperation(op);
      store.recordOperation({ ...op, effect_state: 'IN_FLIGHT' as const });
      store.recordOperation({ ...op, effect_state: 'EFFECT_UNKNOWN' as const });
      store.recordOperation({ ...op, effect_state: 'RECONCILING' as const });
      expect(() => store.recordOperation({ ...op, effect_state: 'EFFECT_CONFIRMED' as const })).not.toThrow();
    });

    it('allows RECONCILING -> DEFINITELY_FAILED_NO_EFFECT', () => {
      store.createRun('run-1', 'goal', 'strategy');
      const op = {
        operation_id: 'op-1',
        run_id: 'run-1',
        step_id: 'step-1',
        attempt_id: 'att-1',
        tool_name: 'tool-1',
        idempotency_key: 'idem-1',
        effect_state: 'PRE_DISPATCH' as const,
        receipt_json: null,
      };
      store.recordOperation(op);
      store.recordOperation({ ...op, effect_state: 'IN_FLIGHT' as const });
      store.recordOperation({ ...op, effect_state: 'EFFECT_UNKNOWN' as const });
      store.recordOperation({ ...op, effect_state: 'RECONCILING' as const });
      expect(() => store.recordOperation({ ...op, effect_state: 'DEFINITELY_FAILED_NO_EFFECT' as const })).not.toThrow();
    });

    it('allows RECONCILING -> AWAITING_HUMAN', () => {
      store.createRun('run-1', 'goal', 'strategy');
      const op = {
        operation_id: 'op-1',
        run_id: 'run-1',
        step_id: 'step-1',
        attempt_id: 'att-1',
        tool_name: 'tool-1',
        idempotency_key: 'idem-1',
        effect_state: 'PRE_DISPATCH' as const,
        receipt_json: null,
      };
      store.recordOperation(op);
      store.recordOperation({ ...op, effect_state: 'IN_FLIGHT' as const });
      store.recordOperation({ ...op, effect_state: 'EFFECT_UNKNOWN' as const });
      store.recordOperation({ ...op, effect_state: 'RECONCILING' as const });
      expect(() => store.recordOperation({ ...op, effect_state: 'AWAITING_HUMAN' as const })).not.toThrow();
    });
  });

  describe('retry from DEFINITELY_FAILED_NO_EFFECT', () => {
    it('allows retry with different attempt_id when previous was DEFINITELY_FAILED_NO_EFFECT', () => {
      store.createRun('run-1', 'goal', 'strategy');
      const op = {
        operation_id: 'op-1',
        run_id: 'run-1',
        step_id: 'step-1',
        attempt_id: 'att-1',
        tool_name: 'tool-1',
        idempotency_key: 'idem-1',
        effect_state: 'PRE_DISPATCH' as const,
        receipt_json: null,
      };
      store.recordOperation(op);
      store.recordOperation({ ...op, effect_state: 'IN_FLIGHT' as const });
      store.recordOperation({ ...op, effect_state: 'DEFINITELY_FAILED_NO_EFFECT' as const });
      // Retry with new attempt_id
      expect(() => store.recordOperation({ ...op, attempt_id: 'att-2', effect_state: 'PRE_DISPATCH' as const })).not.toThrow();
    });
  });

  describe('close behavior', () => {
    it('throws when using store after close', () => {
      store.close();
      expect(() => store.createRun('run-1', 'goal', 'strategy')).toThrow();
    });
  });

  describe('createRun idempotency', () => {
    it('returns true for new run, false for existing', () => {
      expect(store.createRun('run-1', 'goal', 'strategy')).toBe(true);
      expect(store.createRun('run-1', 'goal', 'strategy')).toBe(false);
    });

    it('throws on run identity conflict with different goal', () => {
      store.createRun('run-1', 'goal-1', 'strategy-1');
      expect(() => store.createRun('run-1', 'goal-2', 'strategy-2')).toThrow('run identity conflict: run-1');
    });
  });

  describe('getRun', () => {
    it('returns null for non-existent run', () => {
      expect(store.getRun('nonexistent')).toBeNull();
    });

    it('returns run record for existing run', () => {
      store.createRun('run-1', 'my goal', 'my strategy');
      const run = store.getRun('run-1');
      expect(run).not.toBeNull();
      expect(run!.run_id).toBe('run-1');
    });
  });

  describe('updateRunStatus', () => {
    it('updates run status', () => {
      store.createRun('run-1', 'goal', 'strategy');
      store.updateRunStatus('run-1', 'completed');
      const run = store.getRun('run-1');
      expect(run!.status).toBe('completed');
    });
  });

  describe('snapshot operations', () => {
    it('rejects snapshot for different run', () => {
      store.createRun('run-1', 'goal', 'strategy');
      expect(() => store.saveSnapshot('run-1', {
        session_id: 'run-2',
        version: 0,
        last_seq: 0,
        last_hash: 'abc',
        created_at: '2026-01-01T00:00:00Z',
        summary: {},
      } as any)).toThrow('snapshot identity conflict: run-1');
    });

    it('saves and loads snapshots', () => {
      store.createRun('run-1', 'goal', 'strategy');
      store.saveSnapshot('run-1', {
        session_id: 'run-1',
        version: 0,
        last_seq: 0,
        last_hash: 'abc',
        created_at: '2026-01-01T00:00:00Z',
        summary: { messages: [{ role: 'user', content: 'hi' }] },
      } as any);
      const snap = store.getLatestSnapshot('run-1');
      expect(snap).not.toBeNull();
      expect(snap!.version).toBe(0);
    });

    it('returns null for non-existent snapshot', () => {
      store.createRun('run-1', 'goal', 'strategy');
      expect(store.getLatestSnapshot('run-1')).toBeNull();
    });
  });
});
