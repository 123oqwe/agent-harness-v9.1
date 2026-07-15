# Evolution (v9: Shadow Mode Only)

## Pipeline
Observe -> Candidate -> Offline Eval -> Sandbox Replay -> Shadow -> Canary -> Human Approval -> Limited Activation -> Continuous Monitoring

## CANNOT (v9 hard constraints)
- Modify Policy
- Expand Tool grant
- Raise Risk ceiling
- Obtain Secrets
- Enable external write
- Bypass Release Gate
- Auto-promote generated tools to trusted

## Four-Stage Cycle
Observe -> Extract -> Synthesize -> Optimize
Phase 1: Observe only. Phase 4: Full cycle.

## Cold Start Safety
N<10: pure rules. 10<=N<50: linear weight. N>=50: weight=0.3.
Failure: 2 consecutive -> weight -0.2, 3 consecutive -> quarantine.
Self-Model: confidence<0.5 -> weight=0.
