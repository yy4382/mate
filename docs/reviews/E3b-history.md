# E3b — bounded history and installation snapshots

Independent read-only reviewer `/root/review_e3b_history`. Initial disposition BLOCKED; final disposition PASS after every P1/P2 finding was repaired and independently reproduced against the updated build.

Implemented platform-neutral `ConversationHistory` with local page/search/around and optional bounded `HistorySource`; Slack supplies the acting installation adapter. Cursors bind actor, operation, target, filters, limits, range and order. Results state live local or remote scope, continuation, exhaustion and gaps. Remote acquisition is quiet: it persists evidence and actor freshness but does not create observations, deliveries, seen state, resolution or a whole-target view token.

The reviewer found and rechecked these blockers:

- P1: target and thread queries performed full scans and temporary sorts. v21 now adds expression indexes; production query plans are asserted to avoid `SCAN m` and `USE TEMP B-TREE`.
- P1: no-target search still sorted all authorized candidates. It now walks the `channel_access` primary key, executes a bounded index range per conversation and stops after a total raw budget of 1001. Cross-conversation cursor tests cover empty and nonempty segments.
- P1: one invalid remote item rolled back the page. Each item now imports under a nested transaction; valid siblings commit and the bad item becomes a gap.
- P1: provider exhaustion was coupled to local import gaps. Exhaustion now describes only provider continuation, while mapping/import failures remain explicit gaps; `exhausted + cursor` is rejected.
- P1: quiet acquisition created observations/unseen attention. History mode now leaves observation, delivery and seen/resolved state untouched; a later real event still produces its normal observation and delivery.
- P1: Slack history wrappers for edits/deletes could become blank messages. Hidden and wrapper events are rejected as gaps; ordinary visible message subtypes retain their content.
- P1: a global newer revision prevented another installation from importing an older revision it actually received. Actor visibility now advances independently without rolling global current backward.
- P1: revision alone did not isolate same-revision provider representations. v21 visibility stores `(agent,key,revision,body)`; `message_revisions` evidence is immutable, so a file expansion, delete or newer body seen by one installation cannot change another Agent's read/search/recent result or freshness token.
- P2: legacy `messages.search` materialized all visible keys and `recent` could lose older live rows behind tombstones. v21 filters actor snapshots in indexed SQL and only materializes at most 100 results.

Validation: `pnpm test` rebuilt the project and passed 41 files, 289 ordinary tests, with 7 environment-dependent tests skipped. TypeScript build, `git diff --check`, targeted query-plan checks and the reviewer's two leakage reproducers passed. Slack behavior was checked with synthetic authenticated protocol fixtures; no real Slack/provider call or deployment was performed.

One accepted P3 migration limit remains. v20 never stored actor-specific bodies, so v20→v21 backfills the body for the actor's highest observed revision when present, otherwise the current body, and writes an audit record describing that policy. Same-revision attachment variants that were never persisted cannot be reconstructed from old data. This is explicit evidence loss in the old schema and does not affect fresh v21 operation.
