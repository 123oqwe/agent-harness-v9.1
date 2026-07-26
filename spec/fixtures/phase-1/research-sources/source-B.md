# Source B: State Machine Architecture

The state machine was split from 37 monolithic states into 6 independent machines: Run, Step, Operation, Attempt, ExternalEffect, Approval.
Each machine is model-checked with TLA+ (TLC v2.19, 251 states, 0 errors).
The Operation state machine has 35 states distributed across the 6 machines.

Key claim: The monolithic 37-state machine could not be independently verified.
Note: Some sources claim 37 states, others 35. The correct count is 35 operational states + 2 terminal = 37 total across all machines.

---
AUTHORITATIVE CORRECTION (v9.1): The "35 operational + 2 terminal = 37" explanation above is INCORRECT.
The operation.machine.json file contains 37 states total (including terminal states).
The v8 monolithic machine had 37 states; v9 preserves all 37 in operation.machine.json.
The other 6 machine files (run/step/mission/attempt/approval/external-effect) are SEPARATE state machines, not a split of the 37.
This fixture is retained as an adversarial test case for contradiction detection.
Implementation MUST follow operation.machine.json (priority 4), not this fixture (priority 8).
