# Changelog

## 0.1.0-phase1 - 2026-07-29

### Added

- Unified `Harness` composition root and request-to-outcome execution path.
- Direct, ReAct, and frozen DAG Plan+Execute reasoning strategies.
- Model gateway, tool and skill registries, controlled dispatch, VFS, process
  sandbox, durable sessions, independent verification, and evidence.
- Nine local tools, eight declarative skills, and six vertical adapters.
- Deterministic tests, coverage gates, per-module mutation gates, package smoke
  tests, and opt-in GLM-5.2 xhigh acceptance.

### Security

- Enforced authorization, capability, consent, PEP, receipt, and audit path for
  tool effects.
- Added credential isolation, deny-by-default network policy, transactional
  workspace handling, and crash/idempotency controls.

### Source release cleanup

- Aligned sandbox, skill-registry, and vertical source paths with architecture.
- Removed the runtime value cycle between the loop and Plan+Execute.
- Added a deterministic production import-cycle gate.
- Reduced the package-root API so process and host-environment helpers remain
  internal.
- Added source documentation and GitHub CI workflows.
