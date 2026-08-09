# Findings & Decisions

## Requirements
- Complete Phase 1 mutation (15/15 modules PASS, score >= threshold)
- Refresh Phase 1 evidence (40/40 SHA updated to current HEAD)
- Phase 2 tests verified (all 60 unit files >= 150 lines, need to verify they pass)
- Phase 2 mutation 64/64 complete (via gate, auto-generates evidence)
- Phase 2 gate closure (dev passes locally, local mode 24 commands)
- GLM 5.2 xhigh acceptance (source review + scenario acceptance)
- Commit and push source code to GitHub (only source, no build artifacts)
- Iron rules: no deleting tests, no lowering thresholds, no skip, no fake evidence/mutation

## Current HEAD: 5877c9d4197d98a0d9c521d754a6052b055f2304 (verified 2026-08-09 21:20)

## Mutation Score Formula (verified from source code + result.json)
score = (killed + timeout) / (total - ignored) * 100
- Timeouts count as kills (in numerator)
- Waivers set ignored > 0, reducing denominator AND removing from survived count
- NoCoverage stays in denominator (counts against score)
- securityCriticalModules cannot have waivers (enforced in run-mutation.mjs)
- Proof: session 824/914 = 90.15% (matches result.json)

## Mutation Results (verified from result.json, 2026-08-09 21:15)
14/15 PASS (all stale SHA). Only runtime FAIL.

Key per-file survived counts for runtime (at 5da35117):
  harness.ts:           263 survived + 63 nocov = 326 non-killed (BIGGEST GAP)
  runtime/loop.ts:      142 survived + 34 nocov = 176 non-killed
  runtime/hook-port.ts: 103 survived + 19 nocov = 122 non-killed
  runtime/harness-support.ts: 32 survived + 0 nocov = 32 non-killed
  runtime/retry.ts:     19 survived + 0 nocov = 19 non-killed
  runtime/notifications.ts: 7 survived + 0 nocov = 7 non-killed
  runtime/event-bus.ts: 3 survived + 0 nocov = 3 non-killed
  runtime/session-tree-port.ts: 5 survived + 0 nocov = 5 non-killed
  runtime/pause-resume-port.ts: 0 survived (PASS per-file)
  runtime/errors.ts:    0 survived (PASS per-file)
  runtime/steering-port.ts: 0 mutants (pure types)

## Waivers (verified from equivalent-mutants.json)
- Total: 1226 (1206 gateway + 20 strategies)
- commitSha: 5877c9d4197d (current HEAD)
- configurationHash: 568923d11662d31432417e2849de3e17d88266ce66799f01d2ee2dfdecc441f2
- Gateway: 99.92% with 1206 waivers (PASS, non-security-critical)
- Strategies: 85.88% with 20 waivers (PASS, non-security-critical)

## Config Hash
- Computed from mutationAuthorityFiles (17 files), normalized (strips commitSha + configurationHash)
- Adding test files does NOT change config hash
- Rebinding waivers does NOT change config hash (normalization strips those fields)
- Current: 568923d11662d... (changed from f091d43f5389 due to chunk timeout fix in modules.mjs)

## Phase 2 Tests (verified via wc -l)
- ALL 60 unit test files >= 150 lines (smallest: 150L)
- 14 integration + 15 e2e + 22 security = 115 total Phase 2 test files
- 64 Phase 2 requirements (confirmed from requirements.ndjson)
- Thickening commits: d95abb87 through f28041aa

## Evidence
- Phase 1: 40/40 files exist, ALL stale (commit_sha = bd85e7ed)
- Phase 2: 0/64 (auto-generated when local gate passes)
- Update script: scripts/update-evidence-sha.mjs (updates commit_sha + tree_sha)

## Control State (from agent-harness-v9.1/control/current-state.json)
- Phase 0: VERIFIED
- Phase 1: IN_PROGRESS
- Phase 2: BLOCKED
- Phase 3+: BLOCKED

## GLM API
- Key: e93c1f129cc44ce8908f3f6fa328c00b.hz4tGVIGo3Y8AQni
- Model: glm-5.2, reasoning: xhigh
- Script: scripts/run-glm-acceptance.mjs
- Requires: GLM_API_KEY, GLM_MODEL=glm-5.2, GLM_REASONING_EFFORT=xhigh, GLM_ALLOW_REMOTE=1

## Structural Constraints
1. Phase 2 candidateReady requires: executionOk && identityStable && mutationReady && candidateEvidenceCount === 64 && errors.length === 0
2. releaseReady is always false (needs external CI attestation)
3. Phase 2 evidence auto-generated when local gate passes
4. GLM acceptance requires clean worktree (except equivalent-mutants.json)
5. .gitignore excludes: dist/, node_modules, .stryker-tmp/, coverage/, reports/

## Decisions Log
1. Runtime approach: start with NoCov (easiest wins), then StringLiteral, then ConditionalExpression
2. Full Phase 1 rerun from final HEAD after all test changes committed, NO commits during run
3. Waivers: rebind to final HEAD but leave uncommitted until B.4
4. Phase 2 tests already thick (verified), just need to verify they pass
5. GLM acceptance: run after mutation completes (needs clean worktree + no CPU contention)

## Critical Corrections from Previous Planning (2026-08-09 21:20)
1. HEAD was 5da35117 in old plan -> ACTUAL: 5877c9d4 (1 commit ahead, tsconfig fix)
2. "51/64 still < 150 lines" -> WRONG, ALL 60 files >= 150 lines
3. "run #4" -> ACTUAL: run #9
4. configHash f091d43f5389 -> ACTUAL: 568923d11662d (changed by chunk timeout fix)
5. findings.md HEAD f55e4a2f2 -> ACTUAL: 5877c9d4
6. "12 PASS modules" -> ACTUAL: 14 PASS
7. "3 FAIL modules" -> ACTUAL: only 1 FAIL (runtime)
8. toolsRegistry 87.02% FAIL -> ACTUAL: 92.13% PASS
9. session 85.89% FAIL -> ACTUAL: 90.15% PASS
