# Archived Non-Normative Content

这些文件不是权威来源。权威状态在 control/current-state.json。

## 内容
- FINAL_REPORT.md — 旧报告 (40 reqs / 178 files, actual: 207 / 305+)
- validation-report.json — 旧手动生成的验证报告
- artifacts_orchestrator-test-evidence.json — 旧编排器测试 (exit_code=2, FAIL)
- artifacts_verifier-test-evidence.json — 旧验证器测试 (硬编码pass)
- artifacts_failure-injection-evidence.json — 旧失败注入测试 (6 tests)
- artifacts_readiness-scorecard.json — 旧评分卡
- artifacts_remaining-blockers.json — 旧阻塞报告 (全部已解决)
- v9.1-audit/ — 初始审计文件 (7 files)
- adversarial-review-report-v9.1.json — 旧对抗审查 (55 issues)

## 已移动到正确位置的旧脚本
- check-*.py → factory/phase-gates/ (独立检查工具)
- validate-specification.py → factory/phase-gates/
- gate-*.sh → infra/ (CI gate 脚本)
- orchestrator/* → factory/controller/ (编排器工具)
