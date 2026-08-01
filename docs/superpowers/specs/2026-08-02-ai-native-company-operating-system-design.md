# AI-Native Company Operating System

Date: 2026-08-02

Status: proposed design, pending user review

Owners: human CEO and human CTO

Initial company: two founders building AI software and Agent products on top of a reusable company operating system

## 1. Objective

Build an AI-native company in which autonomous agents perform routine product, engineering, growth, customer, finance, legal-support, and operating work while two human founders retain strategy, fiduciary responsibility, production safety, and irreversible authority.

The first 90-day outcome is a working company loop:

```text
strategy -> opportunity -> product -> release -> growth -> revenue/feedback
        -> financial/risk review -> resource reallocation
```

Success means the loop produces attributable customer and business outcomes. Agent count, message volume, and generated documents are not success metrics.

## 2. Scope and non-goals

### In scope

- Human/agent organization and responsibility boundaries.
- Event, schedule, metric, human-command, and agent-derived triggers.
- Product, engineering, growth, customer, finance, and legal-support workflows.
- Structured collective ideation and independent verification.
- Identity, least privilege, budgets, approvals, audit, memory, and model routing.
- GitHub as engineering source of truth and Feishu/DingTalk as the human control surface.
- Cloud deployment, observability, failure recovery, and a 90-day rollout.

### Non-goals

- Replacing licensed lawyers, accountants, tax advisers, or other regulated professionals.
- Permitting an agent to pay, sign, borrow, transfer equity, expose secrets, or permanently delete production data.
- Creating a separate permanent agent for every conventional corporate title.
- Treating chat history, model confidence, or agent consensus as authoritative evidence.
- Fully automating a process before its risk, rollback, and outcome measurement are understood.

## 3. Selected organizational model

Use a small permanent AI cabinet plus goal-specific, disposable swarms. This combines stable accountability with elastic execution and avoids both a bloated simulated bureaucracy and an unaccountable swarm.

```text
Human Board
  CEO -- strategy, capital, commercial and legal accountability
  CTO -- architecture, production, security and model-risk accountability
      |
Permanent AI Cabinet
  Chief of Staff, COO, CPO, CRO/CMO, CFO, CLO/Compliance,
  People Ops, Risk Officer
      |
Persistent Work Domains
  Product & Research, Engineering, Growth & Revenue,
  Customer Success, Business Operations
      |
Goal-specific Agent Swarms
      |
Independent Auditor and Red Team
```

### 3.1 Human responsibilities

The CEO owns mission, company objectives, capital allocation, pricing principles, financing, equity, material partnerships, human hiring, material customer commitments, and legal accountability.

The CTO owns architecture principles, production safety, model/data policy, security baselines, critical releases, secrets policy, incident response, and technical risk acceptance.

Both founders can stop one workflow, one identity, one domain, or the entire company runtime. R5 actions require both founders.

### 3.2 Permanent AI cabinet

| Role | Accountable output | Must not do |
|---|---|---|
| Chief of Staff | Converts founder intent into goals, constraints, decisions, and compressed briefs | Change strategy or approve its own proposal |
| COO | Work graph, dependency resolution, resource allocation, escalation | Expand company objectives or bypass policy |
| CPO | Evidence-backed problem portfolio, roadmap, product metrics | Promise unreleased capability |
| CRO/CMO | Positioning, growth experiments, CRM funnel, revenue attribution | Change price or contract terms without authority |
| CFO | Cash forecast, budgets, cost attribution, reconciliation package | Pay or change payment destinations |
| CLO/Compliance | Contract comparison, obligation register, privacy/IP risk | Sign, represent itself as counsel, or issue final legal advice |
| People Ops | Role definitions, workload analysis, onboarding and access proposals | Hire/fire humans or access irrelevant personal data |
| Risk Officer | Risk classification, policy checks, incident escalation | Grant itself exceptions or override CTO policy |
| Auditor | Independent completion and governance evidence | Edit business results or accept self-attestation |

### 3.3 Dynamic swarms

Every swarm has exactly one objective, DRI, budget, deadline, success metric, evidence requirement, and termination condition. Roles are instantiated as needed, but identities remain separate when duties conflict. An author cannot be its own reviewer, verifier, or releaser.

### 3.4 Role seats are separate from workers

A company role is a durable `RoleSeat`; an Agent is only one possible worker assigned to that seat. A seat may be occupied by an AI worker, a human worker, or a human-agent pair. Objectives, authority, inbox, history, and accountability belong to the seat and WorkItem, not to a model conversation.

```text
RoleSeat: Engineering Lead
  -> AI-operated
  -> human-operated
  -> paired operation
  -> vacant / paused
```

Every AI-operated seat can be replaced by an authorized human without recreating the project or losing state. Replacement changes the active worker and capabilities; it does not rewrite prior decisions or evidence. Human occupation is not an unrestricted bypass: the person's real identity and organizational authority still pass through policy and audit controls.

## 4. Company control plane

The control plane is deterministic software. Models may propose actions; they do not define policy or directly confer authority.

```text
Feishu/DingTalk, GitHub, Product, CRM, Payment, Monitoring
                         |
                   Event Gateway
                         |
     Goal Registry -- Work Graph -- Policy Engine
     Identity/Budget -- Approval -- Audit Ledger
                         |
               Durable Workflow Engine
                         |
                 Sandboxed Workers
                         |
 GitHub, cloud, CRM, support, content and finance adapters
```

Core services:

- Event Gateway authenticates, validates, deduplicates, classifies, and normalizes input.
- Goal Registry is the authority for objectives, metrics, constraints, and owners.
- Work Graph is the authority for tasks, dependencies, budgets, status, and evidence.
- Policy Engine applies deterministic permission and approval rules.
- Approval Service binds a decision to an exact action, target, version, amount, and expiry.
- Durable Workflow Engine persists progress and resumes without relying on model memory.
- Audit Ledger is append-only and records commands, decisions, checks, tool calls, costs, and results.
- Secrets Broker issues scoped, short-lived credentials after policy authorization.
- Sandboxed Workers isolate tasks and deny production/network access by default.

## 5. Authoritative data model

### 5.1 CompanyEvent

```yaml
event_id: EVT-2026-000001
event_type: github.pr.opened
source: github
actor_id: eng.backend.builder
subject_ref: repo/api/pull/381
occurred_at: 2026-08-02T10:30:00+08:00
correlation_id: PRJ-0041
risk_hint: R2
payload_ref: encrypted://events/EVT-2026-000001
dedupe_key: github:repo/api:pull:381:opened
trust_class: authenticated_external
```

### 5.2 WorkItem

```yaml
work_id: WI-2026-000001
goal_id: GOAL-2026-Q3-01
parent_id: null
objective: Improve first-workflow completion rate
dri: ai.cpo
state: proposed
priority: P1
risk_level: R2
budget:
  currency: CNY
  amount: 2000
deadline: 2026-08-16T18:00:00+08:00
success_metrics:
  - name: completion_rate
    baseline: 0.62
    target: 0.80
approval_policy: policy.product.low-risk.v1
evidence_required:
  - experiment_result
  - test_report
  - deployment_receipt
rollback_ref: runbook://release/rollback-v1
```

Valid states are `proposed`, `triaged`, `planned`, `authorized`, `executing`, `verifying`, `released`, `measuring`, `closed`, and `rolled_back`. Every transition records actor, policy decision, evidence, cost, and timestamp.

### 5.3 Decision

```yaml
decision_id: DEC-2026-000021
question: Which onboarding approach should be tested first?
owner: ai.cpo
options: [guided_setup, template_first, concierge_setup]
selected: template_first
evidence_refs: [research://R-18, metric://onboarding-7d]
assumptions: [small_teams_prefer_working_examples]
dissent_refs: [critique://C-09]
review_at: 2026-08-30
```

### 5.4 Approval

```yaml
approval_id: AP-2026-000032
action: deployment.promote
target: service/api@sha256:abc123
scope: production:25-percent
risk_level: R3
requested_by: release.manager
required_approver: human.cto
expires_at: 2026-08-02T14:00:00+08:00
status: pending
```

### 5.5 Evidence

Evidence contains provenance, immutable artifact hashes, command or provider receipts, observed result, collector identity, and collection time. A model-written summary without the underlying receipt is not completion evidence.

### 5.6 HumanInteraction

```yaml
interaction_id: HI-2026-000081
actor: human.ceo
surface: feishu
mode: exploration
state: clarifying
intent_text_ref: encrypted://interactions/HI-2026-000081
interpreted_objective: Diagnose the decline in qualified leads
assumptions:
  - The initial scope is the last eight weeks
unknowns:
  - Whether product-led and outbound leads should be analyzed together
allowed_effects: [analytics.read, crm.read, report.write]
prohibited_effects: [website.write, price.change, customer.contact]
confirmation_required: true
attention_priority: P2
correlation_id: WI-2026-000044
```

HumanInteraction is the authority for what a human said, what the system understood, which assumptions remain, which interaction mode applies, and whether an executable objective was actually confirmed. Chat text by itself is not authorization.

### 5.7 RoleSeat and Assignment

```yaml
role_seat_id: seat.engineering.lead
role_definition: role://engineering-lead/v2
accountable_for: [technical_design, delivery_quality, engineering_coordination]
reports_to: seat.cto
current_assignment:
  assignment_id: ASG-2026-00019
  worker_type: agent
  worker_id: agent.engineering.lead.04
  mode: delegated
  lease_expires_at: 2026-08-02T18:00:00+08:00
  capability_ref: capability://CAP-0081
  status: active
allowed_human_occupants: [human.cto, human.engineer.on_call]
handoff_checkpoint_ref: checkpoint://CP-104
```

Assignment is a revocable lease, not permanent ownership. Only one worker has write authority for a seat at a time unless the seat is explicitly in pairing mode. Reassignment atomically freezes the old worker, revokes its unused capabilities, creates a checkpoint, and transfers control to the new worker.

### 5.8 ObjectiveRevision

```yaml
revision_id: OR-2026-00014
work_id: WI-2026-000001
base_revision: 3
requested_by: human.ceo
request_source: conversation
natural_language_request: Prioritize reliability; do not ship this week
compiled_patch:
  objective: Improve onboarding without a production release this week
  constraints_added: [production_release_before_2026_08_10_forbidden]
affected_work: [WI-2026-000007, WI-2026-000009]
impact:
  schedule_days: 5
  additional_cost_cny: 600
  invalidated_artifacts: [release_plan_v3]
confirmation_state: confirmed
effective_from_checkpoint: CP-105
```

ObjectiveRevision preserves the old objective, compiles human language into a structured diff, shows downstream effects, and becomes active only after authorization appropriate to the impact.

## 6. Trigger model

All triggers create or update a WorkItem; they never invoke unrestricted tools directly.

1. **Human command:** signed `/goal`, `/project`, `/approve`, `/reject`, `/stop`, `/status`, `/brief`, and `/decision` commands or structured forms.
2. **Schedule:** hourly health/cost/lead checks, daily briefs, weekly operating reviews, monthly budget and access reviews, quarterly strategy reviews.
3. **Business event:** GitHub, product, CRM, support, billing, deployment, or contract lifecycle event.
4. **Metric threshold:** a sustained threshold or statistically justified change activates a predefined playbook.
5. **Agent-derived task:** bounded child work whose budget and capability are strict subsets of the parent. Cross-domain work requires COO admission.
6. **External environment:** verified regulation, dependency, platform, market, or competitor changes enter an observation queue before triage.

Trigger controls include authentication, source trust classification, schema validation, idempotency, debouncing, consecutive-window thresholds, prompt-injection isolation, and per-source rate limits.

## 7. Coordination and collective ideation

### 7.1 Coordination protocol

Every WorkItem has one DRI. COO assigns work based on capability match, least privilege, conflicts of interest, context sufficiency, budget, and recoverability. Handoffs use typed artifacts rather than chat transcripts.

The execution chain is:

```text
author -> reviewer -> verifier -> releaser -> outcome measurement
```

Each identity has bounded turns, time, tokens, money, child count, and explicit exit criteria. Repeated conclusions or non-progress activate a circuit breaker.

Work is assigned to RoleSeats and only then to workers. Scheduling therefore survives a worker change: replacing an Agent with a human, one model with another, or a solo worker with a pair does not change the goal or erase context.

### 7.2 Structured ideation council

1. Three to five roles independently propose solutions without seeing one another's answers.
2. A research role classifies claims as verified, inferred, unverified, or contradictory.
3. Participants cross-critique failure modes; a Red Team develops adversarial cases.
4. A synthesizer scores proposals against an explicit objective function.
5. When evidence cannot decide, the council designs the smallest discriminating experiment.
6. The authorized owner decides and records alternatives, dissent, evidence, and review date.

Initial weighting is user value 30%, revenue potential 20%, strategic alignment 20%, implementation cost 15% inverse, and risk 15% inverse. Only the human board may change weights.

## 8. Risk and approval matrix

| Level | Typical action | Default authority | Required control |
|---|---|---|---|
| R0 | Read, analyze, internal draft | Agent | Log and data-scope check |
| R1 | Issue, branch, CI, test deployment, ordinary content | Agent | Policy check and evidence |
| R2 | Small reversible experiment or ordinary customer response | Agent within budget | Independent review, post-action notice |
| R3 | Production promotion, pricing proposal, material customer promise | Policy-specific | Two independent reviews; CTO/CEO if policy says so |
| R4 | Payment, contract, sensitive export, privilege elevation | Human CEO or CTO by domain | Exact scoped approval and external expertise where required |
| R5 | Equity, debt, litigation, severe incident, irreversible deletion | CEO and CTO | Dual approval, specialist involvement, incident record |

Agents can never independently transfer money, alter payment destinations, sign contracts, obtain complete secrets, permanently delete production data, bypass audit/security controls, raise their own permissions/budgets, or modify their governance rules.

## 9. Operating workflows

### 9.1 Product and engineering

```text
signals -> problem clusters -> opportunity ranking -> discovery council
-> product spec -> technical design -> GitHub issues -> build
-> independent review/security/QA -> progressive release
-> metric observation -> keep, revise or rollback
```

Product specifications define users, evidence, scope, non-goals, flows, acceptance criteria, instrumentation, success metrics, and rollback conditions. GitHub is authoritative for specs, issues, code, tests, reviews, and release artifacts. Releases progress through internal, 5%, 25%, and 100% cohorts and stop or roll back on predefined conditions.

### 9.2 Growth and revenue

```text
market/customer evidence -> ICP and positioning -> experiment
-> content/sales asset -> fact/brand/compliance review
-> channel execution -> CRM -> sales conversion
-> revenue attribution -> product feedback
```

Experiments bind audience, problem, channel, budget, conversion action, and success metric. Agents may publish low-risk verified content and conduct bounded outreach, but may not fabricate relationships, evade opt-outs, promise absent functionality, or change contractual terms.

### 9.3 Customer, finance, and legal support

- Customer agents answer only from approved knowledge, identify severe or high-value cases, and send evidence-backed problems to CPO.
- CFO attributes cloud, model, marketing, and vendor costs to projects; prepares cash forecasts, reconciliation, invoice, and tax packages using read-only financial access.
- CLO compares contracts, maintains obligations, and flags privacy/IP/jurisdiction risk; humans and qualified professionals make final legal decisions.

### 9.4 Operating cadence

- Daily: autonomous metric/exception scan and a one-page founder brief.
- Weekly: 60-minute board review of outcomes, customers, stopped work, autonomy levels, cash, security, and at most three next priorities.
- Monthly: classify projects as Scale, Continue, Revise, Stop, or Escalate and reallocate budgets.
- Quarterly: reassess strategy, objective weights, model/provider policy, and organizational capacity.

## 10. Identity, memory, models, and integrations

Every agent is a service identity with role, manager, allowed/denied tools, data scope, per-task/daily budgets, maximum runtime, and required reviewers. Credentials are short-lived and task-bound; child capabilities only attenuate.

Memory is separated into:

- relational authoritative facts;
- versioned document knowledge;
- append-only event history;
- decision records with dissent and review dates;
- disposable task memory promoted only through validation.

Model routing uses small models for extraction/classification, medium models for routine drafting and code, and strong reasoning models for architecture and synthesis. Legal, financial, security, and production decisions combine a strong model with deterministic rules and human/specialist review. Generation and verification should use different model instances or configurations where practical.

GitHub is the engineering source of truth. Feishu/DingTalk is the command, approval, exception, and report surface; decisions made in chat are copied to the Decision Registry. Cloud infrastructure hosts the gateway, event bus, workflow engine, policy service, PostgreSQL, object storage, retrieval, secrets, workers, monitoring, and audit services.

## 11. Human-machine interaction protocol

Human attention, comprehension, correction, and takeover are first-class system resources. The interface must not reduce the founders to approval operators or force them to inspect raw agent conversations.

### 11.1 Three interaction spaces

**Conversation space** is for expressing ambiguous intent, exploring opportunities, comparing strategies, explaining anomalies, and revising assumptions. It is non-effectful by default. Ordinary messages such as “continue,” “looks good,” or “handle it” do not authorize payment, production release, customer promises, permission changes, or other external effects.

**Work space** is the structured project room. It shows the objective, success metrics, constraints, DRI, state, next action, budget, risk, artifacts, evidence, decisions, and stop/takeover controls. It is the authority for operational progress; chat history is not.

**Decision space** contains time-bounded decision and approval cards. Only an explicit control, signed command, or valid approval endpoint can authorize an approval-gated action.

### 11.2 Intent compilation

Human intent passes through a visible compilation process:

```text
natural-language intent
  -> system restatement
  -> ambiguity and assumption detection
  -> one consequential clarification at a time
  -> proposed Objective Contract
  -> explicit confirmation
  -> authorized WorkItem creation
```

The Objective Contract states the problem, target user, desired outcome, metric, deadline, budget, allowed actions, prohibited actions, and actions that require renewed confirmation. The system asks only questions whose answers materially change scope, risk, cost, or success. Each question explains why the answer matters.

For an ambiguous request such as “find out why acquisition is weak,” the system may propose a bounded read-only investigation, show expected time and cost, and state that it will not change pricing, publish content, edit the website, or contact customers. Execution begins only after the user starts that investigation or has previously delegated an exactly matching workflow.

The same compiler handles mid-execution goal changes. A prompt such as “stop optimizing speed; make reliability the priority” is interpreted as a proposed ObjectiveRevision rather than injected into a worker's private prompt. The UI shows the structured before/after diff, affected tasks, invalidated artifacts, new cost/deadline, and whether running effects must stop. The human can confirm, edit, scope, or cancel the revision.

### 11.3 Collaboration modes

Every interaction and project declares one of four modes:

| Mode | Human role | Agent authority | Exit condition |
|---|---|---|---|
| Exploration | Frames meaning and evaluates alternatives | Research and draft only | Objective Contract confirmed or exploration closed |
| Delegation | Sets outcome and boundaries | Plans and executes within delegated policy | Outcome verified, boundary change, or exception |
| Pairing | Co-edits and makes frequent judgments | Suggests, previews, and applies confirmed changes | Artifact accepted or work delegated |
| Takeover | Directly controls the work | Paused; preserves context and assists read-only | Human explicitly returns control |

Mode changes are explicit events. Entering takeover immediately revokes the affected agent's write capabilities. Returning to delegation requires a scope and state summary so the human knows what will resume.

### 11.4 Interaction state machine

```text
captured -> interpreting -> clarifying -> proposed -> confirmed
-> executing -> checkpoint -> verifying -> reported
-> accepted | corrected | taken_over
```

Invariants:

- No external effect is allowed while `clarifying` or `proposed`.
- `proposed` is not authorization; silence is never approval.
- A material change in objective, audience, budget, data scope, risk, or public promise returns the interaction to `proposed`.
- A human can pause, narrow, correct, or take over at any time.
- `reported` is not completion without evidence or explicit human acceptance where the outcome is subjective.
- Correction appends a new record and never overwrites the original instruction or result.

### 11.5 Universal worker control contract

Every AI worker exposes the same controls regardless of department or model:

- **Inspect:** current role, objective revision, plan, active step, capabilities, budget, sources, produced artifacts, and blockers.
- **Message:** provide non-authoritative context or ask a question without silently changing the goal.
- **Redirect:** propose a natural-language ObjectiveRevision, preview its structured effect, then confirm it.
- **Constrain:** immediately reduce budget, tools, data scope, external communication, deadline, or permitted effects. Constraint reduction can take effect without waiting for the Agent.
- **Pause:** stop before the next effect boundary and revoke unused capabilities.
- **Stop:** terminate the assignment, run required compensation, and preserve a checkpoint.
- **Take over:** replace the Agent with an authorized human in the same RoleSeat.
- **Replace:** assign a different Agent or human while preserving the WorkItem and history.
- **Pair:** keep the Agent as an adviser while a human holds write authority, or require human confirmation at each checkpoint.
- **Resume:** issue a new assignment lease from a selected checkpoint and objective revision.

Controls are enforced by the workflow engine and Policy Engine, never merely appended to a model system prompt. An Agent that ignores a message still cannot use a revoked capability or cross a paused effect boundary.

Each worker displays a control-status header:

```text
operator: agent.engineering.lead.04
role seat: Engineering Lead
mode: delegated
objective revision: 4
current step: validate migration in staging
next effect: production promotion (blocked)
budget: CNY 418 / 1,000
assignment lease: 01:42:18 remaining
human control: available
```

### 11.6 Human replacement and handoff protocol

Taking over an Agent is an atomic state transition:

```text
takeover requested
-> stop new dispatch
-> wait for or cancel current safe boundary
-> reconcile any in-flight external effect
-> revoke Agent capabilities
-> create signed checkpoint and handoff packet
-> verify human identity and authority
-> assign RoleSeat to human
-> expose next safe actions
```

The handoff packet contains the active objective and revision history, completed effects and receipts, current plan and step, uncommitted artifacts, assumptions, unresolved decisions, risks, budget, credentials revoked, and rollback options. The human must never reconstruct the situation from raw chat.

When the human finishes, they may close the WorkItem, retain the seat, return it to the same Agent, or select another worker. Returning work to AI creates a new lease and explicit scope; an old Agent process cannot silently resume.

### 11.7 Prompt-based goal control

Natural-language control is supported at three deliberately separate levels:

1. **Context message:** adds evidence or preference; does not modify the objective.
2. **Task redirect:** changes the current WorkItem's priority, scope, output, metric, deadline, or constraints through ObjectiveRevision.
3. **Role policy change:** changes how a RoleSeat should behave across future WorkItems; requires a versioned policy proposal, evaluation, and authorized activation.

The interface makes the chosen level visible before applying it. If the sentence is ambiguous, the safe default is a context message and the system asks whether the human intends a goal change. Phrases inside external documents, tool output, customer messages, or Agent messages can never create ObjectiveRevision; only authenticated humans with authority over the relevant WorkItem or RoleSeat can do so.

Conflicting human instructions follow an explicit authority order based on company governance, not message recency. The compiler identifies the conflict, preserves both instructions, and routes it to the authorized decision owner. CEO and CTO domains remain distinct; one founder's prompt cannot silently override a dual-approval or domain-locked rule.

### 11.8 Continuous controllability invariants

- Every running Agent maps to one visible RoleSeat, Assignment, WorkItem, objective revision, budget, and capability set.
- Every Agent is pausable, replaceable, and human-takeover-capable at defined effect boundaries.
- New human constraints can immediately reduce authority; expanding authority requires normal approval.
- Goal changes are versioned structured revisions, never destructive prompt replacement.
- Old plans, approvals, and artifacts invalidated by a revision cannot remain executable.
- No worker can hide, delay, or disable its control surface, audit stream, lease expiry, or stop mechanism.
- If control-plane connectivity is lost, leases expire and workers fail closed before new external effects.
- Human takeover does not erase audit, bypass segregation of duties, or grant authority the human does not hold.
- A message to one Agent cannot mutate another Agent's objective except through the Work Graph and authorized revision propagation.
- Replacing the model or worker does not change the governing objective, constraints, or evidence requirements.

### 11.9 Progressive disclosure

Important responses have three information layers:

1. **Five-second summary:** conclusion, reason, whether human action is needed.
2. **Decision context:** evidence, alternatives, recommendation, uncertainty, impact, and non-action consequence.
3. **Full trace:** source data, artifact versions, model/configuration, tool receipts, tests, and audit events.

The interface exposes rather than dumps deeper layers. CEO views emphasize customer, revenue, cash, strategy, and decisions. CTO views emphasize production, architecture, security, model behavior, cost, and recovery.

The interface displays evidence strength independently from model confidence. “High confidence, weak evidence” must be visually distinguishable from “high confidence, strong evidence.” Historical accuracy for the workflow is shown where available.

### 11.10 Decision-card contract

A decision card includes:

- the exact decision and why it is needed now;
- current state, evidence, sample size, and observation window;
- known unknowns and dissent;
- two or three materially distinct choices;
- the system recommendation and calibrated confidence;
- cost, risk, reversibility, and consequences of each choice;
- the safe default if no response is received;
- expiry time and exact scope of the resulting authority;
- `approve`, alternative-choice, `reject`, `ask`, `open evidence`, and `take over` controls as applicable.

Approval is bound to action, target, version, scope, and expiry. A stale card cannot execute. A card must not use deceptive urgency, preselected consent, ambiguous destructive controls, or color alone to convey risk.

### 11.11 Attention and interruption budget

Notifications are classified independently from action risk:

| Priority | Delivery | Examples |
|---|---|---|
| P0 | Immediate interruption and repeated escalation | Active breach, severe production incident, imminent material funds risk |
| P1 | Decision inbox plus deadline alert | High-risk release, material customer or legal decision |
| P2 | Batched at two scheduled windows per day | Ordinary exceptions and budget reallocations |
| P3 | Daily brief | Progress, learning, completed reversible actions |
| P4 | Project room only | Routine agent activity and diagnostics |

One Incident Commander owns each root cause. The system deduplicates correlated alerts, prevents multiple agents from notifying the same human, respects focus hours for P2-P4, and measures founder interruptions, response time, and time spent. Reducing unnecessary human attention is an operating metric, not merely a UI preference.

### 11.12 Correction and learning scope

When a human corrects the system, the interface asks for the smallest necessary applicability:

```text
this occurrence only
this WorkItem
this workflow
company-wide rule
```

A correction records the original behavior, corrected behavior, reason, applicability, re-execution requirement, owner, expiry, and review date. One conversational remark cannot silently become a company-wide policy. Workflow and company rules require explicit confirmation and regression evaluation before activation.

### 11.13 Control and recoverability

Every effectful screen exposes its current mode and automation state. Pause, cancel, undo/rollback when feasible, and takeover are always reachable without navigating through agent-generated content. Before destructive or irreversible action, the interface shows the exact object, scope, consequence, recovery possibility, and required approvers.

On takeover, the system follows the RoleSeat handoff protocol above. It preserves the execution trail and does not attempt to continue in the background.

### 11.14 Required interaction surfaces

The first release requires five coherent surfaces, to be specified visually after this logical protocol is accepted:

1. CEO cockpit for objectives, customer/revenue/cash health, risks, and at most three priority decisions.
2. CTO control center for releases, incidents, security, model/provider health, cost, and permission requests.
3. Decision inbox ordered by business impact, urgency, and expiry rather than arrival time.
4. Project room containing objective, state, swarm, artifacts, evidence, budget, timeline, and control actions.
5. Daily brief showing what changed, what was learned, what the system handled, what is next, and what requires attention.
6. Role and worker control panel showing the RoleSeat, current occupant, objective diff, live step, capability/budget state, and inspect, redirect, constrain, pause, stop, take over, replace, pair, and resume actions.

GitHub remains authoritative for engineering artifacts. The human interface shows summaries and deep links rather than creating a competing copy of code, tests, or PR state.

### 11.15 Human-machine interaction metrics

Measure decision completion time, clarification rounds, false or unnecessary escalations, ignored-notification rate, founder minutes per completed outcome, takeover rate, correction rate, correction recurrence, approval reversals, evidence-open rate, and comprehension errors found in usability tests. Optimization must not suppress legitimate risk alerts merely to improve interruption metrics.

## 12. Failure handling and observability

Workflows are durable, idempotent, pausable, and compensatable. Model timeout uses bounded retry and compatible fallback. Invalid structured output is rejected. Effects such as payment or deployment are never blindly retried. Permission refusal enters approval rather than self-escalation. Loop, cost, and time limits stop non-progress. Partial effects invoke reconciliation or an explicit recovery runbook.

Emergency controls stop a single task, identity, domain, or all execution. Global stop revokes short-lived credentials and enters read-only mode.

The operating dashboard reports goals, active projects/agents, pending decisions, costs, incidents, evidence completeness, success rate, first-pass rate, human rework, time-to-outcome, cost-per-outcome, factual-error rate, escalation rate, rollback rate, and customer/business impact.

## 13. Initial agent manifests

The first four agents are sufficient for the control-plane milestone.

```yaml
agents:
  - id: cabinet.chief_of_staff
    owns: [goal_translation, decision_log, daily_brief]
    tools: [registry.read, work.propose, decision.write, report.write]
    forbidden: [policy.write, approval.grant, external.effect]

  - id: cabinet.coo
    owns: [work_graph, dependency_resolution, resource_allocation]
    tools: [goal.read, work.create, work.assign, work.pause, budget.reserve]
    forbidden: [goal.change, policy.write, approval.grant]

  - id: cabinet.cpo
    owns: [problem_portfolio, opportunity_ranking, product_spec]
    tools: [analytics.read, support.read, research.run, spec.propose]
    forbidden: [product.promise, production.release, price.change]

  - id: assurance.auditor
    owns: [completion_audit, governance_audit]
    tools: [ledger.read, evidence.read, report.append]
    forbidden: [business_artifact.write, evidence.delete, approval.grant]
```

Engineering and growth agents are added only after the control plane passes its gates.

## 14. Ninety-day rollout

| Days | Deliverable | Maximum autonomy |
|---|---|---|
| 1-14 | Goal/work/decision/approval/evidence, RoleSeat/Assignment, and ObjectiveRevision models; GitHub and Feishu/DingTalk; identity, audit, stop/takeover controls; first four agents | R0-R1 |
| 15-28 | Product spec to reviewed PR and test-environment deployment | R1 |
| 29-42 | Feature flags, progressive release, rollback, product-feedback loop | R2 for proven reversible workflows |
| 43-56 | ICP, content, CRM, sales follow-up, and attributable growth experiments | R2 |
| 57-70 | Cost/cash reporting, contract support, customer success, vendor/people operations | R2; financial access read-only |
| 71-84 | Company dashboard, weekly/monthly portfolio loop, independent Red Team, per-workflow autonomy promotion | Selective R3 |
| 85-90 | Failure and attack exercises, permission cleanup, recovery runbooks, production readiness review | Based on evidence |

Autonomy levels are L0 suggestion, L1 low-risk execution, L2 reversible autonomy, L3 supervised end-to-end autonomy, and L4 exception-only supervision. Promotion is per workflow after at least 20 successful runs, complete evidence, acceptable rework/cost, no unresolved severe incident, and passed adversarial tests. Severe incidents cause automatic demotion.

## 15. First-week execution checklist

### Day 1: board contract

- Define one 90-day objective, at most three key results, constraints, total experiment budget, and hard prohibitions.
- Record CEO and CTO decision domains and both global-stop identities.

### Day 2: repositories and schemas

- Select the operating-system repository and create versioned schemas for CompanyEvent, WorkItem, Decision, Approval, Evidence, RoleSeat, Assignment, and ObjectiveRevision.
- Add owner, risk, budget, evidence, and rollback templates to GitHub.

### Day 3: identity and policy

- Create the first four service identities.
- Implement deny-by-default capability manifests and short-lived credentials.
- Encode R0-R5 rules and prohibited actions in deterministic policy.
- Implement assignment leases, capability revocation, safe checkpoints, and atomic human takeover.

### Day 4: command surface

- Connect signed Feishu/DingTalk commands and approval cards.
- Implement `/goal`, `/project`, `/status`, `/decision`, `/approve`, `/reject`, `/stop`, and `/brief`.
- Implement conversation, work, and decision-space boundaries so ordinary chat cannot authorize effects.
- Implement Objective Contract preview and explicit confirmation before WorkItem authorization.
- Implement natural-language redirect as a previewed ObjectiveRevision rather than direct prompt mutation.

### Day 5: durable orchestration

- Persist task state transitions and idempotency keys.
- Add bounded retries, time/cost/child limits, pause/resume, and compensation hooks.

### Day 6: audit and exercises

- Verify that an external prompt cannot grant authority.
- Attempt self-approval, budget expansion, duplicate execution, secret access, and audit deletion; all must fail.
- Exercise single-task and global-stop recovery.

### Day 7: first operating review

- Run one real, low-risk WorkItem end to end.
- Inspect evidence, clarification rounds, founder interruptions, takeover usability, cost, rework, and failure modes.
- Fix control-plane weaknesses before creating engineering or growth swarms.

## 16. Verification plan

Verification has four layers:

1. Unit: schemas, policy decisions, transitions, budgets, idempotency, and capability attenuation.
2. Workflow: product release, marketing experiment, customer complaint, refund proposal, contract review, and incident recovery.
3. Interaction: ambiguous intent, ordinary-chat non-authorization, safe silence, objective-revision diff comprehension, correction scope, pause/takeover/replace, human-to-agent return, progressive disclosure, keyboard access, and notification deduplication.
4. Adversarial: prompt injection, forged approval, stale decision card, privilege escalation, secret exfiltration, self-review, audit deletion, dark-pattern consent, and runaway child creation.
5. Business: time-to-release, founder minutes per outcome, human rework, cost-per-outcome, product activation, qualified leads, paid conversion, retention, and gross margin.

The initial release gate requires traceable evidence for every state change, effective emergency stop and takeover, no self-approval path, no external effect from unconfirmed conversation, safe duplicate-event handling, safe non-response defaults, inability to exceed delegated permission/budget, and one real low-risk workflow completed end to end.

## 17. Deferred decisions

These choices are intentionally deferred to the implementation plan because they depend on the repository's existing runtime and deployment constraints:

- Exact workflow-engine and event-bus products.
- Feishu versus DingTalk as the first adapter; both use the same command contract.
- CRM and analytics vendors.
- Model providers and routing thresholds.
- Exact database table and API layouts derived from the schemas above.
- Visual language and final responsive layouts, which will be decided through clickable prototypes while preserving this interaction protocol.

Deferral does not change responsibility, security, state, or approval semantics defined by this design.

## 18. Acceptance criteria

This design is implemented only when:

- A company objective produces traceable WorkItems across product and growth.
- Every effect has an authenticated actor, policy decision, budget, result, and evidence.
- Product work can progress from evidence to measured progressive release.
- Growth work can progress from evidence to attributable lead/revenue learning.
- Customer, finance, and legal-support signals feed the operating loop without giving agents regulated or irreversible authority.
- CEO and CTO receive decisions and exceptions rather than routine status traffic.
- Humans can distinguish conversation, work, and authorization states without interpreting model prose.
- Ambiguous intent is restated and compiled into a visible Objective Contract before execution.
- Silence, casual agreement, and stale decision cards never authorize an effect.
- Every important decision exposes evidence, uncertainty, alternatives, non-action behavior, and exact authority scope.
- Humans can pause, correct, constrain, or take over work without losing execution history.
- Every RoleSeat can be occupied by an Agent, an authorized human, or a controlled human-agent pair without changing the governing WorkItem.
- Authenticated humans can redirect an Agent through natural language, but the system previews and versions the structured goal change before it takes effect.
- Replacing or taking over an Agent atomically revokes the old assignment, preserves a complete checkpoint, and prevents background continuation.
- Agent control is enforced through workflow state, capability revocation, assignment leases, and policy rather than reliance on prompt obedience.
- Corrections have explicit applicability and cannot silently become company policy.
- Notifications are deduplicated, prioritized, measurable, and bounded by an attention budget.
- No agent can approve itself, expand its own authority, alter governance, or cross the seven hard prohibitions.
- Workflows recover from interruption and duplicate delivery without duplicated external effects.
- Autonomy increases only from measured workflow performance and decreases after severe failure.
- The board can stop and safely resume the system.
