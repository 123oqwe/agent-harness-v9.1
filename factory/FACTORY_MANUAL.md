# Factory Manual — Agent Harness Autonomous Engineering Factory

> **状态来源**: `control/current-state.json`（本文件不是状态来源，只是手册）
> **版本**: v9.2.1
> **最后更新**: 2026-07-16

---

## 1. Factory 是什么

Factory 是一个自主工程控制系统。它调度 Codex 和 Claude Code 作为 worker，
逐个实现 Agent Harness 产品的需求（Requirement），从 Phase 0 到 Phase 8。

**Factory 不是产品。** 产品是 Agent Harness（用户使用的 Agent 平台）。
Factory 是用来开发产品的施工设备。

**Factory 不是人。** Factory 是 Python 程序，运行在 `factory/` 目录。
它通过 `subprocess.Popen` 启动 Codex CLI 和 Claude CLI 作为子进程。

---

## 2. 架构

```
                    control/current-state.json
                    （唯一权威状态来源）
                           |
                           v
                  +------------------+
                  |    Controller    |  ← 工厂的大脑
                  |  (controller.py) |
                  +------------------+
                    /  |  |  |  |  \
                   /   |  |  |  |   \
                  v    v  v  v  v    v
         +--------+ +--------+ +--------+ +--------+ +--------+
         | State  | | Worktree| |Worker  | |Evidence| | Phase  |
         | Store  | | Manager | |Adapter | |Collect | | Gates  |
         +--------+ +--------+ +--------+ +--------+ +--------+
                                  |
                          +-------+-------+
                          |               |
                     +--------+      +--------+
                     | Codex  |      | Claude |
                     |Adapter |      |Adapter |
                     +--------+      +--------+
                          |               |
                     codex exec      claude -p
                     (Popen)         (Popen)
```

### 模块清单

| 模块 | 文件 | 功能 | 状态 |
|------|------|------|------|
| Controller | `controller/controller.py` | 大脑：选择需求、锁定、分配、调度、验证、更新 | [REAL] |
| State Store | `state-store/state_store.py` | 持久状态：原子 JSON 读写 + 文件锁 | [REAL] |
| Worktree Manager | `worktree-manager/worktree_manager.py` | Git worktree 创建/删除/列表 | [REAL] |
| Codex Adapter | `worker-adapters/codex/adapter.py` | 启动 Codex CLI 进程（Popen） | [REAL] |
| Claude Adapter | `worker-adapters/claude/adapter.py` | 启动 Claude CLI 进程（Popen） | [REAL] |
| Evidence Collector | `evidence-collector/evidence_collector.py` | 从 Worker stdout 提取结构化证据 | [REAL] |
| Verifier | `verifier/verifier.py` | 独立验证器：7 项检查 | [REAL] |
| Phase Gates | `phase-gates/gate_runner.py` | Spec Gate + Phase Gate | [REAL] |
| Merge Queue | `merge-queue/merge_queue.py` | git rebase + gate + git merge | [REAL] |
| Blocker Service | `blocker-service/blocker_service.py` | 创建/解决阻塞 | [REAL] |
| Budget Ledger | `budget-ledger/budget_ledger.py` | 预算预留/消费/检查 | [REAL] |
| Secret Service | `secret-request-service/secret_service.py` | 密钥请求（仅 staging） | [REAL] |
| Requirement Queue | `requirement-queue/requirement_queue.py` | 优先级队列 + 原子 pop | [REAL] |
| Worker Registry | `worker-registry/worker_registry.py` | Provider 可用性检查 + 角色映射 | [REAL] |
| Context Packet Builder | `context-packet-builder/context_packet_builder.py` | 最小化上下文包构建 | [REAL] |
| Sandbox Runner | `sandbox-runner/sandbox_runner.py` | 命令执行（容器隔离待实现） | [STUB] |
| Dashboard | `dashboard/generate.py` | 从 current-state.json 生成 HTML | [REAL] |

---

## 3. 工作流

每个需求（Requirement）经过以下 15 步：

```
1. Controller 读取 spec/requirements/requirements.ndjson
   ↓
2. 选择一个 READY 需求
   条件: delivery_phase == current_phase
         implementation_maturity == "not_started"
         所有依赖的 implementation_maturity == "verified"
         state.json 里没有 in_progress 或 verified 记录
   ↓
3. 获取原子锁（写入 state.json active_worktrees）
   ↓
4. 构建 ContextPacket（需求 + 验收标准 + 安全不变量 + 相关 schema + ADR）
   ↓
5. 分配 specialist（根据 owner_role → codex 或 claude）
   ↓
6. [REAL] 启动 Worker 进程
   Codex: codex exec --json -s workspace-write "prompt"
   Claude: claude -p --output-format json "prompt"
   真实 Popen，捕获 stdout/stderr/exit_code
   ↓
7. [REAL] 收集 Evidence
   从 Worker 的真实 stdout 提取
   计算 stdout_hash (SHA-256)
   保存到 evidence/{req_id}.json
   拒绝空数据（返回 error 而不是生成空文件）
   ↓
8. [REAL] 独立验证器检查
   7 项检查:
   - requirement_exists（需求在注册表里）
   - acceptance_criteria_defined（验收标准非空）
   - evidence_valid（证据文件存在且有效 JSON）
   - exit_code_zero（exit code 为 0）
   - evidence_hashed（stdout_hash 存在，不是自报告）
   - process_isolation（PID != PPID，真正独立进程）
   - evidence_not_refused（证据不是空数据）
   
   模式:
   - METADATA_ONLY: 当 harness/ 不存在时，只检查元数据
   - RERUN: 当 harness/ 存在时，checkout commit 重跑测试
   
   验证器 CANNOT: 修改代码/测试/需求/证据/合并/批准生产
   ↓
9. 如果验证 PASS → 进入合并队列
   如果验证 FAIL → 标记 verification_failed，释放锁
   ↓
10. [REAL] 合并队列处理
    git rebase main（在 worktree 里）
    运行 Spec Gate
    git merge --no-ff（在主仓库）
    清理 worktree
    
    rebase 失败 → 创建 blocker
    gate 失败 → 不合并
   ↓
11. 释放锁
   ↓
12. 更新 Registry（只有 Controller 能更新）
   ↓
13. 选择下一个 READY 需求
   ↓
14. 当 Phase 所有需求 verified → 运行 Phase Gate
   ↓
15. Phase Gate PASS → advance_phase() → 进入下一 Phase
    Phase Gate FAIL → 停止，报告失败
```

---

## 4. Agent 角色

Factory 定义了 17 个角色（在 `spec/.agents/` 里）。
Controller 根据 `owner_role` 字段分配 Worker：

| 角色 | 用哪个 Adapter | 能做什么 | 不能做什么 |
|------|---------------|---------|-----------|
| backend | Codex | 实现 API、数据库、工作流 | 修改 spec/、control/ |
| frontend | Codex | 实现 UI、屏幕 | 修改 spec/、control/ |
| devops | Codex | CI/CD、部署 | 修改 spec/、requirements/ |
| runtime | Codex | Loop、Session、Sandbox | 修改 contracts/ |
| routing | Codex | Router DAG、RunPlan | 修改 state-machines/ |
| rag-memory | Codex | RAG、Memory、Context | 修改 requirements/ |
| security | Claude | Policy、PEP、Capability | 修改 acceptance criteria |
| privacy | Claude | 数据治理、PII | 修改 contracts/ |
| independent-verifier | Claude | 独立验证（只读） | 修改任何文件、合并 |
| cto_orchestrator | N/A | 任务分配、Phase Gate | 实现代码 |

**安全规则**: security 和 independent-verifier 使用 Claude（不同 provider），
确保跨 provider 验证。实现 Agent 不能验证自己的输出。

---

## 5. 触发机制

### 手动触发

```bash
# 运行一个需求周期
python3 factory/controller/controller.py cycle

# 自动循环（持续处理需求）
python3 factory/controller/controller.py loop --max-iterations 10 --idle-sleep 30

# 查看状态
python3 factory/controller/controller.py status

# 重启恢复
python3 factory/controller/controller.py recover

# 选择下一个需求
python3 factory/controller/controller.py select

# 运行 Spec Gate
python3 factory/phase-gates/gate_runner.py spec

# 运行 Phase N Gate
python3 factory/phase-gates/gate_runner.py phase0

# 运行独立验证器
python3 factory/verifier/verifier.py
```

### 自动调度

`run_loop()` 函数提供自动调度：

```bash
# 无限循环，每 30 秒检查一次
python3 factory/controller/controller.py loop

# 最多 10 次迭代，空闲时等 60 秒
python3 factory/controller/controller.py loop --max-iterations 10 --idle-sleep 60
```

Loop 行为：
1. 检查 open blockers → 有则停止
2. 运行一个 cycle（选择→锁定→dispatch→evidence→验证→释放）
3. 如果没有 READY 需求 → 运行 Phase Gate
4. Phase Gate PASS → advance_phase()
5. Phase Gate FAIL → 等待 idle_sleep 秒后重试
6. 连续空闲 3 次 → 停止

### CI 触发

GitHub Actions（`.github/workflows/gate.yml`）在每次 push/PR 时运行 Spec Gate。

---

## 6. 状态管理

### 唯一权威状态

`control/current-state.json` 是唯一状态来源。
README、HTML、dashboard 都从它生成，不能手写状态。

### Factory 运行时状态

`factory/state-store/state.json` 存储 Factory 运行时状态：
- current_phase（当前 Phase）
- active_worktrees（正在处理的 worktree）
- worker_leases（Worker 租约）
- requirement_status（需求处理结果）
- command_history（命令历史，最多 1000 条）
- evidence_refs（证据文件引用）
- verifier_results（验证结果）
- merge_queue（合并队列）
- blockers（阻塞列表）
- restart_count（重启次数）

### 状态持久化

State Store 使用：
- JSON 文件 + `fcntl.flock` 文件锁（原子读写）
- 写入临时文件再 `os.rename`（原子替换）
- 进程重启后状态不丢失

### 重启恢复

`restart_recovery()` 清理超过 1 小时的孤儿锁，标记需求为 retry_required。

---

## 7. 验证和 Gate

### Spec Gate（10 项检查）

| # | 检查 | 说明 |
|---|------|------|
| 1 | current_state_exists | current-state.json 存在且有效 |
| 2 | requirements_valid | requirements.ndjson 有效、无重复 ID |
| 3 | model_check_verified | TLC 模型检查 Status=VERIFIED |
| 4 | all_phases_have_requirements | 所有 Phase 有需求 |
| 5 | no_status_contradictions | README 不含状态声明 |
| 6 | api_files_exist | 6 个 API 文件存在且非空 |
| 7 | factory_controller_exists | controller.py 存在 |
| 8 | codeowners_exists | CODEOWNERS 存在 |
| 9 | ui_screens_differentiated | UI 屏幕非通用模板 |
| 10 | adrs_resolved | ADR 全部解决 |

### Phase Gate

Phase Gate 运行真实命令（不是查 Registry）：
- requirements_have_criteria（验收标准非空）
- requirements_have_tests（测试文件非空）
- build（`npm run build`，如果 harness/ 存在）
- type_check（`npx tsc --noEmit`，如果 harness/ 存在）
- unit_tests（`npm test`，如果 harness/ 存在）
- model_check（Phase 0 专属）
- factory_exists（Phase 0 专属）

### Check 脚本（12 个）

| 脚本 | 检查 | 状态 |
|------|------|------|
| check-active-stubs | 扫描 harness/ 的 NotImplementedError | [REAL] |
| check-deprecated-references | 规范文件不引用废弃内容 | [REAL] |
| check-phase-coverage | Phase manifest 覆盖所有需求 | [REAL] |
| check-placeholder-content | 规范文件无 TODO/FIXME | [REAL] |
| check-ui-contracts | UI 路由/API 一致性 | [REAL] |
| check-api-contracts | API 文件存在 | [REAL] |
| check-file-references | 引用文件存在 | [REAL] |
| check-capability-coverage | 能力覆盖 100% | [REAL] |
| check-state-machines | 状态机文件 >= 7 | [REAL] |
| check-requirement-coverage | 需求计数 | [REAL] |
| check-ADR-status | ADR 全部解决 | [REAL] |
| check-test-mappings | 需求有测试文件 | [REAL] |

### 失败注入测试

10 种注入失败全部被检测到：
1. 缺失需求文件 → 检测到
2. 重复需求 ID → 检测到
3. README 状态矛盾 → 检测到
4. PENDING 模型检查 → 检测到
5. 通用 UI 模板 → 检测到
6. ADR NEEDS_VERIFICATION → 检测到
7. 缺失 API 文件 → 检测到
8. 缺失 Factory 控制器 → 检测到
9. 假 PASS 证据 → 检测到
10. 空 Phase 需求列表 → 检测到

---

## 8. 安全和保护

### 受保护路径

| 路径 | 谁能修改 | 保护方式 |
|------|---------|---------|
| spec/contracts/ | CTO + Security | CODEOWNERS + CI |
| spec/state-machines/ | CTO + Security | CODEOWNERS + CI |
| spec/requirements/ | CTO + Product | CODEOWNERS + CI |
| spec/phases/ | CTO | CODEOWNERS + CI |
| control/ | CTO | CODEOWNERS |
| evidence/ | 无人（不可变） | 只读 |
| spec/CODEOWNERS | CTO | CODEOWNERS |

### Worker 权限

- Worker 只能修改 `harness/`、`factory/`、`infra/`
- Worker 不能修改 `spec/`、`control/`、`evidence/`
- Worker 通过 ContextPacket 获得最小化上下文
- Worker 不能直接访问密钥（通过 Secret Service 请求）
- 生产密钥永远不对 Worker 可用

### 验证器隔离

- 验证器使用独立进程（PID != PPID）
- 验证器只读
- security 和 verifier 使用 Claude（不同于实现的 Codex）
- 验证器不能修改代码/测试/需求/证据
- 验证器不能合并或批准生产

### 密钥管理

- Worker 通过 Secret Service 请求密钥
- 只有 staging 密钥可用
- 生产密钥永远不可用
- 密钥有 1 小时过期时间

---

## 9. 已验证的能力

| 能力 | 验证方式 | 结果 |
|------|---------|------|
| 需求选择 | select_ready_requirement() 返回正确需求 | PASS |
| 原子锁定 | acquire_lock/release_lock | PASS |
| ContextPacket | build_packet() 2621 bytes | PASS |
| Worker Popen (Codex) | pid=89115, exit_code=0, 24823 chars | PASS |
| Worker Popen (Claude) | pid=27789, exit_code=0 | PASS |
| Evidence 收集 | collect_from_worker() 真实 hash | PASS |
| Worktree | create/list/remove 真实 git | PASS |
| 合并队列 | rebase + gate + merge | PASS |
| 自动调度 | run_loop 3 iterations | PASS |
| Spec Gate | 10/10 checks | PASS |
| Check 脚本 | 5/5 PASS + 2 injection tests | PASS |
| 模型检查 | TLC v2.19, 251 states, 0 errors | PASS |
| 重启恢复 | orphaned lock cleanup | PASS |
| Blocker 服务 | create/resolve/list | PASS |
| 预算账本 | reserve/consume/check | PASS |
| 密钥服务 | staging only | PASS |

---

## 10. 依赖和限制

### 当前依赖

- Python 3.12+
- Java (OpenJDK 21+) for TLC model checker
- git
- Codex CLI (`codex exec --json`)
- Claude CLI (`claude -p --output-format json`)
- TLC (tla2tools.jar)

### 当前限制（诚实声明）

1. **Sandbox Runner 是 STUB**: 直接运行命令，没有 Docker/MicroVM 隔离
2. **验证器是 METADATA_ONLY**: 当 harness/ 不存在时只检查元数据，不 rerun 测试
3. **没有 cron/daemon**: 必须手动或 CI 触发 `controller.py loop`
4. **Worker 超时 600 秒**: 复杂需求可能需要更长时间
5. **没有并发 Worker**: 一次只处理一个需求
6. **合并队列串行**: 一次只处理一个 merge

### 需要产品代码后才能完整工作的

- 验证器 RERUN 模式（需要 harness/ 有代码和测试）
- Sandbox Runner 容器隔离（需要 Docker）
- Phase Gate 的 build/type-check/unit-tests（需要 harness/ 有 package.json）
- 域评估（需要 harness/ 有评估代码）
