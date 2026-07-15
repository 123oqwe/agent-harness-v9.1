# ADR-007: RAG Indexes

## Decision
LanceDB (vector) + SQLite FTS5 (full-text) + custom graph index.

## Rationale
- LanceDB: local-first, no server, embedding storage
- FTS5: built into SQLite
- Graph: custom for relationship tracking
