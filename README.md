# Agent Harness v9.2.1

**Status is managed by `control/current-state.json`. This README does not contain status.**

To check current status:
```bash
python3 -c "import json; print(json.dumps(json.load(open('control/current-state.json')), indent=2))"
```

## Repository Structure

关系：

```
spec      → 规定应该做什么
factory   → 调用 Codex / Claude Code 自动开发
harness   → 最终用户真正使用的产品
infra     → 构建、测试、部署和运行
evidence  → 证明每项能力是否真的完成
control   → 唯一权威状态来源
```

```
agent-harness-v9.1/
├── control/           ← Authoritative state (current-state.json)
├── spec/              ← Immutable specification (workers cannot modify)
├── factory/           ← Autonomous engineering factory (real executable code)
├── product/           ← Agent Harness product implementation
├── infra/             ← CI/CD and infrastructure definitions
├── evidence/          ← Immutable command output and verification records
├── artifacts/         ← Audit artifacts
├── archive/           ← Superseded non-normative content
│
├── product/           ← Product specification docs (moved to spec/)
├── architecture/      ← Architecture docs (moved to spec/)
├── requirements/      ← Requirement registry (moved to spec/)
├── contracts/         ← JSON Schemas (moved to spec/)
├── state-machines/    ← State machines (moved to spec/)
├── phases/            ← Phase manifests (moved to spec/)
├── api/               ← API contracts (moved to spec/)
├── ui/                ← UI specs (moved to spec/)
├── adr/               ← ADRs (moved to spec/)
├── threat-model/      ← Threat model (moved to spec/)
├── deployment/        ← Deployment specs (moved to spec/)
├── operations/        ← Operations specs (moved to spec/)
├── data-tests/        ← Data test governance (moved to spec/)
├── evals/             ← Evaluation suites (moved to spec/)
├── domains/           ← Domain specs (moved to spec/)
└── appendix/          ← Deprecated content
```

## Factory Manual

The autonomous engineering factory is documented in [factory/FACTORY_MANUAL.md](factory/FACTORY_MANUAL.md).

It covers:
- Factory architecture and module list
- 15-step workflow (select → lock → dispatch → evidence → verify → merge)
- 17 agent roles and their adapter assignments
- Trigger mechanisms (manual, auto-loop, CI)
- State management (current-state.json is the only authority)
- Verification and gates (Spec Gate, Phase Gate, 12 check scripts)
- Security and protections (protected paths, worker permissions, verifier isolation)
- Verified capabilities and honest limitations

## Normative Precedence

See spec/NORMATIVE_PRECEDENCE.md (to be moved).

## Current Phase

Phase 0 — Build the Autonomous Engineering Factory.

See control/current-state.json for authoritative status.
