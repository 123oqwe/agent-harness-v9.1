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
