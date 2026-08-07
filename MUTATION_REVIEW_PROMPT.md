# 完整审查提示词（38 条，去重合并 + 3 项源码补充）

在 /Users/guanjieqiao/agent-runtime-v7/worktrees/phase2-integrated 工作。
分支 codex/phase2-integrated。所有文件路径用绝对路径。

OK mutation 还在后台跑 gateway（chunk 4/43），要几个小时。
不要等，现在同时做以下事情：

═════════════════════════════════════════════════════════════════
1. gateway 10 个无测试文件
═════════════════════════════════════════════════════════════════

gateway 17 个文件里 10 个没有专用测试文件，靠间接覆盖，mutation score 必然低。
circuit-breaker 已跑出来只有 41%。

为这 10 个文件各创建 tests/gateway/{filename}.test.ts：

  a. tests/gateway/circuit-breaker.test.ts (源54行)
     CLOSED→OPEN(5次失败)→HALF_OPEN(60s)→CLOSED(probe成功)
     failureThreshold边界, probe失败回OPEN
  b. tests/gateway/rate-limiter.test.ts (源43行)
     rpm/tpm/concurrent 滑动窗口 boundary, 窗口过期重置, 拒绝超限请求
  c. tests/gateway/key-vault.test.ts (源148行)
     AES-256-GCM 加解密, 环境变量加载, key rotation, 无key时抛错
     解密篡改报错
  d. tests/gateway/capability-registry.test.ts (源224行)
     model binding, tier匹配(direct/work/route/verify), capability查询,
     pricing, estimateCost, 未知model返回null
  e. tests/gateway/economic-kernel.test.ts (源93行)
     budget创建, 扣费, 退款, 余额检查, 超预算拒绝, 多wallet隔离
  f. tests/gateway/provider-adapters.test.ts (源309行)
     每种provider请求/响应映射, error分类(HTTP 429/500/timeout),
     reasoning_effort, thinking参数, stop_reason=tool_use vs stop
  g. tests/gateway/cache-manager.test.ts (源125行)
     cache key生成(model+messages+temperature), TTL过期, hit/miss, invalidation,
     LRU淘汰
  h. tests/gateway/tool-mask.test.ts (源177行)
     tool可见性过滤, state-dependent masking, allowedTools白名单, deny优先于allow
  i. tests/gateway/dag-executor.test.ts (源232行)
     拓扑排序, 并行执行, 依赖等待, cycle检测, 失败传播, 节点状态转换
  j. tests/gateway/glm-gateway-bridge.test.ts (源103行)
     GLM↔ModelGateway桥接, error映射, provider切换, 流式响应

优先补 provider-adapters(309行) 和 dag-executor(232行), 它们最大。
只加测试文件, 不要改 gateway/ 下的源码, 否则当前 mutation run 结果会失效。
每个文件补完后跑 npx vitest run tests/gateway/{filename}.test.ts 确认 pass。

═════════════════════════════════════════════════════════════════
2. runtime 7+1 个无测试文件
═════════════════════════════════════════════════════════════════

runtime 模块 mutate 11 个文件: harness.ts, errors.ts, harness-support.ts,
hook-port.ts, loop.ts, steering-port.ts, retry.ts, notifications.ts,
event-bus.ts, pause-resume-port.ts, session-tree-port.ts。
A2 只补了 hook-port.ts 的测试，其他 10 个文件靠间接覆盖。
之前 runtime 是 0%（timeout），修了 timeout 后可能还是不到 90%。
检查 tests/runtime/ 下有哪些文件，缺的也要补，特别是:
- loop.ts (最大，core 逻辑)
- retry.ts (重试分类逻辑)
- steering-port.ts (steering queue)

harness.ts 通过 harness-support.test.ts 覆盖，可能不够。
loop.ts 只有 phase-2 间接覆盖, 需要直接测试。

═════════════════════════════════════════════════════════════════
3. session 3 个无测试文件
═════════════════════════════════════════════════════════════════

session mutate: durable-session.ts, sqlite-session-store.ts,
progress-store.ts, run-session.ts。之前只补了 sqlite-session-store (32 tests)。
durable-session.ts 和 progress-store.ts 没有直接测试。

注意: sqlite-store-mutation.test.ts 存在但它测的是 store 层,
durable-session.ts 和 progress-store.ts 没有直接测试。

═════════════════════════════════════════════════════════════════
4. strategies 缺 direct.ts 和 react.ts
═════════════════════════════════════════════════════════════════

strategies mutate: runtime/direct.ts, runtime/react.ts, runtime/plan-execute.ts。
A4 只补了 plan-execute 的测试(22个), direct.ts 和 react.ts 没有新测试。
strategies 83.8% 的 175 个 survived 大部分在这两个文件里。需要各创建专用测试文件：

  a. tests/runtime/direct-strategy.test.ts — direct 策略: 单次 model call, 无 tool call, stop 条件
  b. tests/runtime/react-strategy.test.ts — react 策略: 多轮 tool call, oscillation 检测
     max_iterations, budget 耗尽

注意：plan-execute.ts 只在 strategies 的 mutate 列表里，不在 runtime 的。
之前说"被两个模块共享"是错的。
（原始观察 #9: runtime/plan-execute.ts 同时在 strategies 和 runtime 两个模块的 mutate 列表里。
Stryker 会分别对两个模块跑 mutation，但用的是同一个测试文件。
分析 surviving mutant 时要注意区分是哪个模块的 run 产生的。
如果改了 plan-execute 的测试，两个模块的 score 都会变。
但 #18 更正: 实际上 runtime 的 mutate 列表里没有 plan-execute.ts。
plan-execute.ts 只在 strategies 的 mutate 列表里。）
但 runtime/loop.ts 确实在 runtime 模块里且没有直接测试,
它依赖 plan-execute.ts 的执行逻辑, 测试需要覆盖。

═════════════════════════════════════════════════════════════════
5. vfs/toolsRegistry/verification 有测试但覆盖率不够
═════════════════════════════════════════════════════════════════

不只是补一个文件的测试就够。检查每个模块的 mutate 列表:

  vfs 模块 mutate: virtual-filesystem.ts, composite-backend.ts,
    workspace-transaction.ts。A5 只补了 workspace-transaction.ts (15 tests)。
    virtual-filesystem.ts 和 composite-backend.ts 有没有足够的直接测试?
    已覆盖但 88.2% 需要到 90%。读 mutation.json 找 survived 集中的文件。
  session 模块 mutate: 需要确认 mutate 列表里有哪些文件。
    A6 只补了 sqlite-session-store.ts (32 tests)。
    durable-session.ts 有没有直接测试?
  toolsRegistry 模块 mutate: 需要确认。
    A7 只补了 tool-definitions.ts (40 tests)。
    tool-registry.ts, skill-registry.ts 有没有直接测试?
    全有但 79.9% 差距大，208 survived。读 mutation.json 找集中在哪个文件。
  verification mutate: evidence.ts(有测试), eval-runner.ts(有测试),
    verification-engine.ts(有测试) — A3 加了 evidence-mutation.test.ts (41 tests) 但 84.2% 差 0.8%。
    evidence.ts 通过 tests/ui/ah-ui-evidence-001.test.ts 间接覆盖（UI 测试，
    不是直接测 evidence.ts 的 API）。需要确认直接测试足够覆盖 eval-runner.ts
    和 verification-engine.ts 的 surviving mutant。
  对每个模块: grep mutate 列表, 对照 tests/ 目录, 缺的直接补。

═════════════════════════════════════════════════════════════════
6. toolsLeaf 13 个文件有测试但 60.9%
═════════════════════════════════════════════════════════════════

以下文件有测试文件但需要检查覆盖率是否足够:

toolsLeaf 13 个文件全有测试但 60.9%。需要读
reports/mutation/toolsLeaf/mutation.json 找哪些文件的 survived 最多。
重点看 local-tool-host.ts, create-artifact.ts, ask-user.ts 这几个
可能测试最薄的。


完整的无测试文件清单（已验证）:

gateway (10 个无测试):
  circuit-breaker.ts, cache-manager.ts, dag-executor.ts,
  economic-kernel.ts, key-vault.ts, provider-adapters.ts,
  rate-limiter.ts, tool-mask.ts, capability-registry.ts,
  glm-gateway-bridge.ts

runtime (7 个无测试):
  retry.ts, steering-port.ts, errors.ts, notifications.ts,
  event-bus.ts, pause-resume-port.ts, session-tree-port.ts
  (loop.ts 只有 phase-2 间接覆盖, 需要直接测试)
  (harness.ts 通过 harness-support.test.ts 覆盖, 可能不够)

session (3 个无测试):
  durable-session.ts, sqlite-session-store.ts, progress-store.ts
  注意: sqlite-store-mutation.test.ts 存在但它测的是 store 层,
  durable-session.ts 和 progress-store.ts 没有直接测试。

═════════════════════════════════════════════════════════════════
7. server.test.ts 两个质量问题
═════════════════════════════════════════════════════════════════

  a) startServer 用真实端口(18099/18098/18097)，端口冲突或防火墙会 flaky。
     改成 port: 0（系统分配空闲端口），或 mock createServer。
  b) "uses the provided clock function" 测试断言太弱：
     只检查 deps.authz defined，没验证 clock 真的被调用。
     改成 mock clock，验证调用次数或返回值。

═════════════════════════════════════════════════════════════════
8. 测试文件放置规则（vitest.mutation.config.ts）
═════════════════════════════════════════════════════════════════

Stryker 用 vitest.mutation.config.ts（不是 vitest.config.ts）做测试发现。
该配置排除以下目录的测试：
  tests/coverage/**       — 覆盖率镜像测试不算 mutation evidence
  tests/glm-acceptance/** — 需要 GLM API key，非确定性
  tests/phase-2/**        — Phase 2 测试在 mutation runner 并发下会超时
含义：
  - 测试文件必须放在 tests/{module}/ 下（tests/gateway/, tests/runtime/ 等）
  - 放在 tests/phase-2/ 下的测试不参与 Phase 1 mutation
  - testTimeout: 120_000ms（不是默认 5s）
  - 覆盖率阈值在 mutation config 里禁用（Stryker 自己管理覆盖率分析）

═════════════════════════════════════════════════════════════════
9. 补完所有测试后必须 typecheck + lint
═════════════════════════════════════════════════════════════════

每批测试文件加完后跑:
  npm run typecheck && npm run lint
不只是单个 npx vitest run。typecheck 和 lint 失败会让 verify:phase1:local 挂。

═════════════════════════════════════════════════════════════════
10. 不要碰的东西
═════════════════════════════════════════════════════════════════

  - 不要改 gateway/ 下的源码 (当前 mutation run 正在跑, 改了结果失效)
  - 不要 kill 当前正在跑的 stryker 进程
  - 不要改 mutation/modules.mjs（当前 run 已经加载了配置）
  - 只加测试文件和修测试文件，不改源码

═════════════════════════════════════════════════════════════════
11. chunk 默认超时是 15 分钟，不是 30 分钟
═════════════════════════════════════════════════════════════════

scripts/run-mutation.mjs: defaultChunkTimeoutMs = 15 * 60 * 1000
gateway 和其他模块的 chunkTimeoutMs 没有单独设置（除了 sandbox 用 30 分钟）。
provider-adapters.ts(309行) 和
managed-gateway.ts 的大 chunk 有超时风险。
如果某 chunk 超过 15 分钟会被 kill，算 timeout 失败。
之前 gateway 跑到 chunk 4 (capability-registry.ts:1-150) 花了 ~10 分钟。
注意 capability-registry.ts 和 provider-adapters.ts 这种大文件容易超时。
如果 B1 完整 run 挂在某个 chunk, 需要单独跑那个 chunk:
  node scripts/run-mutation.mjs phase1 --module {module}
如果 B1 跑的时候某个 chunk timeout：
  a) 读 mutation log 确认是哪个 chunk
  b) 给那个模块单独设 chunkTimeoutMs: 30 * 60 * 1000
     （在 mutation/modules.mjs 对应模块里加）
  c) 单独重跑那个模块
注意：改 modules.mjs 会让 configurationHash 变化，所有 waiver 失效。
（原始 #17 误以为 chunkTimeoutMs 是 30 分钟, #19 更正为 15 分钟）

═════════════════════════════════════════════════════════════════
12. Stryker exit code 非 0 直接拒绝接受报告
═════════════════════════════════════════════════════════════════

run-mutation.mjs line 856:
  if (run.status !== 0) {
    throw new Error(`Stryker exited ${run.status} for ${moduleName}/${chunkId}; no report is accepted`);
  }
如果 Stryker 跑完某个 chunk 后 exit code 不是 0（即使 mutation.json
已经生成了），整个模块会被标记为 FAIL，不会合并那个 chunk 的结果。
之前 gateway 0% 就是这个原因: server.ts chunk Stryker exit 1，
整个 gateway 模块没有 result.json。注意看 log 里有没有 "Stryker exited"。
如果某个 chunk 出现 warning 但 exit 0，结果是接受的。
但如果出现 error 导致 exit 非 0，即使 mutation.json 存在也不接受。

═════════════════════════════════════════════════════════════════
13. .stryker-tmp 磁盘压力
═════════════════════════════════════════════════════════════════

Stryker 每个 chunk 创建一个完整 repo sandbox 副本。
gateway 43 chunks + 其他 14 个模块, 总共可能 100+ sandbox。
每个 ~50-100MB, 总计可能 5-10GB。
如果磁盘满了 stryker 会 crash（之前"进程死了"可能就是这个原因）。
定期清理:
  rm -rf .stryker-tmp/2026-08-0*  # 只保留最新 run
不要删当前正在跑的 run 目录。

═════════════════════════════════════════════════════════════════
14. stryker 有 patch 改变了 mutant 激活行为
═════════════════════════════════════════════════════════════════

patches/@stryker-mutator+core+9.6.1.patch 修改了 mutant-test-planner.js：
  原版: mutantActivation = testFilter ? 'runtime' : 'static'
  patched: mutantActivation = isStatic ? 'static' : testFilter ? 'runtime' : 'static'
这个 patch 让 static mutant（模块加载时激活的）在有 testFilter 时
仍然用 static 激活。原版 Stryker 会把所有 mutant 改成 runtime 激活。
这意味着: patch 改变了哪些 mutant 被测试覆盖的行为。
本地和 CI 必须都应用这个 patch，否则 mutation 结果不同。
确认：
  a) package.json 有 patch-package 的 postinstall hook（prepare: patch-package）
  b) CI 的 npm ci 之后会自动 apply patches
  c) 本地 node_modules 里 stryker 确实被 patched


32 条。这是真正的最后一批了。核心是：CI runner 问题（#29）、releaseReady 硬编码（#30）、waiver hash 机制（#31）、
stryker patch（#32）。前两个直接影响步骤 G 能不能过。
═════════════════════════════════════════════════════════════════
15. mutation 运行时间预期
═════════════════════════════════════════════════════════════════

15 个模块，每个多 chunk，gateway 一个就 43 chunks。
每个 chunk 3-5 分钟，总计 5-8 小时。
详细计算：如果每个 chunk 平均 5 分钟, gateway 43 chunks = 3.5 小时。
加上其他 14 个模块, 总计可能 8-12 小时。
（参考：chunk 4 开始于 11:57, chunk 5 开始于 12:07, capability-registry.ts:1-150 花了 ~10 分钟）
不要中途 kill 重跑(除非 crash)。让它一次跑完。
跑的时候同时补测试文件，跑完后 commit，再跑第二轮确认。

═════════════════════════════════════════════════════════════════
16. Mutation 运行监控
═════════════════════════════════════════════════════════════════

跑 mutation 期间用 sleep 1800（30 分钟）等待后检查进度。
检查 .stryker-tmp/ 下最新 run 目录确认当前 chunk。
确认进程仍在运行（ps aux | grep stryker）。
如果进程已退出（非正常完成），读 mutation log 确认是 crash 还是完成。
不要 kill 进程，除非 crash（见第 10 条）。
mutation run 正常完成后会生成 reports/mutation/{module}/result.json。

═════════════════════════════════════════════════════════════════
17. 当前 mutation run 结束后要做什么
═════════════════════════════════════════════════════════════════

当前 run 是基于 HEAD 9827b61 跑的。你加的 10 个 gateway 测试 + strategies 测试
+ runtime 测试不会包含在这次 run 里。

这次 run 跑完后:
a) 读所有 15 个模块的 reports/mutation/{module}/result.json
b) 对每个 FAIL 模块，读 mutation.json 找 surviving mutant 的具体文件+行号+mutator
c) 针对性补测试杀掉它们
d) commit 所有新测试
e) 重新跑 npm run test:mutation:phase1（完整重跑，基于新 commit）
f) 重复直到 15/15 PASS
g) 跑 npm run verify:phase1:local 确认全链绿

═════════════════════════════════════════════════════════════════
18. 7 个 PASS 模块可能回归
═════════════════════════════════════════════════════════════════

当前 7 个 PASS 模块的结果基于旧 commit (8723ee8 等)。
你加了 213 个新测试文件, 改了 typecheck/lint 环境。
B1 重跑时 ALL 15 个模块都会重新跑, 不只是 8 个 FAIL 的。
7 个 PASS 的模块如果因为新测试文件引入了 import cycle 或 typecheck
错误, 可能从 PASS 变 FAIL。
B1 跑完后必须确认 15/15 PASS,
不是只看之前 8 个 FAIL 的修没修好。

═════════════════════════════════════════════════════════════════
19. 每个模块的 minimum 阈值不同，不能搞混
═════════════════════════════════════════════════════════════════

从 mutation/thresholds.json:
  85%: gateway, toolsLeaf, skills, strategies, verification, verticals, uiAdapters
  90%: router, toolsRegistry, actionControl, identitySecrets, vfs, sandbox, session, runtime
session 81.3% 要到 90% 需要杀 ~80 个 mutant（914 total, 差 8.7%）。
runtime 之前 0%，修了 timeout 后如果 score 不到 90% 也 FAIL。
toolsRegistry 79.9% 要到 90% 需要杀 ~117 个 mutant（1156 total, 差 10.1%）。
这些是 minimum=90 的模块，比 minimum=85 的难修得多。
优先级应该按 (gap × total_mutants) 排序，不是只看百分比差距。
这是最后一批了。1-23 条合起来是完整的审查结果。

═════════════════════════════════════════════════════════════════
20. test:mutation:check 独立验证 mutation artifact
═════════════════════════════════════════════════════════════════

npm run test:mutation:check 调的是 scripts/check-mutation-thresholds.mjs。
这个脚本不是读 result.json 的 score 字段就信了,
它会:
  a) 用 @stryker-mutator/instrumenter 重新验证 mutant identity
  b) 读 trusted git blob 确认 source 文件没被篡改
  c) 重新计算 score
  d) 检查 equivalent-mutant waiver 的 SHA + config hash 是否匹配
这意味着：
  - 不能手动改 result.json 里的 score 数字
  - equivalent-mutants.json 的 commit_sha 和 configuration_hash
    必须和当前 HEAD + stryker.config 的 hash 完全匹配
  - 如果 instrumenter 版本不匹配（本地 9.6.1 vs CI 9.6.1），
    mutant identity 可能不同，waiver 全部失效
B1 跑完后必须也跑一次 npm run test:mutation:check 确认。
verify:phase1:local 包含这一步吗? 检查 package.json 的 verify:phase1:local:
  npm run typecheck && npm run check:cycles && npm run build &&
  npm run lint && npm test && npm run test:coverage &&
  npm run test:mutation:phase1
没有 test:mutation:check! verify:phase1:local 不包含独立验证。
B2 之后需要单独跑:
  npm run test:mutation:check

═════════════════════════════════════════════════════════════════
21. verify:phase1:local 缺少 5 个必需检查
═════════════════════════════════════════════════════════════════

verify:phase1:local 的命令链:
  typecheck → check:cycles → build → lint → test → test:coverage → test:mutation:phase1
但 Phase 1 exit_criteria 要求的东西这个链不包含:
a) independent_glm_5_2_xhigh: PASS
   → 需要单独跑 npm run test:glm:live
   → 需要 GLM_API_KEY
   → verify:phase1:local 不包含这个
b) domain_evals_all_pass: true
   → evals/ 目录下只有 phase-2.yaml，没有 phase-1.yaml
   → Phase 1 的 6 个 domain evals 文件不存在
   → 这个 exit_criteria 无法满足
c) crash_restore_no_duplicate: PASS
   → tests/session/crash-restore.test.ts 存在但只有 3 个测试
   → 需要确认这 3 个测试是否真正验证了 "崩溃恢复无重复执行"
d) active_stub_count: 0
   → 需要跑 check:phase2:active-stubs
   → verify:phase1:local 不包含这个
e) test:mutation:check (独立验证)
   → verify:phase1:local 跑的是 test:mutation:phase1 (生成 mutation)
   → 但不跑 test:mutation:check (独立验证 mutation artifact 完整性)
   → 需要在 mutation 跑完后单独跑
B2 的正确步骤应该是:
  npm run verify:phase1:local  (typecheck/cycles/build/lint/test/coverage/mutation)
  npm run test:mutation:check  (独立验证 mutation artifact)
  npm run test:glm:live        (GLM 独立验证，需要 GLM_API_KEY)
  node scripts/gates/check-active-stubs.mjs  (确认 active_stub_count=0)
  确认 tests/session/crash-restore.test.ts 的 3 个测试覆盖 "无重复执行"
  确认 domain evals 文件存在或这个 exit_criteria 被标记为 N/A

═════════════════════════════════════════════════════════════════
22. GLM live acceptance 缺失
═════════════════════════════════════════════════════════════════

verify:phase1:local 不包含 GLM 独立验证。
Phase 1 exit_criteria 里有 independent_glm_5_2_xhigh: PASS。
在 B2 通过后需要额外跑：
  npm run test:glm:live
需要 GLM_API_KEY 环境变量。
结果存到 evidence/ 目录。
这是 Phase 1 gate 的硬性要求，不能跳过。

═════════════════════════════════════════════════════════════════
23. Phase 1 domain evals 文件不存在
═════════════════════════════════════════════════════════════════

evals/ 目录下只有 phase-2.yaml 文件：
  evals/coding/phase-2.yaml
  evals/documents/phase-2.yaml
  evals/research/phase-2.yaml
  evals/writing/phase-2.yaml
  evals/planning/phase-2.yaml
  evals/personal-assistant/phase-2.yaml
  evals/multimodal/phase-2.yaml
没有 phase-1.yaml。
Phase 1 exit_criteria: domain_evals_all_pass: true
需要确认这是硬性要求还是 N/A。如果是硬性要求，需创建 6 个
evals/{domain}/phase-1.yaml 文件。
两种可能：
  a) Phase 1 的 evals 在主仓库 agent-harness-v9.1 的 spec/ 下
     (phase2-integrated 是扁平 monorepo, 结构不同)
  b) Phase 1 的 evals 从来没创建过

═════════════════════════════════════════════════════════════════
24. active_stub_count 检查
═════════════════════════════════════════════════════════════════

Phase 1 exit_criteria: active_stub_count: 0
需要跑 node scripts/gates/check-active-stubs.mjs
verify:phase1:local 不包含这个检查。
check-active-stubs.mjs 会扫描 source 文件里的 SEMANTIC_STUB_MARKERS
（如 "not implemented"、"placeholder"、"TODO" 等），
报告哪些 requirement 仍有 active stub。必须全部消除才能 active_stub_count=0。

═════════════════════════════════════════════════════════════════
25. crash_restore_no_duplicate
═════════════════════════════════════════════════════════════════

Phase 1 exit_criteria: crash_restore_no_duplicate: PASS
tests/session/crash-restore.test.ts 存在但只有 3 个测试。
需要确认这 3 个测试是否真正验证了"崩溃恢复无重复执行"：
  - 崩溃后从最后快照恢复，不重复已完成的 step
  - 恢复后从正确的 iteration 继续，不跳过
  - 崩溃前写入的 side effect 不会在恢复后被重复执行
如果 3 个测试不够覆盖这些场景，需要补测试。

37 条。核心是 verify:phase1:local 不包含 GLM 验证、domain evals 文件不存在、mutation:check 没跑、active-stubs 没
检查。这些是 Phase 1 gate 的 exit criteria，不满足就过不了

═════════════════════════════════════════════════════════════════
26. 本地 node v24 vs CI node v20
═════════════════════════════════════════════════════════════════

本地跑的是 node v24.18.0，CI 跑的是 node 20。
Stryker 和 vitest 的行为可能不同（V8 引擎差异、ABI 不兼容的 native 模块）。
特别是 better-sqlite3 和 bcrypt 这两个 native 模块，
node 24 和 node 20 的编译产物不同。
本地 mutation PASS 不代表 CI 上也 PASS。
如果 CI 上 mutation FAIL 但本地 PASS，检查 node 版本差异。
G5 等 CI 绿的时候要确认 CI 上的 mutation 结果和本地一致。

═════════════════════════════════════════════════════════════════
27. CI 用 --maxWorkers=1，本地没有限制
═════════════════════════════════════════════════════════════════

ci.yml 里: npm test -- --maxWorkers=1
本地跑 vitest 时没限 maxWorkers，默认用 CPU 核数并行。
这会导致本地 pass 但 CI 上因为串行跑更慢而 timeout。
B2 (verify:phase1:local) 跑的时候也加 --maxWorkers=1：
  npm test -- --maxWorkers=1
  npm run test:coverage -- --maxWorkers=1
确保本地结果和 CI 一致。

═════════════════════════════════════════════════════════════════
28. coverage threshold 可能因为新测试文件下降
═════════════════════════════════════════════════════════════════

vitest.config.ts 的 coverage thresholds: lines 80%, branches 75%, functions 80%。
新加的测试文件如果 import 了 uncovered 代码，coverage 数字会变。
但更可能的问题是：新测试文件本身可能拉低 coverage（如果测试文件里有
未覆盖的 helper 函数）。
B2 跑 test:coverage 时如果 FAIL，检查 coverage report 里哪些文件
的行数下降，可能是新测试文件引入的。

═════════════════════════════════════════════════════════════════
29. 全部 39 个 Phase 1 evidence 文件的 SHA 都是过期的
═════════════════════════════════════════════════════════════════

artifacts/phase-1/ 下 39 个 evidence 文件的 commit_sha 全部是
bd85e7edc564（8月5日的 commit），当前 HEAD 是 9827b614ccf0。
0 个是 current，39 个 stale。
B2 跑完 verify:phase1:local 后必须重新生成所有 39 个 evidence：
  对每个 Phase 1 requirement：
    a) 用新 HEAD 跑对应测试
    b) 生成 evidence.json（commit_sha=新HEAD, tree_sha=新tree）
    c) 重新跑 GLM 5.2 xhigh 独立验证
    d) 写到 artifacts/phase-1/{requirement_id}/evidence.json
如果不更新，gate 会报 evidence SHA mismatch，
verify:phase1:local 和 verify:phase2:local 都会 FAIL。

═════════════════════════════════════════════════════════════════
30. control/ 和 spec/requirements/ 在这个分支不存在
═════════════════════════════════════════════════════════════════

control/current-state.json — 不存在
spec/requirements/requirements.ndjson — 不存在
evidence/gate-phase1.json — 不存在
这些文件在主仓库 agent-harness-v9.1 的 fix/all-52-problems 分支上。
phase2-integrated 分支是扁平 monorepo，没有 control/ 和 spec/requirements/。
这意味着：
  a) 步骤 H1（更新 control/current-state.json）不能在这个分支做，
     需要切回主仓库操作
  b) gate 的 all_requirements_verified check 无法在这个分支跑
     （它读 requirements.ndjson）
  c) Phase 1 的 39 个 requirement 的 implementation_maturity 状态
     不在这个分支上管理
需要在某个时刻把 phase2-integrated 的成果合并回主仓库，
或者在主仓库补上 control/ 和 spec/requirements/。
步骤 B2 (verify:phase1:local) 跑的是 scripts/gates/verify-phase2-local.mjs，
不读 requirements.ndjson。但最终 gate 闭环需要这个文件。

═════════════════════════════════════════════════════════════════
31. equivalent-mutants.json 未提交且需要重绑
═════════════════════════════════════════════════════════════════

git status 一直显示 M mutation/equivalent-mutants.json。
当前 waiver 绑定的是旧 commit SHA。你加完所有测试 commit 时:
  a) 把 equivalent-mutants.json 一起 commit
  b) commit 后用新 SHA 重绑 waiver:
     读 mutation/equivalent-mutants.json, 把所有 commit_sha 改成新 HEAD
  c) 读 mutation/stryker.base.mjs，确认 config hash 计算，更新 configuration_hash
run-mutation.mjs 的 normalizedAuthorityContent() 函数:
  过滤掉 commitSha 和 configurationHash 字段后再 hash。
所以改 commitSha 不影响 configurationHash。
但改 mutation/modules.mjs（比如调 chunkTimeoutMs）会影响 configurationHash，
因为 modules.mjs 在 mutationAuthorityFiles 列表里。
如果给 gateway 加了 10 个测试文件但没改 modules.mjs:
  configurationHash 不变 → 旧 waiver 仍然有效 (如果 commitSha 匹配)
如果改了 modules.mjs (比如调整 chunkTimeoutMs):
  configurationHash 变了 → 所有 waiver 的 configurationHash 失效
  必须重新生成所有 waiver
所以: 补测试文件不改 modules.mjs 是安全的。
但如果要调 chunkTimeoutMs 或加新文件到 mutate 列表，
必须同时重绑所有 waiver 的 configurationHash。
不重绑的话 mutation gate 会报 waiver SHA mismatch，全部失效。

═════════════════════════════════════════════════════════════════
32. 本地 HEAD 超前 remote
═════════════════════════════════════════════════════════════════

本地 HEAD: 9827b614 (12:16)
origin/product HEAD: 366aa96 (09:46)
本地有 3 个未推送的 commit + 即将补的 20+ 个测试文件。
未推送的 commit 包括：
  9827b61 docs: update progress notes
  c5ee923 test: add mutation tests for tool-definitions + search-files
  294ced8 test: add mutation tests for vfs + session
加上等下要补的 gateway 10 个测试文件 + strategies + runtime，未推送的 commit 会更多。
G3-G4 push 之前必须确认:
  a) 所有新测试 typecheck + lint + test 全 pass
  b) git status clean（包括 equivalent-mutants.json）
  c) 本地 HEAD 和将要 push 的 remote HEAD 差距清楚
不要 push 半成品，CI 会 FAIL，浪费 GitHub Actions 额度。

═════════════════════════════════════════════════════════════════
33. reports/ 在 .gitignore 里
═════════════════════════════════════════════════════════════════

.gitignore 里有 reports/。
所有 mutation 的 result.json 和 mutation.json 都在 reports/mutation/ 下。
它们不会被 git track，不会 push 到 remote。
这意味着：
  a) 本地跑的 mutation 结果在 CI 上不存在
  b) CI 必须自己重新跑 mutation（通过 phase2-mutation.yml workflow）
  c) check-mutation-thresholds.mjs 在 CI 上读的是 CI 自己跑的 result.json
  d) 本地 verify:phase1:local 能过是因为本地有 reports/，
     CI 上 verify 如果不先跑 mutation 会找不到 result.json
phase2-mutation.yml workflow 会跑 mutation 然后 upload-artifact +
attest-build-provenance。但 ci.yml (Phase 1 CI) 不跑 mutation，
只跑 typecheck/build/lint/test/coverage/audit/pack。
所以 CI 绿 ≠ mutation PASS。
G5 "确认 CI 绿" 只能确认 typecheck/build/lint/test/coverage 通过。
mutation PASS 需要单独触发 phase2-mutation.yml workflow (workflow_dispatch)。


35 条了。这三条的核心是：reports/ 不被 git track 所以 CI 要自己跑 mutation，CI 的 ci.yml 不包含 mutation 步骤，
releaseReady/formalAttivation 是硬编码需要 CI attestation。
═════════════════════════════════════════════════════════════════
34. CI 不跑 mutation/verify/GLM
═════════════════════════════════════════════════════════════════

ci.yml 的步骤：
  npm ci → build:workspaces → typecheck → check:cycles → build →
  lint → test → test:coverage → audit → pack
没有：
  - npm run test:mutation:phase1 (mutation)
  - npm run test:mutation:check (threshold 验证)
  - npm run verify:phase1:local (完整 gate)
  - npm run test:glm:live (GLM 验证)
CI 绿只证明代码能编译和测试通过，不证明 mutation 和 GLM 验证通过。
步骤 G5 之后需要手动触发：
  gh workflow run phase2-mutation.yml --repo 123oqwe/agent-harness-v9.1
然后等它跑完，下载 artifact 确认 mutation 全 PASS。

═════════════════════════════════════════════════════════════════
35. product 仓库 CI 无 runner
═════════════════════════════════════════════════════════════════

agentharness91 (product 仓库，private) 最近 5 次 CI run 全部 failure。
最近一次 (366aa96) 2 秒就失败了 — 没有 runner 分配。
这是私有仓库 GitHub Actions 免费额度耗尽的老问题。
之前 Phase 2 ledger 记录过 "将仓库从 private 改为 public 恢复 runner 分配"。
origin 仓库 (agent-harness-v9.1) 是 public，有 runner。
但 product 仓库 (agentharness91) 是 private，没 runner。
G5 "等 CI 绿" 要明确推到哪个仓库：
  - origin (public): 有 runner，CI 能跑
  - product (private): 没 runner，CI 2 秒就 FAIL
如果 gate 需要 product 仓库的 CI attestation：
  a) 把 agentharness91 改成 public，或
  b) 只推 origin，gate 用 origin 的 CI attestation
先确认 verify-phase2-local.mjs 的 formalAuthority 读的是哪个 remote。

═════════════════════════════════════════════════════════════════
36. releaseReady 硬编码 false + formalAuthority 硬编码
═════════════════════════════════════════════════════════════════

verify-phase2-local.mjs line 882:
  const releaseReady = false;
不管 gate 结果怎样，releaseReady 永远是 false。
这是 by design — releaseReady 需要 CI attestation，
而本地无法提供 CI attestation。
formalAuthority.status 永远是 "external_attestation_required"（硬编码）：
  formalAuthority: {
    source: "github-actions-exact-sha-attestation",
    status: "external_attestation_required",
    exactSha: postIdentity.bindings?.commitSha ?? null,
  }
不管 local 还是 dev 模式，status 永远是 "external_attestation_required"。
本地无法满足这个 attestation — 需要 GitHub Actions 的
actions/attest-build-provenance 提供 sigstore 签名。
mode=local 时 success = readiness.candidateReady，不是 releaseReady。
所以步骤 G6 "确认 success=true, releaseReady=true" 是不可能的。
正确的目标应该是:
  mode=local: success=true (即 candidateReady=true)
  releaseReady 永远是 false，需要 CI attestation 才能变 true
  CI attestation 不是本地能做的
G6 的验证标准应该是 candidateReady=true，不是 releaseReady=true。
不要在本地死磕 releaseReady=true。
唯一能拿到 releaseReady=true 的方式是修改 verify-phase2-local.mjs
让它读 CI 上载的 attestation artifact。
或者在 CI 上跑一个不同的 gate 脚本（如果有）。

═════════════════════════════════════════════════════════════════
37. verify:phase2:local --mode local 跑 22 个命令，不是只有 verify:phase1:local 的 7 个
═════════════════════════════════════════════════════════════════

注意：步骤 F1 用 verify:phase2:dev（只跑 5 个命令：manifest + workspace-boundaries
+ assets + contract-drift + phase2-unit），和 G6 用的 verify:phase2:local --mode local 不同。
G6 不是"跑一下确认 success=true"就完了。它在本地跑全部 22 个命令，
预计耗时 3-4 小时。
  1. check-phase2-manifest
  2. check-workspace-boundaries
  3. check-phase2-assets --mode local
  4. check-contract-drift
  5. check-active-stubs --mode scan
  6. typecheck
  7. check:cycles
  8. build
  9. lint
  10. phase1-regression (npm test --maxWorkers=1, timeout 15min)
  11. coverage (test:coverage --maxWorkers=1, timeout 15min)
  12. workspace-coverage (check-workspace-coverage.mjs)
  13. phase2-unit (timeout 10min)
  14. phase2-integration (timeout 5min)
  15. phase2-security (timeout 5min)
  16. phase2-e2e (timeout 10min)
  17. mutation (test:mutation:phase2, timeout 60min)
  18. evaluations (run-phase2-evals.mjs --mode release, timeout 15min)
  19. data (run-phase2-data.mjs --mode release, timeout 15min)
  20. package-smoke (timeout 5min)
  21. workspace-smoke (timeout 5min)
  22. source-checkout-reproduction (timeout 60min)
  23. production-audit (npm audit --omit=dev, timeout 5min)
其中 3 个可能卡住：
  - #10 phase1-regression: 15 分钟跑全部 Phase 1 测试 (串行 --maxWorkers=1)
  - #17 mutation: 60 分钟跑 Phase 2 mutation (64 个 requirement)
  - #22 source-checkout-reproduction: 60 分钟，从 source checkout 重新构建验证
#18 evaluations 和 #19 data 需要 --mode release，可能需要外部数据集。
如果任何一个命令超时或 FAIL，G6 会报 blocker，不会 success=true。
计划里 G6 的预估时间不够，需要明确告诉 session 这是一个 3-4 小时的操作。

═════════════════════════════════════════════════════════════════
38. Evidence 发布机制（RELEASE_AUTHORITY）
═════════════════════════════════════════════════════════════════

verify-phase2-local.mjs line 641:
  RELEASE_AUTHORITY = Symbol("phase2-release-authority")
CLI 运行（node scripts/gates/verify-phase2-local.mjs --mode local）
传递 RELEASE_AUTHORITY 作为 authority token（line 972）。
verifyPhase2() export 不传递（undefined）— 只有 CLI 有发布 authority。

Evidence 发布在 gate run 内部发生（lines 763-768），不是单独步骤。
6 个前置条件全部满足才发布：
  mode==="local" && hasReleaseAuthority && execution.ok &&
  !identity.dirty && identityStable && errors.length===0
createPhase2EvidenceRecords 从 manifest requirements + command receipts
生成 64 条记录。publishPhase2Evidence 写入磁盘 + SHA 验证。
verifyEvidenceBundle 独立重新验证已发布 evidence。
发布后还有 identity check：repo 在发布后变化则 evidence 被撤销。
Evidence 发布要求完整 commit SHA（40 或 64 字符，line 539）。

candidateReady 要求 candidateEvidenceCount === 64（line 654）。
22 个命令中任何一个失败 → 不发布 evidence → candidateReady = false。
所以 G6 的 candidateReady=true 要求：22 命令全过 + evidence 64/64。

═════════════════════════════════════════════════════════════════
总结：执行顺序
═════════════════════════════════════════════════════════════════

1. 补测试文件（第 1-9 条），mutation 在后台跑
2. mutation 跑完后读结果，针对性补测试杀 surviving mutant（第 17 条）
3. commit 所有新测试 + 重绑 equivalent-mutants.json（第 31 条）
4. 重跑 npm run test:mutation:phase1 确认 15/15 PASS（第 17-19 条）
5. 跑 npm run test:mutation:check 独立验证（第 20 条）
6. 跑完整 B2 步骤（第 21-28 条）
7. 重新生成 39 个 Phase 1 evidence（第 29 条）
8. Phase 2 mutation + evidence + gate（第 36-38 条）
9. 推送 + CI + verify:phase2:local
   - G6 目标是 candidateReady=true，不是 releaseReady=true（第 36 条）
   - candidateReady 要求 22 命令全过 + evidence 64/64（第 38 条）
   - verify:phase2:local 要 3-4 小时（第 37 条）
   - CI 不跑 mutation，需单独触发 phase2-mutation.yml（第 34 条）
   - product 仓库没 runner，推到 origin（第 35 条）
10. 更新 control/current-state.json，需在主仓库做，需 CTO 批准（第 30 条）

每步全绿才进下一步。不删测试、不降阈值、不加 skip、不伪造 evidence。

给我总结一下变成完整的提示词 不要忽视每一个细节 但是删除重复的内容 不要hallucinate 这是个大人物 仔细想怎么做 做好了要仔细检查里面的每一项细节
