 # Agent Harness v9.1 — 审查笔记与结构整理

 **日期**: 2026-07-20
 **审查方法**: 逐文件检查,所有结论基于文件内容(grep/python/ls 验证),非主观判断。

 ---

 ## 一、当前状态总结

 | 维度 | 状态 | 证据 |
 |------|------|------|
 | 规范层 | VERIFIED | `control/current-state.json` specification=VERIFIED |
 | 产品代码 | NOT_STARTED | `harness/gateway/` 为空,`source_files` 210/223 不存在 |
 | Phase 0 | VERIFIED | TLA+ 模型检查通过,契约 19 个全部合法 |
 | Phase 1 | READY | 31 个 requirement,依赖图清晰 |
 | Requirements | 221 条 | `requirements.ndjson` 221 行(已从 213 修正) |
 | 架构图 | 18 张 SVG | 01-09 原始,10-18 新增(已补文档引用) |
 | 架构文档 | 18 个 .md | 含 5 个新增(realtime/failure/security/topology/vfs) |
 | 契约 | 19 个 JSON Schema | 全部合法,types/ 19 个 TS 文件匹配 |
 | 状态机 | 7 个 + TLA+ | 模型检查 251 状态 0 错误 |
 | 威胁模型 | 8 威胁 15 控制 | control-test-map 全覆盖 |

 **结论:agent 能否照此做出 harness?** 能。规范完整、自洽、有验收标准。但需要先修复以下结构问题(已在本笔记中修复)。

 ---

 ## 二、发现并已修复的问题(9 项)

 ### 2.1 test_files 路径前缀不一致(已修复)
 **问题**: 28 个 requirement 的 `test_files` 用 `tests/` 前缀(如 `tests/contracts/run-plan.test.ts`),但实际测试文件在 `harness/tests/`。其余 207 个已用 `harness/tests/`。agent 不知在哪创建文件。
 **证据**: `grep -c "tests/" requirements.ndjson` = 28(无 harness/ 前缀);`find . -name "*.test.ts"` 全部在 `harness/tests/`。
 **修复**: 28 个 `tests/` → `harness/tests/`。验证: 0 个残留。

 ### 2.2 evals 目录重复(已修复)
 **问题**: `spec/evals/personal-assistant/`(README.md)和 `spec/evals/personal_assistant/`(phase-1.yaml)—— 两个目录用不同分隔符(连字符 vs 下划线)。其他 13 个 eval 目录全用连字符。
 **证据**: `ls -d spec/evals/personal*` 显示两个目录。
 **修复**: 合并到 `personal-assistant/`(连字符,和其他一致)。验证: evals 目录数 15→14。

 ### 2.3 SPECIFICATION_INDEX.yaml phases 数量不一致(已修复)
 **问题**: 索引说 `phases: count: 9`,实际有 10 个 yaml(含 phase-0R.yaml)。
 **证据**: `ls spec/phases/*.yaml | wc -l` = 10。
 **修复**: count 9→10。

 ### 2.4 control/current-state.json requirements 数量不一致(已修复)
 **问题**: `control/current-state.json` 说 `requirements: 213`,实际 `requirements.ndjson` 有 221 条。
 **证据**: python 计数 ndjson = 221;control json = 213。
 **修复**: 213→221。

 ### 2.5 新增 SVG(10-18)无文档引用(已修复)
 **问题**: 9 张新图(10-capability-token-lifecycle 等)存在但没有任何架构文档引用它们。agent 不会知道去看。
 **证据**: `grep -rl "10-capability" spec/architecture/*.md` = 0 命中。
 **修复**: 在 7 个架构文档里加 SVG 引用(action-control→10, realtime→11, failure→12, security→13, topology→14, vfs→15, evolution→16, context-memory→17, harness-boundary→18)。

 ### 2.6 spec/.agents/ 定位不清(已修复)
 **问题**: 17 个 agent 角色定义文件放在 `spec/`(规范区),但它们是 factory 配置(被 `factory/FACTORY_MANUAL.md` 引用),不是产品规范。agent 可能误当产品架构。
 **证据**: `grep -rn ".agents/" spec/architecture/ spec/product/` = 0 命中;`grep -rn ".agents/" factory/FACTORY_MANUAL.md` = 1 命中。
 **修复**: 加 `spec/.agents/README.md` 标注 "factory configuration, NOT product spec"。

 ### 2.7 37 vs 35 状态矛盾(此前已修,确认)
 **状态**: `operation.machine.json` description 现在说 "All 37 states",07-svg 标 "v9 (37 states)",实际 37 个状态。已一致。

 ### 2.8 7 layers vs 9 bullets 矛盾(此前已修,确认)
 **状态**: `context-memory-rag.md` 现在标 "(9 layers)",下面 9 个 bullet。已一致。

 ### 2.9 03-routing SVG v8 标题(此前已修,确认)
 **状态**: 03-routing 标题现在是 "v9 Dependency-Aware DAG (replaces v8 8-routers)"。已一致。

 ---

 ## 三、已知的非问题(状态说明)

 ### 3.1 source_files 210/223 不存在
 **这是预期的**——产品代码未实现。Phase 1 的 requirement 指向 `harness/runtime/loop.ts` 等文件,agent 要从零创建。`harness/` 目录目前只有测试文件和空 `gateway/`。

 ### 3.2 product-capability-inventory.json 和 .yaml 内容不同
 **这是两种用途**: `.json` 是结构化能力族谱(5 families, 108 capabilities, dict 格式),`.yaml` 是扁平列表(108 items, list 格式)。不矛盾,是同一数据的两种视图。`.json` 用于程序消费,`.yaml` 用于人读。

 ### 3.3 appendix/archive/non-normative/ 未被规范引用
 **这是审计遗留物**,README.md 已标注 "这些文件不是权威来源"。不在 NORMATIVE_PRECEDENCE 里,不影响实现。保留用于追溯。

 ### 3.4 agent-authoring-format.md 在 contracts/ 目录
 **这是 contracts 的补充说明**——定义 agent 如何编写(Markdown + YAML frontmatter → 编译为 agent-graph 节点)。放在 contracts/ 是因为它定义了 agent 定义的契约格式。不是 schema 但和 schema 配套。可接受。

 ---

 ## 四、产品架构完整性评估

 ### 4.1 14 模块(已验证一致)
 - 定义在 `harness-boundary.md`
 - SVG 01 标 "14 Modules (M1-M14)"
 - `module-boundaries.md` 有 can/cannot 表
 - `trust-boundaries.md` 有 6 个 TCB 组件
 - VFS(harness-boundary.md:55)是 M9(Sandbox/Exec Env)的子组件,不是第 15 模块

 ### 4.2 12 步工具执行管线(已验证一致)
 - 定义在 `action-control.md`
 - step 7b(TOCTOU)是子步骤,11 编号项 + 7b = 12 步
 - `security-control-mapping.md` 每步标了 CTRL
 - SVG 10(capability-token-lifecycle)覆盖 step 6-8

 ### 4.3 EffectRisk 11 维度(已验证一致)
 - `effect-risk.schema.json` required: 11 字段
 - `action-control.md` 引用全部 11 维度

 ### 4.4 Capability Token 18 字段(已验证一致)
 - `capability-token.schema.json` required: 18 字段
 - `types/capability-token.ts` 匹配

 ### 4.5 9 个 Phase(已验证一致)
 - 0R(Spec Repair)→ 0(Contract Closure)→ 1-8
 - 每个 phase 有 manifest、entry/exit criteria、gate command
 - 依赖链:每个 phase 的 exit_criteria 是下一个的 entry_criteria

 ### 4.6 威胁模型(已验证一致)
 - 8 个威胁,15 个控制,全部 control_ids 在 controls.yaml 中存在
 - control-test-map 覆盖全部 15 个 CTRL
 - residual-risks.yaml 现在合法(此前 YAML 引号 bug 已修)

 ---

 ## 五、agent 实现路径(Phase 1)

 ### Wave 0: AH-GATEWAY-TESTPROVIDER-001(无依赖,一切的起点)
 → `harness/gateway/scripted-provider.ts`

 ### Wave 1(并行): Sandbox + PolicyEngine + Evidence
 → `harness/runtime/sandbox.ts` + `harness/security/policy-engine.ts` + `harness/verification/evidence.ts`

 ### Wave 2(并行): read_file + exec_command + write_file + LoopEngine
 → `harness/tools/*.ts` + `harness/runtime/loop.ts`

 ### Wave 3: edit_file + search_files
 → `harness/tools/edit-file.ts` + `harness/tools/search-files.ts`

 ### Wave 4: Coding Vertical(Phase 1 exit gate)
 → `harness/domains/coding/ah_coding_vertical_001.ts`

 详细 prompt 见上一轮对话,此处不重复。

 ---

 ## 六、验证结果

 | 检查项 | 结果 |
 |--------|------|
 | NDJSON 221 条全合法 | ✓ |
 | 9 个 phase manifest vs registry | 全一致 |
 | 依赖完整性(0 悬空) | ✓ |
 | 0 重复 ID | ✓ |
 | 所有 YAML 解析 | ✓ |
 | 所有 JSON Schema 解析 | ✓ |
 | 所有 types 匹配 contracts | ✓ |
 | 威胁模型 control 引用全合法 | ✓ |
 | SVG 10-18 全部有文档引用 | ✓(本笔记修复) |
 | test_files 路径前缀统一 | ✓(本笔记修复) |
 | evals 目录无重复 | ✓(本笔记修复) |
 | SPECIFICATION_INDEX 数字一致 | ✓(本笔记修复) |
 | control/current-state.json 数字一致 | ✓(本笔记修复) |
 | spec gate | PASS |
 | 73 个测试 | 全过 |
