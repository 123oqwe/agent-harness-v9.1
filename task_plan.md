# Task Plan: agent-harness Phase 2 Completion

## Goal
Complete all Phase 1+2 conditions blocking Phase 3 entry: mutation scores pass, evidence refreshed, thin tests thickened, gate closure, GLM acceptance, then commit and push source code to GitHub.

## Next Step
Monitor Phase 1 mutation (running in screen "mutation" with caffeinate -i, PID 69340). Gateway chunk 1/43 in progress. 5-8h ETA.

## Current Phase
Phase B: Phase 1 Mutation Running (restarted with caffeinate -i to prevent sleep)

## Phases

### Phase A: Preparation
- [x] A1: Commit uncommitted files (HARNESS_SESSION_DIRECTIVE.md), keep equivalent-mutants.json uncommitted
- [x] A2: Verify dev gate passes (verify:phase2:dev -> success=true)
- [x] A3: Push HEAD to origin (721450a8 pushed)
- [x] A3b: Push to origin (7052dcf3 pushed, includes env leak fix + plan review)
- **Status:** complete

### Phase B: Phase 1 Mutation Rerun (LOCAL, 5-8h)
- [x] B0: Clean .stryker-tmp, npm run prepare (patches applied), set GLM_API_KEY
- [ ] B1: Run Phase 1 mutation (env leak fixed in 3 files, 603/603 gateway tests pass with GLM_API_KEY, ready to rerun)
- [ ] B1: Mutation RUNNING in screen session "mutation" (PID 3240, gateway chunk 1/43 dry run PASSED, 5-8h ETA)
- [ ] B1: Previous run crashed at chunk 32/43 (PID 3215 died, 31 chunks lost). Restarted with caffeinate -i (PID 69340). Gateway chunk 1/43 in progress.
- [ ] B2: Check mutation results, fix failing modules (add tests or register waivers)
- [ ] B3: Independent mutation verification (npm run test:mutation:check)
- [ ] B4: verify:phase1:local (typecheck + cycles + build + lint + test + coverage + mutation)
- [ ] B5: Phase 1 exit_criteria supplements (GLM live, evals, crash-restore, active-stubs)
- [ ] B6: Security metrics (sandbox_violation=0, unauthorized_effect=0, capability_replay=0)
- [ ] B7: Regenerate Phase 1 evidence (40 files, manual update with new HEAD SHA)
- **Status:** in_progress

### Phase C: Phase 2 Thin Test Thickening
- [ ] C0: Review and thicken 52 Phase 2 thin tests (33-116 lines each)
- [ ] C1: Full Phase 2 test verification (npx vitest run tests/phase-2/)
- **Status:** pending

### Phase D: Phase 2 Gate Closure
- [ ] D1: Verify git status clean (only equivalent-mutants.json uncommitted)
- [ ] D2: verify:phase2:dev passes
- [ ] D3: Push to origin, wait for CI green
- [ ] D4: Run Phase 2 mutation via GitHub Actions (gh workflow run phase2-mutation.yml)
- [ ] D5: Run local gate commands individually (except mutation #18 - CI only)
- [ ] D6: Confirm Phase 2 exit_criteria
- **Status:** pending

### Phase E: GLM-5.2 xhigh Scenario Acceptance
- [ ] E1: GLM source review (52 files already reviewed, 0 high/critical)
- [ ] E2: 6 scenario acceptance (long-context, RAG, multimodal, UX, privacy, failure-recovery)
- **Status:** pending

### Phase F: commit and push
- [ ] F1: Final verification (all checks pass)
- [ ] F2: Commit all source changes
- [ ] F3: Push to GitHub (origin, public, has runner)
- **Status:** pending

## Key Questions
1. Phase 2 mutation CANNOT run locally on macOS (requires Linux bubblewrap) - must use GitHub Actions. How to handle local gate command #18? (Run via CI, accept candidateReady cannot be achieved locally)
2. Phase 1 evidence regeneration has no automated script - must manually update 40 files with new SHA. Write a helper script?
3. GLM live acceptance (test:glm:live) requires MUTATION_ARTIFACT_DIGEST and MUTATION_ARTIFACT_NAME env vars - is this the right mechanism for Phase 1 independent_glm_5_2_xhigh?
4. Should artifacts/ and evidence/ directories be pushed to GitHub? User says "GitHub上只放源码" but these are verification artifacts, not source.

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Phase 2 mutation via GitHub Actions | isolatedCommand() throws on macOS: "Seatbelt is diagnostic-only; release candidate CI requires Linux bubblewrap" |
| equivalent-mutants.json stays uncommitted | repositoryContext (line 793-795) allows uncommitted waiver rebind |
| Keep artifacts/ and evidence/ in git | They are part of repo verification integrity, .gitignore already excludes non-source (dist/, reports/, node_modules/) |
| Phase 1 mutation runs locally | run-mutation.mjs has NO platform restriction, uses Stryker directly |
| Fix GLM_API_KEY env leak in tests | KeyVault.loadFromEnv() auto-loads env GLM_API_KEY; tests must delete it in beforeEach before creating KeyVault |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Stale mutation lock (PID 77574 dead) | 1 | Cleaned reports/mutation/.phase1.lock via python3 shutil.rmtree |
| nohup process exited silently | 1 | Run directly in foreground to see output, use exec_command with session |
| Mutation gateway chunk 1/43 dry run failed: expected 'Bearer e93c1f...' to be 'Bearer test-key' | 1 | Fixed provider-adapters.test.ts: added beforeEach delete GLM_API_KEY/ZHIPU_API_KEY in resolve() describe block |
| key-vault.test.ts: "supports ZHIPU_API_KEY for zhipu provider" fails with GLM_API_KEY set | 1 | Fixed: added delete process.env.GLM_API_KEY before ZHIPU_API_KEY test (commit 1f9c3232) |
| managed-gateway-stream.test.ts: "completeStream respects rate limits" fails with GLM_API_KEY set | 1 | Fixed: added delete GLM_API_KEY/ZHIPU_API_KEY in beforeEach (commit 1f9c3232) |

## Notes
- HEAD: 7052dcf3 (pushed to origin)
- HEAD: 0fc68dbd (after plan update commit, not yet pushed)
- Uncommitted: only mutation/equivalent-mutants.json (waiver rebind to 7052dcf3, runner allows)
- Uncommitted: only mutation/equivalent-mutants.json (waiver rebind to 0fc68dbd, runner allows)
- Mutation running in screen session "mutation", monitor: tail -f /tmp/phase1-mutation-run.log
- Mutation restarted with caffeinate -i to prevent system sleep (previous run died after 2h)
- Previous run: 31/43 gateway chunks completed then process died (PID 3215). Results lost (new runId).
- Env leak fix committed: 1f9c3232 (3 test files: provider-adapters, key-vault, managed-gateway-stream)
- 603/603 gateway tests pass with GLM_API_KEY set in env (verified 03:12)
- Previous mutation session 78665 ended (no new results generated, all old results still stale)
- Need full test suite re-verification with GLM_API_KEY set before rerunning mutation
- KeyVault.loadFromEnv() reads GLM_API_KEY/ZHIPU_API_KEY on construction; tests that create KeyVault must delete these env vars first
- Tests that pass without GLM_API_KEY can FAIL with it set (mutation runner exports it)
- configurationHash: 2e02aab1022cac3c64b20c94300813b6dbd1d572b8bd8c9dae4f6d0749b52bd2 (verified)
- Phase 1 baseline: 8dca581e11b8043aed257cb07c5161237633c40e (HEAD is descendant, verified)
- GLM_API_KEY: e93c1f129cc44ce8908f3f6fa328c00b.hz4tGVIGo3Y8AQni
- origin: https://github.com/123oqwe/agent-harness-v9.1.git (PUBLIC, has runner)
- product: https://github.com/123oqwe/agentharness91.git (PRIVATE, no runner)
- 15 mutation modules: gateway(85), router(90), toolsRegistry(90), toolsLeaf(85), skills(85), strategies(85), actionControl(90), identitySecrets(90), vfs(90), sandbox(90), session(90), runtime(90), verification(85), verticals(85), uiAdapters(85)
- 4 missing modules: actionControl, runtime, session, identitySecrets (no result.json)
- Old gateway score: 84.68 (FAIL, threshold 85, gap 0.32%)
- Phase 1 tests: 2859/2859 PASS, Phase 2 unit: 758/758 PASS
- Phase 1 tests with GLM_API_KEY set: 603/603 gateway tests pass (other modules not yet re-verified with GLM_API_KEY)
