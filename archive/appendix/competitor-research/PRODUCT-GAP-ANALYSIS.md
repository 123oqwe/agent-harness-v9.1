# 产品层差距分析 — Agent Harness v9.1 vs Manus / Claude Code / Codex

> 产品视角(非框架/技术)。竞品事实来自官方产品页/定价页/文档(2026-07 抓取)。
> 判定标准:不补则产品在市场上不成立或无获客路径。

---

## 0. 结论先行

AH 的产品文档是**骨架级**(每个文件 5-15 行 bullet),不是可执行的产品规格。竞品(Manus/Claude Code/Codex)都已发货,有完整的产品形态、定价、交付面、用户旅程、生态集成。AH 在产品层落后于全部三家,且不只是"没写代码"——是**产品决策本身缺失**:

1. **没有产品定位**:PRD mission 是技术叙事("build a harness"),不是用户叙事。竞品都有清晰的"为谁解决什么问题"。
2. **没有商业模式**:billing 只说 provider pass-through,没有 AH 自己的定价/订阅/free tier。竞品都有明确定价。
3. **没有零安装形态**:local-first 要求 6 步 onboarding(装 vault/配 provider),竞品 Manus 是 0 步(web 直接用)、Claude Code 是 1 步(login)。
4. **没有产品集成 surface**:external actions 是"agent 调外部 API",不是"agent 住在 Slack/Chrome/GitHub 里"。竞品把 agent 推进用户现有工作流。
5. **没有轻量协作**:企业 RBAC 在 Phase 7,但个人/小团队没有"分享 task 结果/replay"。
6. **垂直广而不深**:7 角色 12 面,但 coding 域只有 1 个 vertical requirement。Claude Code/Codex 深耕 coding。
7. **产品文档悬空**:user-journeys.md 说"See domains/"但 spec/domains/ 不存在。

---

## 1. 逐维度对标

### 1.1 产品定位与叙事

| | AH | Manus | Claude Code | Codex |
|---|---|---|---|---|
| Mission | "Build a general-purpose Agent Harness" | "General AI agent that works for you" | "AI coding assistant" | "Coding agent" |
| 叙事性质 | 技术叙事(给工程师看) | 用户叙事(给大众看) | 用户叙事(给开发者看) | 用户叙事 |
| 目标用户清晰度 | 7 角色,广而模糊 | 大众知识工作者 | 开发者(清晰) | 开发者(清晰) |

**差距:** AH 的 mission 是"我们要造什么",不是"用户得到什么"。竞品都是"用户得到什么"。AH 需要一个面向用户的 product narrative。

### 1.2 商业模式与定价

| | AH | Manus | Claude Code | Codex |
|---|---|---|---|---|
| 定价模式 | 未定义(只说 provider pass-through) | $39/月起 + credits,有 free tier | $20/月 Pro, $100/月 Max + API | $20/月 Plus, $200/月 Pro + API |
| Free tier | 无 | 有(free credits) | 有(有限用量) | 有(有限用量) |
| 获客漏斗 | 无 | free → paid | subscription lock-in | subscription lock-in |
| 计费粒度 | per-task/per-day/per-month budget | per-task | subscription + usage | subscription + usage |

**差距:** AH 假设"用户自带 API key + AH 不收费",这是开源/自托管模式。但如果要商业化(launch-plan Phase 8 production),没有定价策略 = 没有商业模式。billing-and-limits 只定义了成本控制(budget guard),没有收入侧(subscription/usage billing)。

### 1.3 交付面广度

| | AH | Manus | Claude Code | Codex |
|---|---|---|---|---|
| 终端用户面 | CLI(Phase1), Web/Desktop(Phase2), Mobile(Phase6) | Web + Mobile(iOS/Android) | Terminal/VSCode/JetBrains/Desktop/Web/Mobile | CLI/Cloud/IDE |
| 零安装形态 | 无(local-first 需装 vault) | 有(web 直接用) | 部分(Web 面) | 有(Cloud) |
| 外部通道 | 无 | Slack | Telegram/Discord/iMessage/webhook | 无 |
| Remote Control | 无(Phase 6 mobile 才有) | mobile app | 手机续会话 | cloud tasks |

**差距:** AH 的 local-first 是架构选择(安全/隐私优势),但产品代价是高 onboarding 摩擦。竞品的"零安装云端"形态是核心获客路径——用户不装任何东西就能用。AH 没有"云端即时用"选项(用户必须先装 vault+配 provider)。

### 1.4 Onboarding 摩擦

| | AH | Manus | Claude Code | Codex |
|---|---|---|---|---|
| 步数 | 6 步(account/vault/provider/connector/privacy/tool permission) | 0 步(web 输入任务) | 1 步(login) | 1 步(login) |
| 需要用户决策 | 加密初始化、API key、模型选择、数据分类、工具权限 | 无 | 无(用默认) | 无 |
| 首次到价值时间 | 高(需理解 vault/provider/permission) | 秒级 | 分钟级 | 分钟级 |

**差距:** AH 的 6 步 onboarding 是 local-first 架构的产品代价。竞品都用"默认配置 + 延迟配置"降低摩擦。AH 应该:提供"快速开始"(默认 vault + 默认 provider 引导 + 全 T0-T1 自动批准),把 6 步压缩到 1-2 步,高级配置延后。

### 1.5 协作与分享

| | AH | Manus | Claude Code | Codex |
|---|---|---|---|---|
| 分享 task 结果 | 无 | 有(可分享 task replay) | 有(GitHub PR review) | 有(GitHub PR) |
| 团队工作区 | Phase 7 企业 RBAC | 无(个人产品) | Agent teams(peer sessions) | 无 |
| 轻量协作 | 无 | task 分享链接 | Slack/Channels 推送 | 无 |
| 实时协作 | 无 | 无 | agent teams 共享 task list | 无 |

**差距:** AH 的协作是 Phase 7 企业级(重),没有 Phase 1-3 的轻量协作(分享单个 task 结果、replay)。竞品都有"分享 task 结果"的轻量路径。AH 应补:task 结果可分享链接/replay(Phase 2+)。

### 1.6 产品集成 surface(agent 住在用户工具里)

| | AH | Manus | Claude Code | Codex |
|---|---|---|---|---|
| Slack | Phase 5 external action(agent 调 Slack API) | Slack 集成 | Slack(消息推进会话) | 无 |
| GitHub | Phase 5 external action(PR create) | 无 | GitHub Actions(PR review) | GitHub PR review |
| Chrome/Browser | Phase 3 browser_operate(工具) | Browser Operator 扩展 | Chrome 扩展(调试 web app) | 无 |
| IDE 插件 | Phase 1 CLI | 无 | VSCode/JetBrains 插件 | IDE 扩展 |
| 定时任务 | Phase 6 routine scheduler | scheduled tasks | Routines / Desktop scheduled | 无 |

**差距:** AH 的 external actions 是"agent 主动调外部 API"(agent-centric)。竞品的是"外部工具把 agent 拉进来"(tool-centric:Slack 消息推进会话、GitHub PR 触发 review)。这是产品形态差异:AH 把 agent 当中心,竞品把用户现有工作流当中心。AH 缺"agent 作为现有工具的插件"形态。

### 1.7 垂直深度

| | AH | Manus | Claude Code | Codex |
|---|---|---|---|---|
| Coding | 1 vertical requirement(read repo→fix bug→test→diff) | 通用(不深耕) | 深耕(整个产品就是 coding) | 深耕 |
| Documents | 1 vertical + 9 ingest + 4 parse | 通用 | 无 | 无 |
| Research | 1 vertical + 2 tools | 通用(Wide Research) | 无 | 无 |
| 垂直数量 | 7 域 | 1(通用) | 1(coding) | 1(coding) |

**差距:** AH 广(7 域)而不深(每域 1 vertical)。竞品窄而深。AH 的广度是产品差异点,但每个垂直只有 1 个 vertical requirement 意味着没有真正的垂直深度。coding 域只有 AH-CODING-VERTICAL-001,而 Claude Code/Codex 整个产品都是 coding 深度。AH 应:Phase 1-2 把 coding 做深(不只 1 vertical),其他域 Phase 3+ 逐步加深。

### 1.8 产品文档完整性

| | AH | Manus | Claude Code | Codex |
|---|---|---|---|---|
| PRD | 10 行 | 详细产品页 | 详细文档站 | 详细文档站 |
| 用户旅程 | 1 行("See domains/") | 公开用例库 | quickstart/common-workflows | use-cases |
| JTBD | bullet list(25 jobs) | 隐含在用例 | 隐含在文档 | 隐含 |
| Screen specs | 有(23 screens,结构化) | 无(产品直接看) | 有 | 无 |
| domains/ 目录 | 不存在(悬空引用) | N/A | N/A | N/A |

**差距:** AH 的产品文档是骨架(bullet 级),不是可读的产品说明。user-journeys.md 说"See domains/"但 spec/domains/ 不存在。竞品都有可读的 quickstart/workflows。AH 应:把 bullet 扩成可读文档,创建 domains/ 目录或修正引用。

### 1.9 获客与留存

| | AH | Manus | Claude Code | Codex |
|---|---|---|---|---|
| Free tier | 无 | 有 | 有 | 有 |
| 获客路径 | 无(API key 门槛) | free → paid | subscription | subscription |
| 留存机制 | evolution(技术) | task history | CLAUDE.md memory + auto-memory | 无 |
| 产品反馈循环 | 无 | 隐含 | LangSmith eval(Deep Agents 有) | 无 |

**差距:** AH 没有 free tier = 没有获客漏斗。用户必须自带 API key 才能用,门槛高。竞品都有 free tier 降低试用门槛。AH 的 evolution 是技术演化,不是产品反馈循环(用户反馈→产品改进)。

---

## 2. 必须补的产品层缺口(不补则产品不成立)

### P0(产品成立性)

| # | 缺口 | 理由 |
|---|------|------|
| P1 | **产品定位/叙事** | PRD mission 是技术叙事。没有用户叙事 = 没有产品身份,用户不知道"这解决我什么问题"。 |
| P2 | **商业模式/定价** | billing 只有成本侧,没有收入侧。launch-plan Phase 8 production 但无定价 = 无商业模式。 |
| P3 | **零安装云端选项** | local-first 6 步 onboarding 是高摩擦。没有"云端即时用"选项 = 没有低门槛获客路径。 |
| P4 | **快速开始 onboarding** | 6 步压到 1-2 步(默认配置 + 延迟高级配置),否则首次到价值时间太长,用户流失。 |

### P1(竞争力)

| # | 缺口 | 理由 |
|---|------|------|
| P5 | **产品集成 surface** | external actions 是 agent-centric;缺 tool-centric(Slack/Chrome/GitHub 把 agent 拉进现有工作流)。 |
| P6 | **轻量协作/分享** | 企业 RBAC 在 Phase 7;个人/小团队缺分享 task 结果/replay。 |
| P7 | **垂直深度(coding)** | 7 域广而不深;coding 只有 1 vertical。Phase 1-2 应把 coding 做深。 |
| P8 | **产品文档完整性** | bullet 骨架;user-journeys 引用不存在的 domains/。 |

### P2(增长)

| # | 缺口 | 理由 |
|---|------|------|
| P9 | **Free tier / 获客漏斗** | 无 free tier = 无试用路径。 |
| P10 | **产品反馈循环** | evolution 是技术;缺用户反馈→产品改进循环。 |
| P11 | **mobile/channels** | Phase 6+ 落后于 Claude Code(已发货)。 |

---

## 3. AH 已领先的产品决策(维持)

- **Local-first + Privacy Center**:安全/隐私是 AH 的产品差异点(竞品都是云端)。维持。
- **Experience Profiles(Simple/Advanced/Debug)**:竞品无这种 UI 复杂度分层。维持。
- **7 域广度**:竞品都窄(1 域)。AH 的广度是差异点,但要补深度。
- **23 screen specs 结构化**:竞品无这种级别的 UI 规格。维持。
- **WCAG 2.1 AA**:竞品未声明。维持。

---

## 4. 落地建议

1. **立即**:修 user-journeys.md 的 domains/ 悬空引用(创建目录或改引用)。补 product-prd.md 的用户叙事段落。
2. **Phase 1**:补"快速开始"onboarding profile(默认 vault + 默认 provider + T0-T1 自动批准,1-2 步)。coding 域加 2-3 个 vertical requirement(不只 1 个)。
3. **Phase 2**:补"云端托管"选项(零安装,provider 由 AH 托管,vault 可选)。补 task 结果分享/replay。
4. **Phase 3+**:补产品集成 surface(Slack channel injection / GitHub PR review trigger)。补 free tier 定义。
5. **Phase 8 前**:定义定价模式(subscription/usage/freemium)。

---

## 附:竞品产品事实来源

- Manus: manus.im(产品页/定价)、agentpatternscatalog.org(形态)
- Claude Code: code.claude.com/docs(overview/permissions/sub-agents/workflows)、claude.com/pricing
- Codex: developers.openai.com/codex、openai.com/pricing
