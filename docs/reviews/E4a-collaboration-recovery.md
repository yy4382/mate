# E4a — collaboration recovery surface

Independent read-only reviewer `/root/review_e4a`. Initial disposition BLOCKED; final disposition PASS after every High finding was repaired and independently reproduced against the updated code.

This gate centralizes task transitions and their events, adds a platform-neutral `TaskBoard` with exact actor visibility and bounded recovery pages, and separates private reminder firing, delivery/run, optional conversation receipt and semantic result. Schema v22 supplies task baselines, creator provenance, projection mode, reminder result state and bounded paging indexes. Existing v21 configured databases require an explicit offline migration so the evidence-sensitive backfill can compare old and new configuration.

The reviewer found and rechecked these blockers:

- High: several actor and automatic mutations could bypass the canonical transition boundary. All status/owner/assignment/wait/publication changes now use `TaskTransitions`, including freshness draft revision, dependency wake and work cancellation.
- High: `TaskTransitions.change` depended on callers to open a transaction, so an event failure could leave state changed. The service now owns the atomic boundary; a trigger-injected event failure proves the task update rolls back.
- High: reminder history exposed delivery but not the associated run state. The firing projection now reports delivery, run, optional receipt and semantic result independently, with separate event/firing cursors.
- High: evidence-only creator backfill could select an arbitrary candidate when historical signals conflicted. It now fills `created_by` only when the valid evidence resolves to one unique Agent; conflicts remain unknown and fail closed.
- High: draft cancellation checked only parent ownership. `Collaboration.update` now verifies exact child visibility before the parent-owner cancellation rule; a three-Agent transfer regression proves a new parent owner cannot read or cancel the creator/assignee-private child.
- Medium: old externally bound tasks were reported as unanchored legacy tasks. Migration marks only genuinely unanchored old tasks as legacy.
- Medium: sparse visibility could scan without a per-request limit. TaskBoard now examines at most 200 raw rows per page and returns a query-bound continuation even when the visible page is empty.

The reviewer additionally reproduced a real ToolRouter claim against a hidden external task, interleaved sparse pagination over 450 rows, transition rollback, creator conflict, reminder run state and the v21 daemon migration refusal. The final targeted recovery/schema suite passed 10/10. `pnpm test` rebuilt the project and passed 43 files and 299 ordinary tests, with 7 environment-dependent tests skipped. TypeScript and `git diff --check` passed. No real Slack/provider call or deployment was performed.

Final disposition: PASS with no remaining P0/P1 finding. E4b may begin.
