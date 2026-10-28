------------------------- MODULE BackgroundCommand -------------------------
EXTENDS Naturals

VARIABLES checkpoint, continuation, dispatches

vars == <<checkpoint, continuation, dispatches>>

Init ==
    /\ checkpoint = "start"
    /\ continuation = "checkpoint"
    /\ dispatches = 0

SaveInterrupted ==
    /\ continuation = "checkpoint"
    /\ checkpoint' = "interrupted"
    /\ continuation' = "dispatch"
    /\ UNCHANGED dispatches

Dispatch ==
    /\ continuation = "dispatch"
    /\ dispatches < 2
    /\ dispatches' = dispatches + 1
    /\ continuation' = "waiting"
    /\ UNCHANGED checkpoint

ReceiveResult ==
    /\ continuation = "waiting"
    /\ continuation' = "report"
    /\ UNCHANGED <<checkpoint, dispatches>>

CommitReport ==
    /\ continuation = "report"
    /\ checkpoint' = "completed"
    /\ continuation' = "done"
    /\ UNCHANGED dispatches

Crash ==
    /\ continuation # "down"
    /\ continuation' = "down"
    /\ UNCHANGED <<checkpoint, dispatches>>

Reopen ==
    /\ continuation = "down"
    /\ continuation' = CASE checkpoint = "start" -> "checkpoint"
                         [] checkpoint = "interrupted" -> "report"
                         [] OTHER -> "done"
    /\ UNCHANGED <<checkpoint, dispatches>>

Done ==
    /\ continuation = "done"
    /\ UNCHANGED vars

Next == SaveInterrupted \/ Dispatch \/ ReceiveResult \/ CommitReport
        \/ Crash \/ Reopen \/ Done

AtMostOneDispatch == dispatches <= 1

=============================================================================
