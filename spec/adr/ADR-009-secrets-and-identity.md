# ADR-009: Secrets and Identity

## Decision
- Personal: Local Vault stores refresh tokens, Local Broker exchanges
- Enterprise: HashiCorp Vault / AWS KMS
- Identity: WebAuthn for user, SPIFFE for workload
- Capability: Ed25519 signing
