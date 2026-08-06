# Phase Foundation Rebuild Plan
## 从 Phase 1 地基 → Phase 2 → 直入 Phase 3

> 生成时间：基于 `codex/phase2-integrated` @ `6e7623a` 的实际诊断结果
> 工作目录：`/Users/guanjieqiao/agent-runtime-v7/worktrees/phase2-integrated`

---

## 第一部分：实际诊断结果（Ground Truth）

### 仓库与分支现状

| 位置 | 分支 | 布局 | 角色 |
|------|------|------|------|
| `agent-harness-v9.1/` (主仓库) | `fix/all-52-problems` @ `d600c84` | Phase 1 (`harness/` 目录) | 当前 checkout，52 问题修复笔记 |
| `worktrees/phase2-integrated/` | `codex/phase2-integrated` @ `6e7623a` | Phase 2 扁平 monorepo (`packages/` + `apps/` + 顶层模块) | **真正的工作分支** |
| `product/release` remote | `agentharness91` (私有) | Phase 1 `main` + Phase 2 `codex/phase2-integrated` | 发布仓库 |

### 在 `6e7623a` 上实际跑出的结果

| 检查项 | 结果 | 详情 |
|--------|------|------|
| `npm run typecheck` | ✅ PASS | 13/13 turbo 任务通过 |
| `check:phase2:manifest` | ✅ valid | `phase2-gate.json` 有效 |
| Phase 2 unit (`tests/phase-2/unit`) | ⚠️ 611/612 pass | 1 失败：`b0-release-structure.test.ts`（快照不匹配） |
| Phase 1 unit (gateway/runtime/router/...) | ❌ 1678/1736 pass | **58 失败**，集中在 `static-router.test.ts`(RunPlan schema) + `tool-definitions.test.ts`(edit_file 幂等性) |
| `check:workspaces` | ❌ FAIL | `packages/runtime-core/src/event-bus.ts` 违反 identity-only scaffold 约束 |
| Mutation (gate 报告) | ❌ 0/64 completed | registry 已映射 64 项，但无运行结果 |
| `verify:phase2:dev` | ❌ FAIL | blockers: workspace-boundaries + external_attestation + mutation 0/64 + evidence 0/64 |

### 关键发现：`d412384` vs `6e7623a` 的偏离

台账 `PHASE2_MULTI_AGENT_SHARED.md` 记录的最后一次 CI 全绿状态是 `d412384`（16/16 步骤，3150 测试，mutation 64/64 candidate，GLM 52 文件 0 high/critical）。

**但 `6e7623a` 在 `d412384` 之后又多了 26 个提交**（+9107/-663 行，186 文件），包括：

```
d3028a2  evidence: Phase 1 closure - 39/39 requirements verified     ← Phase 1 闭环证据（重要！）
2045892  feat(gateway): unified managed-platform gateway             ← 破坏 workspace 边界
6cbeb9c  feat(gateway): streaming dispatch + prompt cache + WS
bf895f0  feat(gateway): tool-masking state machine + DAG executor
825b9bb  feat: SOTA harness improvements — 10 items                  ← 引入 event-bus.ts 等违规
6e7623a  fix: P1-09 rate_limited + expose ModelGateway accessor
```

这 26 个提交**带来了 Phase 1 闭环证据和新功能**，但同时也**破坏了**：
1. workspace-boundaries（`event-bus.ts` 在 `d412384` 不存在，`6e7623a` 新增 → 违反 scaffold 约束）
2. `static-router.test.ts`（RunPlan schema 验证，58 个失败）
3. `tool-definitions.test.ts`（edit_file 幂等性回归）
4. mutation 覆盖（从 64/64 candidate 退回 0/64，因为新代码未跑 mutation）

### 各 Phase 规划要求（来自 spec/phases/*.yaml）

**Phase 1**（40 reqs，IN_PROGRESS）：
- 退出条件：6 个垂直域 evals 全通过、security 违规=0、active_stub_count=0、**mutation_score ≥ 0.7**、crash_restore 无重复、GLM-5.2 xhigh PASS
- 门禁命令：`npm run verify:phase1:local`（= typecheck + cycles + build + lint + test + coverage + mutation:phase1）

**Phase 2**（64 reqs，BLOCKED）：
- 退出条件：所有 reqs verified、regression 通过、active_stub_count=0、GLM-5.2 xhigh PASS
- 门禁命令：`npm run verify:phase2:local`

**Phase 3**（16 reqs，BLOCKED）入口条件：
- Phase 2 gate 通过
- 退出条件：hard_constraint_violation=0、routing_regret≤15%、unnecessary_multi_agent≤20%、context_isolation、capability_attenuation、merge_conflict 无硬编码规则、GLM xhigh

---

## 第二部分：关键决策 — Reset 还是 Fix Forward？

### 方案 A：Reset 到 `d412384`（干净地基，丢弃新工作）
- ✅ CI 全绿基线、无边界违规、mutation 64/64 candidate
- ❌ **丢失 Phase 1 闭环证据**（`d3028a2`: 39/39 reqs verified）——这是 Phase 1 门禁必需的
- ❌ 丢失 SOTA gateway 改进和新工具（apply-patch/screenshot/undo）
- ❌ 需要重做 26 个提交的工作

### 方案 B：Fix Forward 从 `6e7623a`（保留全部工作，修复回归）✅ 推荐
- ✅ 保留 Phase 1 闭环证据（39/39）——地基已铺好
- ✅ 保留 SOTA 改进和新工具
- ✅ 失败是**可定位、可修复的**（3 个具体问题）
- 需要修：(1) event-bus.ts 边界违规 (2) static-router schema 回归 (3) tool-definitions 幂等性回归

**推荐方案 B**，因为 Phase 1 闭环证据（39/39 reqs verified + GLM）是打地基阶段最耗时的成果，不应丢弃。3 个回归都是 SOTA 提交引入的具体问题，可以精准修复。

---

## 第三部分：分阶段执行计划

每个阶段包含：**目标 → 诊断命令 → 修复提示词 → 验证命令 → 决策点（继续/停留）**

所有命令在 `worktrees/phase2-integrated/` 下执行。

---

### 阶段 0：稳定基线（修复 SOTA 引入的 3 个回归）

**目标**：让 `6e7623a` 回到全绿状态（typecheck + 全测试 + workspace-boundaries 通过），作为向上推进的干净地基。

**诊断命令**：
```bash
cd /Users/guanjieqiao/agent-runtime-v7/worktrees/phase2-integrated

# 1. 确认 3 个回归的精确位置
npx vitest run tests/phase-2/unit/b0-release-structure.test.ts 2>&1 | tail -40
npx vitest run tests/router/static-router.test.ts 2>&1 | tail -40
npx vitest run tests/tools/tool-definitions.test.ts 2>&1 | tail -40
node scripts/check-workspace-boundaries.mjs 2>&1
```

**修复提示词**（喂给 agent）：
```
你正在 worktrees/phase2-integrated（codex/phase2-integrated 分支）工作。
当前 HEAD 6e7623a 有 3 个由 SOTA 提交引入的回归，需要精准修复，不要改动无关代码：

1. workspace-boundaries 违规：packages/runtime-core/src/event-bus.ts 被判定为
   "identity-only scaffold violation: extra source lacks structured requirement binding"。
   runtime-core 是 Phase 1 authority workspace，必须是 identity-only scaffold。
   方案：将 event-bus.ts 移到正确的 Phase 2 workspace（如 packages/runtime-core 只保留
   有 requirement binding 的 Batch1 源：session-tree/hook/steering/budget/pause-resume/
   compaction/model-fallback/context-compiler），或者给 event-bus 绑定一个 Phase 2 requirement。
   先读 scripts/check-workspace-boundaries.mjs 理解判定逻辑，再决定移动还是绑定。

2. static-router.test.ts 58 个失败：RunPlan schema 验证失败（plan_execute errors:
   'must be object' 等）。对比 d412384 和 6e7623a 的 router/static-router.ts 差异：
   git diff d412384..6e7623a -- router/static-router.ts
   找出哪个 SOTA 提交改坏了 RunPlan 结构，回滚那个具体改动（不要回滚整个提交）。

3. tool-definitions.test.ts edit_file 幂等性回归：
   git diff d412384..6e7623a -- tools/tool-definitions.ts tools/tool-executor.ts
   找出 idempotent_write → non_idempotent_write 的改动是否被覆盖。

修复后运行验证命令，全绿才提交。不要删测试、不要降阈值、不要加 skip。
```

**验证命令**：
```bash
npm run typecheck && \
node scripts/check-workspace-boundaries.mjs && \
npx vitest run tests/router/static-router.test.ts tests/tools/tool-definitions.test.ts tests/phase-2/unit/b0-release-structure.test.ts && \
npx vitest run tests/phase-2/unit --reporter=dot 2>&1 | tail -5
```

**决策点**：
- ✅ 全绿 → 提交（`fix: repair SOTA regressions - workspace boundary + router schema + tool idempotency`）→ 进入阶段 1
- ❌ 仍有失败 → 停留，逐个修复直到全绿

---

### 阶段 1：Phase 1 地基验证（全量回归 + mutation）

**目标**：确认 Phase 1 的 40 个 requirement 地基完全稳固，mutation score ≥ 0.7，为 Phase 2 解锁。

**诊断命令**：
```bash
# Phase 1 全量测试（gateway/runtime/router/policy/security/capability/vfs/session/tools/evidence）
npx vitest run tests/gateway tests/runtime tests/router tests/policy tests/security tests/capability tests/vfs tests/session tests/tools tests/evidence --reporter=dot 2>&1 | tail -10

# Phase 1 闭环证据检查
git log --oneline | grep "Phase 1 closure"   # 应看到 d3028a2
ls evidence/                                   # 检查证据文件
```

**修复提示词**：
```
Phase 1 地基验证。在 worktrees/phase2-integrated 上：

1. 跑 Phase 1 全量单元测试（tests/gateway tests/runtime tests/router tests/policy
   tests/security tests/capability tests/vfs tests/session tests/tools tests/evidence）。
   所有失败必须修复到 0 failed。

2. 确认 Phase 1 闭环证据存在（commit d3028a2 "Phase 1 closure - 39/39 requirements
   verified"）。检查 evidence/ 目录下是否有对应的 39 项验证证据文件。
   如果证据文件缺失或指向旧 SHA，需要重新生成。

3. 跑 Phase 1 mutation：
   npm run test:mutation:phase1
   这会用 Stryker 对 gateway/security/runtime/router/vfs/session/tools/verification
   做 mutation testing。目标 score >= 0.7。
   如果有 surviving mutant，逐一检查：是真覆盖缺口就补测试，是等价 mutant 就在
   mutation/equivalent-mutants.json 注册 waiver（绑定当前 commit SHA）。

4. 跑 check:cycles 确认无生产代码 import cycle。

不要删测试、不要降阈值、不要加 skip。每个修复都要对应一个具体的失败原因。
```

**验证命令**（= Phase 1 门禁的本地版）：
```bash
npm run verify:phase1:local
# 等价于：typecheck + check:cycles + build + lint + test + coverage + mutation:phase1
```

**决策点**：
- ✅ `verify:phase1:local` 全绿 + mutation ≥ 0.7 → 提交证据 → 进入阶段 2
- ❌ mutation < 0.7 → 停留，补测试杀 surviving mutant
- ❌ 有测试失败 → 停留，修复后重跑

---

### 阶段 2：Phase 2 架构与边界验证

**目标**：确认 Phase 2 的扁平 monorepo 架构稳固——workspace 边界、contract drift、manifest、active stubs 全部通过。

**诊断命令**：
```bash
# Phase 2 架构检查套件
npm run check:workspaces          # workspace 边界
npm run check:phase2:manifest     # gate manifest 有效性
npm run check:phase2:contract-drift  # contract 漂移
npm run check:phase2:active-stubs    # 活跃 stub 计数

# Phase 2 全量测试
npx vitest run tests/phase-2/unit --reporter=dot 2>&1 | tail -5
npx vitest run tests/phase-2/integration --reporter=dot 2>&1 | tail -5
npx vitest run tests/phase-2/security --reporter=dot 2>&1 | tail -5
npx vitest run tests/phase-2/e2e --reporter=dot 2>&1 | tail -5
npx vitest run tests/phase-2/architecture --reporter=dot 2>&1 | tail -5
```

**修复提示词**：
```
Phase 2 架构验证。在 worktrees/phase2-integrated 上：

1. 跑全部 Phase 2 检查脚本，记录每个的 pass/fail：
   - check:workspaces（workspace 边界：runtime-core 必须 identity-only scaffold）
   - check:phase2:manifest（phase2-gate.json 有效）
   - check:phase2:contract-drift（contract 无漂移，releaseReady 应为 true）
   - check:phase2:active-stubs（active stub 计数，Phase 2 exit_criteria 要求 =0）

2. 跑 Phase 2 全量测试（unit + integration + security + e2e + architecture）。
   目标：0 failed。如果 check:phase2:active-stubs 报 stub 缺失，逐一为缺失的
   requirement 创建可导入性验证测试（参考已有的 tests/phase-2/unit/ah-*.test.ts 模式）。

3. 如果 check:phase2:contract-drift 报 releaseReady=false，读脚本输出找出具体哪个
   contract 漂移了，对齐 contracts/generated/*.ts 与 spec/contracts/*.schema.json。

每个修复对应一个具体的 check 失败。不要改受保护路径（spec/、control/、evidence/
需要 CTO 批准）。
```

**验证命令**：
```bash
npm run check:workspaces && \
npm run check:phase2:manifest && \
npm run check:phase2:contract-drift && \
npx vitest run tests/phase-2/ --reporter=dot 2>&1 | tail -5
```

**决策点**：
- ✅ 全部 check pass + Phase 2 测试 0 failed → 进入阶段 3
- ❌ active-stubs > 0 → 停留，补测试
- ❌ contract-drift releaseReady=false → 停留，对齐 contract

---

### 阶段 3：Phase 2 Mutation 全量（64/64）

**目标**：对全部 64 个 Phase 2 requirement 跑 mutation，达到 gate 要求的覆盖率，杀掉 surviving mutant。

**诊断命令**：
```bash
# 查看 mutation registry 状态
head -60 mutation/phase2-modules.mjs   # 64 项 requirement → source 映射

# 查看当前 mutation 配置文件
ls vitest.mutation*.config.ts stryker.config.json

# 跑 Phase 2 mutation launcher（dry-run 先看规划）
node scripts/run-phase2-mutation-launcher.mjs phase2 --dry-run 2>&1 | head -40
```

**修复提示词**：
```
Phase 2 mutation 全量执行。在 worktrees/phase2-integrated 上：

1. 读 mutation/phase2-modules.mjs，确认 64 项 requirement 都有 sources 映射。
   如果有 status="not_started" 的，先确认其 source 文件存在。

2. 跑 Phase 2 mutation launcher：
   npm run test:mutation:phase2
   这会对 64 项的 owned sources 逐一做 Stryker mutation testing。
   预期耗时较长（每项 30s-5min）。

3. 收集结果：哪些 completed、哪些 failed、surviving mutant 数量。
   对每个 surviving mutant：
   - 读 mutation report（reports/mutation/phase2-diagnostic/...）
   - 如果是真覆盖缺口 → 补测试杀掉它
   - 如果是等价 mutant → 在 mutation/equivalent-mutants.json 注册 waiver（绑定 commit SHA + config hash）

4. 目标：mutation completed = 64/64，gate 报告 mutation.ready = true。

不要伪造 mutation 结果。每个 completed 项必须有真实的 Stryker report。
```

**验证命令**：
```bash
npm run test:mutation:phase2 2>&1 | tail -20
# 然后跑 gate 看 mutation 状态
node scripts/gates/verify-phase2-local.mjs --mode dev 2>&1 | grep -A5 '"mutation"'
```

**决策点**：
- ✅ mutation 64/64 + ready=true → 进入阶段 4
- ❌ 有 failed 项 → 停留，检查是超时还是真失败，逐项处理
- ❌ surviving mutant 过多 → 停留，补测试或注册等价 waiver

---

### 阶段 4：Phase 2 Evidence + Gate 闭环

**目标**：生成 evidence pipeline（64/64），跑通 `verify:phase2:dev`，达成 Phase 2 退出条件。

**诊断命令**：
```bash
# 当前 gate 状态（看剩余 blocker）
node scripts/gates/verify-phase2-local.mjs --mode dev 2>&1 | head -30

# Evidence 目录
ls evidence/ | head -20
```

**修复提示词**：
```
Phase 2 evidence + gate 闭环。在 worktrees/phase2-integrated 上：

1. 跑 verify:phase2:dev，记录所有 blocker。预期剩余：
   - evidence_incomplete (0/64)
   - external_attestation_required
   - assets_release_blocked（如果阶段 2 已修则消除）

2. Evidence pipeline（0 → 64）：
   读 scripts/gates/check-phase2-assets.mjs 理解 evidence 要求。
   为每个 Phase 2 requirement 生成 evidence 文件（从实际测试命令输出提取，
   不可伪造）。evidence 必须包含：requirement ID、测试命令、stdout/stderr、
   exit code、commit SHA、tree SHA。
   存放到 evidence/ 目录。

3. external_attestation_required：
   这是 gate 要求 GitHub Actions exact-SHA attestation（formal authority）。
   本地 dev 模式无法满足——需要推到 origin 让 CI 跑。
   确认 .github/workflows/ci.yml 和 phase2-mutation.yml 配置正确，
   推送后在 CI 绿的情况下 CI 的 attestation 满足 formal authority。

4. 目标：verify:phase2:dev 的 success=true, candidateReady=true。
   releaseReady 可能仍因 external attestation 需要 CI 而为 false——这是正常的，
   推送让 CI 跑完即可。
```

**验证命令**：
```bash
node scripts/gates/verify-phase2-local.mjs --mode dev 2>&1 | head -10
# 检查 success / candidateReady / releaseReady 字段
```

**决策点**：
- ✅ candidateReady=true → 推送到 origin，让 CI 跑 → 进入阶段 5
- ❌ evidence 仍 0/64 → 停留，逐项生成
- ❌ 有其他 blocker → 停留，读 gate report 的 blockers 数组逐个解决

---

### 阶段 5：CI 绿 + Phase 3 入口检查

**目标**：推送让 CI 全绿，确认 Phase 2 退出条件满足，检查 Phase 3 入口条件。

**推送流程**（按用户的推送规范）：
```bash
# 在 codex/phase2-integrated 上开发完成后
git push origin codex/phase2-integrated
git push product codex/phase2-integrated

# CI 绿后，Phase 2 gate 通过后，merge 到 product/main（agentharness91）
# 注意：product/main 是 Phase 1 布局（harness/ 目录），phase2-integrated 是扁平 monorepo
# 结构完全不同 → 需要 force-merge 或 rebase：
git checkout -b phase2-release product/main
git rebase --onto product/main codex/phase2-integrated~1 codex/phase2-integrated
# 或直接 force-merge（如果 product/main 准备好被 Phase 2 布局替换）
```

**Phase 3 入口检查提示词**：
```
Phase 3 入口条件检查。在 worktrees/phase2-integrated 上：

1. 确认 Phase 2 退出条件全部满足（spec/phases/phase-2.yaml exit_criteria）：
   - all_phase_requirements_verified: true（64/64）
   - regression_tests_pass: true
   - active_stub_count: 0
   - independent_glm_5_2_xhigh: PASS

2. 确认 Phase 3 入口条件（spec/phases/phase-3.yaml entry_criteria）：
   - Previous phase gate passed（Phase 2 verify:phase2:local success=true）
   - All dependencies verified
   - No open P0 blockers

3. 读 Phase 3 的 16 个 requirement（spec/phases/phase-3.yaml requirements），
   确认它们的依赖（Phase 1 + Phase 2 的 requirement）都已 verified：
   - AH-ROUTER-DAG-001 依赖 Phase 1 的 AH-ROUTER-FOUNDATION-001
   - AH-MULTIAGENT-DAG-001 依赖 Phase 1 的 AH-RUNTIME-LOOP-001
   - AH-SUBAGENT-001 依赖 Phase 2 的 AH-RUNTIME-SESSIONTREE-001
   等等。读 spec/requirements/requirements.ndjson 确认依赖链。

4. 如果全部满足 → 更新 control/current-state.json（需要 CTO 批准，因为是受保护路径）
   将 phase 2 设为 VERIFIED，phase 3 设为 IN_PROGRESS。
   如果不满足 → 列出具体缺口，停留在 Phase 2。
```

**验证命令**：
```bash
# Phase 3 依赖检查
node scripts/gates/verify-phase2-local.mjs --mode local 2>&1 | head -10  # success=true?
# 检查 Phase 3 的 16 个 requirement 依赖
python3 spec/scripts/check-requirement-coverage.py 2>&1 | tail -10
```

**决策点**：
- ✅ Phase 2 gate success=true + Phase 3 依赖全 verified → **直入 Phase 3** 🎯
- ❌ Phase 2 gate 未通过 → 停留，回到对应阶段修复
- ❌ Phase 3 依赖有缺口 → 停留，补齐依赖

---

## 第四部分：执行顺序总结

```
阶段 0  修 3 个 SOTA 回归（workspace + router + tool）→ 验证：全测试绿
  ↓
阶段 1  Phase 1 全量回归 + mutation ≥ 0.7 → 验证：verify:phase1:local 绿
  ↓
阶段 2  Phase 2 架构检查（边界 + contract + stubs）→ 验证：全部 check pass
  ↓
阶段 3  Phase 2 mutation 64/64 → 验证：mutation.ready=true
  ↓
阶段 4  Phase 2 evidence 64/64 + gate → 验证：verify:phase2:dev candidateReady=true
  ↓
阶段 5  推送 CI 绿 + Phase 3 入口检查 → 验证：Phase 2 gate success → 直入 Phase 3
```

**每个阶段的铁律**：
- 不删测试、不降阈值、不加 skip
- 不改受保护路径（spec/、control/、evidence/）无 CTO 批准
- 不伪造 evidence / mutation 结果
- 每个修复必须对应一个具体失败
- 阶段未全绿不进入下一阶段（"打地基"原则）

---

## 第五部分：当前可立即执行的第一步

阶段 0 的 3 个回归是最紧急的。在 `worktrees/phase2-integrated` 上执行：

```bash
cd /Users/guanjieqiao/agent-runtime-v7/worktrees/phase2-integrated

# 看清 3 个回归的精确差异
git diff d412384..6e7623a -- router/static-router.ts tools/tool-definitions.ts tools/tool-executor.ts
git show 6e7623a:packages/runtime-core/src/event-bus.ts | head -20
node scripts/check-workspace-boundaries.mjs 2>&1
```

然后用阶段 0 的修复提示词开始。
