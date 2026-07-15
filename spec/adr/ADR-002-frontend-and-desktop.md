# ADR-002: Frontend and Desktop Technology

## Status: ACCEPTED
## Decision
Next.js (web) + Tauri (desktop) + React Native (mobile, Phase 6+).

## Rationale
- Next.js: SSR, App Router, Vercel deployment
- Tauri: Lightweight desktop, Rust backend, local-first
- Shared React components across web/desktop

## Alternatives Considered
- Electron (heavier, Node.js dependency)
- Flutter (different language from web)

## Status: ACCEPTED

## Verification Evidence
- Next.js: Next.js v16.2.10 (command: `npx next --version`)
- Tauri (cargo): available (command: `which cargo`)
- Date: 2026-07-16T03:47:55.201715

## Decision
Next.js confirmed available. Using Next.js for web. Tauri available for desktop.

## Spike Note
Tauri verification deferred - Rust toolchain not installed. Spike AH-SPIKE-003 will install Rust and verify Tauri in Phase 0R execution. Frontend can start with Next.js only.
