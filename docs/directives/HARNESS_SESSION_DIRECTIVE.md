在 /Users/guanjieqiao/agent-runtime-v7/worktrees/phase2-integrated 工作。
分支 codex/phase2-integrated。用 git rev-parse HEAD 获取当前 SHA (不要硬编码)。
所有文件路径用绝对路径。

目标: 完成所有阻挡进入 Phase 3 的条件。
Phase 3 本身不在本指令范围内。

铁律:
  - 不删测试, 不降阈值, 不加 skip, 不伪造 evidence/mutation 结果
  - 不要写只检查 toBeDefined 或 module importable 的填充测试
  - 不改动 byte-frozen 的 gate manifest (verification/gates/phase2-gate.json)
  - 不改动 spec/, control/, evidence/ 受保护路径 (需要 CTO 批准)
  - 每步全绿才进下一步

══════════════════════════════════════════════════════════════
当前已验证状态 (HEAD ddd84615, 2026-08-08)
══════════════════════════════════════════════════════════════

已完成 (全部已提交):

mutation 深度测试 — P0-P13 (11 个文件, 311 tests):
  tests/gateway/managed-gateway-deep.test.ts     22 tests  (commit 3d5b878c+26390bc9)
  tests/gateway/provider-adapters.test.ts        37 tests  (commit 0901a47f; 29 pre-existing + 8 added)
  tests/gateway/async-task-adapter-deep.test.ts  24 tests  (commit 1f53cbec)
  tests/gateway/ws-server-deep.test.ts           15 tests  (commit 7e550c2a)
  tests/gateway/model-gateway-deep.test.ts       47 tests  (commit 6979cf9d)
  tests/runtime/direct-strategy.test.ts          12 tests  (commit 350fdb0c)
  tests/runtime/harness-deep.test.ts             23 tests  (commit 6979cf9d)
  tests/runtime/loop-deep.test.ts                51 tests  (commit 6979cf9d)
  tests/session/sqlite-store-deep.test.ts        21 tests  (commit c0fd48f1)
  tests/session/progress-store.test.ts           12 tests  (commit be78628d+6e366db4)
  tests/tools/tool-registry-mutation.test.ts    47 tests  (commit 4a2c6152)

审查提示词补充测试 (20 个文件, 294 tests):
  gateway 9 个: circuit-breaker(11), rate-limiter(9), key-vault(17), capability-registry(17),
    economic-kernel(13), cache-manager(13), tool-mask(18), dag-executor(8), glm-gateway-bridge(6)
  runtime 6 个: retry(26), errors(6), notifications(15), event-bus(12), pause-resume-port(8), session-tree-port(6)
  session 1 个: durable-session(27)
  strategies 4 个: react-strategy(14), react-loop(29), plan-execute-validation(17), plan-execute-mutation(22)

其他修复:
  P0: runPhase1() -> runOne() (350fdb0c)
  P1: steering-port.test.ts 已删除 (350fdb0c)
  P13: configurationHash = 2e02aab1... 已验证
  server.test.ts port:0 (75020cfa)
  managed-gateway-stream.test.ts timeout 已修复, 7/7 pass (ddd84615)
  task_plan.md 43 个错误已修正 (7f2eafaa)
  Phase 1 evidence 40/40 含 AH-GATEWAY-TESTPROVIDER-001 (47960c53)
  Phase 1 domain evals 6 个已创建 (47960c53)
  Phase 1 eval fixtures 已创建 (47960c53)
  Stage 0 SOTA 回归已修复
  Phase 2 mutation 64/64 completed (candidate-only)
  GLM 5.2 xhigh 源码审查 52 个文件, 0 high/critical
  workspace-boundaries: valid, active-stubs: 0, contract-drift: 0 errors
  waiver commitSha 已重绑到 HEAD (保持 uncommitted)
  分支已设置 upstream tracking [origin/codex/phase2-integrated]
  代码已 push 到 origin 和 product

未完成 (6 项):
  1. Phase 1 mutation 从未用新测试跑过 (旧数据见下方索引)
  2. Phase 1 evidence SHA 全部过期 (40/40 stale)
  3. 52 个 Phase 2 薄测试未补厚 (完整清单见下方)
  4. Phase 2 evidence 0/64
  5. Phase 2 gate 从未通过
  6. control/current-state.json 未更新 (P1=IN_PROGRESS, P2=BLOCKED, P3=BLOCKED)

══════════════════════════════════════════════════════════════
Phase 1 mutation 旧结果索引 (B1 重跑前的问题预判)
══════════════════════════════════════════════════════════════

以下是旧 mutation run (Aug 6-8) 的结果。B1 重跑后分数会变 (P6/P8/P9 等 311 个新测试
会影响 gateway, runtime, session 模块)。但以下索引帮助预判哪些文件需要关注。

15 个模块的 mutation 阈值 (mutation/thresholds.json):
  85%: gateway, toolsLeaf, skills, strategies, verification, verticals, uiAdapters
  90%: router, toolsRegistry, actionControl, identitySecrets, vfs, sandbox, session, runtime
  perFileMinimums: toolsLeaf=80%, verticals=80%

─── 11 个已有旧 result.json 的模块 ───

模块 1: gateway — 旧 score 84.68, 阈值 85, FAIL (差 0.32%)
  这是唯一 FAIL 的模块。264 survived + 36 nocov。
  热点文件 (survived 最多):
    gateway/model-gateway.ts: 161 survived + 16 nocov
      -> P6 (model-gateway-deep.test.ts, 47 tests) 应该大幅改善。重跑后重点关注。
    gateway/scripted-provider.ts: 62 survived + 9 nocov
      -> 没有专用深度测试。可能需要补测试或注册 waiver。
    gateway/glm-provider.ts: 39 survived + 5 nocov
      -> 没有专用深度测试。
    gateway/glm-gateway-bridge.ts: 2 survived + 6 nocov
      -> 有 tests/gateway/glm-gateway-bridge.test.ts (6 tests) 但可能不够。
  重跑后如果仍 FAIL: 读 mutation.json 找 surviving mutants,
    补测试杀掉或注册 waiver (见 B2 修复方法)。

模块 2: router — 旧 score 90.19, 阈值 90, PASS (刚过线)
  74 survived + 5 nocov, 全在 router/static-router.ts。
  重跑后可能回归到 FAIL (如果新测试引入了问题)。关注 static-router.ts。

模块 3: sandbox — 旧 score 90.88, 阈值 90, PASS
  56 survived + 1 nocov, 全在 sandbox/process-sandbox.ts。

模块 4: skills — 旧 score 91.44, 阈值 85, PASS
  24 survived + 4 nocov, 全在 skills/skill-registry.ts。

模块 5: strategies — 旧 score 85.18, 阈值 85, PASS (刚过线)
  173 survived + 30 nocov:
    runtime/plan-execute.ts: 141 survived + 17 nocov (最大瓶颈)
      -> 有 plan-execute-validation(17)+plan-execute-mutation(22) 共 39 tests, 但仍多。
    runtime/react.ts: 29 survived + 13 nocov
      -> 有 react-strategy(14)+react-loop(29) 共 43 tests。20 个 waiver 已注册。
    runtime/direct.ts: 3 survived
      -> P7 direct-strategy.test.ts (12 tests) 覆盖良好。

模块 6: toolsLeaf — 旧 score 90.29, 阈值 85, PASS
  38 survived + 2 nocov:
    tools/apply-patch.ts: 12 survived
    tools/search-files.ts: 10 survived
    tools/screenshot.ts: 6 survived
    tools/edit-file.ts: 4 survived + 2 nocov
    tools/undo.ts: 2 survived

模块 7: toolsRegistry — 旧 score 90.98, 阈值 90, PASS
  67 survived + 20 nocov:
    tools/tool-registry.ts: 35 survived + 7 nocov
      -> P11 tool-registry-mutation.test.ts (47 tests) 应该改善。
    tools/tool-executor.ts: 26 survived + 5 nocov
    tools/tool-dispatcher.ts: 6 survived + 8 nocov

模块 8: uiAdapters — 旧 score 95.77, 阈值 85, PASS
  11 survived, 全在 ui/ah_ui_onboarding_001.ts (7) 和 ui/ah_ui_chat_001.ts (4)。

模块 9: verification — 旧 score 87.45, 阈值 85, PASS
  96 survived + 3 nocov:
    verification/verification-engine.ts: 60 survived
    verification/evidence.ts: 21 survived + 2 nocov
    verification/eval-runner.ts: 15 survived + 1 nocov

模块 10: verticals — 旧 score 88.48, 阈值 85, PASS
  56 survived + 3 nocov:
    domains/planning/ah_planning_vertical_001.ts: 22 survived + 2 nocov
    domains/coding/ah_coding_vertical_001.ts: 16 survived
    domains/documents/ah_doc_vertical_001.ts: 10 survived
    domains/research/ah_research_vertical_001.ts: 5 survived + 1 nocov
    domains/personal-assistant/ah_pa_vertical_001.ts: 2 survived

模块 11: vfs — 旧 score 93.33, 阈值 90, PASS
  52 survived + 9 nocov:
    vfs/workspace-transaction.ts: 31 survived + 1 nocov
    vfs/virtual-filesystem.ts: 21 survived + 8 nocov

─── 4 个完全缺失的模块 (无 result.json, 无 mutation.json) ───

模块 12: actionControl — 阈值 90%
  mutate 文件:
    security/policy-engine.ts
    security/authorization-service.ts
    security/capability.ts
    security/pep.ts
    security/consent.ts
    security/action-executor.ts
    security/audit-sink.ts
  有测试: tests/security/ 下有 capability-issue, capability-replay, capability-child 等
  B1 重跑后首次产生 result.json。关注是否达标。

模块 13: identitySecrets — 阈值 90%
  mutate 文件:
    security/auth.ts
    security/secrets-broker.ts
  有测试: tests/security/ 下可能有相关测试。
  B1 重跑后首次产生 result.json。

模块 14: session — 阈值 90%
  mutate 文件:
    session/durable-session.ts
    session/sqlite-session-store.ts
    session/progress-store.ts
    session/run-session.ts
  有测试: durable-session.test.ts (27), sqlite-store-deep.test.ts (21),
    progress-store.test.ts (12)
  P10 已覆盖核心文件。B1 重跑后关注 run-session.ts 是否有 survived。

模块 15: runtime — 阈值 90%
  mutate 文件:
    harness.ts
    runtime/errors.ts
    runtime/harness-support.ts
    runtime/hook-port.ts
    runtime/loop.ts
    runtime/steering-port.ts (纯类型, P1 已删测试, Stryker 不产生 mutant)
    runtime/retry.ts
    runtime/notifications.ts
    runtime/event-bus.ts
    runtime/pause-resume-port.ts
    runtime/session-tree-port.ts
  有测试: P8 harness-deep (23), P9 loop-deep (51), retry (26), errors (6),
    notifications (15), event-bus (12), pause-resume-port (8), session-tree-port (6)
  P0-P13 覆盖了大部分文件。B1 重跑后关注 harness-support.ts 和 hook-port.ts。

─── 已注册的 20 个 equivalent-mutant waivers ───

全部在 strategies 模块:
  runtime/react.ts: 13 个 waivers (HookRestrictionError catch block, 被 integration tests 覆盖但 mutation scope 排除)
  runtime/plan-execute.ts: 7 个 waivers
重跑后如果 waiver 的 strykerMutantId 不再匹配 (代码改了), 需要更新。

══════════════════════════════════════════════════════════════
Phase 2 薄测试完整清单 (52 个, 按行数排序)
══════════════════════════════════════════════════════════════

阶段 C 需要补厚这 52 个文件。每个文件对应一个 Phase 2 requirement。
源代码在 packages/{documents,multimodal,rag,tools,api,ui}/src/ 和 apps/{api,web,tui,desktop}/src/。

主仓库的 source_files 路径是 harness/ 布局, 和 phase2-integrated 的 packages/ 布局不同。
对应关系:
  harness/ingestion/* -> packages/documents/src/parsers/* 和 packages/documents/src/ingestor.ts
  harness/multimodal/* -> packages/multimodal/src/*
  harness/rag/* -> packages/rag/src/*
  harness/tools/* -> packages/tools/src/*
  harness/ui/* -> apps/{api,web,tui,desktop}/src/* 和 packages/{api,ui}/src/
  harness/sandbox/* -> packages/tools/src/oci-sandbox.ts

 33L  ah-mm-doc-vision-001        -> packages/multimodal/src/vision.ts
 37L  ah-mm-vision-verify-001     -> packages/multimodal/src/vision.ts
 42L  ah-tool-image-gen-001       -> packages/multimodal/src/image-gen.ts
 43L  ah-mm-image-edit-001        -> packages/multimodal/src/image-edit.ts
 43L  ah-rag-meta-001             -> packages/rag/src/metadata-index.ts
 45L  ah-doc-ingest-img-001       -> packages/documents/src/image-parser.ts
 45L  ah-mm-artifact-001          -> packages/multimodal/src/artifact-store.ts
 45L  ah-rag-embed-001            -> packages/rag/src/embedding-provider.ts
 45L  ah-rag-graph-001            -> packages/rag/src/graph-index.ts
 46L  ah-sandbox-oci-001          -> packages/tools/src/oci-sandbox.ts
 47L  ah-doc-ingest-unsupported-001 -> packages/documents/src/unsupported-parser.ts
 48L  ah-doc-parse-provenance-001 -> packages/documents/src/ingestor.ts
 48L  ah-rag-rerank-001           -> packages/rag/src/reranker.ts
 49L  ah-doc-ingest-enc-001       -> packages/documents/src/ingestor.ts
 51L  ah-rag-query-001            -> packages/rag/src/query-engine.ts
 52L  ah-rag-embed-mig-001        -> packages/rag/src/embedding-migrator.ts
 53L  ah-doc-parse-table-001      -> packages/documents/src/ingestor.ts
 54L  ah-ux-contract-001          -> packages/api/src/index.ts
 55L  ah-doc-parse-head-001       -> packages/documents/src/ingestor.ts
 55L  ah-doc-parse-imgref-001     -> packages/documents/src/ingestor.ts
 55L  ah-mcp-stdio-001            -> packages/tools/src/mcp-stdio.ts
 57L  ah-ux-web-001               -> apps/web/src/app.ts
 59L  ah-tool-web-fetch-001       -> packages/tools/src/web-fetch.ts
 61L  ah-ui-tui-001               -> apps/tui/src/tui.ts
 64L  ah-rag-cite-001             -> packages/rag/src/citation.ts
 64L  ah-tool-speech-gen-001      -> packages/multimodal/src/speech.ts
 65L  ah-ux-desktop-001           -> apps/desktop/src/shell.ts
 66L  ah-tool-transcribe-001      -> packages/multimodal/src/speech.ts
 69L  ah-tool-web-search-001      -> packages/tools/src/web-search.ts
 71L  ah-mm-image-in-001          -> packages/multimodal/src/image-gen.ts
 71L  ah-rag-chunk-001            -> packages/rag/src/chunker.ts
 71L  ah-runtime-modelfallback-001-adapter -> packages/runtime-core/src/model-fallback.ts
 71L  ah-ux-states-001            -> packages/ui/src/index.ts
 72L  ah-tool-speech-001          -> packages/multimodal/src/speech.ts
 73L  ah-doc-ingest-html-001      -> packages/documents/src/html-parser.ts
 73L  ah-rag-delete-001           -> packages/rag/src/vector-index.ts
 73L  ah-tool-escalate-001        -> packages/tools/src/escalate.ts
 79L  ah-tool-ocr-001             -> packages/tools/src/cli-tools.ts
 80L  ah-doc-ingest-md-001        -> packages/documents/src/markdown-parser.ts
 81L  ah-doc-ingest-web-001       -> packages/documents/src/html-parser.ts
 85L  ah-tool-behavior-verify-001 -> packages/tools/src/behavior-verify.ts
 86L  ah-tool-spreadsheet-001     -> packages/tools/src/cli-tools.ts
 90L  ah-rag-fts-001              -> packages/rag/src/fts-index.ts
 93L  ah-mm-vision-001            -> packages/multimodal/src/vision.ts
 93L  ah-tool-document-001        -> packages/tools/src/cli-tools.ts
 93L  ah-tool-presentation-001    -> packages/tools/src/cli-tools.ts
 94L  ah-doc-ingest-docx-001      -> packages/documents/src/docx-parser.ts
 94L  ah-mm-image-gen-001         -> packages/multimodal/src/image-gen.ts
 99L  ah-doc-ingest-xlsx-001      -> packages/documents/src/xlsx-parser.ts
100L  ah-doc-ingest-pdf-001       -> packages/documents/src/pdf-parser.ts
104L  ah-doc-ingest-pptx-001      -> packages/documents/src/pptx-parser.ts
116L  ah-ux-api-001               -> apps/api/src/server.ts

补厚方法: 对每个文件
  a) 读 acceptance_criteria:
     python3 -c "
     import json
     with open('/Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/requirements/requirements.ndjson') as f:
       for l in f:
         r=json.loads(l) if l.strip() else {}
         if r.get('delivery_phase')==2 and r['id']=='REQ_ID': print(json.dumps(r,indent=2))
     "
  b) 读对应源代码 (见上面的 source mapping)
  c) 读现有薄测试文件
  d) 用 mock provider 测真正功能路径 (不是只测 unavailable)
  e) 每条 acceptance_criteria 至少 1 个测试覆盖
  f) npx vitest run tests/phase-2/unit/ah-XXX-001.test.ts --reporter=verbose
  g) typecheck + lint

══════════════════════════════════════════════════════════════
Phase 1 exit_criteria (spec/phases/phase-1.yaml)
══════════════════════════════════════════════════════════════

共 12 项:
  1. domain_evals_all_pass: true — 6 个 evals 已创建 (47960c53), 需确认能通过
  2-7. 6 个 vertical evals (coding, documents, research, writing, planning, pa)
  8. security: sandbox_violation=0, unauthorized_effect=0, capability_replay=0
  9. active_stub_count: 0 (已满足)
  10. mutation_score: >= 0.7 (需 B1 确认)
  11. crash_restore_no_duplicate: PASS (3 个测试, 需确认覆盖)
  12. independent_glm_5_2_xhigh: PASS
      GLM_API_KEY=e93c1f129cc44ce8908f3f6fa328c00b.hz4tGVIGo3Y8AQni

  verify:phase1:local 跑 7 个命令:
    typecheck -> check:cycles -> build -> lint -> test(全部, 含 Phase 2) -> test:coverage -> test:mutation:phase1
  缺少 5 个检查 (需 B5 手动补充):
    (a) GLM xhigh: npm run test:glm:live
    (b) domain evals: 确认 evals/{domain}/phase-1.yaml 能通过
    (c) crash_restore: 确认 tests/session/crash-restore.test.ts 覆盖
    (d) active_stub_count: node scripts/gates/check-active-stubs.mjs (已满足)
    (e) test:mutation:check: npm run test:mutation:check (独立验证)

Phase 2 exit_criteria (spec/phases/phase-2.yaml): 4 项
  1. all_phase_requirements_verified: true (evidence 64/64)
  2. regression_tests_pass: true (verify:phase2:local 23 命令全过)
  3. active_stub_count: 0 (已满足)
  4. independent_glm_5_2_xhigh: PASS (场景验收, 不是源码审查)

Phase 3 entry_criteria (spec/phases/phase-3.yaml): 3 项
  1. Previous phase gate passed (Phase 2 success=true)
  2. All dependencies verified
  3. No open P0 blockers

══════════════════════════════════════════════════════════════
执行路线图 (阶段 A-F)
══════════════════════════════════════════════════════════════

─── 阶段 A: 确认准备 (10 分钟) ───

A1. 确认 managed-gateway-stream.test.ts 7/7 pass (已修复 ddd84615)
A2. 确认 waiver commitSha 匹配 HEAD (保持 uncommitted)
A3. waiver 重绑方法 (每次 commit 后执行):
    NEW_SHA=$(git rev-parse HEAD)
    python3 -c "
    import json
    with open('mutation/equivalent-mutants.json') as f: d=json.load(f)
    for w in d: w['commitSha']='$NEW_SHA'
    with open('mutation/equivalent-mutants.json','w') as f: json.dump(d,f,indent=2)
    "
    不要 commit 重绑后的版本。
A4. npm run typecheck && npm run lint

─── 阶段 B: Phase 1 Mutation 地基验证 (8-12 小时) ───

B0. 准备:
  B0a. rm -rf .stryker-tmp/2026-08-0* (释放 5-10GB)
  B0b. npm run prepare && ls patches/@stryker-mutator+core+9.6.1.patch
  B0c. export GLM_API_KEY=e93c1f129cc44ce8908f3f6fa328c00b.hz4tGVIGo3Y8AQni
  B0d. 确认 4 个缺失模块: actionControl, runtime, session, identitySecrets

B1. 运行 mutation:
  node scripts/run-mutation.mjs phase1
  5-8 小时 (15 模块, gateway 43 chunks)
  监控: 每 30 分钟 ps aux | grep stryker + ls .stryker-tmp/
  不要中途 kill (除非 crash)
  chunkTimeoutMs: gateway=30min, sandbox=30min, default=15min
  Stryker exit code 非 0 -> 模块拒绝报告 (line 856)
  crash 后: 清理 .stryker-tmp 重跑

B2. 检查结果 (用上方"旧结果索引"预判哪些模块需要关注):
  确认 15/15 模块都有 result.json
  score >= thresholds.json 阈值 (85% 或 90%, 见上方)
  7 个 PASS 模块可能回归, 必须 15/15 PASS

  不达标的模块 — 修复方法:
    a) 读 mutation.json 找 surviving mutants:
       python3 -c "
       import json
       d=json.load(open('reports/mutation/{module}/mutation.json'))
       for fname, fdata in d.get('files',{}).items():
         for m in fdata.get('mutants',[]):
           if m.get('status')=='Survived':
             loc=m.get('location',{})
             print(f'{fname}:{loc.get(\"start\",{}).get(\"line\",\"?\")} id={m[\"id\"]} mutator={m[\"mutatorName\"]}')
       "
    b) 真覆盖缺口 -> 补测试杀掉 (读源文件对应行, 写测试覆盖该分支)
    c) 等价 mutant -> 在 equivalent-mutants.json 注册 waiver:
       {
         "module": "模块名",
         "sourceFile": "源文件路径",
         "reason": "为什么是等价 mutant",
         "reviewedBy": "phase2-integration-lead",
         "reviewedAt": "2026-08-08T00:00:00Z",
         "commitSha": "用 git rev-parse HEAD 获取",
         "strykerMutantId": "从 mutation.json 复制",
         "configurationHash": "node -e \"import {computeMutationConfigurationHash} from './scripts/run-mutation.mjs'; console.log(computeMutationConfigurationHash());\""
       }
    d) 重跑该模块: node scripts/run-mutation.mjs {module}
    e) 循环直到达标
    f) 每次 commit 后重绑 waiver (见 A3)

B3. npm run test:mutation:check (独立验证, verify:phase1:local 不包含)
  = node scripts/check-mutation-thresholds.mjs
  重新验证 mutant identity + git blob + score
  FAIL -> waiver commitSha 或 configurationHash 不匹配

B4. npm run verify:phase1:local
  = typecheck + check:cycles + build + lint + test(全部) + test:coverage + test:mutation:phase1
  npm test 跑全部 (Phase 1 + Phase 2), Phase 2 失败也会让 Phase 1 gate 失败
  coverage threshold: lines 80%, branches 75%, functions 80%
  如果 B1 后没改代码, mutation 复用 result.json。如果 B2 补了测试, B4 重跑 mutation。

B5. 补充 5 个缺失检查:
  B5a. npm run test:glm:live (GLM_API_KEY 见 B0c)
  B5b. 确认 evals/{coding,documents,research,writing,planning,personal-assistant}/phase-1.yaml 能通过
  B5c. 确认 tests/session/crash-restore.test.ts 3 个测试覆盖: 恢复不重复 step, 正确 iteration, side effect 不重复
  B5d. node scripts/gates/check-active-stubs.mjs (已满足)
  B5e. test:mutation:check (已在 B3 做)

B6. 确认 sandbox_violation=0, unauthorized_effect=0, capability_replay=0

B7. 重新生成 Phase 1 evidence (40 个)
  40 个文件存在但 commit_sha 全部过期 (39 个指向 bd85e7ed, 1 个指向 7f2eafaa)
  用新 HEAD 重新生成。参考: scripts/release-evidence.mjs
  evidence 格式 (参考 artifacts/phase-1/AH-CAPABILITY-001/evidence.json):
    requirement_id, commit_sha, tree_sha, source_files[], tests_added[],
    commands_run[], exit_codes[], test_results{pass,total,failed},
    coverage, security_checks, verifier_result, verifier_model,
    test_output, test_output_hash, test_output_sha256,
    test_pass_count, test_total_count, independent_verifier{model,verdict,severity}
  重新跑 GLM 5.2 xhigh 独立验证
  注意: control/ 和 spec/ 在主仓库 agent-harness-v9.1

─── 阶段 C: 补厚 52 个 Phase 2 薄测试 (2-3 天) ───

  完整清单和 source mapping 见上方"Phase 2 薄测试完整清单"。
  对每个文件: 读 acceptance_criteria -> 读源代码 -> 用 mock provider 测真实功能 -> typecheck + lint
  全量验证: npx vitest run tests/phase-2/ --reporter=dot -> 0 failed

─── 阶段 D: Phase 2 Gate 闭环 (1-2 天) ───

D1. git status clean (除 equivalent-mutants.json uncommitted)
  !identity.dirty 是 evidence 发布的 6 个前置条件之一:
    mode==="local" && hasReleaseAuthority && execution.ok &&
    !identity.dirty && identityStable && errors.length===0

D2. node scripts/gates/verify-phase2-local.mjs --mode dev
  确认 candidateReady=true

D3. git push origin codex/phase2-integrated
  agentharness91 (product) 是 PRIVATE 无 runner, 推到 origin (public)
  ci.yml 不跑 mutation, 只跑 typecheck/build/lint/test/coverage/audit/pack
  等 CI 绿

D4. CI 绿后运行 verify:phase2:local --mode local
  node scripts/gates/verify-phase2-local.mjs --mode local
  23 个命令, 3-4 小时:
    1. check-phase2-manifest
    2. check-workspace-boundaries
    3. check-phase2-assets --mode local
    4. check-contract-drift
    5. check-active-stubs --mode scan
    6. typecheck
    7. check:cycles
    8. build
    9. lint
    10. phase1-regression (npm test --maxWorkers=1, 15min) — 重跑全部 Phase 1 测试
    11. coverage (test:coverage --maxWorkers=1, 15min)
    12. workspace-coverage
    13. phase2-unit (10min)
    14. phase2-integration (5min)
    15. phase2-security (5min)
    16. phase2-e2e (10min)
    17. mutation (test:mutation:phase2 = run-phase2-mutation-launcher.mjs phase2, 60min)
        Phase 2 mutation (64 requirement, 用 phase2-modules.mjs), 不同于 B1 (15 模块, 用 modules.mjs)
        读本地 reports/ (gitignored), CI 需单独触发:
        gh workflow run phase2-mutation.yml --repo 123oqwe/agent-harness-v9.1
    18. evaluations (run-phase2-evals.mjs --mode release, 15min)
        fixtures: fixtures/phase-2/assets/evals/*.json (7 domain + benchmark + synthetic)
        --mode release 可能需外部数据, --mode bootstrap 用 fixtures
    19. data (run-phase2-data.mjs --mode release, 15min)
        fixtures: fixtures/phase-2/assets/data/*.json
    20. package-smoke (5min)
    21. workspace-smoke (5min)
    22. source-checkout-reproduction (60min) — 干净 checkout 重建验证
    23. production-audit (npm audit --omit=dev, 5min)
  releaseReady 硬编码 false, 目标 candidateReady=true
  candidateReady 要求 candidateEvidenceCount === 64

D5. 确认 Phase 2 exit_criteria:
  all_phase_requirements_verified=true (evidence 64/64)
  regression_tests_pass=true (23 命令全过)
  active_stub_count=0 (已满足)
  independent_glm_5_2_xhigh=PASS (阶段 E)

─── 阶段 E: Phase 2 GLM-5.2 xhigh 场景验收 (1 天) ───

  已有 52 个源文件 GLM 源码审查 (evidence/ 下 9 个 JSON, 0 high/critical), 可复用。
  阶段 E 是补充场景验收, 两者合起来满足 independent_glm_5_2_xhigh。
  6 个场景: long-context, RAG, multimodal, UX, privacy, failure-recovery

─── 阶段 F: 更新控制状态 (需 CTO 批准, 完成后即可开始 Phase 3) ───

F1. 在主仓库 agent-harness-v9.1 更新 control/current-state.json:
  Phase 1: status -> VERIFIED, maturity -> {verified: 40}
  Phase 2: status -> VERIFIED, maturity -> {verified: 64}
  Phase 3: status -> IN_PROGRESS

F2. 确认 Phase 3 entry_criteria:
  - Previous phase gate passed (Phase 2 success=true)
  - All dependencies verified
  - No open P0 blockers

F3. 确认 B0.5 受保护 patch (phase2-spec-sync) 是否已批准

══════════════════════════════════════════════════════════════
路径总览
══════════════════════════════════════════════════════════════

当前位置: 阶段 A (所有 blocker 已修复, 准备跑 mutation)

A (10min) -> B (8-12h) -> C (2-3天) -> D (1-2天) -> E (1天) -> F (需批准)
确认准备    跑mutation    补52薄测试  gate闭环   GLM场景   更新状态
             15模块达标    typecheck   push+CI    验收6场景  Phase3
             verify        lint        23命令     (复用52   可开始
             5个补充                   3-4h       源码审查)
             40个evidence

每步全绿才进下一步。做完 A-D 后汇总结果, 确认后再做 E-F。

══════════════════════════════════════════════════════════════
Mutation 修复指南: 每个热点文件的具体修复方法
══════════════════════════════════════════════════════════════

以下基于旧 mutation.json 的 survived 分析。B1 重跑后需要重新读 mutation.json
确认哪些 mutant 仍然 survived (P6/P8/P9 等新测试可能已经杀掉了部分)。
读法:
  python3 -c "
  import json
  d=json.load(open('reports/mutation/{module}/mutation.json'))
  for fname, fdata in d.get('files',{}).items():
    for m in fdata.get('mutants',[]):
      if m.get('status')=='Survived':
        loc=m.get('location',{})
        print(f'{fname}:{loc.get(\"start\",{}).get(\"line\",\"?\")} mutator={m[\"mutatorName\"]} id={m[\"id\"]}')
  "

─── gateway 模块 (旧 score 84.68, 阈值 85, FAIL — 最优先) ───

文件 1: gateway/model-gateway.ts — 161 survived + 16 nocov
  P6 (model-gateway-deep.test.ts, 47 tests) 已测了 dispatchExact/dispatchStream/resolve
  但以下辅助函数完全没测 (P6 里 0 个引用):
    isPlainRecord (line 289): 测非对象/null/数组 -> false, 普通对象 -> true
    assertPlainRecord (line 295): 测非对象 -> 抛 ProviderConfigurationError
    assertKnownKeys (line 299): 测未知字段 -> 抛错, 已知字段 -> 通过
    nonEmptyString (line 305): 测空字符串/非字符串 -> 抛错, 正常字符串 -> 返回
    finiteNonNegative (line 310): 测负数/NaN/Infinity/非数字 -> 抛错, 正常 -> 返回
    deepFreeze (line 342): 测已冻结对象跳过, 嵌套对象递归冻结
    canonicalJson (line 349): 测 null/boolean/string/number/array/object 的序列化,
      特别测试 undefined 字段被过滤, 键排序
    contentHash (line 371): 测相同输入 -> 相同 hash, 不同输入 -> 不同 hash
    normalizeContract (line 374): 测试 contract 规范化的各种输入
  修复方法: 在 tests/gateway/model-gateway-deep.test.ts 里加一个 describe
    "helper functions" 测试上述每个函数的正/负路径。
    这些函数是纯函数, 不需要 mock, 直接 import 测试。
  另有 ConditionalExpression (62) 和 StringLiteral (55) survived 集中在
    resolve() 和 normalizeContract() 的条件分支 — P6 已覆盖 resolve 的主要路径,
    但 normalizeContract 的分支可能需要额外测试。

文件 2: gateway/scripted-provider.ts — 62 survived + 9 nocov (612 行)
  有 tests/gateway/scripted-provider.test.ts 但覆盖不足。
  关键未测函数:
    normalizeUsage: 测各种 usage 输入 (缺失字段, 负数, 非数字)
    normalizeToolCallValue: 测 tool call 解析 (缺失 id/name/arguments)
    normalizeMessage: 测消息解析 (各种 role, 缺失 content)
    normalizeMessages: 测消息数组解析 (空数组, 非数组)
    cloneJson: 测深拷贝 (循环引用, 特殊类型)
  修复方法: 在 tests/gateway/scripted-provider.test.ts 里加测试覆盖
    normalize* 函数的各种输入边界。

文件 3: gateway/glm-provider.ts — 39 survived + 5 nocov (362 行)
  有 tests/gateway/glm-provider.test.ts 和 glm-provider-mutation.test.ts 但覆盖不足。
  热点:
    OptionalChaining (13): tool.risk_feature_extractor?.trim() 等 — 测 tool 无
      risk_feature_extractor 时不崩溃
    toolDescription (line 35): 测各种 tool 输入 (空 description, 无 parameters)
    stopReason: 测各种 stop_reason 映射 (stop, length, tool_use, content_filter)
  修复方法: 在 tests/gateway/glm-provider-mutation.test.ts 里加测试。

文件 4: gateway/glm-gateway-bridge.ts — 2 survived + 6 nocov (103 行)
  有 tests/gateway/glm-gateway-bridge.test.ts (6 tests) 但覆盖不足。
  热点: ArrowFunction (2) at line 86-87, 回调函数没被调用。
  修复方法: 测试 createGlmGateway 返回的对象的完整接口。

─── router 模块 (旧 score 90.19, 阈值 90, 刚过线 — 回归风险) ───

文件: router/static-router.ts — 74 survived
  有 tests/router/static-router.test.ts (247 tests) 但 50 个 Regex survived。
  热点: Regex (50) 集中在 line 70-80 — goal 解析正则:
    /\b(?:do\s+not|don't|never|without)\b.../giu — 否定句检测
    /(?:不要|禁止).*?.../giu — 中文否定句
    /\b(rewrite|polish|draft|essay|article|copyedit)\b|润色|改写|.../u — 写作意图检测
  Regex mutant 很难杀 (Stryker 改正则字符, 需要精确的输入来区分)。
  修复方法:
    - 对每个正则, 构造能区分原始正则和 mutant 正则的测试输入
    - 例如: 测 "don't refactor this" -> 否定句被移除; 测 "refactor this" -> 不被移除
    - 如果无法区分 (等价 mutant), 注册 waiver
  ConditionalExpression (13): 路由决策分支, 需要更多路由场景测试

─── strategies 模块 (旧 score 85.18, 阈值 85, 刚过线) ───

文件: runtime/plan-execute.ts — 141 survived
  有 plan-execute-validation(17)+plan-execute-mutation(22) 共 39 tests, 7 个 waiver。
  但仍有 141 survived:
    ConditionalExpression (60): 计划执行的各种条件分支
    Regex (24): 输入解析正则
  修复方法: 读 mutation.json 找具体 survived 行号, 补测试覆盖这些分支。
  如果 Regex 无法区分, 注册 waiver。

文件: runtime/react.ts — 29 survived (13 个已注册 waiver)
  有 react-strategy(14)+react-loop(29) 共 43 tests。
  剩余 29 survived 可能也需要 waiver 或补测试。

─── verification 模块 (旧 score 87.45, 阈值 85, PASS) ───

文件: verification/verification-engine.ts — 60 survived
  有 tests/verification/verification-engine.test.ts 但覆盖不足。
  热点: ConditionalExpression (20), StringLiteral (11)
  修复方法: 读 mutation.json 找具体 survived 行, 补测试。
  如果模块 PASS 且不接近阈值, 可以低优先级处理。

─── toolsRegistry 模块 (旧 score 90.98, 阈值 90, PASS) ───

文件: tools/tool-registry.ts — 35 survived
  P11 (tool-registry-mutation.test.ts, 47 tests) 已覆盖, 但仍有 35 survived。
  热点: ConditionalExpression (12), StringLiteral (9)
文件: tools/tool-executor.ts — 26 survived
  没有专用深度测试。
  修复方法: 创建 tests/tools/tool-executor-deep.test.ts

─── 修复优先级 ───

1. gateway (FAIL, 差 0.32%) — 必须修复到 >= 85%
   优先: model-gateway.ts 辅助函数 (isPlainRecord 等, 纯函数容易测)
   其次: scripted-provider.ts normalize* 函数
   然后: glm-provider.ts toolDescription/stopReason
   最后: glm-gateway-bridge.ts 完整接口

2. router (90.19, 刚过线) — 如果 B1 重跑后回归到 FAIL
   优先: static-router.ts Regex 测试

3. strategies (85.18, 刚过线) — 如果 B1 重跑后回归到 FAIL
   优先: plan-execute.ts ConditionalExpression 分支

4. 其他 PASS 模块 — 低优先级, 只有回归到 FAIL 才需要修复

─── 修复后验证 ───

每次补测试后:
  npx vitest run tests/{module}/{file}.test.ts --reporter=verbose
  npm run typecheck && npm run lint
  重跑该模块 mutation: node scripts/run-mutation.mjs {module}
  确认 score >= 阈值
  每次 commit 后重绑 waiver (见 A3)
