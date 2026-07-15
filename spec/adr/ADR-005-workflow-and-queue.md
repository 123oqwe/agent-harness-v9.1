# ADR-005: Workflow and Queue

## Status: CONDITIONAL
## Decision
Temporal (durable workflow) + Redis (queue/cache).

## Rationale
- Temporal: durable execution, retry, compensation
- Redis: rate limiting, session cache

## Status: CONDITIONAL

## Verification Evidence
- Temporal CLI: NOT FOUND locally
- Redis CLI: NOT FOUND locally
- Date: 2026-07-16T03:47:55.201728

## Decision
Temporal and Redis not available locally. Decision: use Temporal for production durable workflows, but implement a local in-process workflow engine for Phase 1-2 development. Redis replaced by in-memory queue for local development. Migration to Temporal/Redis in Phase 4+.

## Spike Note
AH-SPIKE-006 will verify Temporal local deployment. If Temporal proves too heavy for local dev, will use a simpler durable workflow library (e.g., BullMQ with Redis).
