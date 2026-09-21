# E4b — owner operations view

Independent read-only reviewer `/root/review_e4b`. Initial disposition BLOCKED; final disposition PASS after every correctness and engineering blocker was repaired and independently reproduced. The same reviewer also passed the final API-only change that exports the status/page DTO types.

This gate adds a platform-neutral, owner-authorized `OperationsView`. `status` reads authoritative state and returns bounded safe DTOs. `activity` merges existing domain events with narrow operational facts for runtime completion and internal-DM creation, using a query-bound per-source vector cursor and explicit historical coverage. Local control and Slack control use the same service. Reads do not wake Agents, write deliveries, or create activity.

The reviewer found and rechecked these blockers:

- High: reminder coverage was inferred from the mutable current `legacy` flag, so editing an imported reminder could falsely make its old history complete. Migration and new writes now persist an immutable event baseline, and a pre-v23 legacy-then-edited fixture remains incomplete.
- High: actor/kind/before activity filters and coverage probes lacked matching indexes for a low-resource VPS. The schema now includes the required source/time/actor/kind/coverage indexes; production-shaped query-plan tests reject temporary sorting and verify indexed sparse pagination across 125 rows without loss or duplication.
- High: Slack truncated an oversized serialized reply by slicing its JSON text, producing invalid JSON. It now emits a small valid `mate.control-overflow.v1` envelope with safe counts and a narrowing hint.
- High: operational facts accepted combinations that the read model did not faithfully project. The TypeScript input is a discriminated union, SQLite enforces source/kind/subject/count contracts, and activity uses the stored subject and target references.
- High: some active-to-terminal run paths bypassed lifecycle facts, including work control and budget exhaustion. All such transitions now pass through `Store.transitionRun`; fact insertion shares the transaction, and an injected fact failure rolls the run transition back.

The reviewer additionally verified idempotent fact replay and conflicting replay rejection, internal-DM transaction rollback, SQLite collation-compatible cursors, safe-field exclusion, owner checks inside the service, and zero side effects from status/activity reads. The E4b target suite passed 10/10. The full suite passed 45 files and 309 ordinary tests, with 7 environment-dependent tests skipped. TypeScript and `git diff --check` passed. No real Slack/provider call or deployment was performed.

One nonblocking item is deliberately deferred: each status collection is capped at 100 and reports `truncated`/`atLeast`, but has no continuation. At the intended single-user scale this keeps the first deploy bounded and truthful. Before status becomes a large-team or web-console inventory, add filter or pagination so UUID ordering cannot hide an actionable nonterminal work item beyond the cap.

Final disposition: PASS with no remaining P0/P1 finding. E4c may begin.
