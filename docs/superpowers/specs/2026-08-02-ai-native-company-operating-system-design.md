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

## 11. Failure handling and observability

Workflows are durable, idempotent, pausable, and compensatable. Model timeout uses bounded retry and compatible fallback. Invalid structured output is rejected. Effects such as payment or deployment are never blindly retried. Permission refusal enters approval rather than self-escalation. Loop, cost, and time limits stop non-progress. Partial effects invoke reconciliation or an explicit recovery runbook.

Emergency controls stop a single task, identity, domain, or all execution. Global stop revokes short-lived credentials and enters read-only mode.

The operating dashboard reports goals, active projects/agents, pending decisions, costs, incidents, evidence completeness, success rate, first-pass rate, human rework, time-to-outcome, cost-per-outcome, factual-error rate, escalation rate, rollback rate, and customer/business impact.

## 12. Initial agent manifests

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

## 13. Ninety-day rollout

| Days | Deliverable | Maximum autonomy |
|---|---|---|
| 1-14 | Goal/work/decision/approval/evidence models; GitHub and Feishu/DingTalk; identity, audit, stop controls; first four agents | R0-R1 |
| 15-28 | Product spec to reviewed PR and test-environment deployment | R1 |
| 29-42 | Feature flags, progressive release, rollback, product-feedback loop | R2 for proven reversible workflows |
| 43-56 | ICP, content, CRM, sales follow-up, and attributable growth experiments | R2 |
| 57-70 | Cost/cash reporting, contract support, customer success, vendor/people operations | R2; financial access read-only |
| 71-84 | Company dashboard, weekly/monthly portfolio loop, independent Red Team, per-workflow autonomy promotion | Selective R3 |
| 85-90 | Failure and attack exercises, permission cleanup, recovery runbooks, production readiness review | Based on evidence |

Autonomy levels are L0 suggestion, L1 low-risk execution, L2 reversible autonomy, L3 supervised end-to-end autonomy, and L4 exception-only supervision. Promotion is per workflow after at least 20 successful runs, complete evidence, acceptable rework/cost, no unresolved severe incident, and passed adversarial tests. Severe incidents cause automatic demotion.

## 14. First-week execution checklist

### Day 1: board contract

- Define one 90-day objective, at most three key results, constraints, total experiment budget, and hard prohibitions.
- Record CEO and CTO decision domains and both global-stop identities.

### Day 2: repositories and schemas

- Select the operating-system repository and create versioned schemas for CompanyEvent, WorkItem, Decision, Approval, and Evidence.
- Add owner, risk, budget, evidence, and rollback templates to GitHub.

### Day 3: identity and policy

- Create the first four service identities.
- Implement deny-by-default capability manifests and short-lived credentials.
- Encode R0-R5 rules and prohibited actions in deterministic policy.

### Day 4: command surface

- Connect signed Feishu/DingTalk commands and approval cards.
- Implement `/goal`, `/project`, `/status`, `/decision`, `/approve`, `/reject`, `/stop`, and `/brief`.

### Day 5: durable orchestration

- Persist task state transitions and idempotency keys.
- Add bounded retries, time/cost/child limits, pause/resume, and compensation hooks.

### Day 6: audit and exercises

- Verify that an external prompt cannot grant authority.
- Attempt self-approval, budget expansion, duplicate execution, secret access, and audit deletion; all must fail.
- Exercise single-task and global-stop recovery.

### Day 7: first operating review

- Run one real, low-risk WorkItem end to end.
- Inspect evidence, founder interruptions, cost, rework, and failure modes.
- Fix control-plane weaknesses before creating engineering or growth swarms.

## 15. Verification plan

Verification has four layers:

1. Unit: schemas, policy decisions, transitions, budgets, idempotency, and capability attenuation.
2. Workflow: product release, marketing experiment, customer complaint, refund proposal, contract review, and incident recovery.
3. Adversarial: prompt injection, forged approval, privilege escalation, secret exfiltration, self-review, audit deletion, and runaway child creation.
4. Business: time-to-release, human rework, cost-per-outcome, product activation, qualified leads, paid conversion, retention, and gross margin.

The initial release gate requires traceable evidence for every state change, effective emergency stop, no self-approval path, safe duplicate-event handling, inability to exceed delegated permission/budget, and one real low-risk workflow completed end to end.

## 16. Deferred decisions

These choices are intentionally deferred to the implementation plan because they depend on the repository's existing runtime and deployment constraints:

- Exact workflow-engine and event-bus products.
- Feishu versus DingTalk as the first adapter; both use the same command contract.
- CRM and analytics vendors.
- Model providers and routing thresholds.
- Exact database table and API layouts derived from the schemas above.

Deferral does not change responsibility, security, state, or approval semantics defined by this design.

## 17. Acceptance criteria

This design is implemented only when:

- A company objective produces traceable WorkItems across product and growth.
- Every effect has an authenticated actor, policy decision, budget, result, and evidence.
- Product work can progress from evidence to measured progressive release.
- Growth work can progress from evidence to attributable lead/revenue learning.
- Customer, finance, and legal-support signals feed the operating loop without giving agents regulated or irreversible authority.
- CEO and CTO receive decisions and exceptions rather than routine status traffic.
- No agent can approve itself, expand its own authority, alter governance, or cross the seven hard prohibitions.
- Workflows recover from interruption and duplicate delivery without duplicated external effects.
- Autonomy increases only from measured workflow performance and decreases after severe failure.
- The board can stop and safely resume the system.
