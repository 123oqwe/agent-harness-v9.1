# Phase 3 Implementation Plan — Adaptive Routing & Multi-Agent

> 生成时间: 2026-08-16 06:30 Asia/Shanghai
> 工作目录: /Users/guanjieqiao/agent-runtime-v7/worktrees/phase2-integrated
> 分支: codex/phase2-integrated
> 前置状态: Phase 2 gate 全绿（run 31910167679 SUCCESS，OCI flake 已修 2d826df2）；任务 #7 Phase 1 mutation 重跑进行中
> 规格权威位置: /Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/requirements/requirements.ndjson + spec/phases/phase-3.yaml（受保护路径，只读）

---

## 一、入口状态核查（已完成）

**16 条 Phase 3 requirements 全部 `not_started`，`tests/phase-3/` 不存在，无 phase-3 gate。**

外部依赖全部已实现/已验证（来源：spec implementation_maturity + 工作树文件存在性核对）：

| 依赖 | 阶段 | 状态 | 工作树对应物 |
|------|------|------|--------------|
| AH-CONTRACT-RUNPLAN-001 | 0 | verified | contracts/generated/run-plan.schema.json |
| AH-CONTRACT-TOOLSPEC-001 | 0 | verified | contracts/generated/tool_spec.ts |
| AH-CAPABILITY-001 | 1 | implemented | security/capability.ts |
| AH-POLICY-ENGINE-001 | 1 | implemented | security/policy-engine.ts（PolicyEngine, deriveRiskTier） |
| AH-SANDBOX-001 | 1 | implemented | sandbox/ |
| AH-TOOL-REGISTRY-001 | 1 | implemented | tools/tool-registry.ts |
| AH-RUNTIME-STEERING-001 | 2 | implemented | runtime/steering-port.ts |
| AH-SANDBOX-OCI-001 | 2 | implemented | packages/tools/src/oci-sandbox.ts |

唯一内部依赖：`AH-ROUTER-DAG-001` → `AH-MULTIAGENT-DAG-001` → `AH-AGENT-AUTHORING-001`；`AH-TOOL-VIDEO-GEN-001` → `AH-TOOL-VIDEO-EDIT-001`。

**布局说明**：spec 的 `source_files` 引用 `harness/...`（Phase 1 主仓库布局），本工作树是扁平 monorepo。所有实现落在真实布局（`router/ runtime/ security/ tools/` + `tests/`），文件名遵循现有 camelCase 约定（如 `router/static-router.ts`）。

---

## 二、实施顺序（依赖拓扑）

```
WP-1  AH-ROUTER-DAG-001  (枢纽，14 阶段顺序管线)
  ├─ WP-2 路由扩展: DAG-FAILURE, FALLBACK-11, BUDGET-DYNAMIC, CONTEXT-TOPOLOGY, SKILL-CHAIN
  ├─ WP-3 多智能体:  MULTIAGENT-DAG, SUBAGENT, MULTIAGENT-MERGE, AGENT-AUTHORING
  └─ WP-5  EVAL:     AH-ROUTER-EVAL-001 (precondition: Router DAG implemented)
WP-4  工具: VIDEO-GEN → VIDEO-EDIT; MUSIC-GEN; BROWSER; COMPUTER  (依赖全部就绪)
WP-0  Gate 脚手架: phase3-gate.json + verify-phase3-local.mjs（随各 WP 并行补齐）
```

### WP-1 — AH-ROUTER-DAG-001（P0，唯一枢纽）

- **文件**: `router/pipeline.ts` + `tests/router/dag-pipeline.test.ts`（+ no-parallel / policy-isolation 测试）
- **基座**: `router/static-router.ts`（IntentProfile/ReasoningStrategy/RoutingResult）、`security/policy-engine.ts`、`contracts/generated/`（agent_graph/context_graph/action_manifest/model_binding）
- **14 阶段**（逐阶段实现，禁止 Promise.all 并行）：Identity/Policy → Profiler → Domain/Experience → Context/Capability → Workflow → Strategy → Model/Tool/Skill/Env → AgentGraph → ContextGraph → Schedule → VerificationGraph → Constraint Solver → Policy Validation → RunPlan
- **验收硬点**：输出 `derived_risk_assessment`/`required_consent`（非 risk_policy/consent_policy）；Policy 外部不可变约束且先进入；除 Task Profiler 外零 LLM 调用；按任务画像选 `execution_mode`（static_dag/routing_slip/workflow_script）
- **验证**: 新增测试过 + `npx tsc -b` + `eslint` + 全量 `vitest run tests/router` 绿 → 才进 WP-2
- **状态** (2026-08-19): ✅ 已实现（router/pipeline.ts + tests/router/dag-pipeline.test.ts / no-parallel.test.ts / policy-isolation.test.ts + pipeline-setup.ts）；tsc -b + eslint + 321 router tests 全绿。未提交（保持 re-run 目标 SHA=5f3d795b 干净，pipeline.ts 不在 mutation modules mutate 列表，不影响 re-run）。

### WP-2 — 路由扩展（5 条，各依赖 DAG）

| Req | 文件 | 测试 | 验收要点 |
|-----|------|------|----------|
| AH-ROUTER-DAG-FAILURE-001 | router/dag-failure.ts | tests/router/dag-failure.test.ts | 11 类失败；critical 路径失败中止全 DAG；非 critical 不波及兄弟；下游标 BLOCKED 非 FAILED（状态：✅ 已实现，tsc + eslint + vitest 11/11 全绿，未提交） |
| AH-ROUTER-FALLBACK-11-001 | router/fallback.ts | tests/router/fallback-11.test.ts | 11 类 fallback；retryable 分类；禁回主（loop 防护）；级联失败→durable pause+通知（状态：✅ 已实现，eslint + vitest 12/12 全绿，未提交） |
| AH-ROUTER-BUDGET-DYNAMIC-001 | router/budget-dynamic.ts | tests/router/budget-dynamic.test.ts | 子 agent 预算从父剩余分配；不可超支；重分配需父批准事件；耗尽立即停（无 overshoot）（状态：✅ 已实现，eslint + vitest 9/9 全绿，未提交） |
| AH-ROUTER-CONTEXT-TOPOLOGY-001 | router/context-topology.ts | tests/router/context-topology.test.ts | 7 拓扑 + 隔离验证（isolated 互不可读；shared_selective 显式共享；parent_child 子不可见父全量；VFS 权限层强制）（状态：✅ 已实现，eslint + vitest 13/13 全绿，未提交） |
| AH-ROUTER-SKILL-CHAIN-001 | router/skill-chain.ts | tests/router/skill-chain.test.ts | skill 输出接输入；MCP discovery 扫描；每 skill 需 capability token；链失败保留部分结果（状态：✅ 已实现，eslint + vitest 9/9 全绿，未提交） |

### WP-3 — 多智能体（4 条）

| Req | 文件 | 测试 | 验收要点 |
|-----|------|------|----------|
| AH-MULTIAGENT-DAG-001 | router/multiagent-dag.ts | tests/router/multiagent-dag.test.ts | 带边 DAG；拓扑排序；同级并行；环检测→typed error（状态：✅ 已实现，tsc + eslint + vitest 全绿，未提交） |
| AH-SUBAGENT-001 | security/subagent.ts | tests/security/subagent-capability.test.ts + parent-cannot-sign.test.ts | Parent 建 ChildTaskManifest；Authorization Service 评估并**签名 Child Capability（非 parent）**；Capability 绑定 manifest_hash/delegation_proof/budget_ceiling/tool_grants 子集/delegation_depth（状态：✅ 已实现，tsc + eslint + vitest 全绿，未提交） |
| AH-MULTIAGENT-MERGE-001 | runtime/merge-conflict.ts | tests/runtime/merge-conflict.test.ts + stale-base.test.ts | stale base 检测；语义冲突分析；可重放则 rebase/replay；supervisor 评估（状态：✅ 已实现，tsc + eslint + vitest 全绿，未提交） |
| AH-AGENT-AUTHORING-001 | tools/agent-authoring.ts | tests/tools/agent-authoring.test.ts | frontmatter→AgentGraph node；body→system_prompt；校验；agents/ + ~/.harness/agents/ 双扫描（状态：✅ 已实现，tsc + eslint + vitest 24/24 全绿，未提交） |

**WP-3 状态** (2026-08-22): ✅ 四条全部实现。6 个测试文件 77/77 全绿 + `npx tsc --noEmit` exit 0 + eslint 全绿。未提交（保持 re-run 目标 SHA 干净，WP commit 待 re-run 绿后统一提交）。

### WP-4 — 工具（5 条，依赖全部就绪）

| Req | 文件 | 测试 | 验收要点 | 状态 |
|-----|------|------|----------|------|
| AH-TOOL-VIDEO-GEN-001 | tools/generate-video.ts | tests/tools/generate-video.test.ts | ToolSpec http_api/media_gen/non_idempotent/T3；zod 校验；video:generate scope 能力 token（T3 consent）；secrets-broker 单次交换 API key | ✅ handler + schema + spec + 测试已写，tsc/eslint 绿；vitest 已跑 8/8 绿 |
| AH-TOOL-MUSIC-GEN-001 | tools/generate-music.ts | tests/tools/generate-music.test.ts | 同上，T2，music:generate scope | ✅ handler + schema + spec + 测试已写，tsc/eslint 绿；vitest 已跑 8/8 绿 |
| AH-TOOL-VIDEO-EDIT-001 | tools/edit-video.ts | tests/tools/edit-video.test.ts | ToolSpec cli_wrapper/media_edit/ffmpeg ref；command 枚举校验；video:edit scope | ✅ handler + schema + spec + 测试已写，tsc/eslint 绿；vitest 延后（hands-off） |
| AH-TOOL-BROWSER-001 | tools/browser-operate.ts | tests/tools/browser-operate.test.ts | Playwright/CDP 封装 + typed action schema；隔离 profile + origin allowlist；页面/截图内容标 untrusted；per-origin capability + T3 写精确预览 | ✅ handler + CDP adapter + schema + spec + 测试已写，tsc/eslint 绿；vitest 延后（hands-off） |
| AH-TOOL-COMPUTER-001 | tools/computer-operate.ts | tests/tools/computer-operate.test.ts | 截图/click/type/key/clipboard；per-app capability；单控制器锁 + 消费式全局 interrupt；默认排除自身终端/批准 UI；terminal/IDE/Finder/系统设置 = sentinel 需升级同意 | ✅ handler + reference adapter + schema + spec + 测试已写，tsc/eslint 绿；vitest 延后（hands-off） |

**WP-4 状态** (2026-08-22): ✅ 五条全部实现 + 接入调度链。
- 声明层：`tools/phase3-tool-definitions.ts`（`createPhase3ToolDefinitions`，不动 `createPhase1ToolDefinitions`）；10 个 JSON schema 已就位。每份 ToolSpec 的 `effect_model` 显式声明冻结验收要求的属性（contract 无独立字段，free-form effect_model 承载）：video/music_gen `transport='http_api'`+`tool_group='media_gen'`+`risk='T3'/'T2'`；video_edit `transport='cli_wrapper'`+`tool_group='media_edit'`+`cli_toolchain_ref='ffmpeg'`+`risk='T2'`；browser_operate `transport='wrapper'`+`tool_group='web_automation'`+`risk='T3'`（spec 要求 T3 写精确预览）；computer_operate `transport='wrapper'`+`tool_group='desktop_automation'`（spec 未钉 tier，不发明 risk 键）。deriveRiskTier 派生值（均 T5）≥ 声明值，保守不越界。
- 调度层：`tools/phase3-tool-handlers.ts`（`createPhase3ToolHandlers`，5 个 ToolImplementation 吃 ToolExecutorDeps 的 vfs/credentials/sandbox）；`tools/local-tool-host.ts` 新增 `extraHandlers`（不动 Phase 1 switch）；`harness.ts` HarnessConfig 新增 `extraToolHandlers` 并透传。
- 组合根：`gateway/server.ts` 把 5 个名字并入 ALLOWED_TOOLS（policy + consent auto-approve + snapshot）+ 注册 Phase 3 specs + `createPhase3ToolHandlers()` 注入。video_edit 用 dispatch sandbox 跑 ffmpeg 全可用；video/music/browser/computer 无外部 adapter 时 fail-closed（ToolUnavailableError），adapter 由组合根注入（provider HTTP / CDP session / platform controller）。
- 新增 `tests/tools/phase3-tool-handlers.test.ts`（map shape / credentials 流 / fail-closed / allowlist 拒绝）。
- 未提交（保持 re-run 目标 SHA 干净，WP commit 待 re-run 绿后统一提交）。vitest 全量验证在 re-run 绿后执行。

### WP-5 — EVAL + Gate 闭环

- **AH-ROUTER-EVAL-001**: `evals/routing/dataset.json`（200+ 任务，allowed/forbidden_routes + hard_constraints + preferred_order）+ `evals/routing/eval.ts`（跑法 follow `scripts/gates/run-phase2-evals.mjs` 模式）。硬约束违反=0，routing regret ≤15%
- **Gate**: `verification/gates/phase3-gate.json`（byte-freeze 16 requirements）+ `scripts/gates/verify-phase3-local.mjs`（follow verify-phase2-local.mjs 模式：manifest/workspace-boundaries/typecheck/lint/unit/integration/e2e/security/evals）
- **tests/phase-3/**: 每 WP 的测试放真实 tests/ 对应目录；gate 引用统一路径
- **独立验收**: GLM-5.2 xhigh（routing regret / 不必要 multi-agent / 隔离 / 衰减 / merge / fallback / 对抗路由）

**WP-5 状态** (2026-08-22): ✅ 全部代码已写 + 数据集路由标注已做纯 Node 全量校验（0 hard 违反 / 0 forbidden / 0 不必要 multi / 6 regret=2.9%≤15%）。

- 引擎 `evals/routing/eval.ts`：async `runRoutingEvaluations()`，经真实 `routeDag` 跑全数据集；读 `run_plan.agent_graph.execution_mode` + `nodes.length` + `budget_allocation.usd_micros`（RunPlan 真实字段，非 `constraints`）；`routeSignature(mode, agentCount)` → `static_dag/single|routing_slip/single|workflow_script/multi`；8 类硬约束 token 检查 + forbidden + regret + unnecessary；metrics.pass 判定 = 0/0/≤15%/≤20%。
- 数据集 `evals/routing/dataset.json`：206 任务 / 8 类（simple_code 60、simple_read 40、writing 30、open_ended_research 30、multi_agent_fanout 20、large_scope_workflow 10、prohibition_single_agent 10、regret_allowed_suboptimal 6）；schema `routing-dataset/v1`；budget 约束值全部 ≤1000000 µUSD。
- 行为测试 `tests/router/eval.test.ts`：6 断言（total≥200 & routed==total & errors==[] / hard=0 / forbidden=0 / regret≤15% / unnecessary≤20% / releaseReady）。
- Gate 栈：`verification/gates/phase3-gate.json`（16 reqs byte-freeze，baseline sha f924d261）+ `scripts/gates/run-phase3-evals.mjs`（dataset 完整性 in-process + vitest 委托）+ `scripts/gates/verify-phase3-local.mjs`（makeRunner/record 模式，dev=manifest+workspace-boundaries+unit，local 增 typecheck/lint/routing-eval/evidence publish）+ npm scripts（verify:phase3:dev / verify:phase3:local / test:phase3:evals）。
- **路由标注校验**（纯 Node 复刻 pipeline.ts 决策链，hands-off 安全）：`stripProhibitions` → `stageWorkflow`（openEnded/fanOutHint/largeScope 正则逐字一致）→ `resolveExecutionMode`（open_ended 优先于 fan_out≥12）→ agentCount。结果：emitted 直方图与 8 类设计完全一致（static_dag/single 146、routing_slip/single 30、workflow_script/multi 30）；hard=0（130 个 budget 任务全部解析出 ≤1000000 约束）；forbidden=0；unnecessary=0；regret=6 恰为 regret_allowed 类。**无 veto 可达**：全部 base skill required_tools ⊆ PHASE1_TOOLS 夹具；workflowTools 仅产出 4 个 Phase-1 工具；scripted gateway metadata 覆盖 providerSelection 全部 capabilities。
- vitest/tsc/eslint 全量验证在 mutation re-run 绿后执行（hands-off 中，不占机器）。未提交（保持 re-run 目标 SHA 干净，WP commit 待 re-run 绿后统一提交）。

---

## 三、Gate 说明（发现的规格差异）

- phase-3.yaml（受保护）写 `gate_command: python3 factory/phase-gates/gate_runner.py phase3`，但 `factory/` 不存在。
- 本仓库既有 gate 模式 = `scripts/gates/verify-phase2-local.mjs` + `verification/gates/phase2-gate.json`。**Phase 3 沿用该模式**，不创建 factory/。此差异记录在案，不修改受保护 spec。

---

## 四、铁律（与既有 phase 一致）

1. 不删测试/不降阈值/不加 skip/不伪造 evidence/mutation
2. 不改 spec/、control/、evidence/（需 CTO 批准）
3. 每步全绿才继续（typecheck + lint + 对应 vitest 目录 + 全量回归）
4. 只推源代码；本地 candidate-only 不冒充 VERIFIED
5. 真实布局实现（harness/ 路径不适用）

## 五、执行约束

- **机器占用**：任务 #7 mutation 夜跑进行中（wait_idle gate + runc 时序敏感），**不在此窗口跑 typecheck/vitest**。代码工作从夜跑结束、runner 注销后开始。
- 预计周期：数周（与 PHASE3_READINESS_AUDIT 阶段 F 一致）；按 WP 逐个提交，每 WP 独立验证。
