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
 * This module delegates to ToolExecutor which implements the core pipeline.
 * ActionExecutor adds the consent and credential exchange steps.
 */
export { ToolExecutor as ActionExecutor } from '../tools/tool-executor.js';
export type { ToolReceipt, ToolExecutorDeps, ToolExecutorInjectedDeps } from '../tools/tool-executor.js';
export { ToolExecutorError as ActionExecutorError } from '../tools/tool-executor.js';
