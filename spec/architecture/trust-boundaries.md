# Trust Boundaries

## TCB (Trusted Computing Base) - 6 Independent Components

| Component | Responsibility | Cannot Do |
|-----------|---------------|-----------|
| Workflow Control Plane | Scheduler + DAG + lease | Sign capability, read secret |
| Policy Decision Point | Deny-by-default + risk | Read service secret, modify manifest |
| Authorization Service | Issue CapabilityToken | Modify manifest, decide policy |
| Secrets Broker | Exchange short-lived credential | Decide business permission, hold long-term secret |
| Execution Supervisor / PEP | Verify token + execute | Sign token, modify policy |
| Independent Audit Sink | WORM + forward-secure | Modify execution results, independent write channel |

## Trust Levels
- trusted: user instruction, platform policy
- untrusted: tool output, RAG, web, MCP descriptions
- quarantined: suspicious content, pending review

Rule: Low-trust content CANNOT override high-trust instructions.


## Implementation Notes

### Cross-Cutting Planes

| Plane | Owner | Records | Security Boundary |
|-------|-------|---------|-------------------|
| Control | Router + Policy | RunPlan, Policy decisions | Only CTO can modify |
| Data | Runtime + Tool Host | Tool I/O, file changes | Worker can modify harness/ |
| Observability | Audit + Trace | Spans, metrics, logs | Read-only for workers |
| Identity | Auth Service | Principals, tokens, capabilities | Only Auth Service can issue |
| Budget | Budget Guard + PEP | Budget ledger, consumption | Hard-enforced in PEP |

### Instruction Priority (highest to lowest)
1. Platform policy
2. Organization policy
3. Project policy
4. User instruction
5. Task instruction
6. Retrieved content (RAG, web)
7. Tool output

Retrieved content and Tool output can NEVER override upper-layer instructions.
