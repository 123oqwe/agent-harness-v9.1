# Task Plan: agent-harness Phase 2 Completion (REWRITTEN 2026-08-13 11:40)
# HEAD: df9d205dfb22539fd1038a0b17b2f51df3ad4efb (codex/phase2-integrated)
# Skill: planning-with-files v3.9.0

## CRITICAL FINDINGS (hallucinations from previous progress.md)
1. verify:phase1:local was NOT complete (step 7 aggregate never regenerated)
2. Phase 1 aggregate mutation.json is STALE (commit_sha=5edc6497, Aug 8)
3. test:mutation:check FAILS (needs EXPECTED_SHA + fresh aggregate)
4. Phase 2 mutation CANNOT run on macOS (bootstrap line 758 throws on darwin)
5. Phase 2 gate --mode local CANNOT pass on macOS (mutation step fails)
6. GLM live test CANNOT run until aggregate is regenerated
7. No Phase 2 GLM scenario acceptance script exists
8. Control state not updated (protected path, needs CTO approval)

## GOAL
Complete all Phase 1+2 conditions blocking Phase 3 entry.
Then commit and push source code to GitHub (only source, no build artifacts).

## IRON RULES
- No deleting tests, no lowering thresholds, no skip, no fake evidence/mutation
- No filler tests (only toBeDefined / module importable / length>0 / truthy checks)
- No modifying byte-frozen gate manifest (verification/gates/phase2-gate.json)
- No modifying spec/, control/, evidence/ protected paths (need CTO approval)
- Every step fully green before proceeding
- GitHub: only source code (dist/, reports/, .stryker-tmp/, coverage/, *.tgz gitignored)
- securityCriticalModules (NO waivers): router, toolsRegistry, actionControl,
  identitySecrets, vfs, sandbox, session, runtime
- Waivers ONLY allowed: gateway, toolsLeaf, skills, strategies, verification,
  verticals, uiAdapters
- If context compacted: read this file first, then continue
- No hallucination: every fact must be verified from current state

## VERIFIED CURRENT STATE (2026-08-13 11:40)

### Git
- HEAD: df9d205dfb22539fd1038a0b17b2f51df3ad4efb
- Branch: codex/phase2-integrated
- 0 commits ahead of origin (already pushed)
- Dirty: M mutation/equivalent-mutants.json, M progress.md
- .gitignore: dist/, node_modules, .stryker-tmp/, .turbo/, coverage/, reports/, *.tsbuildinfo, *.tgz
- Remotes: origin (123oqwe/agent-harness-v9.1, public), product/release (agentharness91, private)
- gh CLI: available, authenticated as 123oqwe, scopes: gist, read:org, repo, workflow

### Phase 1 Mutation (ALL 15/15 individual PASS, aggregate STALE)
- 13 modules at commit b5737e41, 2 modules (gateway, session) at 5caa4ef6
- Individual scores: gateway 99.94, router 90.19, sandbox 91.00, skills 91.44,
  strategies 85.88, toolsLeaf 90.29, toolsRegistry 91.96, uiAdapters 95.77,
  verification 86.62, verticals 88.48, vfs 92.13, actionControl 91.50,
  identitySecrets 90.78, session 90.15, runtime 90.76
- Aggregate mutation.json: STALE (commit_sha=5edc6497, Aug 8, score 94.26)
- test:mutation:check: FAILS (needs EXPECTED_SHA + fresh aggregate + artifact digest)
- verify:phase1:local step 7: NOT actually completed (aggregate never regenerated)
- Must re-run full Phase 1 mutation at current HEAD (5-8 hours)

### Phase 2 Tests (ALL PASS from previous gate run)
- 17/18 gate commands PASSED (only mutation failed)
- Phase 2 unit: 1535 tests PASS
- Phase 2 integration: 95 tests PASS
- Phase 2 security: 234 tests PASS
- Phase 2 e2e: 78 tests PASS
- Phase 2 architecture: 54 tests PASS
- Coverage: lines 95.95%, branches 92.28%, functions 96.41%

### Phase 2 Gate
- --mode local: FAILED at mutation step (command 18)
  Root cause: Phase 2 mutation bootstrap requires Linux + Node v20.18.1
  bootstrap line 758: throws on macOS "Seatbelt is diagnostic-only"
  CANNOT run on macOS, MUST run in CI
- --mode dev: 6 commands (no mutation), should pass
- Evidence 0/64 (requires ALL 23 commands pass in --mode local)

### CI
- ci.yml: SUCCESS (typecheck, build, lint, test, coverage, audit, pack)
- phase2-mutation.yml: workflow_dispatch, ubuntu-22.04, Node 20.18.1

### Phase 1 Evidence: 40/40 updated to df9d205d
### Phase 2 Evidence: 0/64 (requires full gate pass)

### GLM Live Test (Phase 1 supplement B5a)
- Script: scripts/run-glm-acceptance.mjs
- Requires: GLM_API_KEY, GLM_ALLOW_REMOTE=1, GLM_MODEL=glm-5.2, GLM_REASONING_EFFORT=xhigh
- Requires: MUTATION_ARTIFACT_DIGEST, MUTATION_ARTIFACT_NAME, ACCEPTANCE_EVIDENCE_ROOT
- Validates: report.commit_sha === HEAD (WILL FAIL with stale aggregate)
- CANNOT run until Phase 1 mutation re-run regenerates aggregate

### Phase 2 GLM Scenario Acceptance (exit criteria #4)
- No dedicated script exists
- 6 scenarios: long-context, RAG, multimodal, UX, privacy, failure-recovery
- Need to create script using real GLM 5.2 API

### Control State (protected, needs CTO approval)
- Phase 1: IN_PROGRESS, Phase 2: BLOCKED, Phase 3: BLOCKED
- File: agent-harness-v9.1/control/current-state.json

### Waivers
- 1226 total (1206 gateway + 20 strategies), needs rebind to df9d205d

### Node
- v24.18.0 (Phase 1 mutation OK, Phase 2 mutation needs v20.18.1+Linux)

## EXECUTION PLAN

### Phase 1: Start Phase 1 Mutation Re-run (BACKGROUND, 5-8h) [BLOCKING]
1.1. Rebind waivers to current HEAD (df9d205d)
1.2. Start: node scripts/run-mutation.mjs phase1 (background, DO NOT KILL)
1.3. Monitor: ps aux | grep stryker, tail /tmp/mutation-phase1-rerun.log

### Phase 2: While Mutation Runs (PARALLEL)
2.1. Commit progress.md and findings.md updates
2.2. Run Phase 2 gate --mode dev (6 commands, no mutation)
2.3. Trigger Phase 2 mutation CI: gh workflow run phase2-mutation.yml
2.4. Create Phase 2 GLM scenario acceptance script

### Phase 3: After Phase 1 Mutation Completes
3.1. Verify 15/15 modules PASS with commit_sha=df9d205d
3.2. Run test:mutation:check with EXPECTED_SHA + MUTATION_ARTIFACT_DIGEST
3.3. Run GLM 5.2 live test (real API, NOT mock)
3.4. Run Phase 2 GLM scenario acceptance (6 scenarios, real API)

### Phase 4: Monitor Phase 2 Mutation CI
4.1. Check CI results: gh run list --workflow=phase2-mutation.yml
4.2. Document Phase 2 gate constraints (macOS limitation)

### Phase 5: Update Control State (needs CTO approval)
5.1. Phase 1: VERIFIED, Phase 2: VERIFIED (if CI passes)

### Phase 6: Final Commit and Push
6.1. Clean up planning files
6.2. Ensure .gitignore covers non-source files
6.3. Commit source code only
6.4. Push to origin

## ENV VARS
GLM_API_KEY=e93c1f129cc44ce8908f3f6fa328c00b.hz4tGVIGo3Y8AQni
GLM_MODEL=glm-5.2
GLM_REASONING_EFFORT=xhigh
GLM_ALLOW_REMOTE=1
MUTATION_ARTIFACT_NAME=phase1-mutation-$(git rev-parse HEAD)
MUTATION_ARTIFACT_DIGEST=<computed from aggregate report>
EXPECTED_SHA=$(git rev-parse HEAD)
ACCEPTANCE_EVIDENCE_ROOT=/tmp/phase1-glm-evidence
