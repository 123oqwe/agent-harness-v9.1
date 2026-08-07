# Findings & Decisions (verified 2026-08-08, HEAD 05dd3424)

## Requirements
- 完成 Phase 1 mutation 地基验证 (15 模块全 PASS, mutation score >= 阈值)
- 补厚 52 个 Phase 2 薄测试 (每条 acceptance_criteria 至少 1 个测试)
- Phase 2 gate 闭环 (candidateReady=true, evidence 64/64)
- 真实 GLM 5.2 xhigh 验收
- commit and push 源码到 GitHub (只放源码, 不放 reports/ dist/ node_modules/)
- 铁律: 不删测试、不降阈值、不加 skip、不伪造 evidence/mutation 结果

## Verified Current State (2026-08-08 02:45)

### Git
- Worktree: /Users/guanjieqiao/agent-runtime-v7/worktrees/phase2-integrated
- Branch: codex/phase2-integrated
- HEAD: 05dd3424aa7f7723d824a73f0fd18087fa82f473
- origin (123oqwe/agent-harness-v9.1, PUBLIC, has CI runner): 落后 1 commit
- product/release (123oqwe/agentharness91, PRIVATE, no runner): 落后 2 commits
- Uncommitted: HARNESS_SESSION_DIRECTIVE.md + mutation/equivalent-mutants.json (waiver rebind)
- equivalent-mutants.json 保持 uncommitted 是设计行为 (runner 允许)
- Stale mutation lock (PID 77574 dead) 已清理

### 测试状态 (全部 PASS)
- Phase 1 tests: 2859/2859 PASS
- Phase 2 unit tests: 758/758 PASS (64 files)
- Phase 2 dev gate: success=true
- typecheck/lint/build: PASS
- Total test files: 298

### Mutation 状态 (STALE - 需要重跑)
- 11 模块有旧 result.json (config_hash 不匹配当前 2e02aab1)
- 4 模块缺失: actionControl, runtime, session, identitySecrets
- 旧 gateway score: 84.68 (FAIL, 阈值 85)
- P6/P8/P9 的 121 新测试不在旧结果中
- conclusion: Phase 1 mutation 必须完全重跑

### Phase 1 Evidence (40/40 STALE)
- 全部 commit_sha 过期 (bd85e7ed 或 7f2eafaa vs 05dd3424)

### Phase 2 Evidence (0/64)
- artifacts/phase-2/ 不存在
- 自动生成 (只在 local gate 通过后), 不可伪造

### Phase 2 Gate
- dev mode: PASS (5 命令全过)
- local mode: 23 命令, 未跑

### Phase 2 Mutation (未跑)
- 64 requirements, 是 local gate 第 17 个命令

### CI (ci.yml)
- origin (public) 有 runner, 不跑 mutation, node v20

### .gitignore
- dist/, node_modules, .stryker-tmp/, reports/, coverage/ 都被 ignore
- "GitHub 上只放源码" 的要求已被 .gitignore 满足

### control/current-state.json (主仓库)
- Phase 1: IN_PROGRESS, Phase 2: BLOCKED, Phase 3: BLOCKED
- 受保护路径, 需 CTO 批准

## Key Mechanism Discoveries

### Evidence 生成机制
- Phase 1: 手动创建 artifacts/phase-1/AH-XXX-001/evidence.json
- Phase 2: 自动生成 (createPhase2EvidenceRecords, 只在 local gate 通过后)
- Phase 2 evidence 在 reports/phase2/ (gitignored)

### Mutation 验证机制
- check-mutation-thresholds.mjs 验证: commit_sha, config_hash, score, waiver commitSha
- 旧结果 config_hash 不匹配 -> 被拒绝

### candidateReady 逻辑
- executionOk (23 命令全过) + identityStable + mutationReady (64/64) + evidenceCount===64 + errors===0
- releaseReady 硬编码 false (需 CI attestation)

## 阻塞分析

### 阻塞 1: Phase 1 mutation 过期 (最高优先级)
- 旧结果 config_hash 不匹配 -> 被拒绝
- 4 模块缺失, gateway FAIL
- 解决: 完整重跑 (5-8h), 可能需要补测试

### 阻塞 2: Phase 1 evidence SHA 过期
- 40/40 过期, 需重新生成

### 阻塞 3: Phase 2 薄测试质量
- 52 文件 33-116 行, 758/758 全过但需确认覆盖 acceptance_criteria

### 阻塞 4: Phase 2 mutation 从未运行
- 需要 64/64 complete

### 阻塞 5: Phase 2 local gate 从未通过
- 23 命令, 3-4h, 需 clean worktree

### 非阻塞
- dev gate PASS, 所有测试 PASS, typecheck/lint/build PASS
- .gitignore 已排除非源码文件

## 仓库结构
- Phase 2 源码: packages/{runtime-core,documents,multimodal,tools,rag,api,ui}/src/ + apps/{api,web,tui,desktop}/src/
- Phase 1 源码: gateway/, runtime/, security/, tools/, router/, session/, vfs/, verification/, domains/, skills/, ui/, sandbox/, ingestion/, harness.ts
- Gate manifest: verification/gates/phase2-gate.json (byte-frozen, 64 requirements)
- Mutation: mutation/modules.mjs (Phase 1, 15 模块), mutation/phase2-modules.mjs (Phase 2, 64 requirements)
- Spec: /Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1/spec/phases/phase-{1,2,3}.yaml
