# 框架层对比 — Agent Harness v9.1 vs Manus / Claude Code / Codex / Deep Agents / Paigeant

> 纯框架设计决策对比。AH 没有真代码(`harness/src` 为空),所以只比**框架决策**,不比实现成熟度。
> "框架缺口"= AH 规格里没有这个设计决策;"实现缺口"= 规格有但没写代码。本文只判框架缺口。
> 调研时间:2026-07-18。Paigeant = LeonKolyang/paigeant(routing slip 编舞框架,非 Pi-Agent)。

---

## 0. 判定标准

"必须补"的判定**不是**"竞品有",而是:**AH 的框架决策集合里缺这一项,会导致 AH 自己的另一项承诺(安全/范围/phase 路线)在框架层不成立**。即框架内部矛盾。
"建议补"= 竞品框架决策更优雅,吸收能简化 AH,但不补不会自相矛盾。
"已领先"= AH 框架决策更严/更全,维持。

---

## 1. AH 框架决策清单(从 14 架构文档提炼,24 项)

| # | 决策点 | AH 框架决策 |
|---|--------|-----------|
| F1 | 运行时模型 | Loop Engine + 事件溯源 session(11 entry types,event log=authority,snapshot=acceleration) |
| F2 | 停止条件 | 9 种:max_iter/budget/cancel/deadline/refusal/malformed/oscillation/goal/context_reset |
| F3 | 错误分类 | network(transient)/tool/model/truncation(structural,不执行)/malformed(repairable) |
| F4 | context_reset | 2 次振荡或目标回退后,写 handoff artifact,spawn 新 session 恢复 |
| F5 | compaction | 40% 窗口触发,7 层窗口,安全状态不压缩,key fact recall≥0.95 |
| F6 | 路由 | before-routing(safety 先入),依赖感知 DAG,3 层(0 LLM/1 LLM/optimizer),abstain |
| F7 | 模型网关 | Provider Adapter(13 方法),Capability Registry,fallback chain,switch re-validation |
| F8 | 工具 | ToolSpec(20+ 字段),4 transport,9+3 工具,generated tools 不自动提权 |
| F9 | MCP | allowlist(signature:command hash / URL+key pin) |
| F10 | 沙箱 | 进程级(Phase1)→ microVM(Phase7);12 步第 9 步 dispatch |
| F11 | 安全核心 | Policy+PEP@every action,Capability Token(单次/签名/TOCTOU 重验),TCB 6 组件,deny-by-default |
| F12 | 12 步管线 | schema→effect→risk→policy→consent→capability→PEP→TOCTOU→credential→sandbox→receipt→postcond→audit |
| F13 | pause/resume | effect-state-aware:PRE_DISPATCH/IN_FLIGHT/NO_RETRY/EFFECT_UNKNOWN→reconcile/CONFIRMED |
| F14 | 记忆 | 6 类型+provenance+trust+conflict+TTL+negative quarantine,model 不直接写高信任事实 |
| F15 | RAG | 5 子系统,ACL-before-retrieval,taint label,注入隔离(regex 库) |
| F16 | 上下文布局 | 7 层窗口,低信任内容隔离于 system/policy |
| F17 | 验证 | Independent Verifier(异模型,无确认偏倚,只看 req+output+evidence),Evidence E0-E7,TLA+ 模型检测 |
| F18 | 外部动作 | Prepare→Commit→Read-back,ExternalEffect 14 状态机,Saga,补偿,幂等,对账 |
| F19 | 多 agent | AgentGraph DAG,5 角色,7 拓扑,合并冲突解决,11 fallback,动态预算 |
| F20 | 演化 | shadow mode,cold-start 权重,4 evolution agents,CANNOT(不改 policy/不扩 tool/不提权) |
| F21 | 企业 | RBAC/ABAC,SSO(OIDC/SAML),SCIM,microVM,数据驻留,留存,SBOM,workload identity,kill switch |
| F22 | steering | 3 队列(steer/followUp/nextTurn),8 级优先级,IN_FLIGHT 不可取消 |
| F23 | cross-session | progress.json(Phase1 interim)→ Phase4 Memory |
| F24 | Hook | Phase2,AR-007 输出重验(schema+policy) |

---

## 2. 六框架决策点对比矩阵

图例:✅有框架决策 / ⚠️部分 / ❌无 / 🏆AH 更强。

| 决策点 | AH | Manus | Claude Code | Codex | Deep Agents | Paigeant |
|--------|----|----|-----|-----|----|----|
| Loop+事件溯源 | ✅F1 | ✅ReAct+文件 | ✅session | ✅ | ✅LangGraph checkpoint | ✅routing slip |
| context_reset/handoff | ✅F4 | ⚠️todo.md | ❌compact only | ❌compact | ✅summarize+offload | ❌ |
| KV-cache 工程 | ❌ | 🏆显式 breakpoint+hit率+掩码 | ✅分层 cache | ⚠️ | ⚠️prompt caching | ❌ |
| 工具掩码状态机 | ❌ | 🏆logits mask 不改 defs | ❌ | ❌ | ❌ | ❌ |
| 文件系统即上下文 | ⚠️分散 | 🏆VFS=统一外置记忆 | ⚠️ | ⚠️workspace | 🏆VFS 可插拔 backend | ❌ |
| before-routing safety | 🏆F6 | ❌ | ⚠️PreToolUse hook | ⚠️sandbox+approval | ⚠️interrupt_on | ❌ |
| PEP@every action | 🏆F11 | ❌ | ⚠️engine 非 model | ⚠️sandbox boundary | ❌ | ❌ |
| Capability Token | 🏆F11 | ❌ | ❌ | ❌ | ❌ | ⚠️OBO token |
| 两阶段运行时+密钥剥离 | ❌ | ⚠️VM 休眠 | ❌ | 🏆 | ❌ | ❌ |
| 网络策略引擎 | ⚠️SSRF only | ❌ | ⚠️network allow | 🏆network_proxy | ❌ | ❌ |
| OS 原生沙箱 | ⚠️进程级 | ✅云 VM | ✅sandbox-exec | 🏆seatbelt/bwrap | ✅sandbox backend | ⚠️worker 隔离 |
| Computer Use | ❌ | 🏆browser+VM | ✅computer-use MCP | ⚠️ | ❌ | ❌ |
| 编排模型 | DAG(F19) | 副本扇出 | 🏆JS 脚本 workflow | ⚠️云并行 | task tool | 🏆routing slip 编舞 |
| 分布式/跨进程 agent | ❌(同进程) | ✅云 VM 隔离 | ✅worktree 隔离 | ✅cloud 容器 | ⚠️subagent | 🏆broker+worker |
| durable transport | ⚠️event log | ✅VM 持久 | ✅session | ✅cloud | ✅LangGraph | 🏆Redis/RabbitMQ |
| Saga 补偿 | 🏆F18 | ❌ | ❌ | ❌ | ❌ | ✅compensation_log |
| 记忆系统 | 🏆F14 6类 | ⚠️文件 | ⚠️CLAUDE.md+auto | ❌ | ✅AGENTS.md+store | ❌(roadmap) |
| 验证/独立验证器 | 🏆F17 | ❌ | ❌ | ⚠️auto-review | ⚠️LangSmith | ❌ |
| 演化 | 🏆F20 shadow+CANNOT | ❌ | ❌ | ❌ | ⚠️improve over time | ❌ |
| 企业治理 | 🏆F21 | ❌ | ✅managed settings | ⚠️ | ⚠️namespace | ❌(roadmap RBAC) |
| HITL/consent | 🏆F12 risk-tier | ⚠️ | ✅6 mode+hooks | ✅approval matrix | ✅interrupt_on | ⚠️ |
| 交付面 | CLI/IDE/Web/Desktop | web | 🏆5面+mobile | CLI/Cloud/IDE | SDK | library |
| 消息级安全(JWS/签名) | ⚠️audit WORM | ❌ | ❌ | ❌ | ❌ | 🏆JWS+OBO |

---

## 3. 逐框架:对方决策 vs AH

### 3.1 Manus — 上下文工程 + 真实环境操作

**对方框架决策(已验证):**
- **KV-cache 命中率是一等指标**:显式 cache breakpoint;工具名一致前缀(`browser_*`/`shell_*`);**logits mask 屏蔽工具而非增删工具定义**(保 cache);典型任务 50 tool call。
- **文件系统即上下文**:沙箱 FS = 无限持久外置记忆;压缩"可还原"(丢内容留 URL/path)。
- **todo.md 站态注入**:每步重写,把目标推到 context 末尾,对抗 lost-in-the-middle。
- **全云 VM 沙箱**:每任务一 Ubuntu VM(网络/FS/Chromium/shell),休眠数小时、自动唤醒、文件保留。
- **Wide Research 副本扇出**:~100 全功能子 agent,各自 context+沙箱。
- **Computer Use 一等公民**:browser agent + Browser Operator 扩展,对自构建产物跑 test/fix 循环。

**vs AH:**
- KV-cache 工程:AH F7 只列 streaming/usage/health,**无 cache breakpoint/hit率/掩码**。F16 标"cached prefix"但没工程化。**框架缺口**。
- 工具掩码:AH 动态加工具(MCP/generated/skill chain)会改 tool defs 块,破坏 cache。**框架缺口**。
- 文件系统即上下文:AH 把 FS/记忆/RAG/窗口分 4 套抽象(F8/F14/F15/F16),无统一。**框架缺口**(与 Deep Agents VFS 同根)。
- todo.md 站态注入:AH active plan(F16)+Mission(F19)部分覆盖,"每步重写推末尾"未规格化。**部分**。
- 云 VM 沙箱:AH microVM 在 Phase7(F10),无休眠唤醒模型。**阶段缺口**。
- 副本扇出:AH F19 支持并行,无"大规模同构克隆"模式。**部分**。
- Computer Use:AH 仅 `behavior_verify`(scope 锁死)+`web_fetch`。**框架缺口**。

**Manus 独有、AH 无:** KV-cache 工程、工具掩码状态机、Computer Use、云 VM 休眠唤醒。

---

### 3.2 Claude Code — 交付面广度 + 脚本化编排 + 缓存分层

**对方框架决策(已验证):**
- **Computer use MCP**:CLI 可控屏(开 app/点击/截图),per-app 审批,sentinel warning(terminal=shell access、Finder=任意文件),终端排除截图(防回灌),Esc 全局中断(注入不能用),截图自动降采样,一次一 session lock。
- **Dynamic Workflows(JS 脚本编排)**:把 plan 移到 JavaScript 脚本,中间结果存脚本变量而非 context;可对抗性评审(独立 agent 互相 review);可 resume;`ultracode` 自动规划;`/deep-research` 内置。规模:几十到几百 agent/run。
- **Prompt caching 分层**:system prompt 层(工具定义)+ conversation 层;model/effort/MCP 连接/插件/deny 工具/compact 都 invalidate;deferred tools(MCP tool search)不扰动 prefix。
- **Subagent frontmatter**:md 文件+YAML(tools/disallowedTools/model/permissionMode/mcpServers/hooks/maxTurns/skills/memory/effort/background/isolation/color/initialPrompt);5 scope;`isolation: worktree`;nested subagent;`Agent(type)` 白名单。
- **权限引擎非模型执行**:deny>ask>allow;6 mode;managed settings 矩阵。
- **Hooks**:PreToolUse 可 deny/force-prompt/skip,**不绕过 deny 规则**(deny-first);多事件。
- **5+1 交付面**:Terminal/VS Code/JetBrains/Desktop/Web + Mobile;Remote Control;Channels(Telegram/Discord/iMessage/webhook 注入会话)。

**vs AH:**
- Computer use:AH 无。**框架缺口**。
- Dynamic Workflows(JS 脚本):AH F6/F19 是模型驱动拓扑,不是"把 plan 移到代码脚本"。**不同范式,AH 无此层**。**框架缺口**。
- Prompt caching 分层:AH F7 无 cache 层抽象。**框架缺口**(与 Manus KV-cache 同根)。
- Subagent frontmatter 丰富配置:AH AgentGraph 节点有 role/model/budget/status,无 per-agent hooks/skills/isolation/memory/effort。**部分**。
- 权限引擎非模型:AH PEP(F11)更强。**AH 领先**。
- Hooks:AH F24(Phase2)+AR-007,事件目录需对齐。**部分(实现)**。
- 交付面:AH 12 面无 mobile/channels。**框架缺口**。

**Claude Code 独有、AH 无:** Computer use、JS 脚本 workflow、prompt caching 分层、mobile+channels。

---

### 3.3 Codex — 两阶段运行时 + 网络策略引擎

**对方框架决策(已验证):**
- **两阶段运行时(Codex Cloud)**:setup 阶段联网装依赖 → agent 阶段默认离线;**secrets 仅 setup 阶段可用,agent 阶段前剥离**。
- **OS 原生沙箱**:macOS Seatbelt(`sandbox-exec -p`)/Linux bubblewrap/WSL2/Windows;默认 `workspace-write`+网络关。
- **network_proxy 网络策略引擎**:domain allow/deny(精确/通配/`*`,deny 必胜)、unix socket allow、`allow_local_binding`(默认禁本地/私网)、SOCKS5;`web_search` cached/live/disabled。
- **Auto-review**:reviewer agent 在审批请求送达用户前评审。
- **审批策略矩阵**:on-request/untrusted/never + granular。
- **Cloud 隔离容器 + 并行云任务**。

**vs AH:**
- 两阶段运行时:AH RunPlan 有 phase 概念,但无"setup 联网 vs agent 离线 + secret 物理剥离"显式模型。Secrets Broker 持短临凭证,但没说 agent 阶段密钥是否物理不在环境。**框架缺口**。
- OS 原生沙箱:AH F10 进程级,未对齐 seatbelt/bwrap。**实现缺口**。
- 网络策略引擎:AH `CTRL-EGRESS-001` 只 SSRF。**框架缺口**(无 domain/socket/local/SOCKS5)。
- Auto-review:AH F17 范围更广,"审批前置 auto-review"UX 未规格化。**部分**。
- 审批矩阵:AH consent+T0-T5(F12)更原则化。**AH 领先**。

**Codex 独有、AH 无:** 两阶段运行时+密钥剥离、细粒度网络策略引擎。

---

### 3.4 Deep Agents — VFS 一等抽象 + 上下文工程自动化

**对方框架决策(已验证):**
- **VFS 可插拔 backend + 路由**:StateBackend(thread-scoped)/FilesystemBackend(local)/StoreBackend(cross-thread)/ContextHubBackend(Hub repo)/Sandbox/LocalShell/CompositeBackend(path prefix 路由);`read_file` 原生支持图像;namespace factory 隔离;wildcard 拒绝防 glob 注入。skills/memory/code/context 共用 VFS。
- **Offloading**:tool 输入/输出 >20K token 自动落 VFS,context 留指针+预览(首10行);85% 触发 summarization(LLM 结构化摘要+FS 保留原文);`ContextOverflowError` fallback;compaction tool(按需);`DeltaChannel` reducer 使 checkpoint 增长线性。
- **Middleware stack**:system_prompt 前置+base+todo+memory+skills+VFS+subagent+HITL+custom;`@dynamic_prompt`;custom state schema(`DeepAgentState`)。
- **Subagents**:`task` tool,独立 context,单次 handoff,general-purpose/custom,stateless messaging,runtime context 传播,per-subagent namespace。
- **Skills progressive disclosure**:startup 读 frontmatter,按需加载全文。
- **HITL**:`interrupt_on` approve/edit/reject。
- **LangGraph durable**:streaming/persistence/checkpointing;LangSmith tracing/eval/deploy。

**vs AH:**
- VFS 一等抽象:AH 无统一 VFS,sandbox(F10)/tools(F8)/memory(F14)/RAG(F15)各触及"文件"用不同抽象。**框架缺口**(权限绕过+事务+一致性三重问题,见 FG4)。
- Offloading 20K 阈值:AH F5 是 40% 窗口触发,无"单 tool 输出超阈值落盘"细粒度机制。**框架缺口**(细粒度)。
- Summarization 85%+FS 保留原文:AH F5 保留安全状态,"原文落 FS"未规格化。**部分**。
- DeltaChannel 线性 checkpoint:AH F1 event log append-only,未声明 checkpoint 线性。**部分**。
- Middleware stack 显式分层:AH F16 是 context 布局,不是"可插拔 middleware"。**不同抽象**。
- Subagent 单次 handoff:AH F19+合并冲突解决更强。**AH 领先**。
- Skills progressive disclosure:AH F8 skill-spec 有,"frontmatter 按需加载"未显式。**部分**。
- HITL:AH F12 consent+ApprovalStateMachine 更强。**AH 领先**。

**Deep Agents 独有、AH 无:** VFS 可插拔 backend 路由、offloading 20K 阈值、DeltaChannel 线性 checkpoint。

---

### 3.5 Paigeant — routing slip 编舞 + 零信任消息 + 分布式 durable

**对方框架决策(已验证):**
- **Routing slip 编舞(无编排器)**:itinerary 随消息走,worker 执行当前步→mark_complete→forward_to_next_step;无中央编排器;`insert_activities` 动态改行程(限 3 次);`can_edit_itinerary`。
- **Saga 补偿**:`compensations` list,失败时逆序执行 compensate;`compensation_log`。
- **零信任消息**:`PaigeantMessage` 带 `obo_token`(OAuth 2.0 OBO)+`signature`(JWS);消息级完整性与真实性;JWE 可选加密。
- **分布式 worker**:每 agent 独立 compute instance(broker+queue);transport 可插拔(in-memory/Redis/RabbitMQ,`BaseTransport`)。
- **Durable**:`WorkflowRepository`(in-memory/SQLite/PostgreSQL);`(correlation_id, step_name, run_id)` 唯一 + `INSERT OR IGNORE` 幂等;routing slip 持久化。
- **Federated 分层**:Workflow Layer(Paigeant,跨服务)+ Task Layer(pydantic-ai/graph,进程内)。

**vs AH:**
- Routing slip 编舞:AH F6/F19 是**集中编排**(router 规划拓扑,runtime 执行)。Paigeant 是**去中心编舞**(行程随消息)。**不同范式**。AH 无"行程随消息"的分布式编舞层。**框架缺口**(若 AH 要跨服务/跨进程)。
- Saga 补偿:AH F18 有,且更细(14 状态机)。**AH 领先**。
- 零信任消息(JWS/OBO):AH 有 Capability Token(F11)+WORM audit(F21),但**消息级签名(JWS)和 OBO token 传播未规格化**。AH Capability 是动作级,Paigeant 是消息级。**框架缺口**(跨进程/跨服务场景)。
- 分布式 worker:AH Phase1-3 同进程(F1),microVM Phase7。无 broker/queue 抽象。**框架缺口**(若 AH 要分布式)。
- Durable repository:AH F1 event log+F17 evidence 更强,"workflow 状态持久化+幂等 step"未显式。**部分**。
- Federated 分层:AH 无"跨服务编排层 vs 进程内执行层"显式分离。**框架缺口**(分布式场景)。

**Paigeant 独有、AH 无:** routing slip 编舞范式、消息级 JWS/OBO、broker/transport 抽象、federated 分层。
**注意:** Paigeant 在治理/验证/记忆/企业上远弱于 AH(roadmap 里 RBAC/audit/memory 都未实现)。它的价值是**分布式编舞范式**。

---

## 4. 框架层必须补的差距(论证:为何是框架内部矛盾)

### `★` 必须补(框架内部矛盾,不补则 AH 自身承诺不成立)

#### FG1 Computer Use / 浏览器代理(Manus+Claude Code)
**框架矛盾:** AH PRD 7 角色中 Researcher/Founder/PA/Writer 的 JTBD 要求操作真实 web(登录墙/JS/SPA/点击流/截图取证),但 F8 工具集只有 `web_fetch`(HTML转md)+`behavior_verify`(Playwright scope 锁死"验证自构建产物")。`behavior_verify` 已有 Playwright 能力却被 scope 限死,是**框架决策自相矛盾**(有能力但故意不用)。不补则 4/7 角色 JTBD 失败,AH 退化成"能读文件+调 API 的 agent"。
**补法:** `behavior_verify` 的 Playwright 提级为通用 `browser_operate` 工具,走 F12 12 步管线+EffectRisk(T2+)+Capability。AH 架构在此发光——竞品浏览器代理是安全事后补丁,AH 能进 TCB。

#### FG2 两阶段运行时+密钥剥离(Codex)
**框架矛盾:** AH 威胁模型列 `THREAT-INDIRECT-INJECTION`/`THREAT-TOOL-POISONING`/`THREAT-MEMORY-POISONING`——都能攻陷 agent loop。AH 防御是 taint(F15)+PEP(F11),但 taint 是软控制(regex+LLM)。更关键:Secrets Broker(F12 第8步)设计为"持短临凭证",但 spec 没说 agent loop 阶段密钥是否**物理不在环境**。若 agent 被注入攻陷,它能调合法需凭证工具(Phase5 Gmail),Capability 签发→密钥 exchange→密钥进入被攻陷 loop 可达范围→第二次工具调用(`web_fetch` 到攻击者服务器、密钥在 URL)即外泄。taint 拦不住"看似合法的二次调用"。AH 的 deny-by-default 是 policy-deny 不是 construction-deny,对密钥外泄路径不成立。这是 T5 企业天花板的硬伤。
**补法:** RunPlan 增 `RunPhase`(setup/agent)。setup 联网+Broker 取密钥装依赖;agent 网络默认关(经 FG3 放行)+密钥从进程环境剥离+每次需密钥工具调用由 Broker 在 dispatch 点单次 exchange 并 scope 到该次。落 F1/F12/Secrets Broker。

#### FG3 细粒度网络策略引擎(Codex)
**框架矛盾:** 四条——(1)`execute_command_sandboxed`(F8,Phase1)可跑 `curl attacker.com`/`npm i 恶意包`,IP allowlist 被 DNS rebinding/CDN exfil 绕过,必须 domain 级;(2)MCP(F9)有签名 allowlist,但信任后无法控它连向哪里——被签名毒 MCP 仍可 phone home;(3)`ENT-RESIDENCY`(F21,Phase7)数据驻留:不能说"此租户流量只许 eu.example.com"则驻留不可执行——AH 承诺驻留却无机制;(4)unix socket:沙箱命令可经 Docker socket 达宿主服务,进程隔离不覆盖。AH 的 `CTRL-EGRESS-001` 是 allow-by-default(只拦 SSRF),与 deny-by-default 哲学矛盾。
**补法:** egress 升级为 network policy(domain 精确/通配/deny 必胜、unix socket 显式 allow、`allow_local_binding` 默认禁、SOCKS5)。强化 F8 `effect-risk`/`tool-spec` 的 network 字段为 policy 对象。

#### FG4 VFS 一等抽象+permission rules(Deep Agents)
**框架矛盾:** 三条——(1)**权限绕过**:PEP(F11)在工具调用时校验,但 `read_file`(F8)与 RAG-retrieve(F15)都读文件=两套权限。`AH-RAG-DELETE-001` 传播"删除",但"权限撤销"(非删除)是否传播到已索引 chunk 未规格——已索引内容可被 retrieve 绕过 read_file 的 deny。具体 auth bypass。(2)**沙箱不 hermetic + checkpoint 名不副实**:工具直达真 FS,"sandbox"(F10)只是标签。`edit_file` 有"checkpoint"(Phase1)但 per-tool 非事务——RunPlan 改 5 文件第 6 步失败,5 文件无法原子回滚。AH reconciliation(F18)只管外部副作用不管文件副作用。VFS 给原子 commit/rollback 边界(stage in VFS,verifier-pass 后 commit)。(3)**多 store 一致性**:memory store(F14)/RAG LanceDB(F15)/evidence dir(F17)/真 FS=4 store 4 一致性模型。VFS 统一。
**补法:** 新增 `harness/vfs/`(可插拔 backend:in-memory/overlay/local/store+read/write permission rules)。所有文件工具经 VFS。改 F8/F15/F12 第9步 sandbox dispatch→VFS dispatch。

#### FG5 KV-cache 工程+工具掩码状态机(Manus)
**框架矛盾:** 四条叠加——(1)AH 7 层窗口(F16)已**假设** prefix cache(system/policy ~8K、recent ~80K 标"cached prefix"),但 F7 model-gateway 无工程化。RunPlan 是 DAG+11 fallback+7 拓扑(F19),每 router stage/每 agent 是一次 LLM call。50 tool call × N agents,cache 全 miss=50×N full forward pass。Claude Sonnet miss/hit≈10x 价差。(2)`BudgetGuard`(F21,Phase2,`AH-RUNTIME-BUDGET-002`)会提前杀 run——**AH 自己的预算控制让 Phase3 多 agent 经济不可行**。(3)F8 允许动态加工具(MCP/generated/skill chain Phase3)。加工具=重序列化 tool defs 块="tool definitions ~4K cached"层失效。Manus 正是撞这墙才改 logits mask。AH 必同样撞墙。(4)compaction(F5,40%触发)重写 context 中段,recent ~80K cached prefix 从 breakpoint 后全失效;`context_reset`(F4)更糟(全清)。**AH 自己的 context 管理与它假设的 cache 互相对抗。**
**补法:** F7 增 cache breakpoint/cache-hit 率指标+布局规则(稳定在前、易变在后、显式 breakpoint)。tool-masking 状态机(工具定义冻结、decode 时按状态 mask)。cache-aware compaction(breakpoint 对齐)。

#### FG6 移动端+Remote Control+Channels(Claude Code)
**框架矛盾:** PRD 7 角色中 PA(Phase2-6 "email/calendar/reminders")、Founder(Phase6 Mission Control)、`AH-UI-DAILYBRIEF-001` 是 mobile 原生。PA 只在桌面=不是 PA。Mission Layer(F19,Phase6,8 需求含 `AH-MISSION-BUDGET-001` 长时预算)运行数小时/数天,用户换设备——不能远程监控/steer 则 Mission Control 半废。`AH-PROACTIVE-SUGG-001`+`AH-ROUTINE-SCHED-001` 异步触发,无 mobile push+2-way channel 则无处投递。steering(F22,3 队列)是 session 内,用户从手机 chat app 无法 steer——输入通道缺失,steering 设计落空。
**可条件降级:** must IF AH 保留 PA/Founder 角色。若 AH 明确 Phase1-3 只做开发者,可延后。但 PRD 已承诺,故按承诺为 must。
**补法:** PRD/ui 增 mobile 面+channels;Phase6 交付;Phase2 可先 push。

### `○` 建议补(框架更优雅,非矛盾)

#### FG7 routing slip 编舞/分布式 worker/消息级 JWS(Paigeant)
**为何建议:** AH F19 多 agent 是同进程集中编排(Phase1-3)。若 AH 要跨服务/跨进程(Phase7 企业 microVM、跨租户),Paigeant 的 routing slip+broker+JWS 是更优范式。但 AH 目前承诺范围在单租户/单进程到 microVM,F18 Saga 已覆盖补偿。**非矛盾,视未来范围**。

#### FG8 Dynamic Workflows JS 脚本编排(Claude Code)
**为何建议:** AH F6/F19 是模型驱动拓扑。Claude Code 的"agent 写 JS 脚本编排自己"是另一范式,适合可重复大规模(500 文件迁移、对抗性 review)。AH Router DAG 更严但更刚性。吸收能补"可重复编排"层。**非矛盾,范式差异**。

#### FG9 Offloading 20K 阈值+DeltaChannel 线性 checkpoint(Deep Agents)
**为何建议:** AH F5 compaction 是窗口级(40%),Deep Agents 是 tool 输出级(20K)+窗口级(85%)双阈值,更细。DeltaChannel 使 checkpoint 线性增长。**优化,非矛盾**。

#### FG10 microVM 沙箱前置+休眠唤醒(Manus/Codex)
**为何建议:** AH F10 microVM 在 Phase7。Manus 云 VM 休眠唤醒支持长会话。AH Mission(Phase6)长时运行需此。**阶段缺口,非框架缺口**。

#### FG11 大规模副本扇出(Manus Wide Research)
**为何建议:** AH F19 支持并行,无"~100 同构克隆"模式与压测。**规模增强,非矛盾**。

### AH 框架已领先(维持)

- **before-routing safety**(F6):全部竞品是 safety 后入或 hook 软拦。AH safety 先于路由,框架级最强。
- **PEP@every action + Capability Token**(F11/F12):竞品全是 sandbox boundary 或 hook,AH 是每动作签名+单次+TOCTOU 重验。
- **记忆 6 类型+negative quarantine**(F14):竞品最多 AGENTS.md+store(Deep Agents)或文件(Manus)。
- **Independent Verifier + Evidence E0-E7 + TLA+**(F17):竞品无(Codex auto-review 是审批前置;Deep Agents LangSmith 是 tracing)。
- **ExternalEffect 14 状态机 + Saga + 对账**(F18):Paigeant 有 Saga 补偿但无 14 状态机;其余无。
- **企业治理矩阵**(F21):Claude Code managed settings 接近但无 SCIM/SBOM/workload identity/数据驻留。
- **演化 shadow+CANNOT**(F20):竞品无。
- **risk-tier consent T0-T5**(F12):比 Codex granular 更原则化。

---

## 5. 框架层总结

**AH 框架定位:** 重治理、重安全、重验证的通用 agent harness。框架决策在安全/记忆/验证/企业/外部动作 5 维领先全部竞品。

**AH 框架缺口(6 项必须):** 集中在"真实环境操作(Computer Use/VFS)+ 上下文工程生产(KV-cache)+ 安全构造性(两阶段运行时/网络策略)+ 交付面(mobile)"。这些不是"竞品有我没有",而是"AH 自己的 PRD/威胁模型/phase 路线在框架层不成立"。

**AH 框架范式差异(3 项建议):** routing slip 分布式编舞(Paigeant)、JS 脚本 workflow(Claude Code)、offloading 细粒度(Deep Agents)。不同范式,吸收能扩展能力范围,但不补不会自相矛盾。

**最关键的隐性框架缺口:** AH 没有把"文件系统"当一等抽象(FG4),导致 sandbox/tools/memory/RAG 四套抽象并存,权限绕过+事务+一致性三重问题。这是最深的设计缺口,优先级应高于 Computer Use。
