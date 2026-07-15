# ADR-003: Backend and API Framework

## Status: REJECTED
## Decision
Node.js + Fastify (API server) + tRPC (type-safe RPC).

## Rationale
- TypeScript end-to-end
- Fastify: high performance, plugin ecosystem
- tRPC: type safety without codegen

## Status: ACCEPTED

## Verification Evidence
- Fastify: npm error could not determine executable to run
npm error A complete log of this run can be found in (command: `npx fastify --version`)
- Date: 2026-07-16T03:47:55.201720

## Decision
Fastify confirmed available. Using Fastify for API server. tRPC will be added as dependency for type-safe RPC.
