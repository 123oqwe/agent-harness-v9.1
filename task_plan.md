# Task Plan: agent-harness Phase 2 (verified state as of 2026-08-08)

## Goal
完成 Phase 1 mutation 地基 → 补厚 55 个薄测试 → Phase 2 mutation → Evidence → Gate 闭环 → push agentharness91

## Next Step
等待 Phase 1 mutation 运行完成 (session 7968, gateway chunk 4/43)，读结果，针对性补测试

## Current Phase
阶段 B: Phase 1 Mutation 运行中 (gateway module, chunk 4/43)

## 参考文档
- pasted-text-1.txt: 原始 6 步计划 + 铁律
- MUTATION_REVIEW_PROMPT.md: 38 条审查提示词
- HARNESS_SESSION_DIRECTIVE.md: 43 个错误修正 + 阶段 A-G 路线图
- PHASE2_PROGRESS_NOTES.md: 完成工作/剩余工作台账
- PHASE2_MULTI_AGENT_SHARED.md: 跨 session 台账
- spec 文件在主仓库: /Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/

## ═══ 已验证的当前状态 ═══

### Git 状态
- Worktree: /Users/guanjieqiao/agent-runtime-v7/worktrees/phase2-integrated
- Branch: codex/phase2-integrated
- HEAD: 75020cfa (动态获取: git rev-parse HEAD)
- Remote agentharness91: 2b5d5dba (本地超前 1 commit: server.test.ts fix)
- 未提交: mutation/equivalent-mutants.json (waiver 重绑, runner 允许)
- Remote: product = https://github.com/123oqwe/agentharness91.git (PRIVATE, 无 runner)
- Remote: origin = https://github.com/123oqwe/agent-harness-v9.1.git (PUBLIC, 有 runner)

### P0-P13 状态 (全部完成, 已验证)
| P项 | 文件 | 测试数 | Commit | 已验证 |
|-----|------|--------|--------|--------|
| P0 | scripts/run-mutation.mjs | N/A | 350fdb0c | ✓ runOne() |
| P1 | tests/runtime/steering-port.test.ts (deleted) | N/A | 350fdb0c | ✓ deleted |
| P2+FIX | tests/gateway/managed-gateway-deep.test.ts | 22 | 3d5b878c+26390bc9 | ✓ 22 tests |
| P3 | tests/gateway/provider-adapters.test.ts | 37 (29+8) | 0901a47f | ✓ 37 tests |
| P4 | tests/gateway/async-task-adapter-deep.test.ts | 24 | 1f53cbec | ✓ 24 tests |
| P5 | tests/gateway/ws-server-deep.test.ts | 15 | 7e550c2a | ✓ 15 tests |
| P6 | tests/gateway/model-gateway-deep.test.ts | 47 | 6979cf9d | ✓ 47 tests |
| P7 | tests/runtime/direct-strategy.test.ts | 12 | 350fdb0c | ✓ 12 tests |
| P8 | tests/runtime/harness-deep.test.ts | 23 | 6979cf9d | ✓ 23 tests |
| P9 | tests/runtime/loop-deep.test.ts | 51 | 6979cf9d | ✓ 51 tests |
| P10 | tests/session/sqlite-store-deep.test.ts | 21 | c0fd48f1 | ✓ 21 tests |
| P10b | tests/session/progress-store.test.ts | 12 | be78628d+6e366db4 | ✓ 12 tests |
| P11 | tests/tools/tool-registry-mutation.test.ts | 47 | 4a2c6152 | ✓ 47 tests |
| P12 | mutation/equivalent-mutants.json | 20 waivers | 6979cf9d | ✓ uncommitted (runner allows) |
| P13 | configurationHash 验证 | N/A | N/A | ✓ 2e02aab1 matches |

### gateway 10 个测试文件 (全部已存在, commit 55853d3d)
| 文件 | 测试数 | 已验证 |
|------|--------|--------|
| circuit-breaker.test.ts | 11 | ✓ |
| rate-limiter.test.ts | 9 | ✓ |
| key-vault.test.ts | 17 | ✓ |
| capability-registry.test.ts | 17 | ✓ |
| economic-kernel.test.ts | 13 | ✓ |
| cache-manager.test.ts | 13 | ✓ |
| tool-mask.test.ts | 18 | ✓ |
| dag-executor.test.ts | 8 | ✓ |
| glm-gateway-bridge.test.ts | 6 | ✓ |
| provider-adapters.test.ts | 37 | ✓ (P3 加厚) |

### runtime 6 个测试文件 (全部已存在, commit 9fef88f7/a9317164)
| 文件 | 测试数 | 已验证 |
|------|--------|--------|
| retry.test.ts | 26 | ✓ |
| errors.test.ts | 6 | ✓ |
| notifications.test.ts | 15 | ✓ |
| event-bus.test.ts | 12 | ✓ |
| pause-resume-port.test.ts | 8 | ✓ |
| session-tree-port.test.ts | 6 | ✓ |

### session 2 个测试文件 (全部已存在)
| 文件 | 测试数 | 已验证 |
|------|--------|--------|
| durable-session.test.ts | 27 | ✓ (be78628d) |
| progress-store.test.ts | 12 | ✓ (be78628d+6e366db4) |

### strategies 3 个测试文件 (全部已存在)
| 文件 | 测试数 | 已验证 |
|------|--------|--------|
| direct-strategy.test.ts | 12 | ✓ (P7) |
| react-strategy.test.ts | 14 | ✓ |
| react-loop.test.ts | 29 | ✓ |

### Phase 1 Mutation B1 旧结果 (HEAD c0fd48f1, 已过期)
PASS (10/15): actionControl 91.50%, identitySecrets 90.78%, router 90.19%, sandbox 91.00%, skills 91.44%, strategies 85.80% (waivers), vfs 92.13%, verification 86.62%, verticals 88.48%, uiAdapters 95.77%, toolsLeaf 90.29%
FAIL (5/15): gateway 55.23%, runtime 65.57%, session 84.14%, toolsRegistry 86.16%
注: P6/P8/P9 的 121 个新测试不在 B1 结果中, 需 B2 重跑

### 阈值 (mutation/thresholds.json + modules.mjs)
85%: gateway, toolsLeaf, skills, strategies, verification, verticals, uiAdapters
90%: router, toolsRegistry, actionControl, identitySecrets, vfs, sandbox, session, runtime
phase1Minimum = 85 (整体)
chunkTimeoutMs: gateway=30min, sandbox=30min, default=15min

### 质量验证
- typecheck: ✓ PASS
- lint: ✓ PASS
- 全部测试: 2763/2764 pass (1 pre-existing timeout in managed-gateway-stream.test.ts)
- 3 个新测试文件: 121/121 pass

### Waiver 机制
- configurationHash: 2e02aab1022cac3c64b20c94300813b6dbd1d572b8bd8c9dae4f6d0749b52bd2
- commitSha: 需与当前 HEAD 匹配 (每次 commit 后重绑, 保持 uncommitted)
- runner 允许 equivalent-mutants.json uncommitted (repositoryContext line 793-795)
- 改 modules.mjs 会变 configurationHash → 所有 waiver 失效 → 必须重绑

## ═══ 阶段 A-G 执行路线图 ═══

### 阶段 A: 快速收尾 ✓ (已完成)
- [x] A1: Waiver 重绑到当前 HEAD, 保持 uncommitted
- [x] A2: server.test.ts port:0 修复 (commit 75020cfa)
- [x] A3: task_plan.md 修正 (本文档)
- [x] A4: typecheck + lint PASS

### 阶段 B: Phase 1 Mutation (进行中)
- [ ] B0: 清理 .stryker-tmp (已清理旧目录)
- [ ] B1: 运行 Phase 1 mutation (session 7968, gateway chunk 4/43, 5-8h)
  - 注意: gateway chunkTimeoutMs=30min, default=15min
  - 注意: Stryker exit code 非 0 拒绝报告
  - 注意: 本地 node v24, CI node v20
- [ ] B2: 检查结果, 15/15 PASS
  - 如果不达标: 补测试杀 surviving 或注册 waiver
- [ ] B3: npm run test:mutation:check (独立验证)
- [ ] B4: npm run verify:phase1:local (--maxWorkers=1)
  - 注意: 跑全部测试 (Phase 1 + Phase 2)
  - 注意: managed-gateway-stream.test.ts 有 1 个 pre-existing timeout
- [ ] B5: 补充 5 个 Phase 1 exit_criteria
  - B5a: npm run test:glm:live (GLM_API_KEY=e93c1f129cc44ce8908f3f6fa328c00b.hz4tGVIGo3Y8AQni)
  - B5b: domain evals (phase-1.yaml 不存在, 需创建或标 N/A)
  - B5c: crash_restore_no_duplicate (3 tests, 确认覆盖)
  - B5d: active_stub_count=0 (check-active-stubs.mjs)
  - B5e: mutation:check (已在 B3)
- [ ] B6: 安全指标 (sandbox_violation=0, unauthorized_effect=0, capability_replay=0)
- [ ] B7: 重新生成 40 个 Phase 1 evidence (39 stale + 1 missing AH-GATEWAY-TESTPROVIDER-001)

### 阶段 C: Phase 2 薄测试补厚 (未开始)
- 52 个薄测试 (tests/phase-2/unit/ah-*.test.ts, 33-116 行)
- 从主仓库读 acceptance_criteria, mock provider, 真实二进制内容
- 每条 acceptance_criteria 至少 1 个测试覆盖

### 阶段 D: Phase 2 Gate 闭环 (未开始)
- D1: git status clean
- D2: verify:phase2:dev (5 命令)
- D3: git push -u origin codex/phase2-integrated (public, 有 runner)
  - 注意: product (agentharness91) 是 PRIVATE 无 runner
- D4: verify:phase2:local --mode local (23 命令, 3-4h)
  - releaseReady 硬编码 false, 目标 candidateReady=true
  - candidateReady 要求 candidateEvidenceCount === 64
- D5: 确认 Phase 2 exit_criteria

### 阶段 E: Phase 2 GLM 场景验收 (未开始)
- 已有 52 个源文件 GLM 源码审查 (evidence/ 下 9 个 JSON)
- 需补充 6 个场景验收: long-context, RAG, multimodal, UX, privacy, failure-recovery

### 阶段 F: 更新控制状态 (需 CTO 批准)
- 在主仓库 agent-harness-v9.1 更新 control/current-state.json
- 确认 B0.5 受保护 patch 是否已批准

### 阶段 G: Phase 3 实现 (数周, 需单独计划)
- 16 个 requirement, 全部 not_started
- 建立在 router/static-router.ts 基础上
- multi_agent capability 在 Phase 3 启用
- 5 个工具 requirement 需要外部服务

## 铁律
1. 不删测试, 不降阈值, 不加 skip
2. 不伪造 evidence/mutation 结果
3. 每个修复必须对应一个具体失败
4. 不改动 byte-frozen gate manifest
5. 不改动 spec/, control/, evidence/ 受保护路径 (需 CTO 批准)
6. 步骤未全绿不进入下一步
7. candidate-only: 本地结果不冒充 VERIFIED
8. 不在本地死磕 releaseReady=true (需 CI attestation)
9. 不写填充测试 (只检查 toBeDefined 或 module importable)
10. Waiver 保持 uncommitted (runner 允许)

## Errors Encountered
| Error | Resolution |
|-------|------------|
| waiver commitSha mismatch | 重绑到 HEAD, 保持 uncommitted |
| ProviderHttpError(503) kind='server' | 修正断言 |
| createEventBus() 不存在 | 用 new EventBus() |
| LoopError → malformed_response | 修正预期 |
| beforeTurn iteration=1 | 修正预期 |
| server.test.ts hardcoded ports | port:0 |

## Key Questions
1. agentharness91 是 PRIVATE 无 runner — 推到 origin (public) 或改 agentharness91 为 public?
2. GLM_API_KEY: e93c1f129cc44ce8908f3f6fa328c00b.hz4tGVIGo3Y8AQni (可用)
3. Phase 1 domain evals 不存在 — 创建或标 N/A?
4. gate_command factory/phase-gates/gate_runner.py 不存在 — verify:phase1:local 是替代品?
5. B0.5 受保护 patch 是否已批准?
6. 40 个 Phase 1 requirement, 只有 39 个 evidence (缺 AH-GATEWAY-TESTPROVIDER-001)
