# ADR-009: Secrets and Identity

## Status: ACCEPTED

## Rationale
WebAuthn for user auth is SOTA (phishing-resistant). SPIFFE for workload identity is industry standard. Ed25519 for capability signing is SOTA (faster than ECDSA, smaller signatures). Personal: Local Vault + Local Broker. Enterprise: KMS/HSM. Agent should verify SPIFFE integration in Phase 7.

## Decision
- Personal: Local Vault stores refresh tokens, Local Broker exchanges
- Enterprise: HashiCorp Vault / AWS KMS
- Identity: WebAuthn for user, SPIFFE for workload
- Capability: Ed25519 signing
