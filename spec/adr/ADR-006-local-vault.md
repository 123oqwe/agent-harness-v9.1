# ADR-006: Local Vault

## Decision
SQLite + SQLCipher + content-addressed blob store.

## Details
- Per-record AES-256-GCM encryption
- Key derivation: HKDF-SHA256 from device key + salt
- Index encryption: full-text, vector, graph
- No sync in Phase 1; CRDT sync in Phase 3+
