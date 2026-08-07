在 /Users/guanjieqiao/agent-runtime-v7/worktrees/phase2-integrated 工作。
分支 codex/phase2-integrated。HEAD b3977e6c。所有文件路径用绝对路径。

你是世界级 harness 工程师。以下是完整指令, 分三部分:
  第一部分: task_plan.md 的 43 个错误及修正
  第二部分: 修正后的完整执行路线图 (阶段 A-G, 从当前状态到 Phase 3)
  第三部分: 参考文档清单和铁律

每步全绿才进下一步。不删测试, 不降阈值, 不加 skip, 不伪造 evidence/mutation。
不要写只检查 toBeDefined 或 module importable 的填充测试。

══════════════════════════════════════════════════════════════
第一部分: task_plan.md 的 43 个错误及修正
══════════════════════════════════════════════════════════════

task_plan.md 是从 compacted session memory 重写的, 没有验证实际文件系统。
以下 43 个错误必须全部修正。修正方法: 对每个声称用 git log/find/rg 验证实际状态,
然后更新 task_plan.md。

─── A 类: 已完成的工作被标记为未完成 (10 个, 最严重, 会导致重复劳动) ───

A1. #1 gateway 10 个无测试文件标"未开始"
实际: 全部已存在 (commit 55853d3d)。验证:
  for f in circuit-breaker rate-limiter key-vault capability-registry economic-kernel cache-manager tool-mask dag-executor glm-gateway-bridge; do
    echo "$f: $(rg -c '\b(it|test)\(' tests/gateway/${f}.test.ts) tests"
  done
修正: 全部标记已完成, 记录测试数:
  circuit-breaker(11), rate-limiter(9), key-vault(17), capability-registry(17),
  economic-kernel(13), cache-manager(13), tool-mask(18), dag-executor(8),
  glm-gateway-bridge(6)。provider-adapters 已有 (P3 补过)。

A2. #2 runtime 5 个文件标"未开始"
实际: 全部已存在 (commit 9fef88f7/a9317164)。
  retry(26), errors(6), notifications(15), pause-resume-port(8), session-tree-port(6)
修正: 全部标记已完成。

A3. #2 event-bus 标"P9 部分覆盖"
实际: tests/runtime/event-bus.test.ts 已存在 (12 tests, commit 55853d3d)。
修正: 标记已完成。

A4. #3 durable-session 标"未开始"
实际: tests/session/durable-session.test.ts 已存在 (27 tests, commit be78628d)。
修正: 标记已完成。

A5. #3 progress-store 标"5 tests"
实际: 12 tests (be78628d 创建 7 + 6e366db4 加 5)。
修正: 更新为 12 tests, 已完成。

A6. #4 react.ts 标"未开始"
实际: react-strategy.test.ts (14 tests) + react-loop.test.ts (29 tests) 已存在。
修正: 标记已完成。

A7. #4 plan-execute 标"22 tests"
实际: 39 tests (validation 17 + mutation 22)。
修正: 更新为 39 tests。

A8. P3 provider-adapters 写"+8 tests"
实际: 37 tests (29 pre-existing from 55853d3d + 8 added by 0901a47f)。
修正: P3 改为 "37 tests (29 pre-existing + 8 added)"。

A9. P10 文件名不匹配
task_plan 写 "sqlite-session-store-deep.test.ts"
实际文件是 tests/session/sqlite-store-deep.test.ts (commit c0fd48f1)。
修正: P10 文件名改为 sqlite-store-deep.test.ts。

A10. P10 行写 "21+5 tests"
实际: sqlite-store-deep 21 + progress-store 12 = 33。
修正: P10 改为 "21+12 tests"。

─── B 类: 索引表内容错误 (9 个) ───

B1. 索引 #18 内容是 #31 的内容 (waiver hash 机制)
原文 #18 是 "7 个 PASS 模块可能回归"。验证:
  sed -n '/^18\./,/^[0-9]*\./p' MUTATION_REVIEW_PROMPT.md | head -20
修正: #18 改为 "7 个 PASS 模块可能回归 | 风险 | B1 重跑时 15 模块全跑,
  7 个 PASS 的可能因新测试引入 import cycle 或 typecheck 错误从 PASS 变 FAIL"

B2. 索引 #19 内容是 #11 的重复 (chunkTimeoutMs)
原文 #19 是 "每个模块的 minimum 阈值不同"。
修正: #19 改为 "per-module 阈值不同 | 已知 | 见 mutation/thresholds.json:
  85%: gateway, toolsLeaf, skills, strategies, verification, verticals, uiAdapters
  90%: router, toolsRegistry, actionControl, identitySecrets, vfs, sandbox, session, runtime"

B3. per-module 阈值未在 Key Questions 里记录具体值
验证: cat mutation/thresholds.json
修正: Key Questions "每模块有不同阈值" 改为上面的 85%/90% 具体列表。

B4. #11 写 defaultChunkTimeoutMs = 15 * 60 * 1000, 未提 gateway 是 30min
实际: rg 'chunkTimeoutMs' mutation/modules.mjs 显示 gateway 和 sandbox 都是 30min。
修正: #11 加注 "default 15min, gateway 和 sandbox 设了 30min"。

B5. #19 写 "chunkTimeoutMs 15 分钟 (非 30)"
实际: gateway 就是 30 分钟。
修正: 删除这条或改为 "gateway chunkTimeoutMs=30min, default=15min"。

B6. #21 写 "verify:phase1:local 是 7 个命令"
原文 #21 核心是 "缺少 5 个必需检查"。
修正: #21 改为 "verify:phase1:local 缺少 5 个必需检查 | 阻塞 |
  链是 typecheck+cycles+build+lint+test+coverage+mutation, 但 Phase 1 exit_criteria
  还要求: (a) GLM xhigh PASS (b) 6 个 domain evals (c) crash_restore (d)
  active_stub_count=0 (e) mutation:check 独立验证"

B7. #23 标 "待确认"
实际: 已确认 phase-1 domain evals 不存在。验证: find evals/ -path "*phase-1*"
修正: #23 改为 "Phase 1 domain evals 不存在 | 阻塞 | evals/ 下只有 phase-2.yaml,
  phase-1 的 6 个 vertical evals 文件不存在, domain_evals_all_pass 无法满足"

B8. #35 标 "待确认"
实际: agentharness91 是 PRIVATE (gh repo view 123oqwe/agentharness91 --json visibility 确认)。
修正: #35 改为 "product 仓库 (agentharness91) 是 PRIVATE | 阻塞 | 无 runner,
  CI 2 秒就 FAIL。必须推到 origin (agent-harness-v9.1, public) 或把 agentharness91 改为 public"

B9. #7 server.test.ts 未标为 blocker
验证: rg '18099|18098|18097' tests/gateway/server.test.ts
修正: 在执行顺序里把 #7 列为必须修复的 blocker (阶段 A2)。

─── C 类: Phase 1 退出条件未跟踪 (7 个) ───

C1. 6 个 vertical tasks 完全未提及
phase-1.yaml exit_criteria 要求 6 个垂直域 evals 全通过:
  coding, documents, research, writing, planning, personal_assistant
验证: cat /Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/phases/phase-1.yaml
修正: Step 1 剩余工作加 "Phase 1 vertical evals (6 域): evals/ 下没有 phase-1.yaml,
  6 个 vertical evals 文件不存在, domain_evals_all_pass 无法满足, 需创建或标 N/A"

C2. 安全指标完全未提及
phase-1.yaml exit_criteria 要求:
  sandbox_violation=0, unauthorized_effect=0, capability_replay=0
修正: Step 1 剩余工作加 "安全指标: 确认 sandbox_violation=0, unauthorized_effect=0,
  capability_replay=0"

C3. spec gate_command 未提及且不存在
phase-1.yaml gate_command 是 python3 factory/phase-gates/gate_runner.py phase1
验证: ls factory/phase-gates/gate_runner.py (两个仓库都不存在)
修正: Key Questions 加 "gate_command factory/phase-gates/gate_runner.py 不存在,
  verify:phase1:local (npm script) 是替代品还是部分实现?"

C4. 40 个 Phase 1 requirements 但只有 39 个 evidence
缺失: AH-GATEWAY-TESTPROVIDER-001。验证:
  python3 -c "import json; reqs=[json.loads(l)['id'] for l in open('/Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/requirements/requirements.ndjson') if l.strip() and json.loads(l).get('delivery_phase')==1]; print(len(reqs))"
  ls artifacts/phase-1/ | wc -l
修正: Step 1 剩余工作加 "Phase 1 evidence 缺失: AH-GATEWAY-TESTPROVIDER-001 没有
  evidence 目录, 40 个 requirement 只有 39 个 evidence"

C5. Phase 2 GLM 场景验收未跟踪
phase-2.yaml 要求 gate 通过后跑 GLM-5.2 xhigh 场景验收
(long-context, RAG, multimodal, UX, privacy, failure-recovery)
当前做的是 52 个源文件的代码审查, 不是场景验收。
修正: 新增阶段 E (见第二部分)。

C6. Phase 2 exit_criteria 未明确列出
phase-2.yaml exit_criteria:
  - all_phase_requirements_verified: true
  - regression_tests_pass: true
  - active_stub_count: 0
  - independent_glm_5_2_xhigh: PASS
修正: D5 加 "确认 Phase 2 exit_criteria 全部满足" (见第二部分 D5)。

C7. B0.5 protected patch approval 未提及
PHASE2_MULTI_AGENT_SHARED.md 反复提到 B0.5 受保护 patch 待批准。
修正: Key Questions 加 "B0.5 受保护 patch (phase2-spec-sync) 是否已批准?
  如果未批准, control/ 和 spec/requirements/ 的字段级落库无法进行"

─── D 类: 矛盾和过时数据 (9 个) ───

D1. P12 标 "已提交", git status 显示未提交
验证: git status --short mutation/equivalent-mutants.json
修正: P12 改为 "未提交 - 工作区有 waiver 重绑 (6979cf9d->b3977e6c), 需要提交"
注意: 提交后需重绑 (见 D2)。

D2. waiver 鸡蛋问题 (#31) 未解释
A1 提交 P12 waiver 后 HEAD 变化, waiver commitSha 立即过期。
正确流程: commit 代码 -> 重绑 waiver 到新 HEAD -> 保持 uncommitted -> 跑 mutation
runner 允许 equivalent-mutants.json uncommitted (repositoryContext line 793-795 过滤该文件)。
修正: 在 P12 修正里加注:
  "提交后必须重绑: 用新 HEAD 的 SHA 更新所有 20 个 waiver 的 commitSha 字段,
   然后保持 uncommitted。不要 commit 重绑后的版本。"

D3. #5/#6 mutation scores 过时
计划写 vfs 88.2%, session 84.14%, toolsRegistry 86.16%, verification 84.2%, toolsLeaf 60.9%
这些是 B1 旧 run 数据。P6/P8/P9 的 121 个新测试还没 mutation 测过。
验证: ls -lt reports/mutation/*/result.json (gateway=Aug6, toolsRegistry=Aug6, etc.)
修正: 所有 mutation score 标注 "(B1 旧数据, 待 B2 重跑)"

D4. G6 未连接 !identity.dirty 前置条件到当前脏工作区
#38 列了 6 个前置条件包括 !identity.dirty。
当前有 4 个未提交文件, 会导致 evidence 不发布。
修正: G6 加 "前置: 提交所有未提交文件 (包括 P12 waiver),
  !identity.dirty 是 evidence 发布的 6 个前置条件之一"

D5. 无交叉引用
task_plan 未引用 PHASE_FOUNDATION_REBUILD_PLAN.md, agent-harness-phase2-prompt.md,
pasted-text-1.txt, PHASE2_MULTI_AGENT_SHARED.md。
修正: 文档顶部加 "参考文档" 章节 (见第三部分)。

D6. Decisions 表缺 chunkTimeoutMs 决策
gateway 的 chunkTimeoutMs 从 15min 改成了 30min。
验证: rg 'chunkTimeoutMs' mutation/modules.mjs
修正: Decisions Made 加 "gateway chunkTimeoutMs 15min->30min | 防止大文件 chunk 超时"

D7. findings.md HEAD 引用过期
findings.md 写 "HEAD: 5d1ec4b8", 实际 b3977e6c。
修正: 更新 findings.md 的 HEAD 引用。

D8. task_plan.md 本身未提交
git status 显示 M task_plan.md。A3 只说提交修正版, 但没提它当前就 uncommitted。
修正: A3 明确 "task_plan.md, findings.md, progress.md 当前都是 M (uncommitted),
  和修正一起提交"

D9. Notes 写 "当前最紧迫: 补 gateway/runtime/session 无测试文件"
实际: 这些已做完。
修正: Notes 改为 "当前最紧迫: 提交 P12 + 修复 server.test.ts + 跑 Phase 1 mutation"。
Next Step 和执行顺序第 1 步同步修正 (见第二部分阶段 A)。

─── E 类: 执行细节遗漏 (8 个) ───

E1. GLM_API_KEY 未提供
B5a 说 npm run test:glm:live 需要 GLM_API_KEY, 但没提供 key。
修正: 加注 "GLM_API_KEY=e93c1f129cc44ce8908f3f6fa328c00b.hz4tGVIGo3Y8AQni"

E2. B1 和 B4 的 mutation 运行重复
B1: node scripts/run-mutation.mjs phase1
B4: npm run verify:phase1:local (内部调用 test:mutation:phase1 = 同一个脚本)
如果 B1 后没改代码, B4 的 mutation 部分复用已有 result.json (P0 修复后发布到模块目录)。
如果 B2 补了测试, B4 会重跑 mutation (5-8 小时)。
修正: B4 加注 "如果 B1 之后没改代码, verify:phase1:local 会复用 result.json。
  建议顺序: B1 -> B2(看结果决定是否补测试) -> B3 -> B4。
  如果 B2 补了测试, B4 会重跑 mutation。"

E3. .stryker-tmp 清理未提
B1 前应清理旧的 .stryker-tmp 释放磁盘 (可能 5-10GB)。
修正: B1 前加 "清理: rm -rf .stryker-tmp/2026-08-0* (保留最新或全删)"

E4. node 版本差异未提
本地 node v24.18.0, CI node v20。better-sqlite3 和 bcrypt native 模块行为可能不同。
修正: B2 加注 "本地 node v24, CI node v20, V8 引擎差异可能导致 mutation 结果不同"

E5. stryker patch 必须确认已应用
patches/@stryker-mutator+core+9.6.1.patch 修改了 mutant 激活行为。
修正: B1 前加 "确认 stryker patch: npm run prepare (patch-package) 后检查 patches/ 存在"

E6. D4 说 "22 个命令" 但实际列了 23 个
编号 1-23 (production-audit 是第 23 个)。
修正: D4 改为 "23 个命令, 3-4 小时"

E7. Phase 2 已有 GLM 源码审查可复用, 未说明
evidence/ 下有 9 个 GLM 验证 JSON (52 个源文件, 0 high/critical)。
阶段 E 是场景验收, 不是重做源码审查。两者合起来满足 independent_glm_5_2_xhigh。
修正: 阶段 E 加注 "已有 52 个源文件的 GLM 源码审查 (evidence/ 下 9 个 JSON)。
  阶段 E 是补充场景验收, 不是重做源码审查。"

E8. 阶段 G 缺少 Phase 3 实现的具体指导
Phase 3 建立在现有 router/ 代码上 (static-router.ts, task-normalizer.ts)。
Phase 3 启用了 Phase 2 禁用的 multi_agent capability。
Phase 3 的 16 个 requirement 有依赖关系。
修正: 阶段 G 扩展为 G1-G4 (见第二部分)。

══════════════════════════════════════════════════════════════
第二部分: 修正后的完整执行路线图 (阶段 A-G)
══════════════════════════════════════════════════════════════

修正完 task_plan.md 后按以下顺序执行。每步全绿才进下一步。

─── 阶段 A: 快速收尾 (30 分钟) ───

A1. 提交 P12 waiver (注意鸡蛋问题)
  A1a. git add mutation/equivalent-mutants.json
       git commit -m "fix: commit waiver rebinding to HEAD b3977e6c"
  A1b. 用新 HEAD 重绑 waiver (不要 commit 重绑后的版本):
       NEW_SHA=$(git rev-parse HEAD)
       python3 -c "
       import json
       with open('mutation/equivalent-mutants.json') as f: d=json.load(f)
       for w in d: w['commitSha']='$NEW_SHA'
       with open('mutation/equivalent-mutants.json','w') as f: json.dump(d,f,indent=2)
       "
  A1c. 验证: git status --short
       (应显示 M mutation/equivalent-mutants.json - 这是正确的, 保持 uncommitted)
       (不要 commit 重绑后的版本, runner 允许 uncommitted)

A2. 修复 server.test.ts 硬编码端口
  文件: tests/gateway/server.test.ts
  把 port: 18099/18098/18097 改成 port: 0 (系统分配空闲端口)
  验证: npx vitest run tests/gateway/server.test.ts

A3. 提交 task_plan.md 修正版 + findings.md + progress.md
  git add task_plan.md findings.md progress.md
  git commit -m "docs: fix task_plan 43 errors - mark completed work, fix index table"
  (这三个文件当前都是 M uncommitted, 和修正一起提交)

A4. typecheck + lint
  npm run typecheck && npm run lint
  验证: 两个都 PASS

─── 阶段 B: Phase 1 Mutation 地基验证 (8-12 小时) ───

B0. 准备工作
  B0a. 清理旧 .stryker-tmp: rm -rf .stryker-tmp/2026-08-0* (保留最新或全删)
  B0b. 确认 stryker patch: npm run prepare && ls patches/ (确认 patch 存在)
  B0c. 确认 GLM_API_KEY 可用: echo $GLM_API_KEY
       (如未设置: export GLM_API_KEY=e93c1f129cc44ce8908f3f6fa328c00b.hz4tGVIGo3Y8AQni)

B1. 运行 Phase 1 mutation (关键路径)
  node scripts/run-mutation.mjs phase1
  预期: 5-8 小时 (15 模块, gateway 43 chunks)
  监控: 每 30 分钟 ps aux | grep stryker + 检查 .stryker-tmp 最新目录
  注意: 不要中途 kill (除非 crash)
  注意: chunkTimeoutMs gateway=30min, sandbox=30min, default=15min
  注意: Stryker exit code 非 0 直接拒绝报告 (run-mutation.mjs line 856)
  注意: 本地 node v24, CI node v20, V8 引擎差异可能导致结果不同

B2. 检查 mutation 结果
  对每个模块读 reports/mutation/{module}/result.json
  确认 mutation score >= thresholds.json 里的阈值:
    85%: gateway, toolsLeaf, skills, strategies, verification, verticals, uiAdapters
    90%: router, toolsRegistry, actionControl, identitySecrets, vfs, sandbox, session, runtime
  注意 #18: 7 个之前 PASS 的模块可能因新测试回归, 必须确认 15/15 PASS
  如果有模块不达标:
    - 读 reports/mutation/{module}/mutation.json 找 surviving mutant 集中的行
    - 真覆盖缺口 -> 补测试杀掉
    - 等价 mutant -> 在 equivalent-mutants.json 注册 waiver (commitSha + configHash)
    - 补完测试后重跑该模块: node scripts/run-mutation.mjs {module}
    - 循环直到达标

B3. 运行 test:mutation:check (独立验证, #20)
  npm run test:mutation:check
  这会用 instrumenter 重新验证 mutant identity + git blob + score
  如果 FAIL: equivalent-mutants.json 的 commitSha 或 configurationHash 不匹配
  注意: 这步在 verify:phase1:local 里不包含, 必须单独跑

B4. 运行 verify:phase1:local
  npm run verify:phase1:local
  = typecheck + check:cycles + build + lint + test + test:coverage + test:mutation:phase1
  注意 #27: 加 --maxWorkers=1 和 CI 一致
  注意 #28: 检查 coverage threshold (lines 80%, branches 75%, functions 80%)
  注意: 如果 B1 之后没改代码, verify:phase1:local 的 mutation 部分 (test:mutation:phase1)
    会复用已有 result.json (P0 修复后发布到模块目录)。
    如果 B2 补了测试, B4 会重跑 mutation (5-8 小时)。

B5. 补充 verify:phase1:local 缺少的 5 个 Phase 1 exit_criteria (#21)

  B5a. independent_glm_5_2_xhigh: PASS
    npm run test:glm:live
    需要 GLM_API_KEY (见 B0c)
    这是 Phase 1 的 GLM 独立验证

  B5b. domain_evals_all_pass: true
    evals/ 下没有 phase-1.yaml (只有 phase-2)
    6 个 vertical evals 文件不存在: coding, documents, research, writing, planning, pa
    domain_evals_all_pass 无法满足
    需要创建 Phase 1 的 domain evals 或确认 exit_criteria 标记为 N/A
    参考 Phase 2 的 evals 格式: cat evals/coding/phase-2.yaml

  B5c. crash_restore_no_duplicate: PASS
    tests/session/crash-restore.test.ts 只有 3 个测试
    确认覆盖: 崩溃后恢复不重复 step, 恢复后正确 iteration, side effect 不重复
    如果不够, 补测试

  B5d. active_stub_count: 0
    node scripts/gates/check-active-stubs.mjs
    确认 activeRequirementIds 为空数组

  B5e. test:mutation:check (已在 B3 做了, 确认通过即可)

B6. 安全指标验证
  确认: sandbox_violation=0, unauthorized_effect=0, capability_replay=0
  如果有违规, 修复

B7. 重新生成 Phase 1 evidence (40 个, #29)
  当前: 39 个 evidence 文件, commit_sha 全部过期, 缺 AH-GATEWAY-TESTPROVIDER-001
  用新 HEAD 重新生成 40 个 evidence 文件
  每个 evidence 包含: requirement_id, commit_sha=新HEAD, tree_sha=新tree,
    测试命令, stdout, exit_code, test_pass_count, test_total_count
  重新跑 GLM 5.2 xhigh 独立验证
  注意: control/ 和 spec/requirements/ 在主仓库 agent-harness-v9.1, 不在本分支
  注意: AH-GATEWAY-TESTPROVIDER-001 需要新建 evidence 目录

─── 阶段 C: Phase 2 薄测试补厚 (2-3 天) ───

注意: 这里的"薄测试"是 tests/phase-2/unit/ah-*.test.ts (Phase 2 requirement 测试),
不是 tests/gateway/ 或 tests/runtime/ 下的 mutation 深度测试 (那些已做完)。

C1. 识别薄测试
  当前 tests/phase-2/unit/ 有 60 个 ah-*.test.ts 文件
  8 个 Batch 1 真测试 (>250 行): ah-hook, ah-runtime-sessiontree, ah-runtime-budget-002,
    ah-runtime-steering, ah-context-compiler, ah-pause-resume, ah-runtime-compaction,
    ah-runtime-modelfallback
  剩余 52 个薄测试 (33-116 行) 需要补厚

C2. 对每个薄测试:
  a) 从主仓库读 acceptance_criteria:
     python3 -c "
     import json
     with open('/Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/requirements/requirements.ndjson') as f:
       for l in f:
         r=json.loads(l) if l.strip() else {}
         if r.get('delivery_phase')==2 and r['id']=='REQ_ID': print(json.dumps(r,indent=2))
     "
     (替换 REQ_ID 为实际 ID)
  b) 读对应源代码文件 (见 pasted-text-1.txt 的路径映射)
  c) 读现有薄测试文件
  d) 用 mock provider 测真正功能路径 (不是只测 unavailable)
     - provider port: 注入 mock, 测 generate/edit/verify/fetch
     - 解析器: 用真实二进制内容 (最小 PDF/DOCX/XLSX/PPTX bytes)
     - RAG: 测 add/remove/search/query/cite/rerank
     - UI: 测 renderScreen/navigate/state
     - 工具: 测 egress + 真实操作
  e) 每条 acceptance_criteria 至少 1 个测试覆盖
  f) npx vitest run tests/phase-2/unit/ah-XXX-001.test.ts --reporter=verbose
  g) typecheck + lint

C3. 全量验证
  npx vitest run tests/phase-2/ --reporter=dot
  确认 0 failed
  npm run typecheck && npm run lint

─── 阶段 D: Phase 2 Gate 闭环 (1-2 天) ───

D1. 确认 git status clean
  提交所有新测试 + 重绑 equivalent-mutants.json (保持 uncommitted)
  验证: git status --short (除了 equivalent-mutants.json, 必须 clean)
  注意: !identity.dirty 是 evidence 发布的 6 个前置条件之一
  (6 个条件: mode==="local" && hasReleaseAuthority && execution.ok &&
   !identity.dirty && identityStable && errors.length===0)

D2. 运行 verify:phase2:dev
  node scripts/gates/verify-phase2-local.mjs --mode dev
  确认: success=true, candidateReady=true
  如果 candidateReady=false, 读 blockers 逐个解决

D3. Push 到 origin (public, 有 runner)
  git push origin codex/phase2-integrated
  注意: 本地超前 origin 4+ 个 commit, 正常 push 即可
  注意 #35: product (agentharness91) 是 PRIVATE 无 runner, 推到 origin
  注意 #34: ci.yml 不跑 mutation, 只跑 typecheck/build/lint/test/coverage/audit/pack
  等 CI 绿

D4. CI 绿后运行 verify:phase2:local --mode local
  node scripts/gates/verify-phase2-local.mjs --mode local
  23 个命令, 3-4 小时:
    1.  check-phase2-manifest
    2.  check-workspace-boundaries
    3.  check-phase2-assets --mode local
    4.  check-contract-drift
    5.  check-active-stubs --mode scan
    6.  typecheck
    7.  check:cycles
    8.  build
    9.  lint
    10. phase1-regression (npm test --maxWorkers=1, 15min timeout)
        -- 注意: 这步重跑所有 Phase 1 测试, Phase 1 不稳这步会 FAIL
    11. coverage (test:coverage --maxWorkers=1, 15min timeout)
    12. workspace-coverage
    13. phase2-unit (10min timeout)
    14. phase2-integration (5min timeout)
    15. phase2-security (5min timeout)
    16. phase2-e2e (10min timeout)
    17. mutation (test:mutation:phase2, 60min timeout)
    18. evaluations (run-phase2-evals.mjs --mode release, 15min timeout)
    19. data (run-phase2-data.mjs --mode release, 15min timeout)
    20. package-smoke (5min timeout)
    21. workspace-smoke (5min timeout)
    22. source-checkout-reproduction (60min timeout)
    23. production-audit (npm audit --omit=dev, 5min timeout)
  可能卡住: #10 (15min), #17 (60min), #22 (60min)
  #18 evaluations 和 #19 data 需要 --mode release, 可能需外部数据集

  注意 #36: releaseReady 硬编码 false, 目标是 candidateReady=true
  注意 #38: candidateReady 要求 candidateEvidenceCount === 64

D5. 确认 Phase 2 exit_criteria 全部满足
  - all_phase_requirements_verified: true (evidence 64/64)
  - regression_tests_pass: true (23 命令全过)
  - active_stub_count: 0 (check-active-stubs)
  - independent_glm_5_2_xhigh: PASS (阶段 E)
  success=true, candidateReady=true
  releaseReady=false 是正常的 (需要 CI attestation)

─── 阶段 E: Phase 2 GLM-5.2 xhigh 场景验收 (1 天) ───

注意: 这不是源码审查。已有 52 个源文件的 GLM 源码审查
(evidence/ 下 9 个 JSON, 0 high/critical), 那些可以复用。
阶段 E 是补充场景验收, 两者合起来满足 independent_glm_5_2_xhigh。

phase-2.yaml 要求: "After the local gate passes, a read-only GLM-5.2 xhigh run
evaluates long-context, RAG, multimodal, UX, privacy, and failure-recovery scenarios."

覆盖 6 个场景:
  1. long-context: 长上下文处理
  2. RAG: 检索增强生成
  3. multimodal: 多模态处理
  4. UX: 用户体验
  5. privacy: 隐私保护
  6. failure-recovery: 故障恢复
确认: independent_glm_5_2_xhigh: PASS

─── 阶段 F: 更新控制状态 (需 CTO 批准) ───

F1. 在主仓库 agent-harness-v9.1 更新 control/current-state.json:
  Phase 1: status -> VERIFIED, maturity -> {verified: 40}
  Phase 2: status -> VERIFIED, maturity -> {verified: 64}
  Phase 3: status -> IN_PROGRESS
  这是受保护路径, 需要人工确认后才能改

F2. 确认 Phase 3 入口条件 (phase-3.yaml entry_criteria):
  - Previous phase gate passed (Phase 2 verify:phase2:local success=true)
  - All dependencies verified
  - No open P0 blockers

F3. 确认 B0.5 受保护 patch (phase2-spec-sync) 是否已批准
  如果未批准, control/ 和 spec/requirements/ 的字段级落库无法进行

─── 阶段 G: Phase 3 实现 (数周, 需单独详细计划) ───

Phase 3 有 16 个 requirement, 全部 not_started, tests/phase-3/ 目录不存在。

G1. 读 Phase 3 specs:
  cat /Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/phases/phase-3.yaml
  python3 -c "
  import json
  with open('/Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/requirements/requirements.ndjson') as f:
    for l in f:
      r=json.loads(l) if l.strip() else {}
      if r.get('delivery_phase')==3: print(json.dumps(r,indent=2))
  "

G2. 读现有 router 代码 (Phase 3 建立在这些之上):
  cat router/static-router.ts
  cat router/task-normalizer.ts
  理解 AH-ROUTER-DAG-001 等如何扩展现有 router

G3. 注意 capability 变化:
  Phase 2 disabled_capabilities: external_write, multi_agent, dynamic_tool_generation
  Phase 3 disabled_capabilities: external_write, dynamic_tool_generation
  (multi_agent 在 Phase 3 启用)

G4. 检查 requirement 依赖:
  AH-SUBAGENT-001 依赖 AH-RUNTIME-SESSIONTREE-001 (Phase 2)
  AH-MULTIAGENT-DAG-001 依赖 AH-RUNTIME-LOOP-001 (Phase 1)
  AH-ROUTER-DAG-001 依赖 AH-ROUTER-FOUNDATION-001 (Phase 1)
  确认所有依赖已 verified

G5. Phase 3 的 16 个 requirement:
  AH-ROUTER-DAG-001: 依赖感知 Router DAG
  AH-ROUTER-DAG-FAILURE-001: DAG 失败传播
  AH-ROUTER-EVAL-001: Router 评估
  AH-ROUTER-FALLBACK-11-001: 11 种 fallback
  AH-ROUTER-BUDGET-DYNAMIC-001: 动态预算路由
  AH-ROUTER-CONTEXT-TOPOLOGY-001: 上下文拓扑
  AH-ROUTER-SKILL-CHAIN-001: 技能链
  AH-MULTIAGENT-DAG-001: 多 Agent DAG
  AH-MULTIAGENT-MERGE-001: 确定性合并
  AH-SUBAGENT-001: 子 Agent
  AH-AGENT-AUTHORING-001: Agent 编写
  AH-TOOL-BROWSER-001: 浏览器工具
  AH-TOOL-COMPUTER-001: 计算机使用工具
  AH-TOOL-VIDEO-GEN-001: 视频生成
  AH-TOOL-VIDEO-EDIT-001: 视频编辑
  AH-TOOL-MUSIC-GEN-001: 音乐生成

G6. Phase 3 exit_criteria:
  - hard_constraint_violation: 0
  - routing_regret: <= 15%
  - unnecessary_multi_agent_rate: <= 20%
  - context_isolation: PASS
  - capability_attenuation: PASS
  - merge_conflict_no_hardcoded_rules: PASS
  - independent_glm_5_2_xhigh: PASS

══════════════════════════════════════════════════════════════
第三部分: 参考文档清单和铁律
══════════════════════════════════════════════════════════════

─── 参考文档 (12 份, 修正 task_plan.md 时在顶部加 "参考文档" 章节引用) ───

治理层:
  1. agent-harness-phase2-prompt.md (/Users/guanjieqiao/agent-harness-phase2-prompt.md)
     - 权威来源, 受保护路径, 8 条禁止红线, candidate-only 规则

战略层:
  2. PHASE_FOUNDATION_REBUILD_PLAN.md (worktree 根目录)
     - 6 阶段战略计划, Fix Forward 决策, per-stage 诊断/验证/决策点

战术层:
  3. pasted-text-1.txt (/Users/guanjieqiao/.codex/attachments/eb6f25e5-1083-4338-b611-b3016d1a887c/pasted-text-1.txt)
     - 原始 6 步计划 + 铁律 + 55 个薄测试分组
  4. MUTATION_REVIEW_PROMPT.md (worktree 根目录)
     - 38 条审查提示词, 最详细的战术文档
  5-7. 内联提示词 (session 历史中, 无独立文件):
     - 用户消息 2: 步骤 7-8 (推送+CI+control/state)
     - 用户消息 48: P0-P13 完整提示词, 16 步执行顺序
     - 用户消息 50: P2-FIX/P10/P5/P6/P8/P9/P12/P13 续接, 13 步执行顺序

跟踪层:
  8.  task_plan.md (worktree 根目录) - planning-with-files 输出, P0-P13 + 6 步 + G1-G6
  9.  findings.md (worktree 根目录) - 技术发现和决策
  10. progress.md (worktree 根目录) - 进度日志
  11. PHASE2_PROGRESS_NOTES.md (worktree 根目录) - 完成工作/剩余工作台账
  12. PHASE2_MULTI_AGENT_SHARED.md (worktree 根目录) - 跨 session 共享台账

spec 文件 (在主仓库):
  - /Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/phases/phase-1.yaml
  - /Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/phases/phase-2.yaml
  - /Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/phases/phase-3.yaml
  - /Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/requirements/requirements.ndjson
  - /Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/control/current-state.json

─── 铁律 (贯穿所有阶段) ───

1. 不删测试, 不降阈值, 不加 skip
2. 不伪造 evidence/mutation 结果
3. 每个修复必须对应一个具体失败
4. 不改动 byte-frozen 的 gate manifest (verification/gates/phase2-gate.json)
5. 不改动 spec/, control/, evidence/ 受保护路径 (需要 CTO 批准)
6. 步骤未全绿不进入下一步
7. candidate-only: 本地结果不冒充 VERIFIED
8. 不在本地死磕 releaseReady=true (需要 CI attestation)
9. 不要写只检查 toBeDefined 或 module importable 的填充测试
10. waiver 保持 uncommitted (runner 允许, 避免 commit 改 HEAD 的鸡蛋问题)

══════════════════════════════════════════════════════════════
完整路径总览
══════════════════════════════════════════════════════════════

当前位置: 阶段 A (P0-P13 测试写完已提交, mutation 没跑)

A (30min)  ->  B (8-12h)  ->  C (2-3天)  ->  D (1-2天)  ->  E (1天)  ->  F (需批准)  ->  G (数周)
提交P12       跑mutation     补52薄测试    gate闭环     GLM场景    更新状态     Phase3实现
修端口        验证15模块     typecheck    push+CI      验收6场景
typecheck     verify         lint         23命令      (复用52
              5个补充                      3-4h         源码审查)
              40个evidence

每步全绿才进下一步。
做完阶段 A-D 后把结果汇总给我, 确认后再做 E-F。
阶段 G 需要单独的详细计划。

先修正 task_plan.md 的 43 个错误, 然后从阶段 A 开始执行。

══════════════════════════════════════════════════════════════
第四部分: 二次审计补充 (15 个执行细节)
══════════════════════════════════════════════════════════════

对指令本身进行二次审计后, 发现以下 15 个执行细节遗漏。

─── F 类: 会导致执行失败的遗漏 (4 个) ───

F1. managed-gateway-stream.test.ts 有 1-2 个预先存在的 timeout 失败
verify:phase1:local 的第 5 步是 npm test = vitest run (全部测试, 不只是 Phase 1)。
managed-gateway-stream.test.ts 的 completeStream 100-loop rate limit 测试会 timeout (5s)。
这会让 verify:phase1:local 在 B4 直接 FAIL。
修复: 在 B4 之前修复这个测试。选项:
  a) 增加 timeout: npx vitest run tests/gateway/managed-gateway-stream.test.ts (看具体哪个超时)
  b) 把 100-loop 改成 10-loop (如果 100 是过度的)
  c) 增加 testTimeout 到 30000
验证: npx vitest run tests/gateway/managed-gateway-stream.test.ts 必须 0 failed

F2. verify:phase1:local 运行全部测试, 不只是 Phase 1
npm test = vitest run (所有 tests/ 下的 .test.ts, 包括 tests/phase-2/)。
这意味着 Phase 2 测试的失败也会让 Phase 1 gate 失败。
修正: B4 加注 "npm test 跑全部测试 (Phase 1 + Phase 2)。
  如果 Phase 2 测试有失败, Phase 1 gate 也会 FAIL。
  确认 npx vitest run --reporter=dot 0 failed 后再跑 verify:phase1:local。"

F3. HEAD 引用已过期
指令写 HEAD b3977e6c, 但已添加 2 个 commit (6911e879, 2b5d5dba)。
当前 HEAD: 2b5d5dba (或更新)。
修正: 所有引用 HEAD 的地方改用 git rev-parse HEAD 动态获取, 不要硬编码 SHA。
  waiver 重绑时也用 NEW_SHA=$(git rev-parse HEAD)。

F4. git push 需要 -u (无 upstream tracking)
codex/phase2-integrated 分支没有设置 remote tracking。
git push origin codex/phase2-integrated 可以, 但之后 git pull 不行。
修正: D3 改为 git push -u origin codex/phase2-integrated

─── G 类: 数据格式遗漏 (3 个, agent 需要知道怎么读写) ───

G1. equivalent-mutants.json waiver 格式
注册新 waiver 时需要以下字段:
  {
    "module": "模块名 (如 strategies)",
    "sourceFile": "源文件路径 (如 runtime/react.ts)",
    "reason": "为什么是等价 mutant (如 NoCoverage: ...)",
    "reviewedBy": "phase2-integration-lead",
    "reviewedAt": "2026-08-08T00:00:00Z",
    "commitSha": "当前 HEAD SHA (用 git rev-parse HEAD 获取)",
    "strykerMutantId": "从 mutation.json 里复制的 mutant ID",
    "configurationHash": "用 computeMutationConfigurationHash() 计算的 hash"
  }
验证 configurationHash:
  node -e "import {computeMutationConfigurationHash} from './scripts/run-mutation.mjs'; console.log(computeMutationConfigurationHash());"

G2. mutation.json 结构 (找 surviving mutants)
路径: reports/mutation/{module}/mutation.json
顶层 keys: files, schemaVersion, thresholds, testFiles, projectRoot, config, framework, phase1_chunked, chunks
找 surviving mutants:
  python3 -c "
  import json
  d=json.load(open('reports/mutation/{module}/mutation.json'))
  for f in d.get('files',[]):
    for m in f.get('mutants',[]):
      if m.get('status')=='Survived':
        print(f'{f[\"name\"]}:{m[\"location\":{\"start\":{\"line\"]} mutant={m[\"id\"]} mutator={m[\"mutatorName\"]}')
  "
  (替换 {module} 为实际模块名)

G3. evidence.json 格式
Phase 1 evidence 路径: artifacts/phase-1/{requirement_id}/evidence.json
Phase 2 evidence 路径: artifacts/phase-2/{requirement_id}/evidence.json
字段:
  requirement_id, commit_sha, tree_sha, source_files[], tests_added[],
  commands_run[], exit_codes[], test_results{pass,total,failed},
  coverage, security_checks, verifier_result, verifier_model,
  test_output, test_output_hash, test_output_sha256,
  test_pass_count, test_total_count, independent_verifier{model,verdict,severity}
参考现有: cat artifacts/phase-1/AH-CAPABILITY-001/evidence.json | python3 -m json.tool

─── H 类: 机制澄清遗漏 (5 个) ───

H1. D4 #17 Phase 2 mutation 和 B1 Phase 1 mutation 是完全不同的系统
B1: node scripts/run-mutation.mjs phase1
  = 15 个模块, Stryker 逐模块跑, 5-8 小时
D4 #17: npm run test:mutation:phase2
  = node scripts/run-phase2-mutation-launcher.mjs phase2
  = 64 个 Phase 2 requirement, 不同的 launcher 脚本
两者不要搞混。Phase 2 mutation 用的是 phase2-modules.mjs 的 64 项映射, 不是 modules.mjs 的 15 模块。
修正: B1 加注 "这是 Phase 1 mutation (15 模块)"。D4 #17 加注 "这是 Phase 2 mutation (64 requirement),
  用 run-phase2-mutation-launcher.mjs, 不同于 B1 的 run-mutation.mjs"。

H2. D4 #22 source-checkout-reproduction 是什么
60min timeout。从 source checkout 重新构建验证: git stash -> clean checkout -> build -> test。
确认代码可以从干净 checkout 复现。
如果 FAIL: 可能是 build 依赖未声明 (如 turbo 缓存, node_modules 版本差异)。
修正: D4 #22 加注 "source-checkout-reproduction: 从干净 checkout 重建验证, 60min。
  如果 FAIL 检查 build 依赖是否完整声明。"

H3. D4 #18/#19 evals/data 实际有 fixtures
evals 使用: fixtures/phase-2/assets/evals/*.json (7 个 domain + public-benchmark + synthetic)
data 使用: fixtures/phase-2/assets/data/*.json (synthetic.json, public-benchmark.json)
--mode release 可能需要真实数据集, 但 --mode bootstrap 用 fixtures。
修正: D4 #18/#19 加注 "evals/data 有 fixtures (fixtures/phase-2/assets/)。
  --mode release 可能需外部数据集, --mode bootstrap 用 fixtures。
  如果 --mode release FAIL, 尝试 --mode bootstrap 确认 fixtures 可用。"

H4. identityStable 前置条件
identityStable 检查 repo identity (commit SHA + tree SHA) 在 gate 执行期间是否稳定。
如果 gate 执行期间有 commit/文件变化, identityStable=false, evidence 不发布。
这就是为什么 D1 要求 git status clean。
修正: #38 的 identityStable 加注 "= gate 执行期间 commit SHA + tree SHA 不变化"

H5. D4 #17 mutation 读本地 reports/
reports/ 在 .gitignore 里, CI 看不到本地 mutation 结果。
但 verify:phase2:local --mode local 是本地跑的, 它自己生成 reports/ 然后读。
CI 上需要单独跑 phase2-mutation.yml workflow 生成自己的 reports/。
这与 D3 的 CI 绿是独立的 — CI 绿只证明 typecheck/build/lint/test/coverage 通过,
mutation 结果需要本地 gate 或 CI workflow 单独验证。
修正: D4 #17 加注 "mutation 步骤生成并读取本地 reports/ (gitignored)。
  CI 的 ci.yml 不跑 mutation, 需单独触发 phase2-mutation.yml workflow:
  gh workflow run phase2-mutation.yml --repo 123oqwe/agent-harness-v9.1"

─── I 类: Phase 3 补充 (3 个) ───

I1. Phase 3 gate_command 也不存在
phase-3.yaml gate_command: python3 factory/phase-gates/gate_runner.py phase3
和 Phase 1 一样, factory/phase-gates/gate_runner.py 不存在。
修正: G6 加注 "Phase 3 gate_command (factory/phase-gates/gate_runner.py phase3) 也不存在,
  和 Phase 1 同样的问题。需要确认替代方案。"

I2. Phase 3 无任何现有源代码
确认: 无文件引用 RouterDag, MultiAgentDag, SubAgent 等。
Phase 3 完全从零开始 (除了 router/static-router.ts 和 router/task-normalizer.ts 作为基础)。
修正: G2 加注 "Phase 3 无现有源代码 (除了 router/static-router.ts 作为基础)。
  AH-ROUTER-DAG-001 等需要从零实现。"

I3. Phase 3 的 4 个工具 requirement 需要外部服务
  AH-TOOL-BROWSER-001: 需要浏览器自动化 (Playwright/Puppeteer)
  AH-TOOL-COMPUTER-001: 需要计算机使用 (屏幕截图+鼠标键盘控制)
  AH-TOOL-VIDEO-GEN-001: 需要视频生成 API (如 Seedance)
  AH-TOOL-MUSIC-GEN-001: 需要音乐生成 API
  AH-TOOL-VIDEO-EDIT-001: 需要视频编辑能力
修正: G5 加注 "Phase 3 的 5 个工具 requirement 需要外部服务/API:
  browser automation, computer use, video gen, music gen, video edit。
  实现前需确认外部服务可用性和 API key。"
