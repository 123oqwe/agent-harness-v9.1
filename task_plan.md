# Task Plan: agent-harness Phase 2 (verified 2026-08-08, HEAD 05dd3424)

## Goal
- Phase 1 mutation 15/15 PASS (local, 5-8h)
- Phase 1 evidence 40/40 SHA refreshed
- Phase 2 thin tests 52 thickened (cover acceptance_criteria)
- Phase 2 mutation 64/64 (MUST run via GitHub Actions, not local)
- Phase 2 gate: dev passes locally, local mode needs CI for mutation
- GLM 5.2 xhigh acceptance
- commit and push source to GitHub

## CRITICAL CONSTRAINT: Phase 2 Mutation Cannot Run Locally
- run-phase2-mutation-bootstrap.mjs isolatedCommand() throws on macOS:
  'Seatbelt is diagnostic-only; release candidate CI requires Linux bubblewrap'
- Also throws on Linux without bubblewrap
- Only runs on GitHub Actions ubuntu-22.04 with bubblewrap + node 20.18.1 + npm 10.8.2
- Phase 1 mutation (run-mutation.mjs) has NO platform restriction, runs locally
- verify:phase2:local --mode local command #18 (mutation) WILL FAIL locally
- candidateReady requires executionOk (all 23 commands pass) -> cannot achieve locally
- Strategy: run all local commands except mutation, trigger mutation via CI

## Current State (verified 2026-08-08 02:45)
- HEAD: 05dd3424aa7f7723d824a73f0fd18087fa82f473
- Branch: codex/phase2-integrated
- origin: behind 1 commit (05dd3424 not pushed)
- product: behind 2 commits
- Uncommitted: HARNESS_SESSION_DIRECTIVE.md + equivalent-mutants.json (waiver rebind)
- Phase 1 tests: 2859/2859 PASS
- Phase 2 unit tests: 758/758 PASS (64 files)
- Phase 2 dev gate: success=true
- typecheck/lint/build: PASS
- Mutation: STALE (config_hash mismatch, 4 modules missing, gateway FAIL)
- Phase 1 evidence: 40/40 STALE
- Phase 2 evidence: 0/64
- Phase 2 local gate: not run (mutation command will fail on macOS)
- Stale mutation lock: cleaned
- configurationHash: 2e02aab1... (verified correct)

## Phase A: Preparation

### A1: Commit uncommitted files [pending]
- Commit HARNESS_SESSION_DIRECTIVE.md update
- equivalent-mutants.json stays uncommitted (waiver rebind, runner allows)
- Verify: git status only has equivalent-mutants.json

### A2: Verify dev gate still passes [pending]
- node scripts/gates/verify-phase2-local.mjs --mode dev
- Verify: success=true

### A3: Push current HEAD to origin [pending]
- git push origin codex/phase2-integrated
- Verify: origin/codex/phase2-integrated == HEAD

## Phase B: Phase 1 Mutation Rerun (LOCAL, 5-8h)

### B0: Prepare [pending]
- B0a: Clean old .stryker-tmp directories (python3 shutil.rmtree)
- B0b: npm run prepare (verify patch exists)
- B0c: export GLM_API_KEY=e93c1f129cc44ce8908f3f6fa328c00b.hz4tGVIGo3Y8AQni
- B0d: Confirm stale lock cleaned
- Verify: patches/@stryker-mutator+core+9.6.1.patch exists

### B1: Run Phase 1 mutation [pending]
- node scripts/run-mutation.mjs phase1
- 15 modules, gateway=43 chunks, estimated 5-8h
- chunkTimeoutMs: gateway=30min, sandbox=30min, default=15min
- Monitor: ps aux | grep stryker, ls .stryker-tmp/
- Do NOT kill (unless crash)
- Verify: 15/15 modules have result.json, commit_sha=HEAD, config_hash=2e02aab1

### B2: Check results [pending]
- Confirm 15/15 modules score >= threshold (85% or 90%)
- For failing modules:
  a) Read mutation.json find surviving mutants (python3 script)
  b) Real coverage gap -> add tests to kill
  c) Equivalent mutant -> register waiver (equivalent-mutants.json)
  d) Rerun module: node scripts/run-mutation.mjs {module}
  e) Loop until passing
- After each test fix: npx vitest run + typecheck + lint
- After each commit: rebind waiver commitSha
- Rebind command:
  NEW_SHA=$(git rev-parse HEAD)
  python3 -c "import json; ..." (rebind commitSha, keep uncommitted)
- Verify: 15/15 PASS

### B3: Independent mutation verification [pending]
- npm run test:mutation:check
- = node scripts/check-mutation-thresholds.mjs
- Verifies: commit_sha, config_hash, score, waiver commitSha + configurationHash
- Verify: exit code 0

### B4: verify:phase1:local [pending]
- npm run verify:phase1:local
- = typecheck + check:cycles + build + lint + test(all) + test:coverage + test:mutation:phase1
- Note: test:mutation:phase1 reuses B1 results if no code changed
- coverage threshold: lines 80%, branches 75%, functions 80%
- Verify: all 7 commands pass

### B5: Phase 1 exit_criteria supplements [pending]
- B5a: Run GLM live acceptance (see B5a-detail below)
- B5b: Confirm evals/{coding,documents,research,writing,planning,personal-assistant}/phase-1.yaml pass
- B5c: Confirm tests/session/crash-restore.test.ts covers:
  - restore does not duplicate step
  - correct iteration count
  - side effect not repeated
- B5d: node scripts/gates/check-active-stubs.mjs (confirm count=0)
- B5e: test:mutation:check (done in B3)
- Verify: all pass

### B5a-detail: GLM Live Acceptance [pending]
- npm run test:glm:live = node scripts/run-glm-acceptance.mjs
- Requires env vars:
  GLM_API_KEY=e93c1f129cc44ce8908f3f6fa328c00b.hz4tGVIGo3Y8AQni
  GLM_MODEL=glm-5.2
  GLM_REASONING_EFFORT=xhigh
  GLM_ALLOW_REMOTE=1
  MUTATION_ARTIFACT_DIGEST=<sha256 of mutation results>
  MUTATION_ARTIFACT_NAME=phase1-mutation-{commitSha}
- This is a release-level acceptance, not a simple Phase 1 check
- May need to verify what it actually requires before running

### B6: Security metrics [pending]
- Confirm sandbox_violation=0, unauthorized_effect=0, capability_replay=0
- Check test output for security violation assertions
- Verify: no security violations in tests

### B7: Regenerate Phase 1 evidence (40) [pending]
- 40 files exist in artifacts/phase-1/AH-XXX-001/evidence.json
- All commit_sha stale (bd85e7ed or 7f2eafaa, need 05dd3424 or newer)
- NO automated script exists for this (release-evidence.mjs is for Phase 2 release)
- Must manually update each file:
  1. Get new commit_sha: git rev-parse HEAD
  2. Get new tree_sha: git rev-parse HEAD^{tree}
  3. Run the requirement's tests: npx vitest run {test_files} --reporter=verbose
  4. Capture test output
  5. Compute test_output_sha256: sha256 of test output
  6. Update commit_sha, tree_sha, test_output, test_output_hash, test_output_sha256
  7. Run GLM 5.2 xhigh independent verification for each requirement
  8. Update independent_verifier field
- Consider writing a script to automate steps 1-6
- Verify: 40/40 commit_sha = current HEAD

## Phase C: Phase 2 Thin Test Thickening

### C0: Review 52 thin tests quality [pending]
- For each file (tests/phase-2/unit/ah-*.test.ts, 33-116 lines):
  a) Read acceptance_criteria from main repo:
     python3 -c "import json; ..." (query requirements.ndjson)
  b) Read corresponding source code (see HARNESS_SESSION_DIRECTIVE.md source mapping)
  c) Read existing thin test file
  d) Confirm each acceptance_criteria has >= 1 test
  e) Confirm tests use mock provider for real functional paths (not just unavailable)
  f) If insufficient, thicken with real functional tests
  g) npx vitest run tests/phase-2/unit/ah-XXX-001.test.ts --reporter=verbose
  h) typecheck + lint
- 52 files sorted by line count (33L-116L)
- Priority: thinnest first (33L-50L)
- Source mapping (from HARNESS_SESSION_DIRECTIVE.md):
  - packages/multimodal/src/vision.ts -> ah-mm-doc-vision, ah-mm-vision-verify, ah-mm-vision
  - packages/multimodal/src/image-gen.ts -> ah-tool-image-gen, ah-mm-image-in, ah-mm-image-gen
  - packages/multimodal/src/image-edit.ts -> ah-mm-image-edit
  - packages/multimodal/src/artifact-store.ts -> ah-mm-artifact
  - packages/multimodal/src/speech.ts -> ah-tool-speech-gen, ah-tool-transcribe, ah-tool-speech
  - packages/rag/src/*.ts -> ah-rag-*
  - packages/documents/src/parsers/*.ts -> ah-doc-ingest-*
  - packages/documents/src/ingestor.ts -> ah-doc-parse-*, ah-doc-ingest-enc
  - packages/tools/src/*.ts -> ah-tool-*, ah-sandbox-oci, ah-mcp-stdio
  - packages/api/src/index.ts -> ah-ux-contract
  - packages/ui/src/index.ts -> ah-ux-states
  - packages/runtime-core/src/model-fallback.ts -> ah-runtime-modelfallback
  - apps/web/src/app.ts -> ah-ux-web
  - apps/tui/src/tui.ts -> ah-ui-tui
  - apps/desktop/src/shell.ts -> ah-ux-desktop
  - apps/api/src/server.ts -> ah-ux-api
- Verify: each file covers all acceptance_criteria

### C1: Full Phase 2 test verification [pending]
- npx vitest run tests/phase-2/ --reporter=dot
- Verify: 0 failed

## Phase D: Phase 2 Gate Closure

### D1: git status clean [pending]
- Only equivalent-mutants.json uncommitted (allowed)
- Verify: git status --short only has equivalent-mutants.json

### D2: verify:phase2:dev [pending]
- node scripts/gates/verify-phase2-local.mjs --mode dev
- 5 commands: manifest, workspace-boundaries, assets, contract-drift, phase2-unit
- Verify: success=true

### D3: Push to origin and wait for CI [pending]
- git push origin codex/phase2-integrated
- Wait for CI green (typecheck/build/lint/test/coverage/audit/pack)
- CI does NOT run mutation
- Verify: CI green

### D4: Run Phase 2 mutation via GitHub Actions [pending]
- gh workflow run phase2-mutation.yml --repo 123oqwe/agent-harness-v9.1
- This runs on ubuntu-22.04 with bubblewrap + node 20.18.1 + npm 10.8.2
- Takes up to 6 hours (timeout: 360 minutes)
- Monitor: gh run list --workflow=phase2-mutation.yml
- Verify: workflow completes with exit code 0
- Note: CANNOT run locally (macOS throws, Linux needs bubblewrap)

### D5: Run local gate commands (except mutation) [pending]
- Run each command individually that can work locally:
  1. node scripts/gates/check-phase2-manifest.mjs
  2. node scripts/check-workspace-boundaries.mjs
  3. node scripts/gates/check-phase2-assets.mjs --mode local
  4. node scripts/gates/check-contract-drift.mjs
  5. node scripts/gates/check-active-stubs.mjs --mode scan
  6. npm run typecheck
  7. npm run check:cycles
  8. npm run build
  9. npx vitest run tests/phase-2/architecture
  10. npm run lint
  11. npm test -- --maxWorkers=1 (phase1-regression)
  12. npm run test:coverage -- --maxWorkers=1
  13. node scripts/gates/check-workspace-coverage.mjs
  14. npx vitest run tests/phase-2/unit
  15. npx vitest run tests/phase-2/integration
  16. npx vitest run tests/phase-2/security
  17. npx vitest run tests/phase-2/e2e
  #18 SKIP: mutation (run via CI in D4)
  19. node scripts/gates/run-phase2-evals.mjs --mode release
  20. node scripts/gates/run-phase2-data.mjs --mode release
  21. node scripts/gates/package-smoke.mjs
  22. node scripts/gates/package-smoke.mjs --mode workspace
  23. node scripts/gates/package-smoke.mjs --mode source-checkout
  + npm audit --omit=dev --audit-level=high
- Verify: commands 1-17, 19-23+audit all pass
- Note: full verify:phase2:local --mode local cannot complete (mutation fails)

### D6: Confirm Phase 2 exit_criteria [pending]
- all_phase_requirements_verified=true (evidence 64/64, via local gate)
- regression_tests_pass=true (commands 1-17, 19-23 pass)
- active_stub_count=0 (command 5)
- independent_glm_5_2_xhigh=PASS (Phase E)
- Note: candidateReady cannot be true locally (mutation command fails)
- candidateReady requires CI attestation anyway (releaseReady=false hardcoded)
- Verify: all achievable criteria satisfied

## Phase E: GLM-5.2 xhigh Scenario Acceptance

### E1: GLM source review (existing) [pending]
- 52 source files reviewed (evidence/ 9 JSONs, 0 high/critical)
- Reusable for independent_glm_5_2_xhigh

### E2: Scenario acceptance [pending]
- 6 scenarios: long-context, RAG, multimodal, UX, privacy, failure-recovery
- GLM_API_KEY=e93c1f129cc44ce8908f3f6fa328c00b.hz4tGVIGo3Y8AQni
- May use npm run test:glm:live or custom scenario scripts
- Need to verify exact mechanism for Phase 2 scenario acceptance
- Verify: all scenarios pass

## Phase F: commit and push

### F1: Final verification [pending]
- typecheck + lint + build: PASS
- All tests: PASS (2859 Phase 1 + 758 Phase 2)
- Phase 2 dev gate: PASS
- Phase 1 mutation: 15/15 PASS
- Phase 1 evidence: 40/40 SHA correct
- Phase 2 mutation: completed via CI
- Local gate commands (except mutation): all pass
- GLM acceptance: pass
- Verify: all pass

### F2: Commit all source changes [pending]
- git add source files (tests/, packages/, apps/, gateway/, scripts/, etc.)
- Do NOT add: reports/, dist/, node_modules/, .stryker-tmp/, coverage/
- .gitignore already excludes these
- equivalent-mutants.json stays uncommitted
- Verify: git status only has equivalent-mutants.json

### F3: Push to GitHub [pending]
- git push origin codex/phase2-integrated (public, has runner)
- Wait for CI green
- Verify: CI green, origin/HEAD == HEAD
- Note: user says 'GitHub上只放源码' - .gitignore ensures this

## Rules
1. Never delete tests, lower thresholds, or add skip
2. Never fake evidence/mutation results
3. Each fix must correspond to a specific failure
4. Never modify byte-frozen gate manifest (verification/gates/phase2-gate.json)
5. Never modify spec/, control/, evidence/ protected paths (needs CTO approval)
6. Never proceed to next step until current step is fully green
7. candidate-only: local results are not VERIFIED
8. Never write filler tests (only toBeDefined or module importable)
9. Waiver stays uncommitted (runner allows)
10. After each test fix: vitest + typecheck + lint
11. After each commit: rebind waiver commitSha
12. Phase 2 mutation MUST run via GitHub Actions (not local)

## Key Info
- GLM_API_KEY: e93c1f129cc44ce8908f3f6fa328c00b.hz4tGVIGo3Y8AQni
- HEAD: git rev-parse HEAD (never hardcode)
- origin: https://github.com/123oqwe/agent-harness-v9.1.git (PUBLIC, has runner)
- product: https://github.com/123oqwe/agentharness91.git (PRIVATE, no runner)
- Spec: /Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/
- Control: /Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/control/current-state.json
- configurationHash: 2e02aab1022cac3c64b20c94300813b6dbd1d572b8bd8c9dae4f6d0749b52bd2
- Phase 1 baseline: 8dca581e11b8043aed257cb07c5161237633c40e (HEAD is descendant)

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Phase A preparation, mutation needs rerun |
| Where am I going? | mutation -> thin tests -> gate -> GLM -> push |
| What's the goal? | Phase 1+2 pass, push source to GitHub |
| What have I learned? | See findings.md - old mutation stale, evidence stale, dev gate PASS, Phase 2 mutation CI-only |
| What have I done? | Full state verification, stale lock cleaned, plan written and verified |
