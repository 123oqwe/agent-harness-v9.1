# API Compatibility Policy

## Versioning
- URL prefix: `/v1`, `/v2`, etc.
- Major version: breaking changes (new URL prefix)
- Minor version: additive changes (same URL, new fields/endpoints)
- Patch: bug fixes (same URL)

## Deprecation
- 6 months notice before removal
- `Deprecation` header in response
- `Sunset` header with removal date
- Migration guide provided in changelog

## Schema Evolution
- New optional response fields: additive (no version bump)
- New required request fields: breaking (major version)
- Removed fields: 6 months deprecation then removal
- Type changes: breaking (major version)

## Client Generation
- OpenAPI spec used for client generation
- Generated clients must compile
- Breaking changes require client regeneration
