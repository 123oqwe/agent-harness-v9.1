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

### Per-Phase acceptance order

Each Phase closes in two non-substitutable steps:

1. The repository-local gate builds, type-checks, tests, runs requirement evals/security/fault cases, validates manifests and maturity paths, and emits reproducible Evidence Packages. No external model is needed for this step.
2. Only after the local gate passes, a read-only independent GLM-5.2 xhigh run receives the frozen requirements, source revision, tests and evidence. It evaluates semantic completeness and adversarial product tasks, cannot edit source/tests/evidence, and emits a separate signed review record.

A model review cannot turn a failing local gate into PASS, and a local green test suite cannot replace the independent semantic review. Human approval remains mandatory wherever Policy or release rules require it.

## Quality Scoring (4 dimensions)
mechanical: test_coverage, safety_checks
semantic: correctness, completeness (by independent reviewer)
Rule: generating model does NOT score itself


## Pre-Approval Auto-Review (G-CX1)

Distinct from Independent Verifier (post-completion): Pre-Approval Auto-Review runs BEFORE user consent is requested for T3+ actions.

### When (action-control step 5a, after step 4 Policy eval, before step 5b Consent check)
Only for DerivedRiskTier >= T3 and RunPlan.context_strategy.auto_review_enabled (default true for T3+).

### What (reviewer agent evaluates ActionManifest)
- Is this action necessary for the goal?
- Is the risk tier correctly derived?
- Is there a lower-risk alternative?
- Does the action match the user's stated intent?

### Outcomes
- **downgrade**: risk over-assessed → tier lowered (e.g. T3→T2), user not disturbed. Logged with rationale. Advisory: PEP may override.
- **confirm**: tier correct → Consent check proceeds normally (step 5b).
- **escalate**: risk under-assessed or action suspicious → tier raised, force human consent even if originally T2. Logged with rationale. Binding: PEP cannot override.

### Constraints
- Reviewer is read-only: cannot modify ActionManifest, issue Capability, or execute.
- Reviewer uses different model OR same model with different system prompt (anti-sycophancy).
- Distinct from Independent Verifier: Verifier checks output correctness post-completion; auto-review checks action prudence pre-consent. Both run.

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
