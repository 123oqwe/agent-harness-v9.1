# Routing System (v9: Dependency-Aware DAG)


![03-routing-8-routers.svg](diagrams/03-routing-8-routers.svg)

## v9 Correction: NOT 8 parallel independent routers

v8 used Promise.all for 8 independent routers. v9 replaces with sequential dependency-aware DAG.

## Router DAG Pipeline

```
Identity and immutable policy
  -> Task profiling (1 LLM max)
  -> Experience/domain resolution
  -> Context and capability probe
  -> Workflow candidates
  -> Reasoning candidates
  -> Model/tool/skill/environment binding
  -> AgentGraph
  -> ContextGraph
  -> Schedule/trigger planning
  -> VerificationGraph
  -> Joint constraint solver
  -> Policy validation
  -> frozen RunPlan
```

## Three-Layer Implementation

1. Deterministic preflight (0 LLM) - file type, modality, permissions, tool existence, Provider health
2. 1 structured Task Profiler LLM call (cheap fast model)
3. Deterministic Candidate Optimizer (registry + scoring + constraint solver)

## Router Outputs (v9 correction)

Router outputs:
- derived_risk_assessment (NOT risk_policy)
- proposed route
- resource bindings

Router does NOT output:
- risk_policy
- consent_policy

Policy authority supplies immutable constraints.


## Three Orthogonal Dimensions Diagram
![Three Orthogonal Dimensions](diagrams/04-three-orthogonal-dimensions.svg)
