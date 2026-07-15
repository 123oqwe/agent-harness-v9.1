# AI Execution Protocol

## MUST

- Read the current phase manifest (`phases/phase-N.yaml`) before starting any work
- Implement ONE Requirement at a time from `requirements/requirements.ndjson`
- Verify all dependencies are VERIFIED before starting a requirement
- Write tests first or alongside implementation
- Generate Evidence Packages from **actual command output only**
- Use an independent verifier (different model family) for verification
- Follow the Blocked Protocol when stuck
- Generate Phase Handoff files at end of each phase
- Work in isolated worktrees (one branch per requirement)

## MUST NOT

- Do not infer missing product decisions
- Do not weaken security gates
- Do not change required fields to optional
- Do not mark tests as skipped to make them pass
- Do not enable production credentials
- Do not claim success without command evidence
- Do not progress when the current Phase Gate fails
- Do not deploy to production without ReleaseApproval
- Do not modify security contracts without ADR + human approval
- Do not delete prior phase regression tests
- Do not use mock to substitute Gate-required real implementation
- Do not fabricate test output
- Do not bypass Policy/PEP/sandbox
- Do not implement deprecated v8 content

## Work Loop

```
1.  Read phases/phase-N.yaml
2.  Read requirements/requirements.ndjson → select one READY requirement
3.  Verify dependencies are all VERIFIED
4.  Create worktree: req/AH-DOMAIN-TOPIC-NNN
5.  Read the requirement's contract schema and acceptance criteria
6.  Write or update tests
7.  Implement minimal complete logic (no stubs on active path)
8.  Run targeted tests
9.  Run package tests
10. Run type-check, lint, security scan, contract validation
11. Generate Evidence Package from actual output
12. Independent verifier checks (different model family)
13. Commit
14. Update requirement status in registry
15. Proceed to next requirement
```

## Blocked Protocol

When encountering any of these conditions, STOP and report blocked:

| Blocker Type | Example |
|-------------|---------|
| specification_conflict | Two requirements contradict each other |
| missing_dependency | Referenced requirement not yet verified |
| real_credential_required | Need production API key to test |
| paid_account_required | Need paid provider account |
| human_legal_decision | Privacy policy decision needed |
| vendor_approval | Provider API access needed |
| test_environment_unavailable | Sandbox/down |
| security_property_unprovable | Cannot prove invariant |
| undefined_state_transition | State machine gap |
| external_api_semantics_unknown | Provider behavior unclear |
| product_ux_decision | UX flow not specified |
| irreversible_infrastructure | Cannot modify safely |

Output format:
```json
{
  "status": "blocked",
  "blocker_type": "...",
  "affected_requirements": ["AH-..."],
  "known_evidence": ["..."],
  "required_decision": ["..."]
}
```

## Phase Handoff

At end of each phase, generate:
```
PHASE_HANDOFF.md
phase-summary.json
verified-requirements.json
open-blockers.json
architecture-snapshot.json
schema-version-map.json
migration-notes.md
known-limitations.md
```

## Evidence Package

```json
{
  "requirement_id": "AH-...",
  "commit_sha": "...",
  "source_files": [],
  "tests_added": [],
  "commands_run": [],
  "exit_codes": [],
  "test_results": {},
  "coverage": {},
  "security_checks": {},
  "known_limitations": [],
  "verifier_result": "pass",
  "verifier_model": "different model family"
}
```

Only actual command output is accepted. Self-reported "PASS" without evidence is forbidden.

## Release Authorization

Production cutover requires:
```json
{
  "release_id": "...",
  "build_digest": "...",
  "release_manifest_hash": "...",
  "target_environment": "production",
  "approved_by": "human principal",
  "approved_at": "ISO 8601",
  "expires_at": "ISO 8601",
  "webauthn_signature": "..."
}
```

Without this signed contract: can deploy to Canary, CANNOT cutover to Production.
