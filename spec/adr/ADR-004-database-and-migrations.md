# ADR-004: Database and Migrations

## Status: ACCEPTED
## Decision
PostgreSQL (cloud) + SQLite (local) + Drizzle ORM.

## Rationale
- PostgreSQL: production, multi-tenant
- SQLite: Local Vault, zero-config
- Drizzle: TypeScript-first, migration support

## Status: ACCEPTED

## Verification Evidence
- PostgreSQL (psql): not installed locally (will use cloud PostgreSQL in staging/prod)
- SQLite (sqlite3): available
- Date: 2026-07-16T03:47:55.201726

## Decision
SQLite confirmed for Local Vault. PostgreSQL will be cloud-managed (not required locally). Drizzle ORM to be added as npm dependency.

## Spike Note
SQLCipher (SQLite encryption) requires native compilation. Will verify in Phase 0R spike AH-SPIKE-005.
