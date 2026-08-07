# Task Plan: agent-harness Phase 2 完整执行计划

## Goal
完成 Phase 1 mutation 地基验证 → 补厚 55 个薄测试 → Phase 2 mutation → Evidence 生成 → Gate 闭环 → push 到 GitHub agentharness91 (product remote)。

## Next Step
运行 `node scripts/run-mutation.mjs gateway` 验证 P6 测试杀 mutant 效果；同时补 gateway 10 个无测试文件。

## Current Phase
Phase 1 mutation 地基 — P0-P13 已完成, waiver 已重绑, 开始 mutation 运行 + 补测试文件

---

## ═══ 原始 6 步计划 (来自 requirements 文件) ═══

| 步骤 | 描述 | 状态 |
|------|------|------|
| Step 1 | Phase 1 地基验证 (mutation score >= 0.7) | 进行中 — P0-P13 完成, 待跑 mutation |
| Step 2 | 补厚 55 个薄测试 | 未开始 |
| Step 3 | 同步 gate manifest owned_sources | 已完成 (candidate-only registry sources) |
| Step 4 | Phase 2 mutation (64/64) | 已完成 (candidate-only) |
| Step 5 | Evidence 生成 | 未开始 |
| Step 6 | Gate 闭环 + push | 未开始 |

### 铁律
- 不删测试、不降阈值、不加 skip、不伪造 evidence/mutation 结果
- 不改动 byte-frozen 的 gate manifest (verification/gates/phase2-gate.json)
- 不改动 spec/、control/、evidence/ 受保护路径 (需要 CTO 批准)
- 步骤未全绿不进入下一步

---

## ═══ Step 1: Phase 1 地基验证 — P0-P13 子计划 ═══

### 已完成项 (已提交)

#### ✔ P0: 修复 runPhase1() 调用 runOne() — commit 350fdb0c
- scripts/run-mutation.mjs 中 runPhase1() 改为调用 runOne() 而非 runModule()
- 使 result.json 正确发布到模块目录

#### ✔ P1: 删除 steering-port.test.ts — commit 350fdb0c
- 删除 142 行纯类型断言 (0 个 mutant)

#### ✔ P2 + P2-FIX: managed-gateway-deep.test.ts (22 tests) — commit 3d5b878c + 26390bc9
- complete() 方法: mock fetch, HTTP 错误, 认证, 预算, 速率限制, 并发
- P2-FIX: fallback, circuit breaker, budget, all-fail

#### ✔ P3: provider-adapters.test.ts (+8 tests) — commit 0901a47f
- resolve() HTTP 路径, 认证 header, AbortSignal, 错误响应

#### ✔ P4: async-task-adapter-deep.test.ts (24 tests) — commit 1f53cbec
- Seedance: submit, poll, resolve, streamEvents, 错误处理

#### ✔ P5: ws-server-deep.test.ts (15 tests) — commit 7e550c2a
- task, task_stream, pause, resume 消息处理

#### ✔ P6: model-gateway-deep.test.ts (47 tests) — commit 6979cf9d
- dispatchExact (17): success, retry, auth/invalid, hash mismatch, deadline, credential, egress, metering, health, cancel, timeout, mapError
- dispatchStream (13): stream events, fallback, auth no-fallback, partial yield, retry, stale, deadline, cancel, credential, health, metering, mapError, attempt_id
- resolve edge cases (17): RunPlan, capability, context boundary, adapter validation, health, policy, describeResolved, switchProvider, price sorting

#### ✔ P7: direct-strategy.test.ts (12 tests) — commit 350fdb0c
- runDirect 所有分支: preflight, stop_reason, budget, tool call rejection, system instruction

#### ✔ P8: harness-deep.test.ts (23 tests) — commit 6979cf9d
- constructor validation, withStreaming/withEventBus, getCacheMetrics, blank runId, concurrent guard, finalizeOverlay, dataDir persistence

#### ✔ P9: loop-deep.test.ts (51 tests) — commit 6979cf9d
- config validation (12), budget tracking (5), classifyUnhandled (5), usage validation (4), clock validation (3), context_reset (3), EventBus (4), plan mode (2), RAG injection (3), steering (3), stop/lifecycle (3), unknown strategy (1), signal abort (1), turn hooks (2)

#### ✔ P10: sqlite-session-store-deep (21+5 tests) — commit c0fd48f1 + 6e366db4
- schema 验证, 状态转换, 事件持久化, progress-store 边界

#### ✔ P11: tool-registry-mutation.test.ts (47 tests) — commit 4a2c6152
- error messages, search, snapshot, freeze

#### ✔ P12: equivalent-mutants.json 提交 — commit 6979cf9d + b3977e6c
- 20 个 waiver, commitSha 和 configurationHash 已更新

#### ✔ P13: configurationHash 验证
- 当前 hash: 2e02aab1022cac3c64b20c94300813b6dbd1d572b8bd8c9dae4f6d0749b52bd2
- 所有 20 waiver 匹配 ✓
- **重要**: waiver 的 commitSha 需要在每次代码 commit 后重绑 (保持 uncommitted, runner 允许)

---

### Step 1 剩余工作

#### □ 运行 Phase 1 mutation
- 命令: `node scripts/run-mutation.mjs phase1`
- 预期: 5-8 小时 (15 模块, gateway 一个就 43 chunks)
- **注意 #11**: chunk 默认超时 15 分钟 (不是 30 分钟)
- **注意 #12**: Stryker exit code 非 0 直接拒绝报告
- **注意 #13**: .stryker-tmp 可能占 5-10GB, 定期清理
- **注意 #14**: stryker patch 改变了 mutant 激活行为, 确认 patch 已应用
- **注意 #15**: 不要中途 kill (除非 crash)
- **注意 #16**: 用 sleep 1800 监控进度
- **注意 #26**: 本地 node v24, CI node v20, 行为可能不同
- **注意 #27**: 跑时加 --maxWorkers=1 和 CI 一致
- 如果有 surviving mutant:
  - 真覆盖缺口 → 补测试杀掉
  - 等价 mutant → 在 equivalent-mutants.json 注册 waiver (commitSha + configHash)
- **注意 #31**: 补测试文件不改 modules.mjs 是安全的 (configHash 不变)
  - 改 modules.mjs (如调 chunkTimeoutMs) → configHash 变 → 所有 waiver 失效 → 必须重绑

#### □ 运行 npm run test:mutation:check
- 独立验证 mutation 阈值
- **注意 #20**: 这步在 verify:phase1:local 里不包含, 需单独跑

#### □ 运行 verify:phase1:local
- 命令: `npm run verify:phase1:local`
- 包括: typecheck + cycles + build + lint + test + coverage + mutation:phase1
- **注意 #21**: 这是 7 个命令的完整 Phase 1 gate
- **注意 #27**: 加 --maxWorkers=1
- **注意 #28**: 检查 coverage threshold (lines 80%, branches 75%, functions 80%)

#### □ Phase 1 额外 exit criteria (注意 #22-25)
- **#22 GLM live acceptance**: `npm run test:glm:live` (需 GLM_API_KEY, verify:phase1:local 不包含)
- **#23 domain evals**: 确认 evals/{domain}/phase-1.yaml 是否存在 (可能不存在)
- **#24 active_stub_count**: `node scripts/gates/check-active-stubs.mjs` (verify:phase1:local 不包含)
- **#25 crash_restore_no_duplicate**: 确认 tests/session/crash-restore.test.ts 覆盖足够

#### □ 重新生成 39 个 Phase 1 evidence (注意 #29)
- artifacts/phase-1/ 下 39 个文件的 commit_sha 全部过期
- 需用新 HEAD 重新生成: evidence.json (commit_sha=新HEAD, tree_sha=新tree)
- 重新跑 GLM 5.2 xhigh 独立验证

---

## ═══ 补测试文件计划 (来自 MUTATION_REVIEW_PROMPT.md #1-6) ═══

### #1 gateway 10 个无测试文件
| 文件 | 源行数 | 测试内容 | 状态 |
|------|--------|---------|------|
| circuit-breaker.test.ts | 54 | CLOSED→OPEN(5次)→HALF_OPEN(60s)→CLOSED, probe失败回OPEN | 未开始 |
| rate-limiter.test.ts | 43 | rpm/tpm/concurrent 滑动窗口, 窗口过期, 拒绝超限 | 未开始 |
| key-vault.test.ts | 148 | AES-256-GCM, 环境变量加载, key rotation, 篡改报错 | 未开始 |
| capability-registry.test.ts | 224 | model binding, tier匹配, capability查询, pricing, estimateCost | 未开始 |
| economic-kernel.test.ts | 93 | budget创建, 扣费, 退款, 余额, 超预算拒绝, 多wallet | 未开始 |
| provider-adapters.test.ts | 309 | 已有 (P3 补了), 检查是否需加厚 | 已有 |
| cache-manager.test.ts | 125 | cache key, TTL, hit/miss, invalidation, LRU | 未开始 |
| tool-mask.test.ts | 177 | tool可见性, state-dependent masking, deny优先 | 未开始 |
| dag-executor.test.ts | 232 | 拓扑排序, 并行执行, 依赖等待, cycle检测, 失败传播 | 未开始 |
| glm-gateway-bridge.test.ts | 103 | GLM↔ModelGateway桥接, error映射, provider切换 | 未开始 |
优先: provider-adapters (加厚) 和 dag-executor (最大)

### #2 runtime 7+1 个无测试文件
| 文件 | 测试内容 | 状态 |
|------|---------|------|
| retry.ts | 重试分类逻辑 | 未开始 |
| steering-port.ts | steering queue | 未开始 (P1 删了旧测试) |
| errors.ts | 错误类型 | 未开始 |
| notifications.ts | 通知逻辑 | 未开始 |
| event-bus.ts | pub/sub | P9 部分覆盖 (EventBus deep) |
| pause-resume-port.ts | 暂停恢复 | 未开始 |
| session-tree-port.ts | 会话树 | 未开始 |
| loop.ts | P9 已覆盖 (51 tests) | ✓ |

### #3 session 3 个无测试文件
| 文件 | 测试内容 | 状态 |
|------|---------|------|
| durable-session.ts | 直接测试 | 未开始 |
| sqlite-session-store.ts | P10 已覆盖 (21 tests) | ✓ |
| progress-store.ts | P10b 部分覆盖 (5 tests) | 部分完成 |

### #4 strategies: direct.ts 和 react.ts
| 文件 | 测试内容 | 状态 |
|------|---------|------|
| direct.ts | P7 已覆盖 (12 tests) | ✓ |
| react.ts | 多轮 tool call, oscillation, max_iterations, budget | 未开始 |
| plan-execute.ts | 已有 (22 tests) | ✓ |

### #5 vfs/toolsRegistry/verification 加厚
| 模块 | 当前 score | 目标 | 缺口 |
|------|-----------|------|------|
| vfs | 88.2% | 90%+ | virtual-filesystem.ts, composite-backend.ts |
| session | 84.14% | 90%+ | durable-session.ts |
| toolsRegistry | 86.16% | 90%+ | tool-registry.ts, skill-registry.ts |
| verification | 84.2% | 90%+ | evidence.ts, eval-runner.ts, verification-engine.ts |

### #6 toolsLeaf 13 个文件 (60.9%)
- 读 reports/mutation/toolsLeaf/mutation.json 找 survived 集中文件
- 重点: local-tool-host.ts, create-artifact.ts, ask-user.ts

---

## ═══ Step 2: 补厚 55 个薄测试 ═══

### 状态: 未开始

### 执行方法 (对每个薄测试)
1. 从主仓库读 acceptance_criteria:
   ```
   python3 -c "import json; [print(json.dumps(r)) for r in [json.loads(l) for l in open('/Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/requirements/requirements.ndjson') if l.strip()] if r.get('delivery_phase')==2 and r['id']=='REQ_ID']"
   ```
2. 读对应源代码文件
3. 读现有薄测试文件
4. 用 mock provider 测真正功能路径:
   - provider port: 注入 mock, 测 generate/edit/verify/fetch
   - 解析器: 用真实二进制内容 (最小 PDF/DOCX/XLSX/PPTX bytes)
   - RAG: 测 add/remove/search/query/cite/rerank
   - UI: 测 renderScreen/navigate/state
   - 工具: 测 egress + 真实操作
5. 每条 acceptance_criteria 至少 1 个测试覆盖
6. 跑: `npx vitest run tests/phase-2/unit/ah-XXX-001.test.ts --reporter=verbose`
7. typecheck + lint 必须通过

### 55 个薄测试按 owner 分组
| Owner | 数量 | Requirement IDs |
|-------|------|-----------------|
| packages/documents | 13 | AH-DOC-INGEST-*, AH-DOC-PARSE-* |
| packages/multimodal | 9 | AH-MM-*, AH-TOOL-{IMAGE-GEN,SPEECH-GEN,TRANSCRIBE} |
| packages/rag | 11 | AH-RAG-* |
| packages/tools | 10 | AH-MCP-STDIO, AH-SANDBOX-OCI, AH-TOOL-* |
| apps/web | 8 | AH-UI-*, AH-UX-WEB |
| apps/api | 1 | AH-UX-API |
| apps/tui | 1 | AH-UI-TUI |
| apps/desktop | 1 | AH-UX-DESKTOP |
| packages/api | 1 | AH-UX-CONTRACT |
| packages/ui | 1 | AH-UX-STATES |

---

## ═══ Step 3: 同步 gate manifest — 已完成 ═══
- gate manifest byte-frozen, 未修改
- mutation registry candidate-only 机制已工作
- mutation authority 接受 registry sources

---

## ═══ Step 4: Phase 2 mutation — 已完成 (64/64) ═══
- candidate-only, 64/64 completed
- 剩余 blocker: evidence_incomplete(0/64) + external_attestation_required

---

## ═══ Step 5: Evidence 生成 ═══

### 状态: 未开始

### 执行方法 (注意 #38)
1. 读 scripts/gates/check-active-stubs.mjs 的 createPhase2EvidenceRecords
2. gate runner (verify-phase2-local.mjs) 在跑测试命令后自动调 createPhase2EvidenceRecords
3. evidence 存到 artifacts/phase-2/{requirement_id}/ 目录
4. 每个证据文件: requirement_id, commit_sha, tree_sha, 测试命令, stdout, exit_code, test_pass_count
5. 从实际 vitest 输出提取, 不可伪造
6. **RELEASE_AUTHORITY 机制 (#38)**:
   - CLI 运行传递 RELEASE_AUTHORITY Symbol (line 972)
   - 6 个前置条件全满足才发布: mode==="local" && hasReleaseAuthority && execution.ok && !identity.dirty && identityStable && errors.length===0
   - candidateReady 要求 candidateEvidenceCount === 64

---

## ═══ Step 6: Gate 闭环 + push ═══

### 状态: 未开始

### 执行步骤

#### G1-G4: 准备和推送
1. 确认所有新测试 typecheck + lint + test 全 pass
2. 确认 git status clean (equivalent-mutants.json 可 uncommitted)
3. 推送: `git push product codex/phase2-integrated` (agentharness91)

#### G5: CI
- **注意 #33**: reports/ 在 .gitignore 里, CI 必须自己跑 mutation
- **注意 #34**: ci.yml 不跑 mutation/verify/GLM, 只跑 typecheck/build/lint/test/coverage/audit/pack
- **注意 #35**: product 仓库 (agentharness91) 可能 private 无 runner
  - origin (agent-harness-v9.1) 是 public 有 runner
  - 需确认 agentharness91 是否 public, 或只推 origin
- **注意 #32**: push 前确认本地 HEAD 和 remote HEAD 差距清楚

#### G6: verify:phase2:local --mode local
- **注意 #37**: 跑 22 个命令, 预计 3-4 小时
  - 可能卡住: #10 phase1-regression (15min), #17 mutation (60min), #22 source-checkout-reproduction (60min)
  - #18 evaluations 和 #19 data 需要 --mode release, 可能需外部数据集
- **注意 #36**: releaseReady 硬编码 false, 目标是 candidateReady=true
  - formalAuthority.status 永远 "external_attestation_required"
  - 不要在本地死磕 releaseReady=true
  - candidateReady 要求: 22 命令全过 + evidence 64/64

### Remote 信息
- product = https://github.com/123oqwe/agentharness91.git (目标)
- origin = https://github.com/123oqwe/agent-harness-v9.1.git (public, 有 runner)
- release = https://github.com/123oqwe/agentharness91.git (同 product)

---

## ═══ MUTATION_REVIEW_PROMPT.md 审查注意事项完整索引 ═══

| # | 主题 | 状态 | 详情 |
|---|------|------|------|
| 1 | gateway 10 个无测试文件 | 未开始 | circuit-breaker, rate-limiter, key-vault, capability-registry, economic-kernel, cache-manager, tool-mask, dag-executor, glm-gateway-bridge |
| 2 | runtime 7+1 个无测试文件 | 部分完成 | P9 覆盖 loop.ts (51 tests), event-bus.ts 部分覆盖; 缺 retry, steering-port, errors, notifications, pause-resume-port, session-tree-port |
| 3 | session 3 个无测试文件 | 部分完成 | P10 覆盖 sqlite-session-store (21 tests), progress-store (5 tests); 缺 durable-session.ts |
| 4 | strategies 缺 direct.ts 和 react.ts | 部分完成 | P7 覆盖 direct.ts (12 tests); 缺 react.ts |
| 5 | vfs/toolsRegistry/verification 加厚 | 未开始 | 各模块 84-88%, 需到 90%+ |
| 6 | toolsLeaf 13 个文件 (60.9%) | 未开始 | 读 mutation.json 找 survived 集中文件 |
| 7 | server.test.ts 质量问题 | 未开始 | 真实端口→port:0, clock 断言太弱→mock验证 |
| 8 | 测试文件放置规则 | 已知 | tests/{module}/ 下, 不放 tests/phase-2/; vitest.mutation.config.ts 排除 coverage/glm-acceptance/phase-2 |
| 9 | 补完测试后 typecheck + lint | 执行中 | 每批测试后跑 npm run typecheck && npm run lint |
| 10 | 不要碰的东西 | 执行中 | 不改 gateway/ 源码, 不 kill stryker, 不改 modules.mjs (当前 run 进行中) |
| 11 | chunk 超时 15 分钟 | 已知 | defaultChunkTimeoutMs = 15 * 60 * 1000 |
| 12 | Stryker exit code 非 0 拒绝报告 | 已知 | run-mutation.mjs line 856 |
| 13 | .stryker-tmp 磁盘压力 | 已知 | 定期 rm -rf .stryker-tmp/2026-08-0* (保留最新) |
| 14 | stryker patch 改变 mutant 激活 | 已知 | patches/@stryker-mutator+core+9.6.1.patch, 确认已应用 |
| 15 | mutation 运行时间 5-8 小时 | 已知 | gateway 43 chunks, 每 chunk 3-5 分钟 |
| 16 | mutation 监控 | 已知 | sleep 1800, ps aux grep stryker, 检查 .stryker-tmp |
| 17 | mutation run 结束后做什么 | 待执行 | 读 result.json, 针对性补测试杀 surviving |
| 18 | waiver hash 机制 | 已理解 | normalizedAuthorityContent 过滤 commitSha + configurationHash; 改 modules.mjs 影响 configHash |
| 19 | chunkTimeoutMs 15 分钟 (非 30) | 已知 | 同 #11 |
| 20 | test:mutation:check 独立验证 | 待执行 | verify:phase1:local 不包含, 需单独跑 |
| 21 | verify:phase1:local 是 7 个命令 | 待执行 | typecheck+cycles+build+lint+test+coverage+mutation |
| 22 | GLM live acceptance 缺失 | 待执行 | npm run test:glm:live, 需 GLM_API_KEY |
| 23 | Phase 1 domain evals 不存在 | 待确认 | evals/{domain}/phase-1.yaml 可能不存在 |
| 24 | active_stub_count 检查 | 待执行 | node scripts/gates/check-active-stubs.mjs |
| 25 | crash_restore_no_duplicate | 待确认 | tests/session/crash-restore.test.ts 3 个测试是否足够 |
| 26 | node v24 vs CI v20 | 已知 | better-sqlite3, bcrypt native 模块差异 |
| 27 | CI --maxWorkers=1 | 待执行 | 本地也加 --maxWorkers=1 |
| 28 | coverage threshold | 待执行 | lines 80%, branches 75%, functions 80% |
| 29 | 39 个 Phase 1 evidence SHA 过期 | 待执行 | 重新生成所有 evidence |
| 30 | control/ 和 spec/requirements/ 不存在 | 已知 | 在主仓库, 非本分支; 需合并回主仓库 |
| 31 | equivalent-mutants.json 重绑 | 已完成 | commitSha 重绑到当前 HEAD, 保持 uncommitted (runner 允许) |
| 32 | 本地 HEAD 超前 remote | 已知 | push 前确认差距 |
| 33 | reports/ 在 .gitignore | 已知 | CI 必须自己跑 mutation |
| 34 | CI 不跑 mutation/verify/GLM | 已知 | 需手动触发 phase2-mutation.yml |
| 35 | product 仓库可能无 runner | 待确认 | agentharness91 是否 public? origin (public) 有 runner |
| 36 | releaseReady 硬编码 false | 已知 | 目标是 candidateReady=true, 不是 releaseReady |
| 37 | verify:phase2:local 22 命令 3-4 小时 | 待执行 | 详见 Step 6 G6 |
| 38 | Evidence 发布 RELEASE_AUTHORITY | 已理解 | CLI 传递 Symbol, 6 前置条件, candidateEvidenceCount===64 |

---

## ═══ 执行顺序 (来自 MUTATION_REVIEW_PROMPT.md 总结) ═══

1. 补测试文件 (#1-9), mutation 在后台跑
2. mutation 跑完后读结果, 针对性补测试杀 surviving mutant (#17)
3. commit 所有新测试 + 重绑 equivalent-mutants.json (#31)
4. 重跑 npm run test:mutation:phase1 确认 15/15 PASS
5. 跑 npm run test:mutation:check 独立验证 (#20)
6. 跑完整 verify:phase1:local (#21-28)
7. 重新生成 39 个 Phase 1 evidence (#29)
8. Phase 2 mutation + evidence + gate (#36-38)
9. 推送 + CI + verify:phase2:local
   - G6 目标 candidateReady=true (#36)
   - candidateReady 要求 22 命令全过 + evidence 64/64 (#38)
   - verify:phase2:local 要 3-4 小时 (#37)
   - CI 不跑 mutation, 需单独触发 (#34)
   - product 仓库可能没 runner (#35)
10. 更新 control/current-state.json, 需在主仓库做, 需 CTO 批准 (#30)

每步全绿才进下一步。不删测试、不降阈值、不加 skip、不伪造 evidence。

## Key Questions
1. Phase 1 mutation score 目标? 整体 >= 0.7; 每模块有不同阈值
2. 哪个 remote? product = agentharness91 (用户指定)
3. agentharness91 是 public 还是 private? 需确认 (影响 CI runner)
4. GLM_API_KEY 是否可用? 需确认 (#22)
5. control/ 和 spec/requirements/ 何时合并回主仓库? (#30)

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| P6 先于 P8/P9 | model-gateway 更独立 |
| P9 先于 P8 | loop.ts 更小更可测 |
| waiver 保持 uncommitted | runner 允许, 避免 commit 改 HEAD 的鸡蛋问题 |
| 使用 planning-with-files | 用户要求, 保留计划跨 compaction |
| 不改 modules.mjs | 避免 configHash 变化导致 waiver 失效 |
| dispatchStream events-yielded 测试改为验证同 provider 不重试 | 外层仍可 switch provider |
| EventBus 用 new EventBus() | createEventBus 不存在 |
| LoopError → malformed_response | classifyUnhandled 的行为 |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| ProviderHttpError(503) kind='server' not 'server_error' | 1 | 修正断言 |
| dispatchStream partial yield + retryable 仍 switch | 1 | 修正测试语义 |
| createEventBus() 不存在 | 1 | 用 new EventBus() |
| LoopError → malformed_response | 1 | 修正预期 |
| beforeTurn iteration=1 | 1 | 修正预期 |
| afterTurn 在 finally 不改变 termination | 1 | 修正测试 |
| nowMs=-1 构造时 throw | 1 | 用 expect(() => new...).toThrow() |
| step_transition 在 direct 不触发 | 1 | 改用 plan_execute |
| policy allowed_tools=[] reject | 1 | 改为 ['read_file'] |
| budget_tokens=undefined 与 exactOptionalPropertyTypes | 1 | 移除显式 undefined |
| RuntimeSteeringPriority 不含 'normal' | 1 | 改为 'user' |
| RuntimeBudgetDecision 需要 reason | 1 | 添加 reason 字段 |
| observedMessages unknown[] 无 find/some | 1 | 改为 any[][] |
| waiver commitSha 不匹配 HEAD | 1 | 重绑到当前 HEAD, 保持 uncommitted |

## Notes
- Worktree: /Users/guanjieqiao/agent-runtime-v7/worktrees/phase2-integrated
- Branch: codex/phase2-integrated, HEAD: b3977e6c
- 未提交: mutation/equivalent-mutants.json (waiver 重绑, runner 允许)
- 已提交: P6/P8/P9 测试文件 (commit 6979cf9d)
- P0-P13 是 Step 1 的子计划, 全部完成
- Step 3 (gate manifest sync) 和 Step 4 (Phase 2 mutation 64/64) 已完成
- 当前最紧迫: 跑 Phase 1 mutation + 补 gateway/runtime/session 无测试文件
