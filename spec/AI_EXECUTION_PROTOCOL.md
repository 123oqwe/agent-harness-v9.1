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
2.  Read requirements/requirements.ndjson → select one READY requirement (READY = implementation_maturity: not_started AND delivery_phase == current phase AND all dependencies implementation_maturity: verified AND current phase not BLOCKED). Prefer the order listed in phases/phase-N.yaml (the manifest sequences requirements by dependency priority, e.g. AH-GATEWAY-TESTPROVIDER-001 MUST be first in Phase 1).
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
14. Update requirement status in registry: rewrite the single NDJSON line for this requirement, changing `implementation_maturity` from `not_started` to `verified` (or `implemented` if partial). Use a script: `python3 -c "import json,sys; lines=open('spec/requirements/requirements.ndjson').readlines(); out=[]; [out.append(json.dumps({**json.loads(l),'implementation_maturity':'verified'} if json.loads(l)['id']=='REQ_ID' else l.rstrip(), ensure_ascii=False)) if l.strip() else out.append(l) for l in lines]; open('spec/requirements/requirements.ndjson','w').write('\\n'.join(out)+'\\n')"`. Replace REQ_ID with the actual requirement ID. Do NOT rewrite the entire file by hand.
15. Write evidence to the path in the requirement's `evidence_path` field (e.g. `artifacts/phase1/AH-XXX-001.json`). The `artifacts/` directory exists; create the phase subdirectory if missing.
16. Proceed to next requirement
```

### Test file convention

Each requirement's `test_files` field lists test paths. These are **targets to create or extend**, not pre-existing files. Note:
- Phase 0 tests (in `harness/tests/`) validate **spec artifacts** (schemas, fixtures, state machines) — they exist and pass already.
- Phase 1+ tests validate **product code** (in `harness/<module>/`, e.g. `harness/runtime/`, `harness/tools/`, `harness/security/`) — you write these alongside implementation.
- A requirement's `test_files` may already exist (from Phase 0 spec validation) but test different concerns than the implementation. You MUST add implementation-specific tests for the requirement's acceptance criteria.
- Run `cd harness && npm test` to execute. `npm run build` (tsc --noEmit) type-checks. `npm run lint` is a no-op until `harness/` source files exist.

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
