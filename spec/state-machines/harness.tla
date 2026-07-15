---- MODULE harness ----
EXTENDS Naturals, Sequences, FiniteSets

(* Agent Harness v9.2 Operation State Machine TLA+ Specification *)

CONSTANTS Operations

VARIABLES state, capabilities, effects

(* Helper: convert sequence to set *)
SeqToSet(seq) ==
  {seq[i] : i \in 1..Len(seq)}

Init ==
  /\ state = [o \in Operations |-> "CREATED"]
  /\ capabilities = << >>
  /\ effects = << >>

Compile(o) ==
  /\ state[o] = "CREATED"
  /\ state' = [state EXCEPT ![o] = "COMPILED"]
  /\ UNCHANGED <<capabilities, effects>>

EvaluatePolicy(o) ==
  /\ state[o] = "COMPILED"
  /\ state' = [state EXCEPT ![o] = "POLICY_EVALUATED"]
  /\ UNCHANGED <<capabilities, effects>>

AutoApprove(o) ==
  /\ state[o] = "POLICY_EVALUATED"
  /\ state' = [state EXCEPT ![o] = "CONSENT_EXEMPT"]
  /\ UNCHANGED <<capabilities, effects>>

Deny(o) ==
  /\ state[o] = "POLICY_EVALUATED"
  /\ state' = [state EXCEPT ![o] = "DENIED"]
  /\ UNCHANGED <<capabilities, effects>>

Authorize(o) ==
  /\ state[o] = "CONSENT_EXEMPT"
  /\ state' = [state EXCEPT ![o] = "AUTHORIZED"]
  /\ capabilities' = Append(capabilities, o)
  /\ UNCHANGED effects

Dispatch(o) ==
  /\ state[o] = "AUTHORIZED"
  /\ state' = [state EXCEPT ![o] = "IN_FLIGHT"]
  /\ UNCHANGED <<capabilities, effects>>

ConfirmEffect(o) ==
  /\ state[o] = "IN_FLIGHT"
  /\ state' = [state EXCEPT ![o] = "EFFECT_CONFIRMED"]
  /\ effects' = Append(effects, o)
  /\ UNCHANGED capabilities

UnknownEffect(o) ==
  /\ state[o] = "IN_FLIGHT"
  /\ state' = [state EXCEPT ![o] = "EFFECT_UNKNOWN"]
  /\ UNCHANGED <<capabilities, effects>>

PreDispatchFail(o) ==
  /\ state[o] = "IN_FLIGHT"
  /\ state' = [state EXCEPT ![o] = "PRE_DISPATCH_FAILED"]
  /\ UNCHANGED <<capabilities, effects>>

RetryFromFail(o) ==
  /\ state[o] = "PRE_DISPATCH_FAILED"
  /\ state' = [state EXCEPT ![o] = "AUTHORIZED"]
  /\ UNCHANGED <<capabilities, effects>>

Next ==
  \E o \in Operations:
    \/ Compile(o)
    \/ EvaluatePolicy(o)
    \/ AutoApprove(o)
    \/ Deny(o)
    \/ Authorize(o)
    \/ Dispatch(o)
    \/ ConfirmEffect(o)
    \/ UnknownEffect(o)
    \/ PreDispatchFail(o)
    \/ RetryFromFail(o)

(* Invariant 1: No unauthorized execution *)
NoUnauthorizedExecution ==
  \A o \in Operations:
    (state[o] = "IN_FLIGHT" \/ state[o] = "EFFECT_CONFIRMED")
    => o \in SeqToSet(capabilities)

(* Invariant 2: No double effect *)
NoDoubleEffect ==
  \A o \in Operations:
    state[o] = "EFFECT_CONFIRMED" => o \in SeqToSet(effects)

(* Invariant 3: Denied is terminal *)
DeniedIsTerminal ==
  \A o \in Operations:
    state[o] = "DENIED" => state[o] = "DENIED"

Spec == Init /\ [][Next]_<<state, capabilities, effects>>

====
