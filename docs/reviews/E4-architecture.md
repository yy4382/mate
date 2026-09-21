# E4 — collaboration recovery, owner activity and tool composition design

Independent read-only reviewer `/root/review_e4_architecture`. First disposition BLOCKED; second disposition design PASS after architecture repair. No E4 code was accepted by this review.

Initial P1 findings were product-semantic: task events omitted dependency wake, work cancellation and draft publication transitions; a review task could not be handed to a peer while remaining in review; channel ACL alone could expose task title/result across the actor-specific external message boundary; every reminder firing forced a channel receipt; the proposed activity journal mixed non-authoritative projection language with transaction-blocking writes; and ToolModule metadata did not fully describe current receipt/work/review-seat contracts.

Accepted design repairs:

- E4a first centralizes every task status/owner/assignment/wait/message-binding/version transition with its event in one transaction. Old tasks get an explicit baseline snapshot and incomplete historical coverage rather than invented events.
- Ordinary peer review can preserve review through claim/unclaim/transfer or explicitly return work for changes. Blind review remains the separate review-seat path and cannot access TaskBoard.
- External anchored tasks require the actor's exact message snapshot as well as conversation ACL. Draft and legacy visibility have fail-closed, evidence-based rules.
- Reminders default to a private author wake. A conversation receipt is explicit. Scheduler firing, delivery/run state, optional receipt and the Agent's author-private result are separate; `deferred` does not itself schedule another wake.
- OperationsView reads authoritative domain sources and exposes per-source coverage. Only internal-DM/runtime facts lacking a safe source use a narrow idempotent fact table. Owner authentication happens in the service, and sensitive bodies/requests/results/paths are excluded.
- ToolModule is a fail-closed discriminated operation specification consumed by the central executor, with explicit work, seat, effect, replay, authorization and post-await fencing policies. It is built-in composition, not a dynamic plugin framework.

The reviewer required low-resource query plans, stable query-bound cursors, TaskBoard-based recovery summaries, two independent reminder cursors, old action receipt compatibility and fault-injection rollback checks. Three final P2 documentation details were resolved before implementation: evidence-only `createdBy` backfill with unknown fail-closed; firingId in reminder delivery and explicit non-scheduling deferred result; and removal of the earlier boolean-style ToolModule description.

Final design disposition: PASS with P0/P1 cleared. E4a, E4b and E4c still require their own implementation checks and independent red-team gates.
