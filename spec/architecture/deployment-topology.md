# Deployment Topology

## Environments
1. Local process (user device)
2. Local sandbox (isolated execution)
3. Local Vault (encrypted storage)
4. Cloud control plane (if cloud-enabled)
5. Model providers (external API)
6. External service providers (Gmail, Calendar, etc.)
7. Enterprise deployment (on-prem or VPC)

## 4 Required Architecture Diagrams
1. Harness Module Decomposition (14 modules)
2. Request-to-Outcome Sequence (full pipeline)
3. Deployment Topology (local/sandbox/vault/cloud/providers/enterprise)
4. Product Experience Architecture (9 domains -> Shared Harness)


## Implementation Notes

### 4 Required Architecture Diagrams
1. Harness Module Decomposition (see diagrams/01-harness-14-modules.svg)
2. Request-to-Outcome Sequence (see diagrams/02-request-to-outcome.svg)
3. Deployment Topology (agent should create this during Phase 7)
4. Product Experience Architecture (agent should create this during Phase 2)

### Deployment Environments
- Local: user device (Harness + Vault + Sandbox)
- Staging: Fly.io (API + workers + staging DB)
- Canary: Fly.io (limited cohort, SLO monitored)
- Production: Fly.io (full deployment, requires ReleaseApproval)
