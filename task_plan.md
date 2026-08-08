# Task Plan: agent-harness Phase 2 Completion
#
# Created: 2026-08-08 14:30
# Last Updated: 2026-08-08 23:40
# HEAD: f55e4a2f (waiver rebind on top of 9784550e)
# Skill: manus2.0planningwithfiles

## GOAL
Complete all Phase 1+2 conditions blocking Phase 3 entry.
Then commit and push source code to GitHub (only source, no build artifacts).

## IRON RULES
- No deleting tests, no lowering thresholds, no skip, no fake evidence/mutation
- No filler tests (only toBeDefined / module importable)
- No modifying byte-frozen gate manifest (verification/gates/phase2-gate.json)
- No modifying spec/, control/, evidence/ protected paths (need CTO approval)
- Every step fully green before proceeding
- GitHub: only source code (dist/, reports/, .stryker-tmp/ gitignored)
- securityCriticalModules (NO waivers): router, toolsRegistry, actionControl,
  identitySecrets, vfs, sandbox, session, runtime
- Waivers ONLY allowed: gateway, toolsLeaf, skills, strategies, verification,
  verticals, uiAdapters
- B3c mutation run: NO commits until it completes

## CURRENT STATE (2026-08-08 23:40)

### Git
- HEAD: f55e4a2f2e6722dc57cd413d337d3b00fe14b44f
- Branch: codex/phase2-integrated
- Worktree dirty: equivalent-mutants.json (rebond), task_plan.md, 
  tests/session/sqlite-store-survival.test.ts (new)
- Uncommitted: infrastructure.test.ts fix NOT yet applied (CI failing)

### B3b Mutation Results (STALE - from 399151b5, 12 commits behind HEAD)
- Aggregate: 83.45% raw / 94.26% with waivers (threshold 85%)
- 12 PASS: gateway(75%->100% w/waivers), router(90%), toolsLeaf(90%),
  skills(91%), strategies(86% w/20 waivers), actionControl(91%),
  identitySecrets(91%), vfs(92%), sandbox(91%), verification(87%),
  verticals(88%), uiAdapters(96%)
- 3 FAIL (ALL security-critical, NO waivers):
  toolsRegistry: 87.02% / 90% - gap 35 kills (target 58 for 92% margin)
  session:       85.89% / 90% - gap 38 kills (target 56)
  runtime:       71.01% / 90% - gap 528 kills (target 583)

### In Progress
- toolsRegistry single-module mutation running in screen session "mutation"
  Started: 2026-08-08 23:32 from HEAD f55e4a2f
  Progress: chunk 1/12 (tool-definitions.ts:1-150), 14/234 mutants tested
  ETA: ~45 min remaining for chunk 1, total ~2-3 hours for all 12 chunks
  Log: /tmp/toolsRegistry-mutation.log
  DO NOT KILL, DO NOT COMMIT until it finishes

### Tests Written (839+ tests across 21+ files, all committed)
B2 tests: 311 (11 files) - before B3b
B2.5b gateway tests: 144 (6 files) - before B3b
Post-B3b tests: 384 (4 files) - after B3b, NOT yet verified by mutation
  - tool-definitions-coverage.test.ts (269 tests)
  - tool-definitions-exact.test.ts (67 tests)
  - tool-registry-coverage.test.ts (31 tests)
  - harness-nocov-coverage.test.ts (17 tests)
New session tests: ~47 tests (sqlite-store-survival.test.ts, uncommitted)

### Waivers
- 1226 total (1206 gateway + 20 strategies)
- commitSha: f55e4a2f (rebound, uncommitted)
- configurationHash: 5289a259... (correct for current config)

### Known Issues
1. CI FAIL: tests/mutation/infrastructure.test.ts L284-296 asserts toolsRegistry
   chunkTimeoutMs should be 15min, but modules.mjs sets 30min.
   Fix: add toolsRegistry to 30min list in test (NOT yet applied)
2. sqlite-store-survival.test.ts has 3 failing tests being fixed
3. findings.md and progress.md are stale (need update)

## PHASES

### Phase A: Preparation - COMPLETE

### Phase B: Phase 1 Mutation

#### B1-B3b: COMPLETE (results STALE, need B3c rerun)

#### B2.5: Kill surviving mutants in 3 FAIL modules

##### B2.5a: toolsRegistry (gap 35, target 58)
- [ ] B2.5a.1: Wait for single-module mutation running in screen
- [ ] B2.5a.2: Check result.json for new score
- [ ] B2.5a.3: If still <90%: read mutation.json, write more tests, rerun
- [ ] B2.5a.4: If >=92%: done, move to B2.5b

##### B2.5b: session (gap 38, target 56)
- [ ] B2.5b.1: Fix 3 failing tests in sqlite-store-survival.test.ts
- [ ] B2.5b.2: Run session tests to verify all pass
- [ ] B2.5b.3: Write tests for durable-session.ts (29 survived)
- [ ] B2.5b.4: Write tests for progress-store.ts (7 survived)
- [ ] B2.5b.5: Write tests for run-session.ts (3 survived)
- [ ] B2.5b.6: typecheck + lint
- [ ] B2.5b.7: Run single-module mutation: node scripts/run-mutation.mjs session
- [ ] B2.5b.8: Verify score >= 92%

##### B2.5c: runtime (gap 528, target 583) -- LARGEST EFFORT
- [ ] B2.5c.1: Extract survived mutants from mutation.json
- [ ] B2.5c.2: Write tests for small files first (pause-resume, event-bus, etc.)
- [ ] B2.5c.3: Write tests for retry.ts (22 survived)
- [ ] B2.5c.4: Write tests for harness-support.ts (53 survived)
- [ ] B2.5c.5: Write tests for loop.ts (177 survived)
- [ ] B2.5c.6: Write tests for hook-port.ts (180 survived)
- [ ] B2.5c.7: Write tests for harness.ts (357 survived, 151 NoCoverage)
- [ ] B2.5c.8: typecheck + lint
- [ ] B2.5c.9: Run single-module mutation: node scripts/run-mutation.mjs runtime
- [ ] B2.5c.10: Verify score >= 92%

#### B3c: Full Phase 1 mutation rerun (ALL 15 modules from final HEAD)
- [ ] B3c.1: Fix CI (infrastructure.test.ts)
- [ ] B3c.2: Fix session test failures
- [ ] B3c.3: Commit ALL test changes + fixes
- [ ] B3c.4: Rebind waivers to new HEAD (uncommitted, allowed)
- [ ] B3c.5: Verify worktree clean except equivalent-mutants.json
- [ ] B3c.6: node scripts/run-mutation.mjs phase1 (5-8h, screen session)
  DO NOT COMMIT during run
- [ ] B3c.7: Verify all 15 modules PASS, aggregate published

#### B4: Independent verification
- [ ] B4.1: Rebind + commit waivers to final HEAD
- [ ] B4.2: Compute artifact digest
- [ ] B4.3: node scripts/check-mutation-thresholds.mjs phase1

#### B5: verify:phase1:local (7 commands)
- [ ] B5.1-B5.7: typecheck, cycles, build, lint, test, coverage, mutation

#### B6: Phase 1 exit_criteria supplements
- [ ] B6a: GLM live acceptance (GLM_API_KEY=e93c1f129cc44ce8908f3f6fa328c00b.hz4tGVIGo3Y8AQni)
- [ ] B6b: Domain evals (6 yaml pass)
- [ ] B6c: Crash restore 3/3
- [ ] B6d: Active stubs 0
- [ ] B6f: Security checks (violation=0, unauthorized=0, replay=0)

#### B7: Regenerate Phase 1 evidence (40 files)
- [ ] B7.1: node scripts/update-evidence-sha.mjs
- [ ] B7.2: Verify 40 files correct SHA
- [ ] B7.3: Commit

### Phase C: Phase 2 Thin Tests - COMPLETE
- [x] C0: 52 thin tests thickened
- [x] C1: Phase 2 tests pass
- [ ] C2: Re-verify after B-phase changes

### Phase D: Phase 2 Gate Closure
- [ ] D1: Clean worktree
- [ ] D2: Dev gate (verify-phase2-local.mjs --mode dev)
- [ ] D3: Push + wait CI
- [ ] D4: Local gate (22 local + #18 via CI = 23 total)
  #18 mutation CANNOT run on macOS -> trigger via GitHub Actions
- [ ] D5: Confirm exit criteria

### Phase E: GLM 5.2 xhigh Scenario Acceptance
- [x] E1: GLM source review (COMPLETE)
- [ ] E2: 6 scenarios

### Phase F: Update Control State (CTO approval)
- [ ] F1: control/current-state.json
- [ ] F2: Phase 3 entry_criteria

### Phase G: Final Commit and Push
- [ ] G1: Final commit
- [ ] G2: git push origin codex/phase2-integrated
- [ ] G3: Verify .gitignore
- [ ] G4: CI passes

## EXECUTION ORDER
B2.5a (wait) -> B2.5b (session tests) -> B2.5c (runtime tests)
-> B3c.1-B3c.3 (fix CI + commit) -> B3c.4-B3c.7 (full mutation, 5-8h)
-> B4 -> B5 -> B6 -> B7 -> C2 -> D1-D5 -> E2 -> F -> G

## Score Formula
score = (killed + timeout) / (total - ignored) * 100
Timeouts count as kills. Waivers set ignored>0, reducing denominator.

## Structural Constraints
1. Phase 2 candidateReady requires all 23 gate commands pass
2. #18 (phase2 mutation) needs Linux bubblewrap, fails on macOS
3. releaseReady hardcoded false (needs external CI attestation)
4. Phase 2 evidence 0/64 (auto-generated only when local gate passes)
5. Solution: 22 local + CI for #18, candidateReady=false, candidateOnly=true
