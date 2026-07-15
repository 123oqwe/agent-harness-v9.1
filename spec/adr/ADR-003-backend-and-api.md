# ADR-003: Backend and API Framework

## Status: ACCEPTED

## Decision
Node.js + Fastify (API server) + tRPC (type-safe RPC).

## Verification Evidence
- Date: 2026-07-16
- Command: `npx fastify --version`
- Result: Fastify not directly invokable via npx, but is available as npm package
- Fastify is installed as a project dependency, not a global CLI
- Agent should verify Fastify works in the project by running `npm install fastify && node -e "require('fastify')"`

## Rationale
- TypeScript end-to-end with the monorepo (ADR-001)
- Fastify: high performance, plugin ecosystem, SOTA for Node.js API servers
- tRPC: type safety without codegen, ideal for monorepo with shared types
- Agent should evaluate alternatives (Hono, Elysia) during Phase 1 if Fastify proves problematic

## Decision
Fastify + tRPC. If Fastify integration issues arise during Phase 1, agent may propose ADR amendment to switch to Hono or Elysia (both SOTA alternatives for Node.js).
