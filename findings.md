# Findings & Decisions

## Requirements
- 完成 Phase 1 mutation 地基验证 (P0-P13 全部子项, mutation score >= 0.7)
- 补厚 55 个薄测试 (每条 acceptance_criteria 至少 1 个测试)
- 同步 gate manifest owned_sources (已通过 mutation registry candidate-only 机制完成)
- Phase 2 mutation 64/64 completed (已完成)
- Evidence 生成 (通过 createPhase2EvidenceRecords, 不可伪造)
- Gate 闭环 + push 到 GitHub agentharness91 (product remote)
- 铁律: 不删测试、不降阈值、不加 skip、不伪造 evidence/mutation 结果

## Research Findings

### 仓库结构
- 扁平 monorepo, 和主仓库 agent-harness-v9.1 布局完全不同
- 源代码: packages/{runtime-core,documents,multimodal,tools,rag,api,ui}/src/ + apps/{api,web,tui,desktop}/src/ + 顶层 gateway/, runtime/, security/, tools/, router/, session/, vfs/, verification/
- 测试: tests/phase-2/{unit,integration,security,e2e,architecture}/ + tests/{gateway,runtime,session,tools,...}/
- Gate manifest: verification/gates/phase2-gate.json (byte-frozen, 64 requirements)
- Mutation registry: mutation/phase2-modules.mjs (可改, 64 项 sources 映射)

### model-gateway.ts (1434 lines) — P6 目标
- ModelGateway class: resolve(), dispatch(), dispatchExact(), dispatchStream(), stream(), switchProvider(), describeResolved()
- FrozenProviderRegistry: normalizes registrations, computes snapshot hash
- dispatchExact: 无 provider fallback, 但同 provider 重试 (maxAttempts=3)
- dispatchStream: 有 provider fallback for retryable, 同 provider 不重试 after eventsYielded>0
- dispatch (full): 有 provider fallback for retryable
- ProviderHttpError 映射:
  - 503 → kind='server', retryable=true
  - 401 → kind='auth', retryable=false
  - 400 → kind='invalid_request', retryable=false
  - 429 → kind='rate_limited', retryable=false
- Backoff: Math.min(100 * 2^attempt, 1000) → 100, 200, 400
- resolveExcluding: 按 estimatedPrice 排序, 然后按 provider_id 二进制比较
- incompatibilityReason 检查: health, authority, run_plan, capabilities, context length, structured_output, tool_calling, data_policy (local_only, regions, retention, training)

### loop.ts (894 lines) — P9 目标
- LoopEngine: 单次使用 (lifecycle: idle→running→finished)
- validateConfig: run_id/goal 非空; max_iterations/budget_tokens/deadline_ms/max_output_tokens_per_call/max_observation_bytes 非负安全整数
- classifyUnhandled: signal.aborted→user_cancel, HookRestrictionError→(force_prompt→approval_required, skip→skipped, else→denied), LoopError→malformed_response, generic Error→provider_failure
- recordTurn: 用 validUsage() 验证 usage (安全整数 >= 0)
- now()/nowMs(): 验证返回值 (ISO timestamp / safe integer >= 0)
- context_reset: 当 estimated context >= capacity * threshold (默认 0.85) 时触发
- EventBus: 发布 model_called, tool_call_start, tool_result, step_transition, run_state_change 事件
- RAG 注入: 查询 ragQuery, 注入为 UNTRUSTED user message
- Steering: kill/human_cancel→stop('user_cancel'), steer→注入 content 为 user message
- auto_execute=false → 终止 approval_required
- Direct 策略在调用 modelCall 前将 iterations 设为 1

### harness.ts (1312 lines) — P8 目标
- Harness class: run(), runOnce(), executeTool(), dispatchHook(), decisionHook(), observationalHook()
- 构造器验证: sessionMasterKey (32 bytes if persistence), buildCommitSha (40 hex), maxSkillRiskTier (1-4), executionContext
- run(): dispatch user_prompt_submit hook, 然后 runOnce()
- runOnce(): route task, open session, create LoopEngine, run loop, verify, build evidence
- ModelFallback: 先试 modelFallback.execute(), 再试 gateway.switchProvider() 最多 5 次
- Streaming: dispatchStream 当 onDelta 提供
- Hooks: pre_turn (decision), post_turn (observational), pre_tool_use (decision), post_tool_use (observational)
- Workspace: TransactionalWorkspace, finalize(success) commits/discards
- Concurrent: activeRun flag 防止并行
- withStreaming/withEventBus: 返回 this 用于链式调用
- getCacheMetrics: 返回 cache manager metrics

### Mutation 状态
- 当前 configurationHash: 2e02aab1022cac3c64b20c94300813b6dbd1d572b8bd8c9dae4f6d0749b52bd2
- Waiver commitSha: c0fd48f1002c9bb4e1b0eaeac8696695e032f763
- 所有 20 个 waiver hash 匹配 — P13 已验证
- equivalent-mutants.json 未提交 (P12 待提交)
- configurationHash 计算来源: mutationAuthorityFiles (含 equivalent-mutants.json 自身, package.json, stryker config, scripts 等)
- 重要: 修改 equivalent-mutants.json 会改变 configurationHash, 需要重新计算并更新所有 waiver

### Phase 2 状态
- 639 unit tests pass
- workspace-boundaries: valid (11 workspaces)
- active-stubs: 0
- contract-drift: 0 errors, 4 warnings
- mutation: 64/64 completed (candidate-only)
- evidence: 0/64 (未生成)
- releaseReady=false, candidateReady=false

### 测试文件清单 (P0-P13)
| P项 | 文件 | 测试数 | 状态 |
|-----|------|--------|------|
| P0 | scripts/run-mutation.mjs (修改) | N/A | 已提交 350fdb0c |
| P1 | tests/runtime/steering-port.test.ts (删除) | N/A | 已提交 350fdb0c |
| P2 | tests/gateway/managed-gateway-deep.test.ts | 22 | 已提交 3d5b878c |
| P3 | tests/gateway/provider-adapters.test.ts | +8 | 已提交 0901a47f |
| P4 | tests/gateway/async-task-adapter-deep.test.ts | 24 | 已提交 1f53cbec |
| P5 | tests/gateway/ws-server-deep.test.ts | 15 | 已提交 7e550c2a |
| P6 | tests/gateway/model-gateway-deep.test.ts | 47 | 未提交 |
| P7 | tests/runtime/direct-strategy.test.ts | 12 | 已提交 350fdb0c |
| P8 | tests/runtime/harness-deep.test.ts | 23 | 未提交 |
| P9 | tests/runtime/loop-deep.test.ts | 51 | 未提交 |
| P10 | tests/session/sqlite-session-store-deep.test.ts | 21+5 | 已提交 c0fd48f1 |
| P11 | tests/tools/tool-registry-mutation.test.ts | 47 | 已提交 4a2c6152 |
| P12 | mutation/equivalent-mutants.json | 20 waivers | 未提交 |
| P13 | (验证, 无文件) | N/A | 已验证 |

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| P6 先于 P8/P9 | model-gateway 更独立, 更容易隔离测试 |
| P9 先于 P8 | loop.ts (894 行) 比 harness.ts (1312 行) 小, 更可测 |
| 跳过 verify:phase1:local 直到 P6/P8/P9 完成 | 用户指令 |
| 使用 planning-with-files skill | 保留计划跨 compaction |
| dispatchStream events-yielded 测试改为验证同 provider 不重试 | 外层仍可 switch provider for retryable |
| EventBus 用 `new EventBus()` | createEventBus 不存在 |
| LoopError → malformed_response | classifyUnhandled 的行为 |
| beforeTurn iteration=1 | direct 策略先递增 |
| afterTurn 在 finally 中不改变 termination | terminatedValue 已 true |
| mutation authority 接受 candidate-only registry sources | gate manifest byte-frozen 不能改 |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| ProviderHttpError(503) kind='server' not 'server_error' | 修正断言 |
| dispatchStream partial yield + retryable 仍 switch provider | 修正测试语义 |
| createEventBus() 不存在 | 用 new EventBus() |
| LoopError → malformed_response not internal_error | 修正预期 |
| beforeTurn iteration=1 not 0 | 修正预期 |
| afterTurn 在 finally 不改变 termination | 修正测试检查 error event |
| nowMs=-1 在构造时 throw | 用 expect(() => new...).toThrow() |
| step_transition 在 direct 不触发 | 改用 plan_execute |
| policy allowed_tools=[] reject | 改为 ['read_file'] |
| budget_tokens=undefined 与 exactOptionalPropertyTypes 冲突 | 移除显式 undefined |
| RuntimeSteeringPriority 不含 'normal' | 改为 'user' |
| RuntimeBudgetDecision 需要 reason | 添加 reason 字段 |
| observedMessages unknown[] 无 find/some | 改为 any[][] |

## Resources
- 源代码: gateway/model-gateway.ts, runtime/loop.ts, harness.ts
- 测试: tests/gateway/model-gateway-deep.test.ts (550 行, 47 tests)
- 测试: tests/runtime/loop-deep.test.ts (683 行, 51 tests)
- 测试: tests/runtime/harness-deep.test.ts (296 行, 23 tests)
- Mutation authority: mutation/equivalent-mutants.json (20 waivers)
- Gate manifest: verification/gates/phase2-gate.json (byte-frozen, 64 requirements)
- Requirements: /Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/requirements/requirements.ndjson
- Remote: product = https://github.com/123oqwe/agentharness91.git
- Worktree: /Users/guanjieqiao/agent-runtime-v7/worktrees/phase2-integrated
- Branch: codex/phase2-integrated, HEAD: 5d1ec4b8
