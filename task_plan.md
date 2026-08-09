# Task Plan: agent-harness Phase 2 Completion
#
# Created: 2026-08-08 14:30
# Last Updated: 2026-08-09 22:50 (Full rewrite with mutation gap analysis)
# HEAD: 5877c9d4197d98a0d9c521d754a6052b055f2304 (codex/phase2-integrated)
# Skill: planning-with-files v4.0.0
#
# REVIEW PASS LOG
# Pass 1: 2026-08-09 22:50 - Initial comprehensive rewrite
# Pass 2: pending
# Pass 3: pending
# Pass 4: pending
# Requirement: 4 consecutive passes with ZERO errors found before execution

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
- If context compacted: read this file first, then continue
- No hallucination: every fact must be verified from current state

## VERIFIED CURRENT STATE (2026-08-09 22:50)

### Git (verified via git rev-parse HEAD)
- HEAD: 5877c9d4197d98a0d9c521d754a6052b055f2304
- Branch: codex/phase2-integrated
- Worktree dirty: M findings.md, M progress.md, M mutation/equivalent-mutants.json
- Untracked: tests/runtime/harness-survival-5.test.ts (41 tests, all pass, used by run #10)
- .gitignore excludes: dist/, node_modules, .stryker-tmp/, coverage/, reports/

### CI (verified via gh run list)
- Run for 5877c9d4: SUCCESS (all 14 steps green, 20m49s)

### Mutation Status: RUN #10 IN PROGRESS (DO NOT KILL)
- Screen session: mutation (PID 1334, stryker PID 30123)
- Running at commit 5877c9d4 (current HEAD)
- Config hash: 568923d11662d31432417e2849de3e17d88266ce66799f01d2ee2dfdecc441f2
- Log: /tmp/runtime-mutation-run10.log
- Tests used: 321 (280 committed + 41 untracked harness-survival-5.test.ts)
- Run #9 CRASHED at chunk 16 (hook-port.ts) due to failing tests in harness-survival-5
- Run #10: harness-survival-5 fixed (all 41 tests pass), started fresh at 5877c9d4
- Chunk 9/33 in progress (harness.ts:1201-1312)
- Estimated completion: ~1.5 hours from now
- Previous result (run #8 at 5da35117): 75.15% FAIL
- Previous counts: total=2777, killed=2073, timeout=14, survived=574, nocov=116
- Need: 0.90 * 2777 = 2499.3 kills (killed + timeout); have ~2120; gap = ~380

### Mutation Results (verified from result.json files, 2026-08-09 22:45)
| Module          | Score   | Threshold | Status | commit_sha  | Stale? |
|-----------------|---------|-----------|--------|-------------|--------|
| actionControl   |  91.47% | 90%       | PASS   | 399151b5    | YES (8 commits behind) |
| gateway         |  99.92% | 85%       | PASS   | 354a2694    | YES (6 commits behind) |
| identitySecrets |  90.78% | 90%       | PASS   | 399151b5    | YES |
| router          |  90.19% | 90%       | PASS   | 399151b5    | YES |
| runtime         |  75.15% | 90%       | FAIL   | 5da35117    | Running run #10 at 5877c9d4 |
| sandbox         |  91.00% | 90%       | PASS   | 399151b5    | YES |
| session         |  90.15% | 90%       | PASS   | 033e9178    | YES (9 commits behind) |
| skills          |  91.44% | 85%       | PASS   | 399151b5    | YES |
| strategies      |  85.88% | 85%       | PASS   | 399151b5    | YES |
| toolsLeaf       |  90.29% | 85%       | PASS   | 399151b5    | YES |
| toolsRegistry   |  92.13% | 90%       | PASS   | f55e4a2f    | YES |
| uiAdapters      |  95.77% | 85%       | PASS   | 399151b5    | YES |
| verification    |  86.62% | 85%       | PASS   | 399151b5    | YES |
| verticals       |  88.48% | 85%       | PASS   | 399151b5    | YES |
| vfs             |  92.13% | 90%       | PASS   | 399151b5    | YES |

14/15 PASS (all stale). Only runtime FAIL. All need full Phase 1 rerun at final HEAD.

### Runtime Module -- BIGGEST BLOCKER (securityCritical, NO waivers)
Run #10 partial results (8/9 harness.ts chunks completed):
  harness.ts (8 chunks): K=339 S=209 NC=46 TO=3 T=597 rate=57.3%
  Chunk 9 (1201-1312): in progress
  harness.ts estimated total: K~367 S~237 NC~56 TO~3 T~663 rate~55.8%

Run #8 per-file results (at 5da35117, 280 tests):
  harness.ts:           K=334 S=263 NC=63  T=663  rate=50.8% (BIGGEST GAP)
  runtime/loop.ts:      K=449 S=142 NC=34  T=630  rate=72.1%
  runtime/hook-port.ts: K=491 S=103 NC=19  T=614  rate=80.1%
  runtime/harness-support.ts: K=384 S=32  NC=0   T=416  rate=92.3%
  runtime/retry.ts:     K=218 S=19  NC=0   T=241  rate=92.1%
  runtime/notifications.ts: K=126 S=7   NC=0   T=133  rate=94.7%
  runtime/event-bus.ts: K=30  S=3   NC=0   T=34   rate=91.2%
  runtime/session-tree-port.ts: K=20 S=5  NC=0   T=25   rate=80.0%
  runtime/pause-resume-port.ts: K=19 S=0  NC=0   T=19   rate=100%
  runtime/errors.ts:    K=2   S=0   NC=0   T=2    rate=100%
  runtime/steering-port.ts: K=0  S=0  NC=0   T=0   (pure types)

Non-killed breakdown (run #8):
  harness.ts: 326 non-killed (S=263 NC=63)
  loop.ts: 176 non-killed (S=142 NC=34)
  hook-port.ts: 122 non-killed (S=103 NC=19)
  harness-support.ts: 32 non-killed (S=32 NC=0)
  retry.ts: 19 non-killed (S=19 NC=0)
  Other: 16 non-killed
  TOTAL: 691 non-killed

Gap analysis (to reach 90% = 2500 kills):
  Current kills: ~2120 (76.3%)
  Need: 380 more kills
  Target by file:
    harness.ts: kill ~200 more (from ~285 to ~85 non-killed)
    loop.ts: kill ~100 more (from 176 to ~76 non-killed)
    hook-port.ts: kill ~70 more (from 122 to ~52 non-killed)
    Other: kill ~10 more
    Total: ~380 kills needed

Survived mutant types (run #10 harness.ts, 8 chunks):
  ConditionalExpression: 68  (test both branches)
  StringLiteral: 67          (assert exact string values)
  ObjectLiteral: 35          (assert exact object properties)
  LogicalOperator: 25        (test edge cases)
  BlockStatement: 23         (execute code blocks)
  EqualityOperator: 18       (test with distinguishing values)
  ArrayDeclaration: 6        (assert exact array contents)
  BooleanLiteral: 5          (test both true/false)
  OptionalChaining: 3        (test with null/undefined)
  MethodExpression: 3        (assert method call results)
  ArrowFunction: 2           (assert callback results)

Survived mutant types (run #8 runtime/*.ts):
  loop.ts: StringLiteral=44, ConditionalExpression=40, ArrayDeclaration=16,
           ObjectLiteral=12, EqualityOperator=10, BlockStatement=6,
           ArithmeticOperator=4, BooleanLiteral=3, ArrowFunction=3,
           LogicalOperator=3, MethodExpression=1
  hook-port.ts: ConditionalExpression=58, LogicalOperator=21, StringLiteral=7,
                BlockStatement=5, EqualityOperator=3, MethodExpression=3,
                BooleanLiteral=2, ArrayDeclaration=2, ArrowFunction=1, ObjectLiteral=1
  harness-support.ts: ConditionalExpression=22, LogicalOperator=4,
                      MethodExpression=3, Regex=2, UnaryOperator=1

### Waivers (verified from equivalent-mutants.json)
- Total: 1226 (1206 gateway + 20 strategies)
- commitSha: 5877c9d4197d (current HEAD)
- configurationHash: 568923d11662d31432417e2849de3e17d88266ce66799f01d2ee2dfdecc441f2
- NOTE: After run #10 completes, rebind to that SHA for single-module check
- NOTE: For full Phase 1 rerun (B.11), rebind to final HEAD

### Phase 2 Tests (verified via wc -l on all files)
- 60 unit test files, ALL >= 150 lines (smallest: 150L)
- 14 integration + 15 e2e + 22 security = 115 total Phase 2 test files
- 64 Phase 2 requirements (confirmed from requirements.ndjson)
- Thickening commits: d95abb87 through f28041aa

### Evidence (verified)
- Phase 1: 40/40 files exist, ALL stale (commit_sha = bd85e7ed)
- Phase 2: 0/64 (auto-generated when local gate passes)
- Update script: scripts/update-evidence-sha.mjs

### Control State (from agent-harness-v9.1/control/current-state.json)
- Phase 0: VERIFIED
- Phase 1: IN_PROGRESS
- Phase 2: BLOCKED
- Phase 3+: BLOCKED

### Score Formula (verified)
- score = (killed + timeout) / (total - ignored) * 100
- Timeouts count as kills (in numerator)
- Waivers set ignored>0, REMOVING mutants from denominator
- NoCoverage counts against score (stays in denominator, NOT in numerator)
- For runtime (securityCritical, no waivers): ignored=0
- Proof: session 824/914 = 90.15% (matches result.json)

### GLM API
- Key: e93c1f129cc44ce8908f3f6fa328c00b.hz4tGVIGo3Y8AQni
- Model: glm-5.2, reasoning: xhigh
- Script: scripts/run-glm-acceptance.mjs
- Requires: GLM_API_KEY, GLM_MODEL=glm-5.2, GLM_REASONING_EFFORT=xhigh, GLM_ALLOW_REMOTE=1

## PHASES

### Phase A: Stabilize [COMPLETE]
[x] A.1-A.7: Concurrency revert, typecheck, tests, gateway waivers -- ALL DONE

### Phase B: Phase 1 Mutation [IN PROGRESS]
This is the BIGGEST and HARDEST phase. Runtime module must reach 90%.
Runtime is securityCritical: NO waivers allowed. All kills must come from tests.
Current score: ~76% (need 90%). Gap: ~380 kills.

- [ ] B.1: Wait for runtime mutation run #10 to complete
  Status: IN PROGRESS (screen "mutation", PID 1334)
  Monitor: tail -5 /tmp/runtime-mutation-run10.log
  DO NOT KILL the mutation run
  Accept: reports/mutation/runtime/result.json has score field
  Check: python3 -c "import json; d=json.load(open('reports/mutation/runtime/result.json')); print(f'score={d["score"]} status={d["status"]}')"

- [ ] B.2: Analyze run #10 final results
  Read mutation.json for exact survived mutants by file, line, mutator type
  Accept: exact per-file K/S/NC/TO/T counts recorded in progress.md

- [ ] B.3: Write harness-survival-6.test.ts (target: kill 100+ in harness.ts)
  File: tests/runtime/harness-survival-6.test.ts
  Target: ~285 non-killed in harness.ts
  Strategy: EXACT assertions (not just success/failure checks)
  B.3a: NoCoverage (~62) - execute uncovered code paths (L408-410, L456-475, L551-552,
        L630-750, L770-895, L921-984, L1085-1109, L1190)
  B.3b: StringLiteral (67) - assert exact event names, error messages, IDs
        (tool-before:run_id:step_id:tool_call_id:attempt_index, etc.)
  B.3c: ObjectLiteral (35) - assert exact object properties (receipts, payloads, contexts)
  B.3d: ConditionalExpression (68) - test both branches of every conditional
  B.3e: LogicalOperator (25) - test null/undefined/empty edge cases
  Accept: all tests pass, typecheck clean, lint clean

- [ ] B.4: Write loop-survival-3.test.ts (target: kill 50+ in loop.ts)
  File: tests/runtime/loop-survival-3.test.ts
  Target: 176 non-killed (S=142 NC=34)
  Focus: NoCoverage(34), StringLiteral(44), ConditionalExpression(40),
         ArrayDeclaration(16), ObjectLiteral(12), EqualityOperator(10)
  Accept: all tests pass, typecheck clean

- [ ] B.5: Write hook-port-survival-3.test.ts (target: kill 40+ in hook-port.ts)
  File: tests/runtime/hook-port-survival-3.test.ts
  Target: 122 non-killed (S=103 NC=19)
  Focus: NoCoverage(19), ConditionalExpression(58), LogicalOperator(21),
         StringLiteral(7), BlockStatement(5)
  Accept: all tests pass, typecheck clean

- [ ] B.6: Write harness-support-survival-2.test.ts (target: kill 15+ in harness-support.ts)
  File: tests/runtime/harness-support-survival-2.test.ts
  Target: 32 non-killed (S=32 NC=0)
  Focus: ConditionalExpression(22), LogicalOperator(4), MethodExpression(3), Regex(2)
  Accept: all tests pass, typecheck clean

- [ ] B.7: Write targeted tests for remaining runtime files
  Files: retry-survival-2.test.ts (19), session-tree-survival-2.test.ts (5),
         event-bus-survival-2.test.ts (3)
  Accept: all tests pass, typecheck clean

- [ ] B.8: Commit all test files
  Command: git add tests/runtime/*.test.ts && git commit -m "test: add targeted mutation survival tests for runtime module"
  Accept: commit successful, all tests still pass

- [ ] B.9: Re-run runtime mutation
  Command: node scripts/run-mutation.mjs runtime
  Monitor: ps aux | grep stryker (every 30 min)
  Time: ~1.5-2 hours (33 chunks)
  Accept: result.json score >= 90.00%, status PASS

- [ ] B.10: If runtime still < 90%, iterate
  a) Read mutation.json for remaining survived mutants
  b) Write more targeted tests (harness-survival-7.test.ts, etc.)
  c) Consider source code refactoring for equivalent mutants (remove dead code,
     simplify conditionals) - BUT do NOT change behavior
  d) Commit tests, re-run mutation
  e) Repeat until score >= 90.00%
  Accept: result.json score >= 90.00%, status PASS

- [ ] B.11: Full Phase 1 mutation rerun (all 15 modules at current HEAD)
  Pre: rebind waivers to current HEAD (uncommitted)
  Pre: verify worktree clean except equivalent-mutants.json
  Pre: rm -rf .stryker-tmp/2026-08-0* (free disk space)
  Command: node scripts/run-mutation.mjs phase1
  Time: 5-8 hours (15 modules, gateway has 43 chunks)
  DO NOT COMMIT during run
  Accept: all 15 modules PASS with commit_sha === HEAD

- [ ] B.12: Commit waivers
  Command: rebind waivers to HEAD, git add, git commit
  Accept: committed waivers have correct commitSha

- [ ] B.13: Run test:mutation:check (independent verification)
  Command: EXPECTED_SHA=5877c9d4197d98a0d9c521d754a6052b055f2304 node scripts/check-mutation-thresholds.mjs phase1
  Accept: "Phase 1 mutation artifact PASS for <SHA>"

- [ ] B.14: Run verify:phase1:local
  Command: npm run verify:phase1:local
  = typecheck + check:cycles + build + lint + test + test:coverage + test:mutation:phase1
  Accept: exit code 0

### Phase B-Sup: Phase 1 exit_criteria Supplements

- [ ] B-Sup.1: GLM live acceptance (real API, no fake data)
  Command: GLM_API_KEY=... GLM_MODEL=glm-5.2 GLM_REASONING_EFFORT=xhigh GLM_ALLOW_REMOTE=1 npm run test:glm:live
  Accept: GLM 5.2 xhigh API responds, tests pass

- [ ] B-Sup.2: Domain evals (6 Phase 1 yaml + fixture validation)
  Command: ls evals/*/phase-1.yaml && ls fixtures/phase-1/assets/evals/*.json
  Accept: 6 eval YAMLs + fixture files exist

- [ ] B-Sup.3: Crash restore (3/3)
  Command: npx vitest run tests/session/crash-restore.test.ts --reporter=verbose
  Accept: 3/3 pass

- [ ] B-Sup.4: Active stubs (0)
  Command: node scripts/gates/check-active-stubs.mjs
  Accept: 0 active stubs

- [ ] B-Sup.5: Security checks
  Command: npx vitest run tests/security/ tests/sandbox/ --reporter=dot
  Accept: 0 violations, all tests pass

### Phase B-Evi: Phase 1 Evidence Regeneration

- [ ] B-Evi.1: Update evidence SHAs (40 files)
  Command: node scripts/update-evidence-sha.mjs
  Accept: 40 evidence files updated with current HEAD

- [ ] B-Evi.2: Verify all 40 files have correct SHA
  Command: python3 check script
  Accept: 40/40 correct

- [ ] B-Evi.3: Commit evidence updates
  Command: git add artifacts/phase-1/ && git commit
  Accept: commit successful

### Phase C: Phase 2 Test Verification

- [ ] C.1: Full Phase 2 test run
  Command: npx vitest run tests/phase-2/ --reporter=dot
  Accept: 0 failed

- [ ] C.2: Typecheck + lint
  Command: npx tsc --noEmit && npx eslint tests/phase-2/ --quiet
  Accept: 0 errors

### Phase D: Phase 2 Gate Closure

- [ ] D.1: Verify clean worktree
  Command: git status --short
  Accept: clean OR only equivalent-mutants.json

- [ ] D.2: Run dev gate
  Command: node scripts/gates/verify-phase2-local.mjs --mode dev
  Accept: no errors

- [ ] D.3: Push to origin and wait for CI
  Command: git push origin codex/phase2-integrated
  Accept: CI green

- [ ] D.4: Run local gate (24 commands, 3-4 hours)
  Command: node scripts/gates/verify-phase2-local.mjs --mode local
  Accept: candidateReady=true (candidateEvidenceCount === 64)

- [ ] D.5: Confirm Phase 2 exit_criteria
  1. all_phase_requirements_verified=true (evidence 64/64)
  2. regression_tests_pass=true (24 commands pass)
  3. active_stub_count=0
  4. independent_glm_5_2_xhigh=PASS (Phase E complete)

### Phase E: GLM 5.2 xhigh Scenario Acceptance

- [x] E.1: GLM source review (COMPLETE - 52 files, 0 high/critical)

- [ ] E.2: Scenario acceptance with real GLM 5.2 API
  Command: GLM_API_KEY=... npm run test:glm:live
  Accept: 6 scenarios pass (long-context, RAG, multimodal, UX, privacy, failure-recovery)

### Phase F: Update Control State (needs CTO approval)

- [ ] F.1: Update control/current-state.json
  Phase 1: VERIFIED, Phase 2: VERIFIED, Phase 3: IN_PROGRESS

- [ ] F.2: Confirm Phase 3 entry_criteria

### Phase G: Final Commit and Push

- [ ] G.1: Final commit (if any remaining changes)
- [ ] G.2: Verify .gitignore excludes build artifacts (GitHub only source code)
- [ ] G.3: Push to origin
- [ ] G.4: Verify CI passes

## EXECUTION ORDER
A (done) -> B.1 (wait) -> B.2 (analyze) -> B.3-B.7 (write tests) -> B.8 (commit)
-> B.9 (re-run) -> B.10 (iterate if needed) -> B.11 (full Phase 1 rerun)
-> B.12 (commit waivers) -> B.13 (mutation:check) -> B.14 (verify:phase1:local)
-> B-Sup (5 supplements) -> B-Evi (40 evidence) -> C (verify Phase 2 tests)
-> D (gate: dev, push, local 24 commands) -> E (GLM scenarios) -> F (control state)
-> G (final push)

## KEY RISK: Runtime Mutation 90% Threshold
Runtime is securityCritical (no waivers). Current ~76%, need 90%. Gap: ~380 kills.
Priority: NoCoverage(115) > StringLiteral(126) > ObjectLiteral(48) >
           ConditionalExpression(198) > LogicalOperator(53) > Other(151)
If tests alone cannot reach 90%: refactor source to eliminate equivalent mutants
(BUT: do NOT change behavior, do NOT delete tests, do NOT lower thresholds)

## Recovery Instructions (if context compacted)
1. Read this file (task_plan.md) completely
2. Read progress.md for latest session log
3. Read findings.md for research discoveries
4. Check: git log --oneline -5, git status --short, ps aux | grep stryker
5. Check mutation: tail -5 /tmp/runtime-mutation-run10.log
6. Check scores: python3 -c "
   import json, os
   t = json.load(open('mutation/thresholds.json'))
   for m in sorted(t['modules'].keys()):
     p = f'reports/mutation/{m}/result.json'
     if os.path.exists(p):
       d = json.load(open(p))
       print(f'{m}: {d["score"]:.2f}% [{d["status"]}] sha={d.get("commit_sha","?")[:7]}')
   "
7. Continue from the first unchecked [ ] item
8. If mutation running: DO NOT KILL, wait for completion
9. If mutation not running: start from B.1 or continue where left off

## Waiver Handling
- run-mutation.mjs reads from WORKING TREE -> uncommitted OK for mutation runs
- check-mutation-thresholds.mjs reads from GIT -> committed required for check
- Adding test files does NOT change config hash
- Rebinding waivers does NOT change config hash

## CI Notes
- ci.yml: typecheck, check:cycles, build, lint, test, coverage, audit, pack
- CI does NOT run mutation (too slow)
- Phase 2 mutation: gh workflow run phase2-mutation.yml
- Phase 2 gate local mode runs mutation as step #18
