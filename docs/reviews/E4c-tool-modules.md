# E4c — tool module composition

Independent read-only reviewer `/root/review_e4c`. Initial disposition BLOCKED; final disposition PASS after all acceptance and engineering blockers were repaired and independently reproduced.

This gate replaces the monolithic operation schema, policy lists and dispatch switch with four fixed built-in modules: conversation/history, coordination/reminders, session/status and capabilities. Every public operation carries one complete discriminated spec: schema, description, work policy, seat policy, effect policy, replay policy, argument authorizer, post-await fence and handler. `ToolRouter` now owns strict discovery aliases, registration validation, actor/run/work/action injection, replay, transaction boundaries and asynchronous reauthorization. Production composition is sealed; the model and runtime cannot install another module.

The reviewer found and rechecked these blockers:

- High: only `seatPolicy: deny` originally affected execution, so a statically supplied module could label a body-returning handler `redacted-read` and expose it to a review seat. Production Router no longer accepts injected modules. Registration enforces valid seat/effect/work combinations, all four policies pass through the central seat switch, held-send results are replaced with the current owned draft projection, and async operations recheck run, object authorization, work and seat after awaiting.
- Medium: retrying, continuing or discarding a held task intent used the unrelated currently selected work. The Router now resolves the own intent under current ACL and uses the actual task work when available, otherwise the intent-bound work. A regression selects an exhausted unrelated work and still applies the active intent against its own work.
- Medium: claiming an existing canonical message-task also fell back to the unrelated selected work. Resolution now uses the existing task message binding, then `message_work`, and only then the selected work. The exhausted-unrelated-work reproduction now succeeds and records an intent bound to the canonical task work.
- High: operation names were present in the system prompt hash, but changes to a spec schema, description or policies were invisible to `configVersion`. A stable contract fingerprint now covers operation name, description, JSON schema, work/seat/effect/replay policies and discovery schemas. It is embedded in operation documentation, so contract changes require the existing explicit session configuration migration.

The refactor preserves all 82 operation names and strict input schemas. Existing atomic action identity continues to store the invocation's selected work for old receipt compatibility, while task/reminder authorization and actual domain writes use their object-bound work. Immutable and refreshable replay, changed-argument conflict, executing/unknown refusal, direct versus `tools.call`, review-seat discovery, broker/adapter receipt ownership and post-await stop/ACL/work fences have dedicated coverage. The obsolete `ToolEnvironment` runtime path was removed so it cannot become a second registration boundary.

Independent validation passed `pnpm exec tsc --noEmit`, `git diff --check`, and the full suite: 45 files and 314 ordinary tests passed, with 7 environment-dependent tests skipped. No real provider, Slack or deployment action was performed.

Final disposition: PASS with no remaining critical/high or acceptance blocker. E4 is complete and E5 may begin.
