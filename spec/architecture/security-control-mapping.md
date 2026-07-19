# Security Control Mapping

![13-security-control-mapping](diagrams/13-security-control-mapping.svg)

## Purpose

Maps all 15 CTRL control items (from `threat-model/controls.yaml`) to their enforcement points in the architecture. Without this mapping, security controls are scattered across YAML files with no architectural context. Implementers do not know where to enforce each control, and security auditors cannot verify coverage from architecture diagrams.

## Control → Enforcement Point Mapping

| CTRL ID | Control | Enforcement Point | Module | Implementation | Test |
|---------|---------|-------------------|--------|----------------|------|
| CTRL-REVALIDATE-001 | TOCTOU manifest hash re-validation | action-control step 7b | M10 Action Control | harness/security/revalidate.ts | harness/tests/security/toctou.test.ts |
| CTRL-EGRESS-001 | SSRF / private IP filter | tool dispatch (web_fetch, browser_operate) | M8 Tool Fabric + M9 Sandbox | harness/security/egress-filter.ts | harness/tests/security/ssrf.test.ts |
| CTRL-EGRESS-002 | Fine-grained network policy (allow/deny, unix, SOCKS5) — supersedes 001 | EffectRisk.egress_policy enforcement | M10 Action Control + M8 Tool Fabric | harness/security/network-policy.ts | harness/tests/security/network-exfil.test.ts |
| CTRL-TAINT-001 | Taint labels on untrusted content | context compilation + RAG retrieve | M2 Context & Data | harness/security/taint.ts | harness/tests/security/injection.test.ts |
| CTRL-MEMORY-VERIFY-001 | Memory write verification | Memory Write Proposal (pipeline step 20) | M7 Memory + M12 Assurance | harness/security/memory-verify.ts | harness/tests/security/memory-poison.test.ts |
| CTRL-PLUGIN-SIGN-001 | MCP signature verification (allowlist) | MCP server connection | M8 Tool Fabric | harness/security/plugin-sign.ts | harness/tests/security/tool-poison.test.ts |
| CTRL-CAPABILITY-SINGLE-USE-001 | Capability token atomic single-use | action-control step 7 (PEP validate) | M10 Action Control | harness/security/capability-replay.ts | harness/tests/security/capability-replay.test.ts |
| CTRL-CONTEXT-ISOLATION-001 | Context graph isolation | context topology enforcement | M2 Context & Data | harness/security/context-leak.ts | harness/tests/security/context-leak.test.ts |
| CTRL-BUDGET-PEP-001 | BudgetGuard in PEP (hard-enforced) | action-control step 4 (policy eval) + step 7 | M10 Action Control | harness/security/budget-bypass.ts | harness/tests/security/budget-bypass.test.ts |
| CTRL-SCREEN-ISOLATION-001 | Screen content isolation (computer use) | computer_operate/browser_operate dispatch | M8 Tool Fabric | harness/security/screen-injection.ts | harness/tests/security/screen-injection.test.ts |
| CTRL-RUNPHASE-001 | Two-phase runtime (setup→agent, credential stripping) | RunPlan execution phase transition | M5 Runtime Core | harness/security/cred-reach.ts | harness/tests/security/cred-reach.test.ts |
| CTRL-CRED-REACH-001 | Credential single-exchange at dispatch (no env leak in agent phase) | action-control step 8 (credential exchange) | M10 Action Control + M5 Runtime | harness/security/cred-reach.ts | harness/tests/security/cred-reach.test.ts |
| CTRL-MSG-INTEGRITY-001 | Cross-process message integrity (obo_token + jws_signature) | AgentGraph edge transmission (F8) | M4 Router + M5 Runtime | harness/security/msg-tamper.ts | harness/tests/security/msg-tamper.test.ts |
| CTRL-TOOL-MASK-001 | Tool-masking state machine (preserve KV-cache) | model API gateway (decode-time masking) | M3 Model Gateway | harness/gateway/cache-invalidation.ts | harness/tests/gateway/cache-invalidation.test.ts |
| CTRL-VFS-001 | VFS as single file-access authority | all file-touching tools + RAG retrieve | M9 VFS + M8 Tool Fabric | harness/vfs/index.ts | harness/tests/security/context-leak.test.ts |

## CTRL on the 12-Step Tool Execution Pipeline

| Step | Action | CTRL Enforced |
|------|--------|---------------|
| 01 | Schema validation | — |
| 02 | Effect classification (EffectRisk) | — |
| 03 | Risk derivation (EffectRisk + Policy + Context → DerivedRiskTier 0-5) | — |
| 04 | Policy evaluation (PEP) | CTRL-BUDGET-PEP-001 (budget check) |
| 05a | Pre-Approval Auto-Review (G-CX1, T3+ only) | — |
| 05b | Consent check (T2+ requires human review) | — |
| 06 | Capability issuance (Authorization Service signs) | — |
| 07 | PEP validation (token valid? unused? unexpired?) | CTRL-CAPABILITY-SINGLE-USE-001 |
| 07b | TOCTOU re-validation (recompute manifest hash, compare to approval-time) | CTRL-REVALIDATE-001 |
| 08 | Credential exchange (Secret Broker, single-use, no env leak) | CTRL-CRED-REACH-001 |
| 09 | Sandbox/environment dispatch | CTRL-VFS-001 + CTRL-EGRESS-002 + CTRL-SCREEN-ISOLATION-001 |
| 10 | Receipt capture | — |
| 11 | Postcondition verification | — |
| 12 | Audit (immutable, WORM) | — |

## CTRL Grouped by Module

### M10 Action Control (5 CTRL)
- CTRL-REVALIDATE-001 (step 7b)
- CTRL-CAPABILITY-SINGLE-USE-001 (step 7)
- CTRL-BUDGET-PEP-001 (step 4 + step 7)
- CTRL-CRED-REACH-001 (step 8)
- CTRL-EGRESS-002 (step 9 dispatch)

### M2 Context & Data (2 CTRL)
- CTRL-TAINT-001 (untrusted content taint labels)
- CTRL-CONTEXT-ISOLATION-001 (topology isolation)
- Injection pattern library: 10+ regex (ignore previous, role redef, etc.). Match → suspicious → blocks T2+ actions.

### M8 Tool Fabric (3 CTRL)
- CTRL-EGRESS-001 (web_fetch SSRF)
- CTRL-PLUGIN-SIGN-001 (MCP allowlist signature)
- CTRL-SCREEN-ISOLATION-001 (computer use isolation)
- mcp_allowlist.json: command hash / URL+key pin

### M5 Runtime + M4 Router (3 CTRL)
- CTRL-RUNPHASE-001 (setup→agent, credential stripping)
- CTRL-MSG-INTEGRITY-001 (F8 cross-process obo+jws)
- CTRL-CRED-REACH-001 (shared with M10)
- F8: Capability = per-call authorization, message signature = transport integrity

### M3 Model Gateway (1 CTRL)
- CTRL-TOOL-MASK-001: tool definitions stable, decode-time mask. Preserves KV-cache (F5). Phase 3 launch blocker.

### M9 VFS (1 CTRL)
- CTRL-VFS-001: single file-access authority. Closes RAG bypassing read_file deny.

### M7 Memory (1 CTRL)
- CTRL-MEMORY-VERIFY-001: memory write verification + PII check. Sensitive data local, desensitized to cloud.

## Phase Coverage

- Phase 1: 7 CTRL enforced
- Phase 2+: +8 CTRL enforced
- Every CTRL has a test_fixture (see `threat-model/control-test-map.yaml`)
- When implementation files are moved or renamed, `control-test-map.yaml` must be updated synchronously


![13-security-control-mapping](diagrams/13-security-control-mapping.svg)
