# ADR-006: Local Vault

## Status: ACCEPTED

## Rationale
SQLite + SQLCipher confirmed via `which sqlite3` (available). SQLCipher requires native compilation — verify in Phase 1 spike. Per-record AES-256-GCM with HKDF-SHA256 key derivation is SOTA for local encrypted storage.

## Decision
SQLite + SQLCipher + content-addressed blob store.

## Details
- Per-record AES-256-GCM encryption
- Key derivation: HKDF-SHA256 from device key + salt
- Index encryption: full-text, vector, graph
- No sync in Phase 1; CRDT sync in Phase 3+
