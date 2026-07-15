# ADR-012: CI/CD

## Status: ACCEPTED

## Rationale
GitHub Actions + Turborepo cache is SOTA for monorepo CI. Docker build for containerization. Fly.io deploy for multi-region. Agent should verify Fly.io CLI integration in Phase 7. Canary deployment requires ReleaseApproval (human WebAuthn signature).

## Decision
GitHub Actions + Turborepo cache + Docker build + Fly.io deploy.

## Pipeline
1. Lint + type-check
2. Unit tests
3. Integration tests
4. Contract validation
5. Build Docker image
6. Deploy to dev
7. Deploy to staging (on main)
8. Deploy to canary (on tag)
9. Production (on ReleaseApproval)
