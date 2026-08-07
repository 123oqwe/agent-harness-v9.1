在 /Users/guanjieqiao/agent-runtime-v7/worktrees/phase2-integrated 工作。
分支 codex/phase2-integrated。HEAD b3977e6c。所有文件路径用绝对路径。

你是世界级 harness 工程师。以下是完整的指令, 分为两大部分:
- 第一部分: 修正 task_plan.md (当前有 28 个错误)
- 第二部分: 修正后的完整执行路线图 (从当前状态到 Phase 3)

铁律: 不删测试, 不降阈值, 不加 skip, 不伪造 evidence/mutation 结果。
每个修复必须对应一个具体失败。
不改动 byte-frozen 的 gate manifest (verification/gates/phase2-gate.json)。
不改动 spec/, control/, evidence/ 受保护路径 (需要 CTO 批准)。
步骤未全绿不进入下一步。
不要写只检查 toBeDefined 或 module importable 的填充测试。

══════════════════════════════════════════════════════════════
第一部分: 修正 task_plan.md 的 28 个错误
══════════════════════════════════════════════════════════════

你的 task_plan.md 是从 compacted session memory 重写的, 没有验证实际文件系统。
以下 28 个错误必须修正。修正方法: 对每个声称, 用 git log + find + rg 验证实际状态,
然后更新 task_plan.md。

A 类: 已完成的工作被标记为未完成 (9 个 — 最严重, 会导致重复劳动)

错误 1: #1 gateway 10 个无测试文件标"未开始"
实际: 全部已存在 (commit 55853d3d)。验证命令:
  for f in circuit-breaker rate-limiter key-vault capability-registry economic-kernel cache-manager tool-mask dag-executor glm-gateway-bridge; do
    rg -c '\b(it|test)\(' tests/gateway/${f}.test.ts
  done
修正: 全部标记为已完成, 记录测试数。

错误 2: #2 runtime 5 个文件标"未开始"
实际: retry(26 tests), errors(6), notifications(15), pause-resume-port(8),
session-tree-port(6) 全部已存在 (commit 9fef88f7/a9317164)。
修正: 全部标记为已完成。

错误 3: #2 event-bus 标"P9 部分覆盖"
实际: tests/runtime/event-bus.test.ts 已存在 (12 tests)。
修正: 标记为已完成。

错误 4: #3 durable-session 标"未开始"
实际: tests/session/durable-session.test.ts 已存在 (27 tests, commit be78628d)。
修正: 标记为已完成。

错误 5: #3 progress-store 标"5 tests"
实际: 12 tests (commit be78628d 创建 7 + 6e366db4 加 5)。
修正: 更新为 12 tests, 已完成。

错误 6: #4 react.ts 标"未开始"
实际: tests/runtime/react-strategy.test.ts (14 tests) +
tests/runtime/react-loop.test.ts (29 tests) 已存在。
修正: 标记为已完成。

错误 7: #4 plan-execute 标"22 tests"
实际: 39 tests (validation 17 + mutation 22)。
修正: 更新为 39 tests。

错误 8: Notes 写"当前最紧迫: 补 gateway/runtime/session 无测试文件"
实际: 这些已做完。修正为: 当前最紧迫是提交 P12 + 跑 Phase 1 mutation。

错误 9: Next Step 写"补 gateway 10 个无测试文件" + 执行顺序第 1 步"补测试文件 (#1-9)"
实际: #1-4 已做完。修正为: 提交 P12 waiver + 修复 server.test.ts + 跑 mutation。

B 类: 索引表内容错误 (8 个)

错误 10: 索引 #18 内容是 #31 的内容 (waiver hash 机制)
原文 #18 是"7 个 PASS 模块可能回归"。验证:
  sed -n '/^18\./,/^[0-9]*\./p' MUTATION_REVIEW_PROMPT.md | head -20
修正: #18 改为"7 个 PASS 模块可能回归 | 风险 | B1 重跑时 15 个模块全跑, 7 个 PASS 的可能因新测试引入 import cycle 或 typecheck 错误从 PASS 变 FAIL"

错误 11: 索引 #19 内容是 #11 的重复 (chunkTimeoutMs)
原文 #19 是"每个模块的 minimum 阈值不同"。
修正: #19 改为"per-module 阈值不同 | 已知 | 见 mutation/thresholds.json: 85% (gateway, toolsLeaf, skills, strategies, verification, verticals, uiAdapters), 90% (router, toolsRegistry, actionControl, identitySecrets, vfs, sandbox, session, runtime)"

错误 12: per-module 阈值 (85%/90%) 未记录
验证: cat mutation/thresholds.json
修正: 在 Key Questions 里把"每模块有不同阈值"改为具体值:
  85%: gateway, toolsLeaf, skills, strategies, verification, verticals, uiAdapters
  90%: router, toolsRegistry, actionControl, identitySecrets, vfs, sandbox, session, runtime

错误 13: #11 写 defaultChunkTimeoutMs = 15 * 60 * 1000
实际: gateway 的 chunkTimeoutMs 是 30 * 60 * 1000。
验证: rg 'chunkTimeoutMs' mutation/modules.mjs
修正: #11 加注: "default 15min, 但 gateway 和 sandbox 设了 30min"

错误 14: #19 写"chunkTimeoutMs 15 分钟 (非 30)"
实际: gateway 就是 30 分钟。
修正: 删除这条或改为"gateway chunkTimeoutMs=30min, default=15min"

错误 15: #21 写"verify:phase1:local 是 7 个命令"
原文 #21 的核心是"缺少 5 个必需检查"。
修正: #21 改为"verify:phase1:local 缺少 5 个必需检查 | 阻塞 | 链是 typecheck+cycles+build+lint+test+coverage+mutation, 但 Phase 1 exit_criteria 还要求: (a) GLM xhigh PASS (b) 6 个 domain evals (c) crash_restore (d) active_stub_count=0 (e) mutation:check 独立验证"

错误 16: #23 标"待确认"
实际: 已确认 phase-1 domain evals 不存在 (只有 phase-2)。
验证: find evals/ -path "*phase-1*"
修正: #23 改为"Phase 1 domain evals 不存在 | 阻塞 | evals/ 下只有 phase-2.yaml, phase-1 的 6 个 vertical evals 文件不存在, exit_criteria domain_evals_all_pass 无法满足"

错误 17: #35 标"待确认"
实际: agentharness91 是 PRIVATE (gh repo view 确认)。
修正: #35 改为"product 仓库 (agentharness91) 是 PRIVATE | 阻塞 | 无 runner, CI 2 秒就 FAIL。必须推到 origin (agent-harness-v9.1, public) 或把 agentharness91 改为 public"

C 类: Phase 1 退出条件未跟踪 (5 个)

错误 18: 6 个 vertical tasks 完全未提及
phase-1.yaml exit_criteria 要求 6 个垂直域 evals 全通过:
  coding, documents, research, writing, planning, personal_assistant
验证: cat /Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/phases/phase-1.yaml
修正: 在 Step 1 剩余工作里加"Phase 1 vertical evals (6 个域): evals/ 下没有 phase-1.yaml, 这个 exit_criteria 无法满足, 需要创建或标记为 N/A"

错误 19: 安全指标完全未提及
phase-1.yaml exit_criteria 要求:
  sandbox_violation=0, unauthorized_effect=0, capability_replay=0
修正: 在 Step 1 剩余工作里加"安全指标: 确认 sandbox_violation=0, unauthorized_effect=0, capability_replay=0"

错误 20: spec gate_command 未提及且不存在
phase-1.yaml gate_command 是 python3 factory/phase-gates/gate_runner.py phase1
验证: ls factory/phase-gates/gate_runner.py (两个仓库都不存在)
修正: 在 Key Questions 里加"gate_command factory/phase-gates/gate_runner.py 不存在, verify:phase1:local (npm script) 是替代品还是部分实现?"

错误 21: 40 个 Phase 1 requirements 但只有 39 个 evidence
缺失: AH-GATEWAY-TESTPROVIDER-001
验证:
  python3 -c "import json; [print(json.loads(l)['id']) for l in open('/Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/requirements/requirements.ndjson') if l.strip() and json.loads(l).get('delivery_phase')==1]"
  ls artifacts/phase-1/
修正: 在 Step 1 剩余工作里加"Phase 1 evidence 缺失: AH-GATEWAY-TESTPROVIDER-001 没有 evidence 目录, 40 个 requirement 只有 39 个 evidence"

错误 22: Phase 2 GLM 场景验收未跟踪
phase-2.yaml 要求 gate 通过后跑 GLM-5.2 xhigh 场景验收
(long-context, RAG, multimodal, UX, privacy, failure-recovery)
当前做的是 52 个源文件的代码审查, 不是场景验收。
修正: 在 Step 6 或新增 Step D 里加"Phase 2 GLM-5.2 xhigh 场景验收: 不是源码审查, 是场景验收测试, gate 通过后执行"

D 类: 矛盾和过时数据 (6 个)

错误 23: P12 标"已提交", git status 显示未提交
验证: git status --short mutation/equivalent-mutants.json
修正: P12 改为"未提交 — 工作区有 waiver 重绑 (6979cf9d->b3977e6c), 需要提交"

错误 24: #5/#6 mutation scores 过时
计划写 vfs 88.2%, session 84.14%, toolsRegistry 86.16%, verification 84.2%, toolsLeaf 60.9%
这些是 B1 旧 run 数据。P6/P8/P9 的 121 个新测试还没 mutation 测过。
验证: ls -lt reports/mutation/*/result.json (看时间戳)
修正: 所有 mutation score 标注"(B1 旧数据, 待 B2 重跑)"

错误 25: G6 未连接 !identity.dirty 前置条件到当前脏工作区
#38 列了 6 个前置条件包括 !identity.dirty
当前有 4 个未提交文件, 会导致 evidence 不发布。
修正: 在 G6 里加"前置: 提交所有未提交文件 (包括 P12 waiver), !identity.dirty 是 evidence 发布条件"

错误 26: 无交叉引用
task_plan 未引用 PHASE_FOUNDATION_REBUILD_PLAN.md, agent-harness-phase2-prompt.md,
pasted-text-1.txt, PHASE2_MULTI_AGENT_SHARED.md。
修正: 在文档顶部加"参考文档"章节, 列出所有 12 份计划文档的路径和用途。

错误 27: Decisions 表缺 chunkTimeoutMs 决策
gateway 的 chunkTimeoutMs 从 15min 改成了 30min。
验证: rg 'chunkTimeoutMs' mutation/modules.mjs
修正: 在 Decisions Made 里加"gateway chunkTimeoutMs 15min->30min | 防止大文件 chunk 超时"

错误 28: #7 server.test.ts 未标为 blocker
验证: rg '18099|18098|18097' tests/gateway/server.test.ts
修正: 在执行顺序里把 #7 列为必须修复的 blocker

══════════════════════════════════════════════════════════════
第二部分: 修正后的完整执行路线图
══════════════════════════════════════════════════════════════

修正完 task_plan.md 后, 按以下顺序执行。每步全绿才进下一步。

阶段 A: 快速收尾 (预计 30 分钟)

A1. 提交 P12 waiver
  git add mutation/equivalent-mutants.json
  git commit -m "fix: commit waiver rebinding to HEAD b3977e6c"
  验证: git status --short (mutation/equivalent-mutants.json 不再显示 M)

A2. 修复 server.test.ts 硬编码端口
  文件: tests/gateway/server.test.ts
  把 port: 18099/18098/18097 改成 port: 0
  验证: npx vitest run tests/gateway/server.test.ts

A3. 提交 task_plan.md 修正版
  git add task_plan.md findings.md progress.md
  git commit -m "docs: fix task_plan 28 errors — mark completed work, fix index table"

A4. typecheck + lint
  npm run typecheck && npm run lint
  验证: 两个都 PASS

阶段 B: Phase 1 Mutation 地基验证 (预计 8-12 小时)

B1. 运行 Phase 1 mutation (关键路径)
  node scripts/run-mutation.mjs phase1
  预期: 5-8 小时 (15 模块, gateway 43 chunks)
  监控: 每 30 分钟检查 ps aux | grep stryker 和 .stryker-tmp
  注意: 不要中途 kill (除非 crash)
  注意: chunkTimeoutMs gateway=30min, default=15min
  注意: Stryker exit code 非 0 拒绝报告

B2. 检查 mutation 结果
  对每个模块读 reports/mutation/{module}/result.json
  确认 mutation score >= thresholds.json 里的阈值:
    85%: gateway, toolsLeaf, skills, strategies, verification, verticals, uiAdapters
    90%: router, toolsRegistry, actionControl, identitySecrets, vfs, sandbox, session, runtime
  如果有模块不达标:
    - 读 mutation.json 找 surviving mutant 集中的行
    - 真覆盖缺口 → 补测试杀掉
    - 等价 mutant → 在 equivalent-mutants.json 注册 waiver (commitSha + configHash)
  注意 #18: 7 个之前 PASS 的模块可能因新测试回归, 必须确认 15/15 PASS

B3. 运行 test:mutation:check (独立验证, #20)
  npm run test:mutation:check
  这会用 instrumenter 重新验证 mutant identity + git blob + score
  如果 FAIL: equivalent-mutants.json 的 commitSha 或 configurationHash 不匹配

B4. 运行 verify:phase1:local
  npm run verify:phase1:local
  = typecheck + check:cycles + build + lint + test + test:coverage + test:mutation:phase1
  注意 #27: 加 --maxWorkers=1 和 CI 一致
  注意 #28: 检查 coverage threshold (lines 80%, branches 75%, functions 80%)

B5. 补充 verify:phase1:local 缺少的 5 个 Phase 1 exit_criteria (#21)

  B5a. independent_glm_5_2_xhigh: PASS
    npm run test:glm:live
    需要 GLM_API_KEY
    这是 Phase 1 的 GLM 独立验证, 不是 Phase 2 的

  B5b. domain_evals_all_pass: true
    evals/ 下没有 phase-1.yaml (只有 phase-2)
    6 个 vertical evals 文件不存在: coding, documents, research, writing, planning, pa
    这意味着 domain_evals_all_pass 无法满足
    需要创建 Phase 1 的 domain evals 或确认这个 exit_criteria 被标记为 N/A

  B5c. crash_restore_no_duplicate: PASS
    tests/session/crash-restore.test.ts 只有 3 个测试
    确认是否覆盖: 崩溃后恢复不重复 step, 恢复后正确 iteration, side effect 不重复
    如果不够, 补测试

  B5d. active_stub_count: 0
    node scripts/gates/check-active-stubs.mjs
    确认 activeRequirementIds 为空数组

  B5e. test:mutation:check (已在 B3 做了)

B6. 安全指标验证 (#19 新增)
  确认: sandbox_violation=0, unauthorized_effect=0, capability_replay=0
  如果有违规, 修复

B7. 重新生成 Phase 1 evidence (40 个, #29)
  当前: 39 个 evidence 文件, commit_sha 全部过期, 缺 AH-GATEWAY-TESTPROVIDER-001
  用新 HEAD 重新生成 40 个 evidence 文件
  每个 evidence 包含: requirement_id, commit_sha=新HEAD, tree_sha=新tree, 测试命令, stdout, exit_code
  重新跑 GLM 5.2 xhigh 独立验证
  注意: 这步可能需要在主仓库 agent-harness-v9.1 做 (control/ 和 spec/ 在那里)

阶段 C: Phase 2 薄测试补厚 (预计 2-3 天)

注意: 这里的"薄测试"是 tests/phase-2/unit/ah-*.test.ts (Phase 2 requirement 测试),
不是 tests/gateway/ 或 tests/runtime/ 下的 mutation 深度测试 (那些已做完)。

C1. 识别薄测试
  当前 tests/phase-2/unit/ 有 60 个 ah-*.test.ts 文件
  8 个 Batch 1 真测试 (>250 行): ah-hook, ah-runtime-sessiontree, ah-runtime-budget-002,
    ah-runtime-steering, ah-context-compiler, ah-pause-resume, ah-runtime-compaction,
    ah-runtime-modelfallback
  剩余 ~52 个薄测试 (33-116 行) 需要补厚

C2. 对每个薄测试:
  a) 从主仓库读 acceptance_criteria:
     python3 -c "import json; [print(json.dumps(r)) for r in [json.loads(l) for l in open('/Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/requirements/requirements.ndjson') if l.strip()] if r.get('delivery_phase')==2 and r['id']=='REQ_ID']"
  b) 读对应源代码文件
  c) 读现有薄测试文件
  d) 用 mock provider 测真正功能路径 (不是只测 unavailable)
  e) 每条 acceptance_criteria 至少 1 个测试覆盖
  f) npx vitest run tests/phase-2/unit/ah-XXX-001.test.ts --reporter=verbose
  g) typecheck + lint

C3. 全量验证
  npx vitest run tests/phase-2/ --reporter=dot
  确认 0 failed
  npm run typecheck && npm run lint

阶段 D: Phase 2 Gate 闭环 (预计 1-2 天)

D1. 确认 git status clean
  提交所有新测试 + 重绑 equivalent-mutants.json
  验证: git status --short (必须 clean, 因为 !identity.dirty 是 evidence 发布条件)

D2. 运行 verify:phase2:dev
  node scripts/gates/verify-phase2-local.mjs --mode dev
  确认: success=true, candidateReady=true
  如果 candidateReady=false, 读 blockers 逐个解决

D3. Push 到 origin (public, 有 runner)
  git push origin codex/phase2-integrated
  注意 #35: product (agentharness91) 是 PRIVATE 无 runner, 推到 origin
  注意 #34: ci.yml 不跑 mutation, 只跑 typecheck/build/lint/test/coverage/audit/pack
  等 CI 绿

D4. CI 绿后运行 verify:phase2:local --mode local
  node scripts/gates/verify-phase2-local.mjs --mode local
  22 个命令, 3-4 小时:
    1. check-phase2-manifest
    2. check-workspace-boundaries
    3. check-phase2-assets --mode local
    4. check-contract-drift
    5. check-active-stubs --mode scan
    6. typecheck
    7. check:cycles
    8. build
    9. lint
    10. phase1-regression (npm test --maxWorkers=1, 15min timeout)
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
    23. production-audit (5min timeout)
  可能卡住: #10 (15min), #17 (60min), #22 (60min)
  #18 evaluations 和 #19 data 需要 --mode release, 可能需要外部数据集

  注意 #36: releaseReady 硬编码 false, 目标是 candidateReady=true
  注意 #37: verify:phase2:local 不是"跑一下"就完了, 是 3-4 小时
  注意 #38: evidence 发布需要 6 个前置条件全满足:
    mode==="local" && hasReleaseAuthority && execution.ok &&
    !identity.dirty && identityStable && errors.length===0
  candidateReady 要求 candidateEvidenceCount === 64

D5. 确认结果
  success=true, candidateReady=true, evidence 64/64
  releaseReady=false 是正常的 (需要 CI attestation)

阶段 E: Phase 2 GLM-5.2 xhigh 场景验收 (预计 1 天)

注意: 这不是源码审查 (已经做了 52 个文件), 是场景验收测试。
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

阶段 F: 更新控制状态 (需 CTO 批准)

F1. 在主仓库 agent-harness-v9.1 更新 control/current-state.json:
  Phase 1: status -> VERIFIED, maturity -> {verified: 40}
  Phase 2: status -> VERIFIED, maturity -> {verified: 64}
  Phase 3: status -> IN_PROGRESS
  这是受保护路径, 需要人工确认后才能改

F2. 确认 Phase 3 入口条件 (phase-3.yaml entry_criteria):
  - Previous phase gate passed (Phase 2 verify:phase2:local success=true)
  - All dependencies verified
  - No open P0 blockers

阶段 G: Phase 3 实现 (预计数周)

Phase 3 有 16 个 requirement, 全部 not_started, tests/phase-3/ 目录不存在。
Phase 3 的 16 个 requirement:
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

Phase 3 exit_criteria:
  - hard_constraint_violation: 0
  - routing_regret: <= 15%
  - unnecessary_multi_agent_rate: <= 20%
  - context_isolation: PASS
  - capability_attenuation: PASS
  - merge_conflict_no_hardcoded_rules: PASS
  - independent_glm_5_2_xhigh: PASS

G1. 创建 tests/phase-3/ 目录结构
G2. 读每个 requirement 的 acceptance_criteria
G3. 实现源代码 + 写测试
G4. 跑 Phase 3 gate

══════════════════════════════════════════════════════════════
完整路径总览
══════════════════════════════════════════════════════════════

当前位置: 阶段 A (P0-P13 测试写完已提交, mutation 没跑)

A (30min) → B (8-12h) → C (2-3天) → D (1-2天) → E (1天) → F (需批准) → G (数周)
  提交P12    跑mutation    补薄测试    gate闭环    GLM验收   更新状态    Phase3实现
  修端口     验证阈值      52个文件    22命令      6场景
  typecheck  verify       typecheck   push+CI
             5个补充       lint        3-4h
             40个evidence

每步全绿才进下一步。不删测试, 不降阈值, 不加 skip, 不伪造 evidence。
做完阶段 A-D 之后, 把结果汇总给我, 确认后再做 E-F。
阶段 G 需要单独的详细计划。

先修正 task_plan.md 的 28 个错误, 然后从阶段 A 开始执行。
