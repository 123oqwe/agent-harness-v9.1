# Action Control


![07-operation-state-machine.svg](diagrams/07-operation-state-machine.svg)

## Tool Execution Pipeline (12 steps)
1. Schema validation
2. Effect classification (EffectRisk)
3. Risk derivation (EffectRisk + Policy + Context -> DerivedRiskTier)
4. Policy evaluation (PEP)
5. Consent check
6. Capability issuance (Authorization Service signs)
7. PEP validation (verify token valid, not expired, not used)
8. Credential exchange (Secret Broker provides short-lived credential)
9. Sandbox/environment dispatch
10. Receipt capture
11. Postcondition verification
12. Audit (immutable audit event)

## v9 Corrections
- Policy enters BEFORE routing (not after)
- PEP at EVERY action (not just plan validation)
- Child Capability signed by Authorization Service (NOT parent)
- EffectRisk replaces static risk tiers
- Email compensation = unavailable (NOT retractable)
- Re-route creates new RunPlan revision + revokes old capabilities
