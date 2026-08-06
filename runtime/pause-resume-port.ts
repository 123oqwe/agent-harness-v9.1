/**
 * In-memory adapter ports for PauseResumeController.
 * Provides journal, read-back, and reconciliation implementations
 * suitable for local and test usage.
 */
import type {
  PauseResumeJournalPort,
  PauseResumeEffectRecord,
  EffectReadBackPort,
  EffectResolution,
  EffectReconciliationPort,
} from '@agent-harness/runtime-core';

/** In-memory journal: stores operation records keyed by operation_id. */
export class InMemoryPauseResumeJournal implements PauseResumeJournalPort {
  private readonly records = new Map<string, PauseResumeEffectRecord>();

  getOperation(operationId: string): PauseResumeEffectRecord | null {
    return this.records.get(operationId) ?? null;
  }

  recordOperation(record: PauseResumeEffectRecord): void {
    this.records.set(record.operation_id, { ...record });
  }

  clear(): void {
    this.records.clear();
  }
}

/**
 * Read-back port that resolves IN_FLIGHT operations.
 * Default implementation treats all operations as "confirmed" (safe for
 * local development where effects are immediate). Production deployments
 * should inject a real read-back port that queries the external system.
 */
export class DefaultEffectReadBack implements EffectReadBackPort {
  async query(operation: PauseResumeEffectRecord): Promise<EffectResolution> {
    // For local usage: assume the effect was confirmed if the operation
    // reached IN_FLIGHT state. This is safe because local operations are
    // synchronous and their effects are immediately verifiable.
    if (operation.effect_state === 'IN_FLIGHT') {
      return {
        status: 'confirmed',
        stored_outcome_json: JSON.stringify({ operation_id: operation.operation_id }),
      };
    }
    return { status: 'indeterminate' };
  }
}

/**
 * Reconciliation port for EFFECT_UNKNOWN operations.
 * Default implementation returns "indeterminate" which transitions to
 * AWAITING_HUMAN. Production deployments should inject a real reconciler.
 */
export class DefaultEffectReconciliation implements EffectReconciliationPort {
  async reconcile(_operation: PauseResumeEffectRecord): Promise<EffectResolution> {
    return { status: 'indeterminate' };
  }
}
