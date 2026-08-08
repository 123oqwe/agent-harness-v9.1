# Findings & Decisions

## Requirements
- Complete Phase 1 mutation (15/15 modules PASS, score >= threshold)
- Refresh Phase 1 evidence (40/40 SHA updated to current HEAD)
- Thicken 52 Phase 2 thin tests (each acceptance_criteria covered by >= 1 test)
- Phase 2 mutation 64/64 complete (via GitHub Actions, cannot run locally)
- Phase 2 gate closure (dev passes locally, local mode needs CI for mutation)
- GLM 5.2 xhigh acceptance (source review + scenario acceptance)
- commit and push source code to GitHub (only source, no build artifacts)
- Iron rules: no deleting tests, no lowering thresholds, no skip, no fake evidence/mutation

## Current HEAD: f55e4a2f2e6722dc57cd413d337d3b00fe14b44f
## B3b run commit: 399151b5a0a84b4212ea16d9a7947fc960264233 (STALE, 12 commits behind)

## Research Findings

### Mutation Score Formula (verified from source code)
score = (killed + timeout) / (total - ignored) * 100
- Timeouts count as kills
- Waivers set ignored > 0, reducing denominator AND removing from survived count
- securityCriticalModules cannot have waivers (enforced in run-mutation.mjs L276)

### B3b Mutation Results (from 399151b5, STALE)
Aggregate: 83.45% raw / 94.26% with waivers (threshold 85%)

12 PASS modules:
  gateway:         75.05% -> 100% with 1206 waivers [PASS]
  router:          90.19% / 90% [PASS]
  toolsLeaf:       90.29% / 85% [PASS]
  skills:          91.44% / 85% [PASS]
  strategies:      85.88% / 85% [PASS] (20 waivers)
  actionControl:   91.47% / 90% [PASS]
  identitySecrets: 90.78% / 90% [PASS]
  vfs:             92.13% / 90% [PASS]
  sandbox:         91.00% / 90% [PASS]
  verification:    86.62% / 85% [PASS]
  verticals:       88.48% / 85% [PASS]
  uiAdapters:      95.77% / 85% [PASS]

3 FAIL modules (ALL security-critical, NO waivers):
  toolsRegistry: 87.02% / 90% - 1156 total, 1006 killed, 127 survived, 23 nocov
    tool-definitions.ts: 63 survived (StringLit 21, BoolLit 21, ObjLit 21)
    tool-executor.ts: 38 surv+nocov (CondExpr 10, StringLit 8, ArrayDecl 4)
    tool-registry.ts: 35 surv+nocov (StringLit 11, CondExpr 9, OptChain 4)
    tool-dispatcher.ts: 14 surv+nocov (StringLit 8, OptChain 1, Arrow 1)
    Gap: 35 kills for 90%, 58 for 92% margin

  session: 85.89% / 90% - 914 total, 785 killed, 108 survived, 21 nocov
    sqlite-session-store.ts: 90 surv+nocov (StringLit 29, CondExpr 24, Block 13)
    durable-session.ts: 29 survived (StringLit 12, CondExpr 6, Block 6)
    progress-store.ts: 7 survived (Block 3, StringLit 2)
    run-session.ts: 3 survived (CondExpr 1, UnaryOp 1, StringLit 1)
    Gap: 38 kills for 90%, 56 for 92% margin

  runtime: 71.01% / 90% - 2777 total, 1962 killed, 576 survived, 229 nocov, 10 timeout
    harness.ts: 357 surv+nocov (CondExpr 97, StringLit 79, ObjLit 49) - 151 NoCov!
    hook-port.ts: 180 surv+nocov (CondExpr 79, LogOp 29, StringLit 22, Bool 20)
    loop.ts: 177 surv+nocov (StringLit 60, CondExpr 46, ArrayDecl 17)
    harness-support.ts: 53 surv+nocov (CondExpr 28, StringLit 7, Regex 4)
    retry.ts: 22 surv+nocov (CondExpr 8, StringLit 8, EqOp 3)
    Gap: 528 kills for 90%, 583 for 92% margin

### Config Hash
- Computed: 5289a259bd7219fdebbc4c67be111f3753f7d11463923a1982ef178ddbfd292c
- Source: mutationAuthorityFiles (17 files), normalized (strips commitSha + configurationHash)
- Adding test files does NOT change config hash
- Rebinding waivers does NOT change config hash (normalization strips those fields)

### CI Failure (identified 2026-08-08 23:35)
- tests/mutation/infrastructure.test.ts L284-296 asserts that only gateway and router
  have 30min chunkTimeoutMs, all others 15min
- mutation/modules.mjs sets toolsRegistry to 30min (added to prevent timeout)
- Fix: update test to include toolsRegistry in 30min list
- Status: NOT yet applied

### Waiver Architecture
- check-mutation-thresholds.mjs reads waivers from git blob (committed state)
- Single-module runs allow uncommitted equivalent-mutants.json changes
- Phase 1 full run requires clean worktree (except equivalent-mutants.json)
- 1206 gateway waivers: non-security-critical module, allowed
- 20 strategies waivers: non-security-critical module, allowed

### Structural Constraints
1. Phase 2 candidateReady requires all 23 gate commands pass
2. #18 (phase2 mutation) needs Linux bubblewrap, fails on macOS
3. releaseReady hardcoded false (needs external CI attestation)
4. Phase 2 evidence 0/64 (auto-generated only when local gate passes)
5. GLM acceptance CI requires main branch (must run locally)

## Decisions Log
1. toolsRegistry chunkTimeoutMs: keep 30min, update test (not modules.mjs)
2. Session tests: write sqlite-store-survival.test.ts targeting survived mutants
3. Runtime approach: start with small files, work up to harness.ts
4. B3c: run from final HEAD after all test changes committed, NO commits during run
5. Waivers: rebind to HEAD but leave uncommitted until B4
