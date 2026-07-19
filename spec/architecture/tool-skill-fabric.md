# Tool & Skill Fabric


![09-tool-skill-catalog.svg](diagrams/09-tool-skill-catalog.svg)

## ToolSpec (v9 expanded from v8 ToolDefinition)
Every tool must have: schemas, effects, risk_feature_extractor, preconditions, postconditions, timeout, cancellation, retry, idempotency, sandbox, network, credentials, data_egress, receipt, verification, reconciliation, compensation, tests, maturity, certification.

Only production_certified tools enter production Registry.

## Phase 1 Tools (9, reduced from v8's 20)
read_file, list_directory, search_files, write_file, edit_file, execute_command_sandboxed, parse_document, create_artifact, ask_user

run_tests is a controlled execute_command profile, NOT a separate tool.

All file-touching tools (read_file, list_directory, search_files, write_file, edit_file, create_artifact) are thin wrappers over the Virtual Filesystem (architecture/virtual-filesystem.md, FG4). VFS is the single file-access authority; it enforces permission rules for both tool calls and RAG retrieval, and provides the OverlayBackend transactional checkpoint that makes edit_file a real per-RunPlan transaction.

## Tool Transport (4 types)
Native (in-process), CLI Wrapper (subprocess), MCP (JSON-RPC), HTTP API

## MCP Allowlist (Phase 2)
MCP servers require explicit approval before connection. An `mcp_allowlist.json` in project or global config lists approved MCP servers by signature (command hash for stdio, URL + key pin for remote). Unlisted MCP servers are denied. This controls THREAT-TOOL-POISONING (CTRL-PLUGIN-SIGN-001). Enterprise deployments may use a managed `mcp_allowlist.json` that overrides all other scopes (exclusive scope, same pattern as enterprise MCP policy).

## SkillSpec
Must include: input/output schema, required context, required tools, allowed effect classes, workflow template, verification template, failure policy, risk ceiling, eval suite.
Skill can only SUGGEST tool grants. Policy decides.

## Agent Authoring Format (G-PI1)

Agents are authored as Markdown files with YAML frontmatter, compiling to AgentGraph nodes. See `contracts/agent-authoring-format.md` for the format specification. Provides developer ergonomics parity with Claude Code (subagent md frontmatter) and pi-agents (agent = md file). The compiler validates frontmatter against `agent-graph.schema.json` (including per-agent config fields: isolation/hooks_ref/memory_scope/effort/disallowed_tool_refs per G-CC1). Agent md files live in `agents/` (project) or `~/.harness/agents/` (global); Router discovers agents by scanning these directories.

## Generated Tools
ALWAYS: untrusted, sandbox-only, no secrets, no external writes, network denied by default, manual publication required. Success count does NOT auto-promote to trusted.


## Implementation Notes

### ToolSpec Implementation

```typescript
interface ToolImplementation {
  spec: ToolSpec;
  execute(input: ToolInput, ctx: ExecutionContext): Promise<ToolOutput>;
}
```

### Phase 1 Tools (9, reduced from v8's 20)

| Tool | Transport | Effect | Risk | Source File |
|------|-----------|--------|------|-------------|
| read_file | native | read_only | T0 | harness/tools/read_file.ts |
| list_directory | native | read_only | T0 | harness/tools/list_directory.ts |
| search_files | native | read_only | T0 | harness/tools/search_files.ts |
| write_file | native | idempotent_write | T1 | harness/tools/write_file.ts |
| edit_file | native | idempotent_write | T1 | harness/tools/edit_file.ts |
| execute_command_sandboxed | cli_wrapper | non_idempotent | T2 | harness/tools/execute_command.ts |
| parse_document | native | read_only | T0 | harness/ingestion/parse_document.ts |
| create_artifact | native | idempotent_write | T1 | harness/tools/create_artifact.ts |
| ask_user | native | pure | T0 | harness/tools/ask_user.ts |

`run_tests` is a controlled `execute_command` profile, not a separate tool.

### Generated Tools
Always: untrusted, sandbox-only, no secrets, no external write, network denied by default.
Trust pipeline: untrusted → verified (10+ uses, 80% success) → trusted (50+ uses, 90% success, human review) → builtin.
Agent should NOT auto-promote. Success count does not equal trust.

### execute_command_sandboxed output_mode (backpressure)
The `execute_command_sandboxed` tool accepts an `output_mode` parameter to control context window consumption:
- `full` (default): returns full stdout/stderr
- `summary`: on success returns exit code + line count only; on failure returns exit code + failure-related output (stderr + failing assertions). Implements backpressure: success = minimal output, failure = full diagnostic.
- `silent`: returns exit code only, never returns output
Purpose: 200+ lines of passing test output wastes 2-3% of context window. Deterministic output control is better than letting the model truncate.

### Phase 2 Tools (additions)

| Tool | Transport | Effect | Risk | Source File |
|------|-----------|--------|------|-------------|
| web_search | http_api | read_only | T2 | harness/tools/web_search.ts |
| web_fetch | http_api | read_only | T2 | harness/tools/web_fetch.ts |
| behavior_verify | cli_wrapper | read_only | T1 | harness/tools/behavior_verify.ts |

- web_search: search engine query, returns ranked results. Requires consent (T2). Results tagged `trust_level: "untrusted"`, `taint_labels: ["web"]`. Needed for research vertical beyond given sources.
- web_fetch: fetch a URL and extract content. Requires consent (T2). SSRF blocked (CTRL-EGRESS-001): no internal/private IPs. Content tagged untrusted. HTML to markdown extraction.
- behavior_verify: Playwright-based UI behavior verification. Clicks through running application, tests UI features, API endpoints, database states. Returns PASS/FAIL per criterion. Fills the functional behavior verification gap (industry blank 2).

### Computer Use Tools (FG1 — Phase 3+)

Computer use is a first-class action surface for the Founder persona ("launch a web app end-to-end", "manage AI short drama production") and any task requiring a GUI. It is distinct from `behavior_verify`, which is scoped to verifying self-built web products.

| Tool | Transport | Effect | Risk | Source File |
|------|-----------|--------|------|-------------|
| computer_operate | native | non_idempotent | T4 | harness/tools/computer_operate.ts |
| browser_operate | cli_wrapper (Playwright/CDP) | non_idempotent | T3 | harness/tools/browser_operate.ts |

- computer_operate: OS-level screen interaction (screenshot, click, type, key, clipboard) for native apps and desktop. Requires per-app approval. Sentinel apps (terminals, IDEs, Finder, System Settings) require escalated consent and are flagged as equivalent-to-shell / any-file / system-settings. Browser and trading surfaces are view-only; terminals and IDEs are click-only; other apps get full control. Binds EffectRisk.screen_access.
- browser_operate: general browser agent (not limited to self-built products). Navigates, clicks, fills forms, extracts content. Drives logged-in sessions. Content tagged `trust_level: "untrusted"`, `taint_labels: ["web","screen"]`.

### Screen Injection Isolation (FG6)

Computer use opens a prompt-injection feedback channel: a screenshot that contains malicious text (or the agent own output) can be re-ingested as instruction. Controls (CTRL-SCREEN-ISOLATION-001):
- `display_policy.screenshot_isolation = exclude_self_output` (default): the agent own terminal/UI and approval prompts never enter screenshots, so on-screen prompts cannot feed back into the model.
- `display_policy.global_interrupt_consumed`: the global interrupt key is consumed so injected content cannot dismiss dialogs via simulated input.
- `display_policy.single_session_lock`: only one session controls the machine at a time (lock file).
- Per-app approval = per-app Capability; sentinel apps get a separate escalated-consent tier.

This is required because `THREAT-INDIRECT-INJECTION` (text taint, CTRL-TAINT-001) does not cover pixel-level re-ingestion. Without FG6, computer use would be an injection bypass of the taint system.

### Two-Phase Runtime Binding (FG2)

Every ToolSpec declares `run_phase_binding` (setup | agent). Tools that only install dependencies (e.g. a constrained `package_install` profile) bind to `setup`. Tools requiring credentials bind to `agent` only and obtain credentials via single-exchange at dispatch (CTRL-CRED-REACH-001), never via environment variables persisting across the loop. See `runtime-core.md` RunPhase.

### Network Policy Binding (FG3)

Tools with network access bind an `egress_policy_ref` to EffectRisk.egress_policy (CTRL-EGRESS-002). The boolean `network_access` is a derived summary only; enforcement is the domain-level policy. `execute_command_sandboxed`, `web_fetch`, `browser_operate`, and MCP server traffic are all subject to egress_policy.


## Mobile Surface Tools (Phase 6)

The Mobile + Remote Control + Channels surface (Product Surface 13) requires tools that bridge the agent session to external messaging channels and mobile push.

| Tool | Transport | Effect | Risk | Source File |
|------|-----------|--------|------|-------------|
| send_push_notification | http_api | communicate | T3 | harness/tools/send_push_notification.ts |
| receive_channel_message | native | read_only | T2 | harness/tools/receive_channel_message.ts |
| steer_session | native | pure | T1 | harness/tools/steer_session.ts |

- send_push_notification: sends a push notification to the user's mobile device (iOS/Android). Extends the AH-CAPMAP-020 in-app notification system (Phase 1, local event queue, no push) to mobile push in Phase 6. Requires per-notification-type user consent (T3). Notification content tagged `trust_level: "trusted"` (platform-generated, not agent-injected) but agent-supplied body is `untrusted` and sanitized (no URL auto-open, no action buttons that execute commands).
- receive_channel_message: receives a message from an external channel (Telegram/Discord/iMessage/webhook) and injects it into the session steering queue. Message content tagged `trust_level: "untrusted"`, `taint_labels: ["channel","external"]`. Enters the `nextTurnQueue` (steering), NOT a direct context write. This is the Channels pattern: external chat messages can steer the agent.
- steer_session: lets a remote device (mobile, another desktop) insert a steering command into the session's steer/followUp/nextTurn queue. This is Remote Control: cross-device session continuation. The session event log remains the authority (not device-local state).

### Channel Injection Isolation

Channel-injected messages are a prompt-injection vector (an attacker could send "ignore previous instructions" via Telegram). Controls:
- Every channel message gets `taint_labels: ["channel","external"]` and goes through the injection pattern library (CTRL-TAINT-001).
- Channel messages enter the steering queue, not the conversation directly; the agent sees them as user-originated steering, not as system instructions.
- A channel message cannot grant capabilities, expand tool grants, or change permission mode.

## Sandbox Sleep/Wake (Phase 6+)

Long-running missions (Phase 6) may run for hours or days. The sandbox supports sleep/wake:
- **Sleep**: the Runtime writes a handoff artifact (goal, completed steps, open tasks, checkpoint refs) to VFS, persists the sandbox filesystem, and releases compute. All Capability Tokens are expired (cannot be reused after wake).
- **Wake**: the Runtime verifies state integrity (hash check), rebuilds context from the handoff artifact + VFS, re-issues fresh Capability Tokens, and resumes. Files in the sandbox are preserved across sleep.

This is distinct from `context_reset` (which clears the window and starts fresh): sleep/wake preserves the full session state, just releases compute resources.

## Fan-Out Mode (Phase 3+)

For large-scale homogeneous tasks (e.g. multi-source fan-out research), the Router may select `execution_mode: workflow_script` with a fan-out pattern:
- The originator agent spawns N clones (default max 6, bounded by AH-SUBAGENT-001 max concurrent; configurable up to 100 with an elevated concurrency grant approved by the Authorization Service), each in its own context window and its own sandbox.
- Each clone is a capability-attenuated (tool_grants subset of originator, per AH-SUBAGENT-001), receives a slice of the task, and returns a result. NOT a full-capability agent: AH security model requires child capabilities to be subsets of the parent.
- The originator aggregates and deduplicates results.
- Clone budget is allocated from the originator's remaining budget; a clone that exceeds its allocation is killed.
- A clone failure does not block other clones (non-critical path).

This is declared in `agent-graph.schema.json` as `execution_mode: workflow_script` with a fan-out sub-pattern. Distinct from `routing_slip` (which is sequential open-ended) and `static_dag` (which is fixed topology): fan-out is parallel homogeneous.
