# Task Plan: agent-harness Phase 2 Completion

## Goal
Complete all Phase 1+2 conditions blocking Phase 3 entry: mutation scores pass, evidence refreshed, thin tests thickened, gate closure, GLM acceptance, then commit and push source code to GitHub.

## Current State (HEAD: 94b134f9, 2026-08-08)
- Phase 1 mutation RUNNING (chunk 40/43 gateway, 4 gateway + 14 modules remaining, ~45-75 min ETA)
- CI running (31228262998) with 45-min timeout (was 30, increased for larger test suite)
- Phase 2 unit tests: 959/959 PASS (+201 tests from thickening)
- Phase 2 integration: 95/95 PASS
- Phase 2 e2e: 78/78 PASS
- Phase 2 security: 234/234 PASS
- Phase 1 security: 113/113 PASS
- Active stubs: 0
- Crash restore: 3/3 PASS
- Domain evals: 12/12 PASS
- 20 waivers rebound to HEAD (uncommitted, as expected)
- Only mutation/equivalent-mutants.json uncommitted

## Phases

### Phase A: Preparation - COMPLETE
- [x] A1: Commit uncommitted files
- [x] A2: Verify dev gate passes (success=true)
- [x] A3: Push HEAD to origin

### Phase B: Phase 1 Mutation - IN PROGRESS
- [x] B0: Clean .stryker-tmp, npm run prepare, set GLM_API_KEY
- [x] B0b: Fix CI failures (env leak, VFS routing, OCI runtime, ripgrep install, timeout increase)
- [ ] B1: Run Phase 1 mutation (RUNNING, chunk 40/43, ~45-75 min ETA)
- [ ] B2: Check mutation results, fix failing modules (add tests or waivers)
- [ ] B3: Independent mutation verification (npm run test:mutation:check)
- [ ] B4: verify:phase1:local (typecheck + cycles + build + lint + test + coverage + mutation)
- [ ] B5: Phase 1 exit_criteria supplements:
  - [x] B5b: Domain evals 12/12 PASS
  - [x] B5c: Crash restore 3/3 PASS
  - [x] B5d: Active stubs 0
  - [x] B6: Security tests 113/113 PASS
  - [ ] B5a: GLM live (requires mutation complete + MUTATION_ARTIFACT_DIGEST)
  - [ ] B5e: test:mutation:check (same as B3)
- [ ] B7: Regenerate Phase 1 evidence (40 files, stale SHA)

### Phase C: Phase 2 Thin Test Thickening - COMPLETE
- [x] C0: All 52 thin tests thickened (~201 new tests added)
- [x] C1: Phase 2 unit tests 959/959 PASS

### Phase D: Phase 2 Gate Closure
- [ ] D1: Verify git status clean (only equivalent-mutants.json uncommitted)
- [ ] D2: verify:phase2:dev passes
- [ ] D3: Push to origin, wait for CI green
- [ ] D4: Run Phase 2 mutation via GitHub Actions (gh workflow run phase2-mutation.yml)
- [ ] D5: Run local gate commands individually (except #18 mutation - CI only)
- [ ] D6: Confirm Phase 2 exit_criteria (evidence 64/64, 23 commands pass, active_stubs=0, GLM xhigh)

### Phase E: GLM-5.2 xhigh Scenario Acceptance
- [x] E1: GLM source review (52 files, 0 high/critical)
- [ ] E2: 6 scenario acceptance (long-context, RAG, multimodal, UX, privacy, failure-recovery)

### Phase F: commit and push
- [ ] F1: Final verification (all checks pass)
- [ ] F2: Commit all source changes
- [ ] F3: Push to GitHub (source code only, .gitignore excludes build artifacts)

## Key Facts
- GLM_API_KEY: e93c1f129cc44ce8908f3f6fa328c00b.hz4tGVIGo3Y8AQni
- origin: https://github.com/123oqwe/agent-harness-v9.1.git (PUBLIC, has runner)
- configurationHash: 2e02aab1022cac3c64b20c94300813b6dbd1d572b8bd8c9dae4f6d0749b52bd2
- 15 mutation modules: gateway(85), router(90), toolsRegistry(90), toolsLeaf(85), skills(85), strategies(85), actionControl(90), identitySecrets(90), vfs(90), sandbox(90), session(90), runtime(90), verification(85), verticals(85), uiAdapters(85)
- 4 new modules: actionControl, runtime, session, identitySecrets (no old results)
- Old gateway score: 84.68 (FAIL, threshold 85, gap 0.32%)
- Phase 2 mutation CANNOT run locally (macOS, needs Linux bubblewrap)
- GLM live test requires: mutation complete + PASS + MUTATION_ARTIFACT_DIGEST + ACCEPTANCE_EVIDENCE_ROOT
- Phase 2 mutation workflow: .github/workflows/phase2-mutation.yml (exists)
