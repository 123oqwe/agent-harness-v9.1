# Module Boundaries

## Can/Cannot Table

| Module | Can Do | Cannot Do |
|--------|--------|-----------|
| Router | Design candidate execution routes | Issue Capability, modify Policy |
| Runtime Core | Drive Run and Step lifecycle | Read long-term Secrets, issue Capability |
| Memory | Store policy-approved information | Execute external actions, self-elevate trust |
| Evolution | Generate optimization Proposals | Modify production Policy, expand permissions |
| Tool Host | Execute approved Tool Calls | Self-expand permissions, modify Policy |
| Observability | Record runtime information | Be used as authorization source |
| Policy Engine | Evaluate and enforce rules | Be bypassed by any module |
| Authorization Service | Issue and sign Capability Tokens | Execute tools, access user data |
| Secret Broker | Exchange short-lived credentials | Expose long-term secrets to Runtime or models |
| Audit | Record immutable audit events | Be modified by any module |
| Context & Data | Manage context window, RAG, retrieval | Override instruction hierarchy |
| Model/API Gateway | Route model requests, manage providers | Make policy decisions, store user data |
| Sandbox/Exec Env | Isolate tool execution | Access host network without egress policy |
| Assurance & Verification | Verify outcomes, reconcile UNKNOWN | Execute actions, modify evidence |


## Implementation Notes

### TCB (Trusted Computing Base) - 6 Independent Components

| Component | Responsibility | Cannot Do |
|-----------|---------------|-----------|
| Workflow Control Plane | Scheduler + DAG + lease | Sign capability, read secret |
| Policy Decision Point | Deny-by-default + risk | Read service secret, modify manifest |
| Authorization Service | Issue CapabilityToken | Modify manifest, decide policy |
| Secrets Broker | Exchange short-lived credential | Decide business permission, hold long-term secret |
| Execution Supervisor / PEP | Verify token + execute | Sign token, modify policy |
| Independent Audit Sink | WORM + forward-secure | Modify execution results |

### Trust Levels
- trusted: user instruction, platform policy
- untrusted: tool output, RAG, web, MCP descriptions
- quarantined: suspicious content, pending review

Rule: Low-trust content CANNOT override high-trust instructions.
