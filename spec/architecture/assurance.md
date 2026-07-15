# Assurance & Verification

## Advisory Loop (8 stages)
Intent -> Context -> Plan -> Execute -> Verify -> Recover -> Reflect -> Compact

## Evidence Contract Levels
E0: claim | E1: interface | E2: unit_tested | E3: integration_tested | E4: fault_injected | E5: adversarial_tested | E6: canary_verified | E7: production_observed

Level bound to actual verification strength, not file existence.

## Independent Verifier
- Must NOT read generating agent's full explanatory context (avoid confirmation bias)
- Sees: requirements + output + evidence + test results + success criteria only
- Different model family from implementation

## Quality Scoring (4 dimensions)
mechanical: test_coverage, safety_checks
semantic: correctness, completeness (by independent reviewer)
Rule: generating model does NOT score itself


## Implementation Notes

### Evidence Levels (bound to actual verification, not file existence)
- E0: claim (assertion only)
- E1: interface (compiles)
- E2: unit_tested (unit tests pass)
- E3: integration_tested (integration tests pass with real components)
- E4: fault_injected (fault injection tests pass)
- E5: adversarial_tested (security/adversarial tests pass)
- E6: canary_verified (canary SLO met)
- E7: production_observed (production monitoring confirms)

### Independent Verifier
- Uses different model family from implementer
- Read-only: cannot modify code, tests, requirements, evidence
- Reruns tests in clean checkout
- Compares own output hashes to Evidence Package hashes
- Issues signed VerificationRecord

### Quality Scoring (4 dimensions)
- mechanical: test_coverage %, safety_checks pass
- semantic: correctness + completeness (by independent reviewer)
- Rule: generating model does NOT score itself
