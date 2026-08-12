# Findings & Decisions

## Requirements
- Complete Phase 1 mutation (15/15 modules PASS, score >= threshold)
- Refresh Phase 1 evidence (40/40 SHA updated to current HEAD)
- Phase 2 tests verified (all 64 unit files >= 150 lines, need to verify they pass)
- Phase 2 gate closure (dev passes locally, local mode 23 commands)
- GLM 5.2 xhigh acceptance (source review + scenario acceptance)
- Commit and push source code to GitHub (only source, no build artifacts)
- Iron rules: no deleting tests, no lowering thresholds, no skip, no fake evidence/mutation

## Current HEAD: 7016507c94f21cf97aabb6ab3819b83ad09a3260 (verified 2026-08-12 10:15)

## Mutation Score Formula (verified from source code + result.json)
score = (killed + timeout) / (total - ignored) * 100
- Timeouts count as kills (in numerator)
- Waivers set ignored > 0, reducing denominator AND removing from survived count
- NoCoverage stays in denominator (counts against score)
- securityCriticalModules cannot have waivers (enforced in run-mutation.mjs)

## Mutation Results (verified from result.json + mutation.json, 2026-08-12 10:00)
14/15 PASS (all stale SHA). Only runtime FAIL.
Runtime: 88.77% (2724 total, 2401 killed, 283 survived, 23 NoCov, 17 timeout, gap 34)

Per-file survived counts for runtime (from run #35, commit 9ac096c6):
  harness.ts:              103 survived + 13 nocov (total 469)
  runtime/loop.ts:          73 survived + 6 nocov  (total 550)
  runtime/hook-port.ts:     48 survived + 2 nocov  (total 614)
  runtime/harness-support.ts: 39 survived + 2 nocov (total 637)
  runtime/retry.ts:          9 survived            (total 241)
  runtime/notifications.ts:  7 survived            (total 133)
  runtime/event-bus.ts:      3 survived            (total 34)
  runtime/session-tree-port.ts: 1 survived         (total 25)
  runtime/pause-resume-port.ts: 0 survived          (total 19)
  runtime/errors.ts:         0 survived            (total 2)

Run #35 (9ac096c6) produced IDENTICAL results to run #34 (d3f75971).
The 13 NoCov coverage tests in 9ac096c6 did NOT improve the score.

Run #36 (7016507c) adds:
- 8 error/message builders extracted to harness-support.ts + 28 direct tests
- Early harness-support.ts chunks showing 92.70%

## Waivers (verified from equivalent-mutants.json)
- Total: 1226 (1206 gateway + 20 strategies)
- commitSha: needs rebind to 7016507c (currently at previous HEAD)
- configurationHash: 568923d11662d31432417e2849de3e17d88266ce66799f01d2ee2dfdecc441f2
- Gateway: 99.92% with 1206 waivers (PASS, non-security-critical)
- Strategies: 85.88% with 20 waivers (PASS, non-security-critical)
- Runtime: securityCritical, NO waivers allowed

## Config Hash
- Computed from mutationAuthorityFiles (17 files), normalized (strips commitSha + configurationHash)
- Adding test files does NOT change config hash
- Rebinding waivers does NOT change config hash (normalization strips those fields)
- Current: 568923d11662d... (verified from owner.json)

## Lint (verified 2026-08-12 10:00)
- npm run lint: PASS (0 errors, 0 warnings)
- npm run lint only lints source dirs: gateway security runtime router sandbox session
  skills tools ui verification vfs domains ingestion harness.ts index.ts scripts
  benchmarks packages apps tests/phase-2/architecture
- npx eslint . shows 1501 errors but those are ALL in test files (not linted by npm run lint)
  1326 @typescript-eslint/no-explicit-any
  140 @typescript-eslint/no-unused-vars
  3 @typescript-eslint/consistent-type-imports
  1 @typescript-eslint/no-require-imports
- These test-file lint errors are NOT blocking for any gate

## Phase 2 Tests (verified via wc -l, 2026-08-12 10:00)
- ALL 64 unit test files >= 150 lines (smallest: 150L)
- 30 non-unit Phase 2 test files < 150 lines (e2e, security, integration, architecture)
  These are NOT the original 52 thin unit tests — those are resolved.
- 117 total Phase 2 test files: 64 unit + 14 integration + 15 e2e + 22 security + 2 architecture

## Evidence
- Phase 1: 40/40 files exist, ALL stale (commit_sha = bd85e7edc564 for 39, 7f2eafaa for 1)
- Phase 2: 0/64 (auto-generated when local gate passes)
- Update script: scripts/update-evidence-sha.mjs (exists, verified)

## Control State (from agent-harness-v9.1/control/current-state.json, verified 2026-08-12)
- Phase 0: VERIFIED
- Phase 1: IN_PROGRESS (maturity: implemented=40)
- Phase 2: BLOCKED (maturity: not_started=64)
- Phase 3: BLOCKED

## Phase 2 Gate candidateReady Requirements (from verify-phase2-local.mjs, verified)
candidateReady = executionOk && identityStable && mutationReady &&
                  candidateEvidenceCount === 64 && errors.length === 0
- executionOk: mode==="local" && hasReleaseAuthority && execution.ok
- identityStable: clean git identity (only equivalent-mutants.json uncommitted)
- mutationReady: inspectPhase2MutationReadiness returns ok=true
  (checks all 64 reqs have source/test files, NOT if mutation was run)
- candidateEvidenceCount: 64 (auto-generated when commands pass)
- releaseReady: always false (needs external CI attestation)

## Phase 2 Mutation
- reports/mutation/phase2/ does NOT exist (no results yet)
- inspectPhase2MutationReadiness checks file existence for all 64 requirements
- Phase 2 mutation is run as command 17 in the local gate
- Script: node scripts/run-phase2-mutation-launcher.mjs phase2

## GLM API
- Key: e93c1f129cc44ce8908f3f6fa328c00b.hz4tGVIGo3Y8AQni
- Model: glm-5.2, reasoning: xhigh
- Script: scripts/run-glm-acceptance.mjs
- Phase 1: source review done + 6 vertical evals
- Phase 2: 6 scenarios (long-context, RAG, multimodal, UX, privacy, failure-recovery)

## Decisions Log
1. Runtime approach: extract functions to harness-support.ts + direct tests (working, gap down from 100 to 34)
2. Full Phase 1 rerun from final HEAD after all test changes committed
3. Waivers: rebind to final HEAD but leave uncommitted
4. Phase 2 tests already thick (verified), just need to verify they pass
5. GLM acceptance: run after mutation completes (needs clean worktree + no CPU contention)
6. Lint: npm run lint only lints source dirs, test file lint errors are NOT blocking
7. verify:phase1:local includes full 15-module mutation rerun (5-8h)

## Critical Corrections from Previous Planning
1. HEAD 5877c9d4 -> ACTUAL: 7016507c (many commits since Aug 9)
2. progress.md references run #9 -> ACTUAL: run #36 in progress
3. lint "888 errors" -> ACTUAL: npm run lint PASSES (0 errors)
4. "51/64 still < 150 lines" -> ACTUAL: ALL 64 unit files >= 150 lines
5. findings.md HEAD 5877c9d4 -> ACTUAL: 7016507c
