# Post-FG 剩余框架差距

> FG1-FG11 补齐后的核对 + 仍存在的框架缺口。本文是 FRAMEWORK-COMPARISON.md 的增量:那份是补齐前(列 F1-F11 缺口),这份是补齐后(核对闭合状态 + 列剩余缺口)。
> 调研时间:2026-07-20。核对方法:逐文件读 spec/architecture/ 19 个 md + state-machines/invariants.md + types/ + contracts/ + threat-model/residual-risks.yaml。
> 修改方案见 spec/adr/ADR-013-post-fg-framework-gaps.md。本文只列事实,不做决策。

---

## 1. FG1-FG11 补齐状态(全部已闭合)

逐条核对了 invariants.md / types / contracts / architecture / threat-model,确认:

| FG# | 缺口 | invariants | types/contracts | architecture | 判定 |
|-----|------|-----------|-----------------|--------------|------|
| FG1 | Computer Use / 屏幕操作面 | FG1/FG6 4 条 | effect-risk.ts screen_access, tool-spec.ts display_policy | tool-skill-fabric + security-control-mapping | 已闭合 |
| FG2 | 两阶段运行时 + 密钥剥离 | 4 条 | run-plan.ts run_phase_config, run-plan.schema.json | runtime-core + action-control step 8 | 已闭合 |
| FG3 | 细粒度网络策略引擎 | 3 条 | effect-risk.ts egress_policy, tool-spec.ts egress_policy_ref | security-control-mapping CTRL-EGRESS-002 | 已闭合 |
| FG4 | VFS 一等抽象 + backend 路由 | 3 条 | CTRL-VFS-001 | virtual-filesystem.md 完整 | 已闭合 |
| FG5 | KV-cache 工程 + 工具掩码 | 2 条 | run-plan.ts context_strategy(cache_breakpoints, tool_masking) | model-api-gateway | 已闭合 |
| FG6 | 屏幕级注入隔离 | 并入 FG1 | tool-spec.ts display_policy | tool-skill-fabric + CTRL-SCREEN-ISOLATION-001 | 已闭合 |
| FG7 | routing slip 编舞 | 4 条 | agent-graph.ts routing_slip, insert_limit | routing-system Mode B | 已闭合 |
| FG8 | 零信任消息级安全 | 2 条 | agent-graph.ts message_security(obo/jws/jwe) | trust-boundaries + runtime-topology | 已闭合 |
| FG9 | workflow script 编排 | 4 条 | agent-graph.ts execution_mode | routing-system Mode C | 已闭合 |
| FG10 | offloading + cache-aware compaction | 3 条 | run-plan.ts offload_token_threshold | context-memory-rag | 已闭合 |
| FG11 | prompt caching 管理层 | 并入 FG5 | 并入 FG5 | 并入 FG5 | 已闭合 |

结论:FG1-FG11 在 spec 层 100% 闭合。剩余工作是实现 + 跑通不变式,不是补框架缺口。

---

## 2. 事实修正(纠正前一轮分析的两处误判)

### G-CC2 误判纠正
前一轮说"cache 失效矩阵只有 invariants 没有可执行清单"。错误。`spec/architecture/model-api-gateway.md` 已有:
- "Cache layers and invalidation matrix" 表格(System prompt / Conversation 两层 + 失效条件)
- "Actions that invalidate the cache" 清单(Model switch / Effort level change / MCP connect-disconnect / Compaction-context_reset)
- `AH-OBS-TRACE-001` acceptance_criteria 已写明"per-run cache invalidation events traced"

真实缺口只剩:run_phase 切换(setup→agent)对 cache 的影响没列入矩阵。小补。

### G-CC1 误判纠正
前一轮说"AH-SUBAGENT-001 管 capability attenuation"。确认正确,Child Capability 已绑定:manifest_hash, parent_delegation_proof, budget_ceiling, tool_grants(subset), resource_grants, delegation_depth。真实缺口是 agent-graph.schema.json 的 node 字段缺 isolation/hooks_ref/memory_scope/effort/disallowed_tool_refs(不是 capability 字段缺)。

---

## 3. 补齐后剩余的框架缺口(8 项)

以下 8 项是 FG1-FG11 补齐后**仍然存在**的框架缺口。每项只列证据和为什么是缺口,修改方案见 ADR-013。

### G-OS1:Phase 1 OS 沙箱机制未指定

**证据:**
- AH-SANDBOX-001 acceptance_criteria 列 12 条(Path traversal/Symlink/Network/Process/Memory/Output/Timeout/Cancellation/Binary/stdin/Shell injection/egress_policy)。
- 但没有一条指定用什么 OS 机制实现(Seatbelt? bubblewrap? seccomp? chroot? rlimit?)。
- deployment-topology.md 只列 7 个环境名词,Phase 1 沙箱机制空白。
- runtime-core.md "Two-Phase Runtime" 说 "agent phase: network disabled by default" 但没说怎么 disable。
- 对比 Codex:sandbox-exec -p(macOS Seatbelt)/ bubblewrap(Linux)/ WSL2(Windows),默认 workspace-write + 网络关,是框架级决策。

**为什么是框架缺口:** AH-SANDBOX-001 delivery_phase=1,但不指定机制,实现者不知道用什么。这是 Phase 1 ship blocker。

### G-CC1:Subagent per-agent 配置字段缺

**证据:**
- agent-graph.schema.json nodes.items.properties 当前字段:agent_id, role, model_binding_ref, budget_ceiling, status, parent_agent_id, delegation_depth, tool_grant_refs, skill_binding_refs。
- 缺字段:无 isolation(worktree/process/sandbox)、无 hooks_ref、无 memory_scope、无 effort、无 disallowed_tool_refs。
- AH-SUBAGENT-001 绑定 tool_grants(subset) + delegation_depth,但不管 isolation 级别或 per-agent hooks。
- 对比 Claude Code subagent frontmatter:每个子 agent 独立 tools/disallowedTools/model/permissionMode/mcpServers/hooks/maxTurns/skills/memory/effort/isolation:worktree。

**为什么是框架缺口:** AgentGraph 契约里就没有这些字段。Phase 3 多 agent 实现时,无法声明"这个 worker 用 worktree 隔离 + 自己的 hooks + 不许调 MCP"。契约层缺字段,不是代码没写。

### G-CC2:Cache 失效矩阵缺 run_phase 切换

**证据:**
- model-api-gateway.md 已有 "Cache layers and invalidation matrix" 表格 + "Actions that invalidate the cache" 清单(4 条:Model switch / Effort / MCP / Compaction-context_reset)。
- 缺:run_phase 切换(setup→agent)对 cache 的影响。FG2 的 setup→agent 会剥离 credentials + 关网络 + 改 tool 可用性(setup 工具在 agent phase 不可用),可能改变 system prompt 或 tool-definition block。
- AH-OBS-TRACE-001 追踪 cache invalidation events,但没列 run_phase 切换这个事件。

**为什么是框架缺口:** 不变式说"compaction aligns with cache breakpoints",但没说 run_phase 切换时 cache 失效半径。实现者不知道切 phase 时 cache 保不保留。

### G-CX1:审批前 auto-review 未规格化

**证据:**
- assurance.md 当前:Advisory Loop 8 stages + Evidence E0-E7 + Independent Verifier(完成后,异模型,无确认偏倚)+ Quality Scoring。
- action-control.md 12 步:step 4 Policy evaluation → step 5 Consent check → step 6 Capability issuance。
- 缺:step 5 之前或之中,没有"reviewer agent 先评审审批请求再决定要不要打扰用户"这个时点。
- Independent Verifier 是完成后验证(run 结束后);Codex auto-review 是审批前预审(T2+ action 执行前)。不同时点,互补不替代。

**为什么是框架缺口:** 验证时点只有"完成后"(Verifier)和"每 action PEP"(step 7)。缺"审批请求生成后、送达用户前"的第三时点。assurance.md 没有这个时点。

### G-PI1:Agent 不是 markdown 文件

**证据:**
- skill-spec.schema.json 是 JSON schema(13 required 字段)。
- agent-graph.schema.json 是 JSON schema(node = 结构化对象)。
- 无"agent = md 文件"的编译路径。开发者要创建 agent,必须手写 JSON RunPlan + AgentGraph。
- 对比 pi-agents:agent = md 文件(YAML frontmatter + 正文作 system prompt)。对比 Claude Code:subagent = md + YAML frontmatter。

**为什么是框架缺口:** AgentGraph 契约是结构化 JSON,没有"md → agent"的编译路径。开发者人体工学框架决策,不是实现细节。

### G-PI2:TUI 概念缺失

**证据:**
- ui/screens/ 目录 19 个 yaml,无 tui.yaml。
- ui/routes.yaml 19 条路由,无 tui。
- product-prd.md Surface 11:"CLI/IDE (Phase 1)" — 只声明交付面,无 TUI 交互模型。
- 对比 pi-tui:差分渲染终端 UI,开发者纯键盘操作。

**为什么是框架缺口:** ui/ 目录没有 TUI 这一面。Phase 1 CLI 如果只复用 Web chat.yaml,终端体验差。pi-tui 的差分渲染是框架级交互决策。

### G-PI3:运行时 workflow 可视化缺失

**证据:**
- realtime-execution-visualization.md StreamEvent 表格 11 种(tool_call_start/tool_result/step_transition/file_change/command_output/model_decision/error_event/budget_update/run_state_change/tool_call_authorized/tool_executing),无 workflow_graph 事件。
- asyncapi.yaml 事件类型枚举无 workflow_graph。
- mission_control.yaml 无 workflow graph 组件。
- 对比 pi-agents:workflow = JSON 图 + Mermaid 可视化(flow 检视)。
- Phase 3 多 agent 时,用户在 run 进行中看不到"当前 AgentGraph 执行到哪个节点、routing slip 到第几步"。

**为什么是框架缺口:** 实现者/用户在 run 进行中看不到 AgentGraph 执行进度。可观测性框架决策,不是事后报告。

### G-MAN1:Active plan 站态注入未规格化

**证据:**
- context-memory-rag.md "Context Window Layout (9 layers)" 有 active plan: ~2K 层。
- 但没说"每 turn 末尾重写 active plan 推到 context 末尾"的具体技术。
- runtime-core.md "Compaction Trigger" 说 must preserve "goals, constraints, decisions, approvals, side effects, open tasks, security state" — 但这是 compaction 时的保留,不是每 turn 的主动注入。
- 对比 Manus:每步重写 todo.md,把全局目标"背诵"到 context 末尾,对抗 lost-in-the-middle。刻意保留失败动作与观测。

**为什么是框架缺口(弱):** 7 层窗口有 active plan 层,但没说"每步重写推末尾"。这是对抗 lost-in-the-middle 的具体技术,Manus 验证有效。

---

## 附:竞品架构骨架(增量,详见 FRAMEWORK-COMPARISON.md)

> FRAMEWORK-COMPARISON.md 已有详细框架对比。这里只补 4 个竞品的架构骨架一句话,供快速定位。

- **Manus**:云端大脑 + 本地 sidecar 桥。agent 在云端跑,通过 Socket.IO 向本地 Go sidecar 下发文件/终端操作。KV-cache 工程(logits mask 屏蔽工具)+ 文件系统即上下文是独有。详细逆向见仓库外 manus-reverse-engineering.md。
- **Claude Code**:引擎非模型执行权限 + JS 脚本编排(Dynamic Workflows)+ 5+1 交付面 + prompt caching 分层。Computer Use 安全设计(per-app 审批/终端不入截图/Esc 消费)是 FG1/FG6 来源。
- **Codex**:两阶段运行时(setup 联网→agent 离线+密钥剥离)+ network_proxy 网络策略引擎 + OS 原生沙箱(Seatbelt/bubblewrap)+ auto-review。FG2/FG3 来源。
- **Pi-agent**:pi-agents(markdown 化 agent + TUI + workflow JSON 图 + Mermaid)+ paigeant(routing slip 编舞 + JWS/OBO 零信任消息 + Saga 补偿)。FG7/FG8 来源;Saga 你更细。
