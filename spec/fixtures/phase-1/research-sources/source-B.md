# Source B: State Machine Architecture

The state machine was split from 37 monolithic states into 6 independent machines: Run, Step, Operation, Attempt, ExternalEffect, Approval.
Each machine is model-checked with TLA+ (TLC v2.19, 251 states, 0 errors).
The Operation state machine has 35 states distributed across the 6 machines.

Key claim: The monolithic 37-state machine could not be independently verified.
Note: Some sources claim 37 states, others 35. The correct count is 35 operational states + 2 terminal = 37 total across all machines.
