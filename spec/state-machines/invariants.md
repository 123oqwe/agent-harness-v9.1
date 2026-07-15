# State Machine Invariants

## OperationStateMachine Invariants (must be model-checked)

1. No unauthorized execution: Must pass through POLICY_EVALUATED -> AUTHORIZED before any execution
2. No double irreversible effect: Same operation cannot commit twice
3. Expired fencing cannot commit: EXPIRED is terminal
4. Terminal states not re-enterable: All terminal states are final
5. CONSENT_EXEMPT exists: Low-risk auto-approve path
6. Only PRE_DISPATCH_FAILED can automatic retry
7. EFFECT_UNKNOWN must read-back before retry: RECONCILING required
8. AWAITING_HUMAN is non-terminal: Can transition to EFFECT_CONFIRMED or REMEDIATION_REQUIRED
9. REMEDIATION_REQUIRED is terminal: Requires new Run or human process
10. Each retry generates new attempt_id and new CapabilityToken

## RunStateMachine Invariants

1. Terminal states not re-enterable
2. Cannot execute without valid frozen RunPlan
3. Pause during IN_FLIGHT must check effect state before resume

## ExternalEffectStateMachine Invariants

1. IN_FLIGHT cannot retry - must query first
2. EFFECT_UNKNOWN must reconcile
3. Prepare -> Commit -> Read-back two-phase protocol

## ApprovalStateMachine Invariants

1. No execution without approval for T2+
2. AWAITING_HUMAN non-terminal
3. REMEDIATION_REQUIRED terminal

## Cross-Machine Invariants

1. CapabilityToken use_limit=1 enforced atomically
2. Policy enters BEFORE routing
3. PEP at EVERY action
4. Child Capability signed by Authorization Service (not parent)
