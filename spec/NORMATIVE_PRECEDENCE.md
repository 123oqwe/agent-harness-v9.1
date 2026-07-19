# Normative Precedence

This document defines the priority hierarchy for all specification sources.
When sources conflict, the higher-priority source wins.

## Priority Hierarchy (highest to lowest)

| Priority | Source | Location | Format |
|----------|--------|----------|--------|
| 1 | Machine-readable contracts | `contracts/*.schema.json` | JSON Schema |
| 2 | Phase manifests | `phases/phase-N.yaml` | YAML |
| 3 | Requirement registry | `requirements/requirements.ndjson` | NDJSON |
| 4 | State-machine definitions | `state-machines/*.machine.json` + `*.tla` | JSON + TLA+ |
| 5 | Security invariants | `state-machines/invariants.md` + `threat-model/` | Markdown + YAML |
| 6 | Architecture specifications | `architecture/*.md` | Markdown |
| 7 | Product specifications | `product/*.md` + `domains/` | Markdown |
| 8 | Examples and explanatory prose | Inline in spec files | Code/Prose |
| 9 | Deprecated appendices | `appendix/deprecated-v8-content/` | Markdown |

## Rules

1. **Deprecated content MUST NOT be implemented.** Any requirement that references deprecated content is invalid.
2. **No source may silently override a higher-priority source.** If architecture Markdown says "optional" but the JSON Schema says "required", the JSON Schema wins.
3. **When a contract is frozen, lower-priority sources cannot contradict it.** A frozen schema cannot be overridden by a markdown note.
4. **TLA+ model-check results override prose claims.** If prose says "this transition is safe" but TLA+ finds a violation, the TLA+ result wins.
5. **Phase manifests define what is in scope.** A requirement not listed in the current phase manifest is not ready for implementation, even if its specification_maturity is "frozen".
6. **Runtime state authority is `control/current-state.json`.** The `status` field of a phase manifest MUST match `control/current-state.json` for that phase. If they differ, `current-state.json` wins for runtime status (which phase is VERIFIED/READY/BLOCKED); the phase manifest's scope/requirements/enabled_domains remain normative for content. Phase manifests MUST be updated to match current-state.json when status changes.

## Conflict Resolution Process

1. Identify the conflicting sources and their priority levels.
2. The higher-priority source is normative.
3. The lower-priority source must be corrected to match.
4. If the conflict is intentional (e.g., a planned change), create an ADR.
5. The ADR must explicitly state which source is being overridden and why.
6. The ADR must update both sources to be consistent.

## Frozen vs Provisional

- **frozen**: Cannot be changed without an ADR + human approval. Breaking changes require migration.
- **provisional**: Can be updated within the same phase. Breaking changes require notification.
- **draft**: Can be freely updated. Not yet ready for implementation.
- **verified**: Has been tested against actual implementation. Cannot regress.

## Deprecated Content Handling

All deprecated v8 content is in `appendix/deprecated-v8-content/`.
Each deprecated section includes:
- source_file
- source_section
- original_text
- reason_for_deprecation
- replacement_requirement_ids
- migration_notes

Deprecated content is preserved for traceability but MUST NOT be used as normative.
