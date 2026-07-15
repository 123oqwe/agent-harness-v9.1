# ADR-007: RAG Indexes

## Status: ACCEPTED

## Rationale
LanceDB is SOTA for local-first vector search (no server, embedded, supports ANN). SQLite FTS5 is built-in and proven. Custom graph index for relationship tracking. Agent should benchmark LanceDB vs alternatives (e.g., chromadb, faiss) during Phase 2 implementation and adjust if needed.

## Decision
LanceDB (vector) + SQLite FTS5 (full-text) + custom graph index.

## Rationale
- LanceDB: local-first, no server, embedding storage
- FTS5: built into SQLite
- Graph: custom for relationship tracking
