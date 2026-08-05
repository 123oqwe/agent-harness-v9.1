# ADR-014: Tool Expansion for Vertical Domains

## Status: ACCEPTED

## Rationale

Phase 1 defines 9 tools (read_file, list_directory, search_files, write_file, edit_file, execute_command_sandboxed, parse_document, create_artifact, ask_user). This is sufficient for the coding/research vertical (Codex/Claude Code shape) but cannot serve the 21 product verticals listed in `spec/product/jobs-to-be-done.md` and `spec/product/personas.md`:

AI music, AI company, AI short drama, AI design, AI law, AI architecture, AI hardware design, AI PPT, Excel, AI advertising, AI blog, AI digital avatar, AI subtitle/dubbing localization, AI accounting/tax, AI audit, AI insurance claims, AI HR/recruiting, AI consulting/research, AI counseling, AI education/tutoring, AI translation/localization.

Gap analysis shows three structural deficits:

1. **No generation tools.** Image/video/speech/music generation exist only as model-api-gateway capability enums (adapter path), not as model-callable tools. The agent cannot initiate generation inside the loop, receive an artifact path, and feed it to the next step (PPT / website / video). Manus ships these as first-class tools; Codex/Claude Code do not, but they also do not target media-producing verticals.
2. **No structured-document write tools.** Phase 2 has docx/pptx/xlsx ingest (read side) but no write/operate tools. `create_artifact` is too generic to preserve PPT layouts, Excel formulas, or DOCX tracked changes.
3. **No real-time voice or human-escalation primitive.** HR interviewing, counseling crisis handoff, and tutoring require conversational voice (distinct from one-shot TTS) and asynchronous human escalation (distinct from synchronous ask_user).

## Decision

Add 14 tools, 3 gateway capabilities, 3 ToolSpec fields, 1 sandbox toolchain spec, and 2 threat controls. Tools are organized by transport (not by phase) because transport determines the implementation contract; phase assignment is a secondary attribute tracked in phase manifests. The 14th tool (schedule_task) closes the loop-engineering gap: the agent could run, evaluate, and plan the next run, but had no model-callable way to create or manage a future scheduled run. It wraps the Phase 6 routine scheduler engine as a model-callable interface.

### New tools (14)

| Tool | Transport | Effect | Risk | Phase | Unlocks verticals |
|------|-----------|--------|------|-------|-------------------|
| generate_image | http_api | non_idempotent | T2 | 2 | design, short drama, ads, blog, PPT, architecture, hardware, insurance |
| generate_speech | http_api | non_idempotent | T2 | 2 | short drama, dubbing, digital avatar, HR, counseling, education, a11y |
| transcribe_audio | http_api | read_only | T2 | 2 | subtitle, dubbing, HR input, meeting minutes |
| manipulate_spreadsheet | cli_wrapper | idempotent_write | T1 | 2 | Excel, accounting, audit, consulting |
| generate_presentation | cli_wrapper | idempotent_write | T1 | 2 | PPT |
| generate_document | cli_wrapper | idempotent_write | T1 | 2 | legal contracts, consulting reports |
| ocr_document | cli_wrapper | read_only | T0 | 2 | accounting, audit, insurance |
| escalate_to_human | native | pure | T0 | 2 | counseling crisis, legal escalation, audit flagged |
| generate_video | http_api | non_idempotent | T3 | 3 | short drama, ads, digital avatar, education |
| generate_music | http_api | non_idempotent | T2 | 3 | music, short drama BGM, ads jingle |
| edit_video | cli_wrapper | non_idempotent | T2 | 3 | short drama editing, ads editing, dubbing mux |
| voice_converse | http_api | non_idempotent | T3 | 6 | HR interview, counseling, education tutoring |
| clone_voice | http_api | non_idempotent | T4 | 6 | digital avatar (biometric, escalated consent) |
| schedule_task | native | idempotent_write | T1 | 6 | loop engineering (all long-running missions) |

### New gateway capabilities (3)

Added to `spec/architecture/model-api-gateway.md` Capability Registry:
- `transcription` (ASR; distinct from `audio_understanding` which is semantic, not verbatim)
- `music_generation`
- `realtime_speech` (bidirectional streaming voice; distinct from `speech_generation` which is one-shot TTS)

### New ToolSpec fields (3, optional, backward-compatible)

Added to `spec/contracts/tool-spec.schema.json`:
- `transport` (enum: native, cli_wrapper, mcp, http_api). Was implied by fabric tables but absent from the schema. Now explicit so the Registry can validate transport-specific fields.
- `tool_group` (string, pattern `^[a-z_]+$`). Used by the tool-masking state machine (CTRL-TOOL-MASK-001) to mask groups via decode-time logits without editing tool definitions. Examples: `fs`, `web`, `media_gen`, `media_edit`, `doc`, `voice`, `shell`.
- `cli_toolchain_ref` (string). References a dependency key in `spec/deployment/sandbox-toolchain.yaml`. Required when transport=cli_wrapper; the runtime checks availability before spawn and returns a structured error if missing (instead of crashing).

These fields are optional. Existing fixtures and Phase 1 tool specs remain valid. The fabric's transport table is now schema-backed rather than prose-only.

### New sandbox toolchain spec

`spec/deployment/sandbox-toolchain.yaml` declares the external binaries and Python packages that cli_wrapper tools depend on (openpyxl, python-pptx, python-docx, ffmpeg, tesseract). Verified at sandbox init; on missing dependency the affected tool returns a structured error and the agent can fall back to `execute_command_sandboxed`.

### New threat controls (2)

- `CTRL-MEDIA-EGRESS-001`: generation tool egress restricted to provider allowlist; prompt/content not logged externally.
- `CTRL-VOICE-BIOMETRIC-001`: voice clone requires biometric consent proof; biometric template not persisted.

## Non-goals

- Vertical workflows (accounting pipeline, recruiting pipeline, counseling CBT loop) are skills/missions, not tools. This ADR adds primitives only.
- Domain knowledge (legal corpus, tax rules, building codes, component library) is RAG, not tools.
- External system integration (bank API, tax filing, ATS, ad platforms, claims systems) is MCP connectors, not tools.
- Video nonlinear editing UX (timeline, multi-track) is out of scope; `edit_video` covers ffmpeg-level operations only.

## Constraints

- ToolSpec schema changes are backward-compatible (optional fields only). Existing fixtures validate without modification.
- New requirements follow existing `AH-TOOL-{NAME}-001` convention and are added to `requirements.ndjson` + phase manifests.
- Phase assignment respects dependency ordering: generation tools depend on `AH-POLICY-ENGINE-001` (Phase 1); cli_wrapper tools depend on `AH-SANDBOX-001` (Phase 1); `voice_converse`/`clone_voice` deferred to Phase 6 (Mission Layer) because they need the long-running session and biometric consent infrastructure.
- `spec/contracts/` and `spec/requirements/` are protected paths (PROTECTED_PATHS.md). This ADR is the required approval artifact for those changes.
- `schedule_task` security binding: scheduled runs enter agent phase (CTRL-RUNPHASE-001) — credentials absent from env, obtained via single-exchange at dispatch. Scheduled runs require fresh reauth (AH-SCHED-REAUTH-001), cannot reuse the scheduling agent's capability token (CTRL-CAPABILITY-SINGLE-USE-001). A scheduled run's capability set is a subset of the scheduling agent's (AH-SUBAGENT-001 attenuation rule). Max concurrent schedules enforced per user to prevent resource exhaustion. This is the loop-engineering entry point: run -> evaluate -> schedule next -> sleep -> wake with fresh credentials.
