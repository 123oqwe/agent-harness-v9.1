# Request-to-Outcome Pipeline


![02-request-to-outcome.svg](diagrams/02-request-to-outcome.svg)

## v9 Correction: Safety enters BEFORE routing

v8 had Policy Validator as step 7, after Router already decided. v9 puts immutable Policy Constraints before Task Profiling.

## Pipeline (v9 normative)

```
User Input
  -> Input Normalization
  -> Identity Resolution
  -> Immutable Policy Constraints        (safety enters HERE, before routing)
  -> Task Profiling
  -> Context/Capability Probe
  -> Workflow Candidate Generation
  -> Resource Binding
  -> Agent Graph Planning
  -> Context Graph Planning
  -> Verification Graph Planning
  -> Joint Constraint Solver
  -> Policy Validation
  -> RunPlan Freeze
  -> Runtime Execution
  -> Per-Action Authorization (PEP)     (PEP at EVERY action)
  -> Tool/Model Execution
  -> Verification
  -> Reconciliation
  -> Outcome Package
  -> Memory Write Proposal
  -> User-visible Completion
```

## Scheduled/Routine Task Pipeline

```
Trigger
  -> Re-evaluate current policy
  -> Rebuild current context
  -> Confirm credentials (must be fresh)
  -> Run
```

Cannot reuse days-old Capability for scheduled tasks.


## Memory Write Proposal PII Check (AR-008 fix)
Memory write proposal in the pipeline MUST check data classification before sending to cloud model. If memory contains sensitive data (financial, health, location, PII), the proposal must be processed locally only. Cloud model only receives desensitized metadata.


## Implementation Notes

### Pipeline (v9: safety enters BEFORE routing)

```
User Input
  → Input Normalization
  → Identity Resolution
  → Immutable Policy Constraints        ← safety enters HERE
  → Task Profiling (1 LLM max)
  → Context/Capability Probe
  → Workflow Candidate Generation
  → Resource Binding
  → Agent Graph Planning
  → Context Graph Planning
  → Verification Graph Planning
  → Joint Constraint Solver
  → Policy Validation
  → RunPlan Freeze
  → Runtime Execution
  → Per-Action Authorization (PEP)     ← PEP at EVERY action
  → Tool/Model Execution
  → Verification
  → Reconciliation
  → Outcome Package
  → Memory Write Proposal
  → User-visible Completion
```

### Scheduled Task Pipeline
```
Trigger
  → Re-evaluate current policy
  → Rebuild current context
  → Confirm credentials (must be fresh, not days-old)
  → Run
```
