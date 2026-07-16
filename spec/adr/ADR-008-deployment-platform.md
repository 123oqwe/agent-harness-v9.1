# ADR-008: Deployment Platform

## Status: ACCEPTED

## Note: Vercel CLI installation deferred to Phase 7 (deployment setup). Fly.io CLI available. Decision stands: Vercel for web, Fly.io for API/workers, R2 for storage.
## Decision
Vercel (web) + Fly.io (API/workers) + Cloudflare R2 (object storage).

## Rationale
- Vercel: Next.js native, edge functions
- Fly.io: multi-region, Docker-based
- R2: S3-compatible, no egress fees

## Status: ACCEPTED

## Note: Vercel CLI installation deferred to Phase 7 (deployment setup). Fly.io CLI available. Decision stands: Vercel for web, Fly.io for API/workers, R2 for storage.

## Verification Evidence
- Vercel CLI: NOT FOUND
- Fly.io CLI: available
- Date: 2026-07-16T03:47:55.201737

## Decision
Neither CLI installed locally. Vercel and Fly.io are SaaS platforms - CLIs not required locally for development. Will install during Phase 7 deployment setup. Decision stands: Vercel for web, Fly.io for API/workers, R2 for storage.

## Spike Note
AH-SPIKE-007 will install CLIs and verify deployment in staging environment during Phase 7.
