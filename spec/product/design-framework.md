# Design Framework — Trust-Native Agent Platform

> 产品设计框架。把 AH 已有的框架护城河翻译成用户可感知、可操作、可信任的产品体验。
> 基于事实:每条设计决策指向 AH 已有的架构文档 + 竞品已验证的产品形态。

---

## 0. 核心命题

**竞品的产品领先是"易用 + 集成广",这是浅层——任何竞品都能加 Slack 集成、加 mobile 面。AH 的产品领先是"信任深度产品化",这是深层——竞品无法复制,因为他们的框架没有 TCB / Independent Verifier / Capability Token / 6 类记忆 / ExternalEffect 状态机。**

当前 AH 的问题不是"框架不够强",而是"框架护城河没有被翻译成产品体验"。框架层领先没有传导到产品层。这个设计框架解决传导问题:把 5 条框架护城河翻译成 5 个用户可感知的产品支柱,形成一个连贯的产品身份。

## 产品身份

**AH 是"信任原生的 agent 平台"(Trust-Native Agent Platform)**:用户能精确控制 agent 自主度(Trust Dial),每个行为可验证(Evidence Ribbon),agent 有归用户所有的人格(Memory Sovereign),数据不离手(Privacy First),agent 会变好但不越界(Bounded Evolution)。

这个身份是竞品无法复制的——他们的框架是"执行引擎 + 权限开关",AH 的框架是"可验证信任基础设施"。他们的产品形态(易用/集成广)AH 可以补(已在 FG1-FG11 框架修复中补了 computer-use/网络策略/VFS 等);AH 的产品形态(信任深度)他们补不了。

---

## 1. 五个设计支柱

每个支柱:框架基础(已有)→ 产品体验(要设计)→ 竞品对比(基于事实)→ 落地(具体 screen/UX 决策)→ trade-off 解决。

### 支柱 1:Trust Dial(信任旋钮)

**框架基础**(已有):
- EffectRisk → DerivedRisk Tier 0-5(action-control.md)
- Capability Token 单次/签名/TOCTOU 重验(trust-boundaries.md, action-control.md)
- PEP@every action(action-control.md 12 步)
- consent 分级(T0-T1 auto, T2 session confirm, T3+ exact preview, T4 recent_password, T5 webauthn)
- 安全先于路由(routing-system.md)

**产品体验**:
用户为每个域/任务调"自主度旋钮",不是全局 binary。旋钮有 6 档,对应 T0-T5:
- T0-T1(读取/幂等写):agent 自主执行,用户只看结果
- T2(非幂等本地):agent 执行后通知,可回滚
- T3(外部副作用):执行前预览,用户一键批准/拒绝
- T4-T5(不可逆/高影响):需近期密码/webauthn

**关键产品化**:旋钮不是用户手动设 T0-T5,而是 agent 根据 EffectRisk 自动推导 + 用户可见可调。用户看到的是"这个任务 agent 会:读 5 个文件(自主)、改 3 个文件(通知后)、发 1 封邮件(需你批准)"——人话,不是 T 码。

**域感知**:不同域不同默认 dial。coding 域默认 T2(可回滚的本地写),external actions 默认 T3(需批准),personal assistant 默认 T3。这是竞品做不到的——他们的权限是全局的(Claude Code 6 mode 不分域,Codex sandbox 不分任务)。

**竞品对比**(基于事实):
- Claude Code: 6 permission modes(default/acceptEdits/plan/auto/dontAsk/bypassPermissions),全局,不分域/任务。用户要手动切。
- Codex: sandbox mode(read-only/workspace-write/danger-full-access)+ approval policy(on-request/untrusted/never),二元,不分域。
- Manus: 无用户侧自主度控制(几乎全自动)。
- AH: 6 档 × 域感知 × 任务感知 × 风险自动推导。更深。

**落地**:
- onboarding:设默认 dial per persona(Founder T4 ceiling, Developer T2, Researcher T0)
- chat screen:显示当前任务的 dial 摘要("3 自主 / 1 需批准")
- task_view:每个 step 显示它的 tier + 状态
- settings:可调每域默认 dial(Advanced profile)

**trade-off 解决**:复杂度。Simple profile 隐藏 dial(全用推导默认),Advanced/Debug 才显示可调。用户不碰 dial 也能用——默认安全(T0-T1 auto, T2 notify, T3+ confirm)。

### 支柱 2:Evidence Ribbon(证据带)

**框架基础**(已有):
- Independent Verifier 异模型,不看生成者上下文(assurance.md)
- Evidence E0-E7 绑定实际验证强度(assurance.md)
- WORM audit sink(trust-boundaries.md)
- run/step/operation/attempt 状态机(state-machines/)
- OTel trace + replay(operations)

**产品体验**:
每个 agent 行动有一条"证据带":做了什么 → 验证到什么级别(E0-E7)→ 是否独立验证过(异模型)→ 可 replay。不是日志,是可读的"信任凭证"。

**关键产品化**:证据分层显示。成功 + 低风险(E2 以下)折叠成一行("3 文件已改,单元测试过")。失败 + 高风险(E4+)展开成证据链(谁批准的 / 执行了什么 / 独立验证结论 / 为什么通过)。用户可 replay 任何 run 看 agent 当时怎么决策的。

**竞品对比**(基于事实):
- Manus: agent 行为黑盒,输出即结果,无验证层。
- Claude Code: 有 trace/replay 但无 Independent Verifier(同模型自评),无 E0-E7 分级。
- Codex: auto-review 是审批前评审,不是执行后独立验证。
- Deep Agents: LangSmith tracing 是可观测,不是可验证(同体系自评)。
- AH: 异模型独立验证 + E0-E7 强度分级 + WORM 不可篡改。这是企业/合规级的产品差异化。

**落地**:
- evidence_viewer:从"列表"升级为"run timeline + 证据层 + replay 按钮"
- task_view:每个 step 旁有证据图标(E0-E7 色阶)
- 新 screen:replay_player(时间轴拖拽,看 agent 每步决策 + 证据)

**trade-off 解决**:噪音。默认只显示 < E3 的摘要,E4+ 展开。replay 是按需展开(不占主界面)。

### 支柱 3:Memory Sovereign(记忆主权)

**框架基础**(已有):
- 6 类记忆(episodic/semantic/procedural/preference/relationship/goal)(context-memory-rag.md)
- provenance(每条记忆有来源)
- trust assessment(记忆有信任度)
- conflict resolution(冲突记忆有解决)
- TTL + auto-expiry
- negative quarantine(失败记忆隔离)
- model 不可直接写高信任事实

**产品体验**:
agent 有持久人格,跨会话学习。用户在 memory_center 可看/删/纠每条记忆,看信任度/来源/冲突。记忆默认 agent 自管,用户可介入但不必介入。

**关键产品化**:记忆不是文件(CLAUDE.md),是结构化人格图谱。用户看到的是"agent 记住:你喜欢简洁回复(来源:3 次纠正,信任度 0.8)"。冲突记忆显式标注("agent 记住你用 tabs,但最近 2 次你用 spaces")。负反馈自动进 negative memory("上次 refactor 你否决了重命名,agent 记住了")。

**竞品对比**(基于事实):
- Claude Code: CLAUDE.md + auto-memory,flat 文件,无类型/trust/conflict/negative。
- Deep Agents: long-term memory via VFS,无 6 类/trust/conflict/quarantine。
- Manus: 文件系统即记忆,无结构化人格。
- AH: 6 类 + provenance + trust + conflict + TTL + negative。是"结构化 agent 人格",不是"记忆文件"。

**落地**:
- memory_center:从"列表"升级为"记忆图谱(按类型分组) + 信任度色阶 + 冲突标注"
- 新交互:记忆纠正(用户改一条,agent 更新 trust)
- notifications:低信任/冲突记忆提醒(不强制管理)

**trade-off 解决**:管理负担。默认 agent 自管,只在 conflict(冲突)/ low-trust(信任度<0.5)/ negative(失败)时通知用户。用户不碰也能用。

### 支柱 4:Privacy First Surface(隐私优先面)

**框架基础**(已有):
- local-first vault(ADR-006, onboarding)
- data classification(privacy-ux.md)
- Memory write PII check(request-to-outcome.md)
- provider data policy validation(model-api-gateway.md)
- Secrets Broker 短临凭证(action-control.md, FG2 两阶段运行时)

**产品体验**:
用户始终知道"数据在哪"(local / cloud / 哪个 provider)。敏感数据本地处理,云模型只收脱敏元数据。隐私中心可配每类数据去向。每个 action 有"数据流指示器"(这个 action 的数据去了哪)。

**关键产品化**:不是隐私政策文档,是实时可见的数据流。用户在 chat 里看到"这个 PDF 在本地解析,摘要发给 Claude(脱敏)"。敏感操作前弹"这个操作会把 X 发给 Y,继续?"。

**竞品对比**(基于事实):
- Manus/Claude Code/Codex/Deep Agents: 全云端,数据流向不透明。用户不知道 agent 把什么发给了哪个 provider。
- AH: local-first + 透明数据流 + 可配每类数据去向。隐私优先市场的产品差异化。

**落地**:
- privacy_center:从"设置页"升级为"实时数据流看板 + 每类数据去向配置"
- chat screen:每个 action 有数据流图标(local/cloud/provider 名)
- onboarding:隐私设置默认"敏感本地,非敏感可选 cloud"

**trade-off 解决**:local-first vs 零安装冲突。解决:分层部署。敏感数据(PII/财务/健康)强制 local,非敏感(代码/公开文档)可选 cloud 托管(降低 onboarding 摩擦)。FG2 两阶段运行时保证 agent 阶段密钥物理剥离。

### 支柱 5:Bounded Evolution(有界演化)

**框架基础**(已有):
- evolution shadow mode only(evolution.md)
- CANNOT:不改 policy / 不扩 tool / 不提权 / 不取 secret / 不开 external write / 不绕 release gate / 不自动提权 generated tools
- cold-start safety(N<10 pure rules)
- 4 evolution agents(dedup/techdebt/evaldrift/doccleanup)
- negative memory quarantine

**产品体验**:
agent 会随使用变好,但永远不会越过用户设的边界。演化提议可见,用户可批准/拒绝。负反馈形成 negative memory。用户看到的是"agent 建议优化:把 read_file 改成批量读(预计省 30% token),shadow 测试通过,批准?"

**关键产品化**:演化不是黑盒"模型更新",是可见的提议流。每个提议有:shadow 测试结果 / 预期收益 / 影响范围 / 用户批准按钮。用户不批准就不生效。CANNOT 边界在 UI 显式标注("agent 不能改你的安全策略")。

**竞品对比**(基于事实):
- Deep Agents: "improve over time"无约束,agent 可自由更新 memory/prompt。
- Claude Code: auto-memory 无边界,agent 自由写。
- Manus: 无演化层。
- AH: shadow only + CANNOT + 用户批准 + cold-start。治理化演化是产品差异化。

**落地**:
- notifications:evolution suggestion(已有,升级为带 shadow 结果)
- 新 screen:evolution_center(提议列表 + 批准流 + shadow 对比)
- settings:演化边界可见(CANNOT 清单)

**trade-off 解决**:太保守则不变好。解决:shadow 自动跑(不阻塞用户),用户只批准"生效"。低风险提议(如 dedup)可设自动批准,高风险(如 prompt 改动)必须人工。

---

## 2. 可持续差异化分析

| 维度 | 竞品(浅层,可复制) | AH(深层,不可复制) |
|------|-------------------|-------------------|
| 自主度控制 | 全局 binary mode | 域感知 × 任务感知 × 风险推导 6 档 |
| 行为可验证 | 同体系 trace | 异模型独立验证 + E0-E7 + WORM |
| 记忆 | flat 文件 | 6 类结构化人格 + trust + conflict |
| 隐私 | 全云端不透明 | local-first + 实时数据流 |
| 演化 | 无约束 improve | shadow + CANNOT + 用户批准 |

**为什么竞品无法复制**:他们的框架没有 TCB 6 组件(信任无法分离)、没有 Independent Verifier(无法异模型验证)、没有 Capability Token(无法 per-action 签名)、没有 6 类记忆(无法结构化人格)、没有 ExternalEffect 状态机(无法事务化外部动作)。要补这些不是加 feature,是重写框架。Manus 重写过 4 次(其博客承认),Claude Code/Codex 的框架是闭源单体,无法加 TCB。

**AH 能补竞品浅层的**:已在 FG1-FG11 框架修复中补了 computer-use/网络策略/VFS/KV-cache/routing slip/msg integrity/workflow script/offloading。浅层差距在缩小,深层差距在保持。

---

## 3. 落地优先级

### Phase 1-2(立即,产品身份确立)
- **Trust Dial**:onboarding 设默认 dial per persona;chat screen 显示任务 dial 摘要。这是产品身份的第一印象。
- **Evidence Ribbon**:evidence_viewer 升级为 timeline + replay。这是"可验证"的可感知面。
- **Privacy First**:chat screen 加数据流图标;onboarding 隐私默认(敏感 local)。

### Phase 3-4(信任深度产品化)
- **Memory Sovereign**:memory_center 升级为图谱 + trust + conflict。记忆人格化。
- **Bounded Evolution**:evolution_center + 批准流。治理化演化可见。

### Phase 5-8(企业/合规变现)
- Evidence Ribbon 的 E0-E7 对接 SOC2/ISO27001/HIPAA 审计(企业为合规付费)。
- Trust Dial 的 T4-T5 对接金融/医疗(高影响操作需 webauthn)。
- Privacy First 对接 GDPR/CCPA(数据驻留 + 删除权)。

---

## 4. 这个框架解决了什么产品层缺口(对应 ../appendix/competitor-research/PRODUCT-GAP-ANALYSIS.md)

| 产品层缺口 | 本框架如何解决 |
|-----------|--------------|
| P1 产品定位缺失 | 产品身份 = Trust-Native(5 支柱) |
| P3 零安装形态 | 分层部署(敏感 local,非敏感 cloud)解决 onboarding 摩擦 |
| P4 Onboarding 摩擦 | Trust Dial 默认安全 + Simple profile 隐藏旋钮 |
| P5 集成 surface | external actions + Trust Dial = agent 住在外部工具但自主度可调 |
| P6 轻量协作 | Evidence Ribbon 的 replay 可分享(分享一个 run 的证据带) |
| P10 反馈循环 | Bounded Evolution = 用户反馈→shadow→批准→生效 |

未解决的(需战略决策):
- P2 商业模式(开源 vs 商业)——仍需用户定。
- P7 垂直深度——本框架是横切设计,垂直深度需 per-domain 补。
- P9 Free tier——依赖 P2 决策。

---

## 5. 设计原则(约束所有产品决策)

1. **默认安全,可调透明**:用户不碰任何设置也能安全使用(默认 T0-T1 auto)。高级控制透明可见但不强制。
2. **人话优先,技术码在后**:用户看到"agent 会发 1 封邮件(需你批准)",不是"T3 consent required"。
3. **证据分层,不造噪音**:成功折叠,失败展开,高风险突出。
4. **local 默认,cloud 可选**:敏感数据强制 local,非敏感可选 cloud。
5. **演化可见,边界不可越**:用户能看到 agent 在变好,但 CANNOT 边界永远显式。
