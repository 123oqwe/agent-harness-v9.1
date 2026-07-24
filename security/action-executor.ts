/**
 * AH-ACTION-EXECUTOR-001: Action Executor (12-step pipeline)
 *
 * Implements the documented 12-step Action Control pipeline:
 *   1. Schema validation
 *   2. Effect classification (EffectRisk)
 *   3. Risk derivation (EffectRisk + Policy + Context -> DerivedRiskTier)
 *   4. Policy evaluation (PEP, deny-by-default)
 *   5a. Pre-Approval Auto-Review (G-CX1, if tier >= T3)
 *   5b. Consent check
 *   6. Capability issuance (Authorization Service signs)
 *   7. PEP validation (verify token valid, not expired, not used)
 *   7b. TOCTOU re-validation (recompute manifest hash)
 *   8. Credential exchange (Secret Broker, single-use, scoped)
 *   9. VFS or Sandbox dispatch
 *   10. Receipt capture
 *   11. Postcondition verification
 *   12. Audit (immutable audit event)
 *
 * ToolExecutor remains the low-level compatibility implementation. The
 * product composition root uses this concrete authority, which requires
 * consent, postcondition verification and final immutable audit.
 */
import {
  ToolExecutor,
  ToolExecutorError,
  type ToolExecutorDeps,
  type ToolExecutorInjectedDeps,
  type ToolReceipt,
} from '../tools/tool-executor.js';
import type { ConsentService } from './consent.js';
import type { AuditSink } from './audit-sink.js';
import type { ToolSpec } from '../contracts/index.js';
import type { PostconditionVerifierPort } from '../tools/tool-executor.js';

export interface ActionExecutorInjectedDeps extends ToolExecutorInjectedDeps {
  consent: ConsentService;
  auditSink: AuditSink;
  postconditionVerifier: NonNullable<ToolExecutorInjectedDeps['postconditionVerifier']>;
}

export class DeclaredPostconditionVerifier implements PostconditionVerifierPort {
  async verify(input: {
    readonly tool: ToolSpec;
    readonly result: unknown;
  }): Promise<{ readonly valid: boolean; readonly reason?: string }> {
    if (input.result === undefined) {
      return { valid: false, reason: 'tool returned undefined' };
    }
    for (const condition of input.tool.postconditions) {
      const kind = condition.type;
      if (kind === 'required_field') {
        const field = condition.field;
        if (
          typeof field !== 'string' ||
          typeof input.result !== 'object' ||
          input.result === null ||
          !(field in input.result)
        ) {
          return {
            valid: false,
            reason: `required postcondition field missing: ${String(field)}`,
          };
        }
      } else {
        return {
          valid: false,
          reason: `unsupported postcondition: ${String(kind)}`,
        };
      }
    }
    return { valid: true };
  }
}

export class ActionExecutor extends ToolExecutor {
  readonly #auditSink: AuditSink;
  readonly #operationId: string | undefined;

  constructor(deps: ToolExecutorDeps, injected: ActionExecutorInjectedDeps) {
    super(deps, injected);
    this.#auditSink = injected.auditSink;
    this.#operationId = injected.execCtx?.operation_id;
  }

  override async execute<T>(
    toolName: string,
    input: unknown,
    effect: (deps: ToolExecutorDeps) => Promise<T>,
    verifyResult?: (result: T) => Promise<void> | void,
  ): Promise<{ result: T; receipt: ToolReceipt }> {
    const started = Date.now();
    try {
      const outcome = await super.execute<T>(
        toolName,
        input,
        effect,
        verifyResult,
      );
      this.#auditSink.record({
        tool_name: toolName,
        ...(outcome.receipt.token_id === undefined
          ? {}
          : { token_id: outcome.receipt.token_id }),
        verdict: 'allow',
        risk_tier: outcome.receipt.derived_risk_tier ?? 0,
        manifest_hash_match: true,
        reason: 'postconditions_verified',
        ...(this.#operationId === undefined
          ? {}
          : { operation_id: this.#operationId }),
        duration_ms: Math.max(1, Date.now() - started),
      });
      return outcome;
    } catch (error) {
      this.#auditSink.record({
        tool_name: toolName,
        verdict: 'deny',
        risk_tier: 0,
        manifest_hash_match: false,
        reason: error instanceof Error ? error.message : String(error),
        ...(this.#operationId === undefined
          ? {}
          : { operation_id: this.#operationId }),
        duration_ms: Math.max(1, Date.now() - started),
      });
      throw error;
    }
  }
}

export type { ToolReceipt, ToolExecutorDeps } from '../tools/tool-executor.js';
export { ToolExecutorError as ActionExecutorError };
