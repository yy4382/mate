# R8 product semantics and final documentation
Baseline: 0d3392d. Independent reviewer: /root/review_r8 (fresh context, read-only).
Scope: five legitimate choices through actual Pi loop without task tree; dispatch eligibility before batch LIMIT; README/HOW_IT_WORKS/ACCEPTANCE current behavior rewrite and reference-document status corrections.

Checks:
- Implementer pnpm run check: 176 passed, 7 optional tests skipped.
- Separate actual local SRT/Docker suite: 7/7 passed with existing pinned image, no image pull or external requests.
- Reviewer pnpm exec vitest run: independently 176 passed, 7 skipped.
- Reviewer pnpm exec tsc --noEmit: passed.
- Local Markdown links and git diff --check: passed.

Reviewer inspected actual diff, product direction, private Raft reference behavior, full prompt and relevant production paths. SQL ingress, overlapping-target unknown/sending and same-Agent artifact checks match dispatch checks and run before LIMIT. Pi scenarios traverse Supervisor/ToolRouter/persistent state for defer-retain, discard, continue, revise and re-read/retry; no forced task tree and continue does not fake seen state.

No P0–P2 or acceptance blockers found. Existing R5b1 deferred outbox starvation is resolved: blocked targets cannot fill the dispatch batch ahead of unrelated eligible output. Documents distinguish local freshness from Slack atomicity, stricter review seats, absent general search/integrations, bounded context/files, unknown reconciliation and single-host limits. No claim about model intelligence or live service validation.

Disposition: PASS. R1–R8 product refactor complete within the documented scope. Independent reviewer did not rerun optional isolation tests; the separate 7/7 result is implementer-executed real backend evidence. No deployment, push, external resource creation or Slack/provider call.
