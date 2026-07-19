# ADR-013: Post-FG Framework Gaps

## Status: ACCEPTED

## Rationale
FG1-FG11 在 spec 层 100% 闭合后(核对见 spec/appendix/competitor-research/POST-FG-REMAINING-GAPS.md),仍存在 8 项框架缺口。缺口证据见该文件 §3。

## Decision

### 已落地(architecture/ui/product/contracts/state-machines/types/api)

| 缺口 | Phase | 落地文件 |
|------|-------|---------|
| G-OS1 | 1 | runtime-core.md "Phase 1 Sandbox Mechanism" 段(Seatbelt/bubblewrap/AppContainer) |
| G-CC1 | 3 | agent-graph.schema.json node 增 5 字段(isolation/hooks_ref/memory_scope/effort/disallowed_tool_refs);types/agent-graph.ts 重新生成;invariants.md 增 Subagent Configuration Invariants |
| G-CC2 | 2 | model-api-gateway.md cache 失效清单增 run_phase setup→agent |
| G-CX1 | 5 | assurance.md 增 Pre-Approval Auto-Review 段;action-control.md step 5 拆 5a/5b |
| G-PI1 | 3 | contracts/agent-authoring-format.md(md+YAML→AgentGraph node);tool-skill-fabric.md 增引用段落 |
| G-PI2 | 2 | ui/screens/tui.yaml(diff-render TUI);routes.yaml 注释;product-prd.md Surface 11 展开 |
| G-PI3 | 3 | realtime-execution-visualization.md 增 workflow_graph 事件 + 段落;asyncapi.yaml 枚举增;mission_control.yaml components 增 |
| G-MAN1 | 2 | context-memory-rag.md 增 Active Plan Injection 段 |

### 已落地(requirements.ndjson + phase manifests)

8 项缺口的 acceptance_criteria 增补和 3 个新 requirement 已全部写入 requirements.ndjson(224 条)和对应 phase manifest:

- G-OS1: AH-SANDBOX-001 acceptance 增 OS-native containment 条目
- G-CC1: AH-SUBAGENT-001 + AH-MULTIAGENT-DAG-001 acceptance 增字段绑定 + node config 验证
- G-CC2: AH-OBS-TRACE-001 acceptance 增 run_phase cache invalidation 追踪
- G-CX1: 新增 AH-VERIFIER-AUTOREVIEW-001(delivery_phase=5,加入 phase-5.yaml)
- G-PI1: 新增 AH-AGENT-AUTHORING-001(delivery_phase=3,加入 phase-3.yaml)
- G-PI2: 新增 AH-UI-TUI-001(delivery_phase=2,加入 phase-2.yaml)
- G-PI3: AH-MULTIAGENT-DAG-001 acceptance 增 workflow_graph 事件发射
- G-MAN1: AH-CONTEXT-COMPILER-001 acceptance 增 active plan injection

## 约束
- types/*.ts 不手改,改完 schema 跑 json-schema-to-typescript 重新生成(已执行)。
- 新增 invariants 需重跑 TLA+ 模型检查(AH-SPEC-MODELCHECK-001)。
- G-CX1 escalate 是 binding(PEP 不能 override),downgrade 是 advisory。
