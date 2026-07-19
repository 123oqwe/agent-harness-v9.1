# State Machine Invariants

## OperationStateMachine Invariants (must be model-checked)

1. No unauthorized execution: Must pass through POLICY_EVALUATED -> AUTHORIZED before any execution
2. No double irreversible effect: Same operation cannot commit twice
3. Expired fencing cannot commit: EXPIRED is terminal
4. Terminal states not re-enterable: All terminal states are final
5. CONSENT_EXEMPT exists: Low-risk auto-approve path
6. Only PRE_DISPATCH_FAILED can automatic retry
7. EFFECT_UNKNOWN must read-back before retry: RECONCILING required
8. AWAITING_HUMAN is non-terminal: Can transition to EFFECT_CONFIRMED or REMEDIATION_REQUIRED
9. REMEDIATION_REQUIRED is terminal: Requires new Run or human process
10. Each retry generates new attempt_id and new CapabilityToken

## RunStateMachine Invariants

1. Terminal states not re-enterable
2. Cannot execute without valid frozen RunPlan
3. Pause during IN_FLIGHT must check effect state before resume
4. context_reset must write handoff artifact (goal, completed steps, open tasks, checkpoint refs, next step) before clearing session

## ExternalEffectStateMachine Invariants

1. IN_FLIGHT cannot retry - must query first
2. EFFECT_UNKNOWN must reconcile
3. Prepare -> Commit -> Read-back two-phase protocol

## ApprovalStateMachine Invariants

1. No execution without approval for T2+
2. AWAITING_HUMAN non-terminal
3. REMEDIATION_REQUIRED terminal

## Cross-Machine Invariants

1. CapabilityToken use_limit=1 enforced atomically
2. Policy enters BEFORE routing
3. PEP at EVERY action
4. Child Capability signed by Authorization Service (not parent)

## Framework Invariants (FG1-FG11)

These are not bound to a single state machine; they are cross-cutting invariants enforced across Runtime, Action Control, and the Model Gateway.

### RunPhase Invariants (FG2)
1. agent phase executes with network disabled by default (egress only via CTRL-EGRESS-002 allowlist)
2. Before entering agent phase, all credentials are stripped from the process environment
3. A tool requiring a credential obtains it via single-exchange at dispatch (CTRL-CRED-REACH-001); the credential is never present in env across loop iterations
4. scheduled/routine tasks always enter agent phase (credentials absent from agent env)

### VFS Invariants (FG4)
1. All file access (tool read_file/edit_file, RAG retrieve, memory, evidence) goes through the VFS
2. A path denied by VFS permission rules is denied at both read_file and retrieve (no RAG bypass of read_file deny)
3. OverlayBackend file edits are atomic per-RunPlan: on verification failure, staged edits are discarded and never reach the real FS

### Network Policy Invariants (FG3)
1. network_access boolean is a derived summary; egress_policy is the enforcement target
2. deny rules always win over allow rules
3. unix sockets denied unless explicitly allowed; local/private binding denied by default

### Computer Use Invariants (FG1/FG6)
1. computer_operate requires per-app approval; sentinel apps (terminal/Finder/system settings) require escalated consent
2. screenshot_isolation=exclude_self_output: agent own UI/terminal never enters screenshots
3. global interrupt key is consumed (injected content cannot dismiss dialogs)
4. single_session_lock: only one session controls the machine at a time

### Cache Invariants (FG5/FG11)
1. Tool definitions are stable in the prompt; action selection constrained via tool-masking, not via adding/removing tool definitions mid-loop
2. Compaction aligns with cache breakpoints (post-compaction stable prefix remains a cache hit)

### Cross-Process Message Invariants (FG8)
1. Cross-process AgentGraph messages carry obo_token (delegation) and jws_signature (integrity)
2. A message with invalid JWS signature is rejected; a message cannot exceed OBO permissions

### Routing Slip Invariants (FG7)
1. insert_limit enforced: agent cannot insert more steps than insert_limit (default 3) per itinerary
2. Itinerary is append-only auditable: executed steps moved to executed log, cannot be deleted or reordered
3. Forward is idempotent: a duplicated forward message does not execute the step twice (idempotency by step_id)
4. A routing-slip workflow has no central orchestrator; if a worker dies, the message waits on the broker until a worker picks it up

### Subagent Configuration Invariants (G-CC1)
1. A worker node with isolation=worktree MUST execute in its own git worktree (not shared workspace)
2. disallowed_tool_refs deny wins over tool_grant_refs allow (deny-by-default)
3. memory_scope=isolated worker cannot read parent memory store (enforced at VFS permission layer FG4)
4. hooks_ref=null means inherit parent hooks; non-null hooks subject to AH-HOOK-001 trust levels (cannot escalate)
5. effort is per-node, not per-run: same model may run at different effort across DAG nodes

### Workflow Script Invariants (FG9)
1. Intermediate results live in script variables, NOT in the main agent context window
2. The main session receives only the final artifact from the script, not per-sub-agent results
3. A workflow script is resumable: if interrupted, it resumes from the last completed phase
4. Adversarial cross-check mode: independent agents review each other's findings before the script reports

### Offloading Invariants (FG10)
1. Tool I/O exceeding offload_token_threshold (default 20000) MUST be offloaded to VFS before entering the conversation layer
2. Offloaded content is reversible: the pointer + preview can be expanded back via read_file/grep through VFS
3. Offloading runs before LLM-based compaction; compaction triggers only after offloading cannot keep the window under the Smart-Zone boundary

### Sleep/Wake Invariants (microvm)
1. Before hibernation, the Runtime writes a handoff artifact (goal, completed steps, open tasks, checkpoint refs) to VFS
2. On wake, the Runtime verifies state integrity (hash check of persisted state) before rebuilding context
3. All Capability Tokens expire during sleep; wake requires re-issuance (no stale capability reuse)
4. Files in the sandbox are preserved across the sleep/wake cycle

### Fan-Out Invariants (fanout)
1. Each fan-out clone runs in its own independent context window and its own sandbox
2. A clone failure does not block other clones (non-critical path)
3. Results are aggregated and deduplicated by the originator before reporting
4. Clone budget is allocated from the originator's remaining budget; a clone cannot exceed its allocation

### Mobile/Channel Invariants (mobile)
1. Channel-injected messages (Telegram/Discord/iMessage/webhook) carry taint_label ["channel","external"] and are untrusted
2. A remote steer from mobile enters the steering queue (steer/followUp/nextTurn), not a direct context write
3. Push notifications require explicit user consent per notification type
4. Cross-device session continuation rebuilds from the event log (event log is the authority, not device-local state)
