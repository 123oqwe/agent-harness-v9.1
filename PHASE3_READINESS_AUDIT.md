# Phase 3 Readiness Audit -- 完整交接文档

> 生成时间: 2026-08-08 01:10 Asia/Shanghai
> 工作目录: /Users/guanjieqiao/agent-runtime-v7/worktrees/phase2-integrated
> 分支: codex/phase2-integrated, HEAD: b3977e6c6f126aa27a3ae680346110b7bdf48440
> 目的: 为新 session 提供从当前状态到 Phase 3 的完整路线图

---

## 一、环境与仓库结构

### 1.1 工作目录

| 位置 | 分支 | 布局 | 角色 |
|------|------|------|------|
| worktrees/phase2-integrated/ | codex/phase2-integrated @ b3977e6c | 扁平 monorepo (packages/ + apps/ + 顶层模块) | 真正的工作分支 |
| agent-harness-v9.1/ (主仓库) | fix/all-52-problems | Phase 1 (harness/ 目录) | control/ 和 spec/ 的权威位置 |
| origin remote | https://github.com/123oqwe/agent-harness-v9.1.git (public) | - | 有 GitHub Actions runner |
| product remote | https://github.com/123oqwe/agentharness91.git (private) | - | 无 runner (私有仓库免费额度耗尽) |
| release remote | 同 product | - | 同 product |

### 1.2 Git 状态

分支: codex/phase2-integrated
HEAD: b3977e6c6f126aa27a3ae680346110b7bdf48440
未提交文件:
  M findings.md
  M mutation/equivalent-mutants.json
  M progress.md
  M task_plan.md

最近 5 个 commit:
  b3977e6c  fix: rebind equivalent-mutants.json waivers to current HEAD 6979cf9d
  6979cf9d  test: P6/P8/P9 deep mutation tests + P12 commit waivers
  5d1ec4b8  fix: replace streamEvents test with resolve to avoid Stryker crash
  7e550c2a  test: P5 ws-server deep message handling (15 tests)
  c0fd48f1  test: P10 sqlite-session-store deep tests (21 tests)

### 1.3 关键路径

- 源代码: packages/{runtime-core,documents,multimodal,tools,rag,api,ui}/src/ + apps/{api,web,tui,desktop}/src/ + 顶层 gateway/, runtime/, security/, tools/, router/, session/, vfs/, verification/
- 测试: tests/{gateway,runtime,session,tools,...}/ + tests/phase-2/{unit,integration,security,e2e,architecture}/
- Gate manifest: verification/gates/phase2-gate.json (byte-frozen, 64 requirements, 不可直接改)
- Mutation registry: mutation/phase2-modules.mjs (可改, 64 项 sources 映射)
- Mutation waivers: mutation/equivalent-mutants.json (20 个 waiver)
- Gate 脚本: scripts/gates/verify-phase2-local.mjs (主 gate runner)
- 需求规格: /Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/requirements/requirements.ndjson
- 阶段规格: /Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/phases/phase-{2,3}.yaml
- 控制状态: /Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/control/current-state.json (受保护路径)

---

## 二、所有计划文档清单 (共 12 份)

### 2.1 独立文档 (9 份)

| # | 文件 | 路径 | 行数 | 大小 | 层级 |
|---|------|------|------|------|------|
| 1 | pasted-text-1.txt | /Users/guanjieqiao/.codex/attachments/eb6f25e5-1083-4338-b611-b3016d1a887c/pasted-text-1.txt | 194 | 11KB | 战术层 |
| 2 | MUTATION_REVIEW_PROMPT.md | worktrees/phase2-integrated/ | 734 | 49KB | 战术层 |
| 3 | PHASE_FOUNDATION_REBUILD_PLAN.md | worktrees/phase2-integrated/ | 459 | 20KB | 战略层 |
| 4 | task_plan.md | worktrees/phase2-integrated/ | 398 | 21KB | 跟踪层 |
| 5 | findings.md | worktrees/phase2-integrated/ | 171 | 12KB | 跟踪层 |
| 6 | progress.md | worktrees/phase2-integrated/ | 107 | 5KB | 跟踪层 |
| 7 | PHASE2_PROGRESS_NOTES.md | worktrees/phase2-integrated/ | 642 | 34KB | 跟踪层 |
| 8 | PHASE2_MULTI_AGENT_SHARED.md | worktrees/phase2-integrated/ | 89 | 57KB | 跟踪层 |
| 9 | agent-harness-phase2-prompt.md | /Users/guanjieqiao/agent-harness-phase2-prompt.md | 642 | 25KB | 治理层 |

### 2.2 内联提示词 (3 份, 存在于 session 历史中, 无独立文件)

| # | 来源 | Session 文件 | 内容 |
|---|------|-------------|------|
| 10 | 用户消息 2 | 06/rollout-2026-08-06T22-18-22*.jsonl | 步骤 7-8 (推送 + CI + control/state 更新) |
| 11 | 用户消息 48 | 同上 | 完整 P0-P13 提示词, 含 16 步执行顺序 |
| 12 | 用户消息 50 | 同上 | 续接提示词, P2-FIX/P10/P5/P6/P8/P9/P12/P13 + 13 步执行顺序 |

### 2.3 各文档内容摘要

#### 文档 1: pasted-text-1.txt -- 原始 6 步计划

种子提示词, 启动了整个 harness session. 包含:
- 仓库结构说明 (扁平 monorepo vs 主仓库 harness/ 布局)
- 55 个薄测试按 owner 分组清单
- 步骤 1: Phase 1 地基验证 (npm run verify:phase1:local, mutation score >= 0.7)
- 步骤 2: 补厚 55 个薄测试 (每条 acceptance_criteria 至少 1 个测试)
- 步骤 3: 同步 gate manifest owned_sources (byte-frozen vs mutation registry)
- 步骤 4: Phase 2 mutation (64/64, Stryker, surviving mutant 处理)
- 步骤 5: Evidence 生成 (createPhase2EvidenceRecords, RELEASE_AUTHORITY token)
- 步骤 6: Gate 闭环 (verify:phase2:dev, success=true, candidateReady=true)
- 铁律: 不删测试, 不降阈值, 不加 skip, 不伪造 evidence/mutation

#### 文档 2: MUTATION_REVIEW_PROMPT.md -- 38 条审查提示词

最详细的战术文档. 38 个编号条目:

条目 1-6: 无测试文件清单
- 条目 1: gateway 10 个无测试文件 (circuit-breaker, rate-limiter, key-vault, capability-registry, economic-kernel, provider-adapters, cache-manager, tool-mask, dag-executor, glm-gateway-bridge)
- 条目 2: runtime 7+1 个无测试文件 (retry, steering-port, errors, notifications, event-bus, pause-resume-port, session-tree-port, loop.ts, harness.ts)
- 条目 3: session 3 个无测试文件 (durable-session, sqlite-session-store, progress-store)
- 条目 4: strategies 缺 direct.ts 和 react.ts 测试
- 条目 5: vfs/toolsRegistry/verification 覆盖率不够
- 条目 6: toolsLeaf 13 个文件有测试但 60.9%

条目 7-10: 质量和规则
- 条目 7: server.test.ts 硬编码端口 (18099/18098/18097), 应改 port:0
- 条目 8: 测试文件放置规则 (vitest.mutation.config.ts 排除 tests/phase-2/, tests/coverage/, tests/glm-acceptance/)
- 条目 9: 每批测试加完后必须 typecheck + lint
- 条目 10: 不要碰 gateway/ 源码, 不要 kill stryker, 不要改 modules.mjs

条目 11-17: mutation 运行机制
- 条目 11: chunk 默认超时 15 分钟 (不是 30 分钟)
- 条目 12: Stryker exit code 非 0 直接拒绝接受报告
- 条目 13: .stryker-tmp 磁盘压力 (5-10GB)
- 条目 14: stryker patch 改变了 mutant 激活行为
- 条目 15: mutation 运行时间预期 (5-8 小时)
- 条目 16: mutation 运行监控方法
- 条目 17: 当前 mutation run 结束后要做什么

条目 18-28: Phase 1 gate 和环境问题
- 条目 18: 7 个 PASS 模块可能因新测试回归
- 条目 19: 每个模块的 minimum 阈值不同
- 条目 20: test:mutation:check 独立验证
- 条目 21: verify:phase1:local 缺少 5 个必需检查 (GLM 验证, domain evals, mutation:check, active-stubs, crash_restore)
- 条目 22: GLM live acceptance 缺失
- 条目 23: Phase 1 domain evals 文件不存在
- 条目 24: active_stub_count 检查
- 条目 25: crash_restore_no_duplicate
- 条目 26: 本地 node v24 vs CI node v20
- 条目 27: CI 用 --maxWorkers=1
- 条目 28: coverage threshold 可能因新测试下降

条目 29-38: evidence, CI, gate 机制
- 条目 29: 39 个 Phase 1 evidence 文件 SHA 过期
- 条目 30: control/ 和 spec/requirements/ 在 phase2-integrated 分支不存在
- 条目 31: equivalent-mutants.json 未提交且需要重绑
- 条目 32: 本地 HEAD 超前 remote
- 条目 33: reports/ 在 .gitignore 里
- 条目 34: CI 不跑 mutation/verify/GLM
- 条目 35: product 仓库 CI 无 runner
- 条目 36: releaseReady 硬编码 false, 目标是 candidateReady=true
- 条目 37: verify:phase2:local --mode local 跑 22 个命令 (3-4 小时)
- 条目 38: Evidence 发布机制 (RELEASE_AUTHORITY Symbol, 6 个前置条件)

#### 文档 3: PHASE_FOUNDATION_REBUILD_PLAN.md -- 6 阶段战略计划

第一部分: 诊断结果
- d412384 (CI 全绿基线) vs 6e7623a (当前) 的 26 个 commit 偏离分析
- 3 个 SOTA 引入的回归: workspace-boundaries, static-router schema, tool-definitions 幂等性

第二部分: 关键决策 -- Fix Forward (推荐) vs Reset

第三部分: 6 个阶段
- 阶段 0: 稳定基线 (修 3 个 SOTA 回归)
- 阶段 1: Phase 1 地基验证 (全量回归 + mutation >= 0.7)
- 阶段 2: Phase 2 架构与边界验证
- 阶段 3: Phase 2 Mutation 全量 (64/64)
- 阶段 4: Phase 2 Evidence + Gate 闭环
- 阶段 5: CI 绿 + Phase 3 入口检查

每个阶段有: 诊断命令, 修复提示词, 验证命令, 决策点 (继续/停留)

#### 文档 4: task_plan.md -- planning-with-files 跟踪文档

原始 6 步计划跟踪:
- Step 1 (Phase 1 地基验证): 进行中 (P0-P13 子计划)
- Step 2 (补厚 55 个薄测试): 未开始
- Step 3 (同步 gate manifest): 已完成
- Step 4 (Phase 2 mutation 64/64): 已完成 (candidate-only)
- Step 5 (Evidence 生成): 未开始
- Step 6 (Gate 闭环 + push): 未开始

P0-P13 子计划跟踪:
- P0-P5, P7, P10, P11: 已提交
- P6, P8, P9: 已提交 (commit 6979cf9d)
- P12: 标记已提交但实际未提交 (矛盾)
- P13: 已验证

G1-G6 gate 执行步骤:
- G1: 提交未提交文件
- G2: 运行 Phase 1 mutation
- G3: typecheck + lint
- G4: 跑完整 verify:phase1:local
- G5: CI
- G6: verify:phase2:local --mode local

#### 文档 9: agent-harness-phase2-prompt.md -- 治理框架

- 权威来源 (7 项, 按优先级)
- 受保护路径 (spec/contracts, spec/state-machines, spec/requirements, spec/phases, control, evidence, AI_EXECUTION_PROTOCOL.md, NORMATIVE_PRECEDENCE.md)
- 8 条禁止红线
- candidate-only 规则

---

## 三、完成状态总览

### 3.1 P0-P13 Mutation 深度测试子计划

| P项 | 目标文件 | 测试文件 | 测试数 | Commit | 状态 |
|-----|----------|----------|--------|--------|------|
| P0 | scripts/run-mutation.mjs | (修改 runPhase1->runOne) | N/A | 350fdb0c | 已提交 |
| P1 | tests/runtime/steering-port.test.ts | (删除) | N/A | 350fdb0c | 已提交 |
| P2 | gateway/managed-gateway.ts | tests/gateway/managed-gateway-deep.test.ts | 22 | 3d5b878c+26390bc9 | 已提交 |
| P3 | gateway/provider-adapters.ts | tests/gateway/provider-adapters.test.ts | 37 | 0901a47f | 已提交 |
| P4 | gateway/async-task-adapter.ts | tests/gateway/async-task-adapter-deep.test.ts | 24 | 1f53cbec | 已提交 |
| P5 | gateway/ws-server.ts | tests/gateway/ws-server-deep.test.ts | 15 | 7e550c2a | 已提交 |
| P6 | gateway/model-gateway.ts | tests/gateway/model-gateway-deep.test.ts | 47 | 6979cf9d | 已提交 |
| P7 | runtime/direct.ts | tests/runtime/direct-strategy.test.ts | 12 | 350fdb0c | 已提交 |
| P8 | harness.ts | tests/runtime/harness-deep.test.ts | 23 | 6979cf9d | 已提交 |
| P9 | runtime/loop.ts | tests/runtime/loop-deep.test.ts | 51 | 6979cf9d | 已提交 |
| P10 | session/sqlite-session-store.ts | tests/session/sqlite-store-deep.test.ts | 21 | c0fd48f1 | 已提交 |
| P10b | session/progress-store.ts | tests/session/progress-store.test.ts | 12 | 6e366db4 | 已提交 |
| P11 | tools/tool-registry.ts | tests/tools/tool-registry-mutation.test.ts | 47 | 4a2c6152 | 已提交 |
| P12 | mutation/equivalent-mutants.json | (20 waivers 重绑) | N/A | b3977e6c | 未提交 |
| P13 | (验证 configurationHash) | N/A | N/A | N/A | 已验证 |

P12 问题: equivalent-mutants.json 的 waiver 重绑 (commitSha 6979cf9d -> b3977e6c) 只存在于工作区. git status 显示 M mutation/equivalent-mutants.json. committed 版本的 waiver 仍指向 6979cf9d.

### 3.2 原始 6 步计划状态

| 步骤 | 描述 | 状态 |
|------|------|------|
| Step 1 | Phase 1 地基验证 (mutation >= 0.7) | P0-P13 测试写完已提交, 但 mutation 还没用新测试跑过 |
| Step 2 | 补厚 55 个薄测试 | 完全未开始 |
| Step 3 | 同步 gate manifest owned_sources | 已完成 (通过 mutation registry candidate-only 机制) |
| Step 4 | Phase 2 mutation 64/64 | 已完成 (candidate-only) |
| Step 5 | Evidence 生成 | 完全未开始 (artifacts/phase-2/ 为空, 0/64) |
| Step 6 | Gate 闭环 + push | 完全未开始 |
| Step 7 | 推送 + CI | 完全未开始 |
| Step 8 | 更新 control/current-state.json | 完全未开始 (受保护路径, 需 CTO 批准) |

### 3.3 PHASE_FOUNDATION_REBUILD_PLAN 6 阶段状态

| 阶段 | 描述 | 状态 |
|------|------|------|
| 阶段 0 | 修 3 个 SOTA 回归 | 已完成 (workspace-boundaries, static-router, tool-definitions, b0-release-structure 全过) |
| 阶段 1 | Phase 1 全量回归 + mutation | 部分完成 (测试写了, mutation 没跑) |
| 阶段 2 | Phase 2 架构检查 | 已完成 (workspaces, manifest, contract-drift, active-stubs 全过) |
| 阶段 3 | Phase 2 mutation 64/64 | 已完成 (candidate-only) |
| 阶段 4 | Phase 2 evidence + gate | 未开始 |
| 阶段 5 | CI 绿 + Phase 3 入口检查 | 未开始 |

### 3.4 control/current-state.json 实际状态

Phase 1: IN_PROGRESS (maturity: implemented: 40)
Phase 2: BLOCKED (blocker: "Phase 1 not passed", maturity: not_started: 64)
Phase 3: BLOCKED (blocker: "Phase 2 not passed", maturity: not_started: 16)

### 3.5 GLM 5.2 xhigh 验证状态

已完成 52 个源文件的代码审查 (evidence/ 目录下 9 个 JSON 文件).
所有 critical/high 发现已修复.
但这是源代码审查, 不是 spec 要求的场景验收测试.

spec phase-2.yaml 要求: "After the local gate passes, a read-only GLM-5.2 xhigh run evaluates long-context, RAG, multimodal, UX, privacy, and failure-recovery scenarios."

### 3.6 测试统计

- 测试文件总数: 298
- 测试总数: ~11,293
- Phase 1 evidence 文件: 39 个 (但 SHA 过期, 指向旧 commit)
- Phase 2 evidence 文件: 0 个
- Phase 3 测试目录: 不存在
- Phase 3 requirements: 16 个 (全部 not_started)

---

## 四、阻挡进入 Phase 3 的所有条件 (共 12 项)

### 阻挡 1: P12 waiver 未提交

- 问题: mutation/equivalent-mutants.json 的 waiver 重绑只在工作区
- 影响: checkout 后 waiver 不生效, mutation gate 会报 SHA mismatch
- 修复: git add mutation/equivalent-mutants.json && git commit

### 阻挡 2: Phase 1 mutation 未用新测试跑过

- 问题: P6/P8/P9 等 121 个新测试已提交但 mutation 没重跑
- 影响: mutation score 仍是旧数据, 不知道是否 >= 0.7
- 修复: node scripts/run-mutation.mjs phase1 (预计 5-8 小时)
- 验证: 所有 15 个模块 mutation score >= 阈值

### 阻挡 3: verify:phase1:local 从未通过

- 问题: 完整的 Phase 1 门禁从未用新测试跑过
- 影响: Phase 1 地基未验证
- 修复: npm run verify:phase1:local (typecheck + cycles + build + lint + test + coverage + mutation)
- 注意: 审查提示词第 21 条指出 verify:phase1:local 缺少 5 个必需检查 (GLM, domain evals, mutation:check, active-stubs, crash_restore), 这些需要额外手动验证

### 阻挡 4: 步骤 2 -- 补厚 55 个薄测试

- 问题: 55 个 Phase 2 薄测试 (8-104 行) 未按 acceptance_criteria 补厚
- 影响: Phase 2 requirement 覆盖不足
- 修复: 对每个薄测试读 acceptance_criteria, 用 mock provider 测真实功能路径
- 分布: documents(13), multimodal(9), rag(11), tools(10), web(8), api(1), tui(1), desktop(1), api-contract(1), ui-states(1)

### 阻挡 5: 步骤 5 -- Phase 2 Evidence 生成 (0/64)

- 问题: artifacts/phase-2/ 为空
- 影响: gate 要求 candidateEvidenceCount === 64
- 修复: 跑 verify:phase2:local --mode local, gate runner 自动生成 evidence (22 个命令全过后)
- 前置条件: 所有 22 个命令必须通过

### 阻挡 6: Phase 2 独立 GLM-5.2 xhigh 场景验收

- 问题: 当前 GLM 验证是源代码审查, 不是场景验收
- 影响: 不满足 phase-2.yaml exit_criteria 的 independent_glm_5_2_xhigh: PASS
- 修复: 在 gate 通过后跑 GLM-5.2 xhigh 场景验收 (long-context, RAG, multimodal, UX, privacy, failure-recovery)

### 阻挡 7: Phase 2 gate 从未通过

- 问题: verify:phase2:local --mode local 从未跑过
- 影响: Phase 2 退出条件未满足
- 修复: node scripts/gates/verify-phase2-local.mjs --mode local (22 个命令, 3-4 小时)
- 22 个命令: manifest, workspace-boundaries, assets, contract-drift, active-stubs, typecheck, cycles, build, lint, phase1-regression, coverage, workspace-coverage, phase2-unit, phase2-integration, phase2-security, phase2-e2e, mutation, evaluations, data, package-smoke, workspace-smoke, source-checkout-reproduction, production-audit

### 阻挡 8: CI 未绿

- 问题: 代码未 push, CI 未跑
- 影响: gate 需要 CI exact-SHA attestation (formalAuthority)
- 修复: git push origin codex/phase2-integrated, 等 CI 绿
- 注意: product 仓库 (agentharness91) 是 private 无 runner, 推到 origin (public)

### 阻挡 9: 39 个 Phase 1 evidence 文件 SHA 过期

- 问题: 所有 Phase 1 evidence 的 commit_sha 指向旧 commit
- 影响: gate 会报 evidence SHA mismatch
- 修复: 用新 HEAD 重新生成 39 个 evidence 文件

### 阻挡 10: control/current-state.json 未更新

- 问题: Phase 1 仍是 IN_PROGRESS, Phase 2 仍是 BLOCKED
- 影响: Phase 3 入口条件 "Previous phase gate passed" 未满足
- 修复:
  - Phase 1 status -> VERIFIED, maturity: {verified: 40}
  - Phase 2 status -> VERIFIED, maturity: {verified: 64}
  - Phase 3 status -> IN_PROGRESS
- 注意: 受保护路径, 需 CTO 批准

### 阻挡 11: server.test.ts 硬编码端口

- 问题: 仍使用 port 18099/18098/18097
- 影响: CI 上端口冲突会导致 flaky test
- 修复: 改为 port: 0 (系统分配空闲端口)

### 阻挡 12: Phase 3 的 16 个 requirement 完全未实现

- 问题: tests/phase-3/ 目录不存在, 16 个 requirement 全部 not_started
- 影响: 即使 Phase 2 gate 通过, Phase 3 也没有任何代码可执行
- Phase 3 的 16 个 requirement:
  - AH-ROUTER-DAG-001, AH-ROUTER-DAG-FAILURE-001, AH-ROUTER-EVAL-001
  - AH-ROUTER-FALLBACK-11-001, AH-ROUTER-BUDGET-DYNAMIC-001
  - AH-ROUTER-CONTEXT-TOPOLOGY-001, AH-ROUTER-SKILL-CHAIN-001
  - AH-MULTIAGENT-DAG-001, AH-MULTIAGENT-MERGE-001
  - AH-SUBAGENT-001, AH-AGENT-AUTHORING-001
  - AH-TOOL-BROWSER-001, AH-TOOL-COMPUTER-001
  - AH-TOOL-VIDEO-GEN-001, AH-TOOL-VIDEO-EDIT-001, AH-TOOL-MUSIC-GEN-001

---

## 五、文档缺陷 (10 项, 来自 4 轮审计)

| # | 缺陷 | 影响 |
|---|------|------|
| 1 | P10 文件名不匹配: 文档写 sqlite-session-store-deep.test.ts, 实际是 sqlite-store-deep.test.ts | 混淆 |
| 2 | P12 状态矛盾: task_plan 说已提交, findings 说未提交, git status 确认未提交 | 误导 |
| 3 | findings.md HEAD 过期 (5d1ec4b8 vs 实际 b3977e6c) | 过时信息 |
| 4 | server.test.ts 硬编码端口未修复 | CI flaky 风险 |
| 5 | task_plan 未引用 PHASE_FOUNDATION_REBUILD_PLAN.md | 战略层缺失 |
| 6 | task_plan 未引用 agent-harness-phase2-prompt.md | 治理层缺失 |
| 7 | task_plan 未引用 pasted-text-1.txt | 源头缺失 |
| 8 | 审查提示词第 18, 21 条在 task_plan 中无跟踪 | 风险未跟踪 |
| 9 | 第 22, 23 条 (GLM live acceptance, domain evals) 跟踪不足 | 退出条件未跟踪 |
| 10 | task_plan.md 本身未提交 | 跟踪状态可能丢失 |

---

## 六、执行路线图 (从当前状态到 Phase 3)

### 阶段 A: 收尾 Phase 1 mutation 地基 (预计 1 天)

1. 提交 P12 waiver (git add mutation/equivalent-mutants.json && git commit)
2. 修复 server.test.ts 硬编码端口 (改 port:0)
3. typecheck + lint 确认通过
4. 运行 node scripts/run-mutation.mjs phase1 (5-8 小时)
5. 检查所有模块 mutation score >= 阈值
6. 运行 npm run verify:phase1:local
7. 补充 verify:phase1:local 缺的 5 个检查 (GLM, domain evals, mutation:check, active-stubs, crash_restore)
8. 重新生成 39 个 Phase 1 evidence (用新 HEAD)

### 阶段 B: 补厚 55 个薄测试 (预计 2-3 天)

1. 对每个薄测试: 读 acceptance_criteria -> 读源代码 -> 用 mock provider 测真实功能
2. 每条 acceptance_criteria 至少 1 个测试覆盖
3. typecheck + lint
4. 跑 Phase 2 全量测试确认 0 failed

### 阶段 C: Phase 2 Gate 闭环 (预计 1-2 天)

1. 运行 node scripts/gates/verify-phase2-local.mjs --mode dev
2. 确认 candidateReady=true
3. push 到 origin: git push origin codex/phase2-integrated
4. 等 CI 绿
5. CI 绿后运行 node scripts/gates/verify-phase2-local.mjs --mode local (3-4 小时, 22 命令)
6. 确认 success=true, candidateReady=true, evidence 64/64

### 阶段 D: GLM-5.2 xhigh 场景验收 (预计 1 天)

1. 在 gate 通过后跑 GLM-5.2 xhigh 场景验收
2. 覆盖 long-context, RAG, multimodal, UX, privacy, failure-recovery
3. 确认 PASS

### 阶段 E: 更新控制状态 (需 CTO 批准)

1. 在主仓库 agent-harness-v9.1 更新 control/current-state.json:
   - Phase 1 -> VERIFIED, maturity: {verified: 40}
   - Phase 2 -> VERIFIED, maturity: {verified: 64}
   - Phase 3 -> IN_PROGRESS
2. 这是受保护路径, 需要人工确认

### 阶段 F: Phase 3 实现 (预计数周)

1. 创建 tests/phase-3/ 目录结构
2. 实现 16 个 Phase 3 requirement
3. 写测试覆盖每个 requirement
4. 跑 Phase 3 gate

---

## 七、铁律 (贯穿所有阶段)

1. 不删测试, 不降阈值, 不加 skip
2. 不伪造 evidence/mutation 结果
3. 每个修复必须对应一个具体失败
4. 不改动 byte-frozen 的 gate manifest (verification/gates/phase2-gate.json)
5. 不改动 spec/, control/, evidence/ 受保护路径 (需要 CTO 批准)
6. 步骤未全绿不进入下一步
7. candidate-only: 本地结果不冒充 VERIFIED
8. 不在本地死磕 releaseReady=true (需要 CI attestation)
