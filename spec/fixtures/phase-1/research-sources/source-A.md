# Source A: Router System Design

Agent Harness v9 uses a dependency-aware Router DAG, replacing v8's 8 parallel routers that used Promise.all.
The Router DAG pipeline has 13 stages: Identity → Policy → Profiling → Probe → Candidates → Binding → AgentGraph → ContextGraph → VerificationGraph → Solver → Validation → Freeze → Runtime.
The Router outputs derived_risk_assessment, NOT risk_policy. Policy is an external immutable constraint.

Key claim: Parallel routers (Promise.all) are deprecated because they lack dependency semantics.
