# Harness 项目整理笔记

## 仓库说明

项目有两个 GitHub 仓库：

| 仓库 | URL | 角色 | commits |
|------|-----|------|---------|
| **agentharness91** (product) | https://github.com/123oqwe/agentharness91.git | **最终源码落实仓库** | 87 |
| agent-harness-v9.1 (origin) | https://github.com/123oqwe/agent-harness-v9.1.git | 早期开发分叉（已废弃） | 50 |

两个仓库从 `fdcca74` (docs: normalize phase architecture design) 分叉后各自独立发展。
agentharness91 是主仓库，包含更成熟的实现（managed-gateway、tool-executor、harness.ts 组合根等）。

## agentharness91 目录结构 (153 个 .ts 文件)

```
harness/
├── harness.ts                    # 组合根：TaskContract → Policy → Router → Loop → Gateway → Tool → VFS → Session → Evidence
├── index.ts                      # 公共 API 导出
│
├── gateway/                      # 模型网关层
│   ├── model-gateway.ts          # FrozenProviderRegistry + ModelGateway (resolve/dispatch/switchProvider)
│   ├── managed-gateway.ts        # ManagedGateway：KeyVault + CapabilityRegistry + RateLimiter + CircuitBreaker + failover
│   ├── glm-provider.ts           # GLM-5.2 provider adapter（支持 tools/tool_calls 原生函数调用）
│   ├── glm-gateway-bridge.ts     # GLM ↔ ModelGateway 桥接
│   ├── scripted-provider.ts      # 确定性测试 provider（零网络）
│   ├── key-vault.ts              # AES-256-GCM 加密密钥存储，从环境变量/.env 自动加载
│   ├── capability-registry.ts    # 模型能力注册表（capabilities/pricing/context/tools/data_policy）
│   ├── rate-limiter.ts           # 滑动窗口速率限制（rpm/tpm/concurrent）
│   ├── circuit-breaker.ts        # 熔断器（CLOSED→OPEN→HALF_OPEN→CLOSED）
│   ├── economic-kernel.ts        # 经济内核（预算追踪）
│   ├── llm-cache.ts              # LLM 缓存（TTL + 持久化）[新增]
│   ├── server.ts                 # WebSocket 服务器
│   └── ws-server.ts              # WS 连接管理
│
├── runtime/                      # 运行时层
│   ├── loop.ts                   # LoopEngine：direct/react/plan_execute 策略 + 停止条件 + 错误分类 + progress.json
│   ├── sandbox.ts                # OS 原生沙箱（macOS Seatbelt sandbox-exec / Linux bwrap / Windows JobObject）
│   ├── event-bus.ts              # EventBus pub/sub 流式事件 [新增]
│   ├── plugin-manager.ts         # PluginManager hooks 系统（pre_tool_use deny 不可绕过）[新增]
│   ├── session-manager.ts        # SessionManager 多轮对话 + SteeringQueue [新增]
│   ├── health-monitor.ts         # HealthMonitor 组件健康检查 [新增]
│   ├── context-rag.ts            # 语义分块/向量检索/压缩/输出验证/状态reducer/few-shot/消毒/注入检测/文档验证 [新增]
│   ├── context-offload.ts        # 机械卸载（>20K chars 写入 VFS）[新增]
│   ├── retry.ts                  # 重试策略（分类：network/rate_limited/server/timeout）
│   └── notifications.ts          # 通知队列
│
├── security/                     # 安全控制层
│   ├── policy-engine.ts          # PolicyEngine deny-by-default 策略引擎
│   ├── pep.ts                    # PolicyEnforcementPoint（单次使用 token + TOCTOU + AuditSinkPort 审计日志）
│   ├── capability.ts             # CapabilityService 单次使用能力令牌
│   ├── authorization-service.ts  # AuthorizationService Ed25519 签名授权
│   ├── auth.ts                   # 认证服务
│   ├── secrets-broker.ts         # SecretsBroker 单次交换凭证
│   ├── consent-service.ts        # ConsentService 用户同意管理（scope/expiry/revoke）[新增]
│   └── mcp-allowlist.ts          # MCP Allowlist + McpClient（stdio + SSE）[新增]
│
├── tools/                        # 工具层
│   ├── tool-registry.ts          # ToolRegistry（冻结快照 + tool_search + tool_load 延迟加载）
│   ├── tool-executor.ts          # ToolExecutor（Policy→Capability→PEP→VFS/Sandbox→Receipt→Evidence 全链路）
│   ├── skill-registry.ts         # SkillRegistry
│   ├── edit-file.ts              # edit_file（find/replace 补丁 + checkpoint）
│   ├── read-file.ts              # read_file
│   ├── write-file.ts             # write_file
│   ├── list-directory.ts         # list_directory
│   ├── search-files.ts           # search_files
│   ├── execute-command.ts        # execute_command_sandboxed
│   ├── create-artifact.ts        # create_artifact
│   └── ask-user.ts               # ask_user
│
├── vfs/                          # 虚拟文件系统层
│   ├── virtual-filesystem.ts     # VirtualFilesystem（权限规则 + OverlayBackend 事务隔离 + checkpoint/restore）
│   └── composite-backend.ts      # CompositeBackend 路由（/workspace//scratch//memories//evidence/）+ 锁 + hash chain [新增]
│
├── router/                       # 路由层
│   └── static-router.ts          # StaticRouter（TaskContract→RunPlan，策略选择 direct/react/plan_execute）
│
├── session/                      # 会话层
│   └── durable-session.ts        # DurableSession（append-only 事件日志 + hash chain + 快照 + 崩溃恢复）
│
├── ingestion/                    # 文档摄入层
│   ├── parse-document.ts         # parse_document（txt/md/json/csv/html + PDF/DOCX/PPTX/XLSX/audio/video 检测）[扩展]
│   └── ah_doc_vertical_001.ts    # 文档垂直领域
│
├── verification/                 # 验证层
│   ├── evidence.ts               # EvidencePackage（从实际命令输出生成，不可伪造）
│   └── eval-runner.ts            # EvalRunner 评估运行器
│
├── domains/                      # 垂直领域
│   └── coding/ah_coding_vertical_001.ts
├── research/
├── writing/
├── planning/
├── personal_assistant/
└── ui/                           # UI 适配器（8 个）
    ├── ui-state.ts
    ├── ah_ui_chat_001.ts
    ├── ah_ui_coding_001.ts
    ├── ah_ui_approval_001.ts
    ├── ah_ui_evidence_001.ts
    ├── ah_ui_onboarding_001.ts
    ├── ah_ui_privacy_001.ts
    ├── ah_ui_settings_001.ts
    └── ah_ui_task_001.ts
```

## 52 个问题验证总结

### Phase 1 (P1-01 ~ P1-24)

| 问题 | 状态 | 实现位置 | 说明 |
|------|------|----------|------|
| P1-01 原生函数调用 | ✅ 已有 | glm-provider.ts | tools 数组 + tool_calls 解析，tool_choice 支持 |
| P1-02 edit_file 幂等性 | 🔧 已修 | tool-executor.ts | idempotent_write → non_idempotent_write |
| P1-03 OS 级沙箱 | ✅ 已有 | runtime/sandbox.ts | sandbox-exec/bwrap/JobObject + fail-closed |
| P1-04 网络策略 | ✅ 已有 | sandbox.ts + policy-engine.ts | egress allowlist + SSRF 防护 |
| P1-05 interrupt/resume | 🔧 已补 | loop.ts | auto_execute=false 暂停 + plan_ready 事件 |
| P1-06 流式输出 | 🔧 已补 | event-bus.ts + loop.ts | EventBus publish model_called/run_state_change |
| P1-07 模块接线 | 🔧 已补 | harness.ts | HealthMonitor/EventBus/PluginManager/SessionManager 加入 HarnessConfig |
| P1-08 多轮对话 | 🔧 已补 | session-manager.ts + harness.ts | SessionManager 加入 HarnessConfig |
| P1-09 错误分类 | ✅ 已有 | loop.ts + scripted-provider.ts | rate_limited(429)不重试，truncation不重试 |
| P1-10 plan mode | 🔧 已补 | loop.ts | auto_execute=false → paused + plan_ready |
| P1-11 max_iterations | 🔧 已修 | static-router.ts | 3 → 50 |
| P1-12 truncation 恢复 | ✅ 已有 | loop.ts | stop_reason=length → malformed_response，不执行 |
| P1-13 崩溃恢复 | ✅ 已有 | loop.ts + durable-session.ts | progress.json 每轮写 + 事件日志 hash chain |
| P1-14 审计日志 | ✅ 已有 | pep.ts | AuditSinkPort write allow/deny |
| P1-15 diff/patch 编辑 | ✅ 已有 | edit-file.ts | find/replace + checkpoint |
| P1-16 API mock 模式 | ✅ N/A | server.ts | 使用真实 KeyVault + ManagedGateway，无硬编码 mock |
| P1-17 Gateway 组件 | ✅ 已有 | managed-gateway.ts | KeyVault + CapabilityRegistry + Router + UsageMeter |
| P1-18 速率限制 | ✅ 已有 | rate-limiter.ts | rpm/tpm/concurrent 滑动窗口 |
| P1-19 熔断器 | ✅ 已有 | circuit-breaker.ts | CLOSED→OPEN(5次失败)→HALF_OPEN(60s)→CLOSED |
| P1-20 fallback 自动恢复 | ✅ 已有 | managed-gateway.ts | 失败后自动切到下一个 provider |
| P1-21 成本估算 | ✅ 已有 | capability-registry.ts | estimateCost() 在 route 中调用 |
| P1-22 工具格式重验证 | ⚠️ 接口存在 | capability-registry.ts | tool_calling 元数据字段，各 adapter 独立序列化 |
| P1-23 路由评分 | ✅ 已有 | model-gateway.ts | 硬约束过滤 + 按价格排序，无猜测权重 |
| P1-24 hooks 系统 | 🔧 已补 | plugin-manager.ts + loop.ts | on_task_start/on_task_end 接入 LoopEngine |

### Phase 2 (P2-01 ~ P2-28)

| 问题 | 状态 | 实现位置 | 说明 |
|------|------|----------|------|
| P2-01 比例上下文预算 | 🔧 已补 | context-rag.ts | allocateContextBudget(modelContextWindow) |
| P2-02 向量嵌入 | 🔧 已补 | context-rag.ts | EmbeddingProvider + cosineSimilarity + hybridSearch |
| P2-03 语义分块 | 🔧 已补 | context-rag.ts | Python def/class, Markdown header, generic paragraph |
| P2-04 增量索引 | 🔧 已补 | context-rag.ts | FileFingerprint + computeFingerprint + fingerprintsEqual |
| P2-05 上下文卸载 | 🔧 已补 | context-offload.ts | >20K chars 写入 VFS /scratch/ |
| P2-06 自动压缩 | 🔧 已补 | context-rag.ts | compactMessages 70% 触发 |
| P2-07 压缩模型 | 🔧 已补 | context-rag.ts | verifyModel L3 + preserveKeys |
| P2-08 延迟工具加载 | 🔧 已补 | tool-registry.ts | tool_load() 函数 |
| P2-09 MCP SSE 传输 | 🔧 已补 | mcp-allowlist.ts | McpTransportType 'stdio' \| 'sse' |
| P2-10 MCP allowlist | 🔧 已补 | mcp-allowlist.ts | isStdioAllowed + isRemoteAllowed |
| P2-11 结构化输出验证 | 🔧 已补 | context-rag.ts | validateStructuredOutput + validationRetryPrompt |
| P2-12 LLM 缓存 | 🔧 已补 | llm-cache.ts | TTL + 持久化 |
| P2-13 文档加载器 | 🔧 已修 | parse-document.ts | detectFormat() 支持 PDF/DOCX/PPTX/XLSX/HTML |
| P2-14 同意管理 | 🔧 已补 | consent-service.ts | approve/check/revoke + path scope + expiry |
| P2-15 VFS 即记忆 | 🔧 已补 | composite-backend.ts | /workspace//scratch//memories//evidence/ 路由 |
| P2-16 OverlayBackend 并发 | 🔧 已补 | composite-backend.ts | 文件级锁 |
| P2-17 EvidenceBackend 完整性 | 🔧 已补 | composite-backend.ts | hash chain + verifyEvidenceChain + WORM |
| P2-18 流式输出模式 | 🔧 已补 | event-bus.ts | StreamMode values/updates/messages/custom/debug |
| P2-19 注入检测 | 🔧 已补 | context-rag.ts | detectInjectionRegex + quarantine |
| P2-20 输出消毒 | 🔧 已补 | context-rag.ts | sanitizeToolCall 路径遍历/shell 注入检测 |
| P2-21 凭证脱敏 | 🔧 已补 | context-rag.ts | redactCredentials + SECRET_PATTERNS |
| P2-22 音频/视频摄入 | 🔧 已修 | parse-document.ts | audio/video 格式检测 + transcribe_audio 标记 |
| P2-23 会话树最大深度 | 🔧 已补 | session-manager.ts | maxSessionDepth=3 |
| P2-24 steering queue 限制 | 🔧 已补 | session-manager.ts | steer:5/follow_up:10/next_turn:20 |
| P2-25 few-shot 管理 | 🔧 已补 | context-rag.ts | ExampleSelector 关键词匹配 |
| P2-26 状态 reducer | 🔧 已补 | context-rag.ts | reduceState overwrite/append/merge/vote |
| P2-27 OCI sandbox | ✅ N/A | sandbox.ts | 默认用 OS-native sandbox，OCI 可选 |
| P2-28 非代码输出验证 | 🔧 已补 | context-rag.ts | verifyDocumentOutput 4 维度 |

## 本次提交记录 (agentharness91)

1. `e5d74fb` — 修复 P1-02/P1-11/P2-13/P2-22 + 新增 9 个缺失模块
2. `4c1cc0d` — 接线 P1-05/P1-06/P1-07/P1-08/P1-10/P1-24 + 新增 P2-12 LLM cache

## 验证状态

- 673 tests pass, 23 skipped, 0 failed
- typecheck clean
- build OK
- 已推送到 https://github.com/123oqwe/agentharness91.git main 分支
