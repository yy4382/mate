# R7a session lifecycle review
Baseline: 3985b42. Independent reviewer: /root/review_r7a (fresh context, read-only).
Scope: v15 checkpoint/reset tables; model checkpoint/status/reset; owner agent-reset; deferred rotation at run completion/recovery, fresh worker, prior-delivery continuation; private action receipt inspection.
Validation: pnpm run check — 161 passed, 7 optional real-backend tests skipped. Independent latest suite 162 passed including one temporary red-team test, removed afterward; diff check clean.
Findings and repairs:
- P2 blocker: context reset retained unknown execution debt but provided no model lookup. Added paginated own actions.list and actions.read; no replay/resolution side effect.
- P2 blocker: broad historical receipts bypassed reminder indirect target ACL. Full historical request/receipt now only Broker execution operations; other capabilities return metadata and require current ACL-aware read paths. Regression includes revoked reminder and peer action access.
Additional reviewer probes passed: cancelled selected work does not continue original work; owner reset racing old-run catch does not overwrite new session; nested historical reads do not leak revoked bodies.
Disposition: PASS. Model reset preserves identity, durable coordination and budget, supersedes old delivery with a continuation unless cancelled; paused work stays paused. Owner reset explicitly leaves Agent paused. Session history remains in SQLite for diagnosis; fresh context receives checkpoint, not arbitrary old transcript. Unknown effects stay unresolved until evidence/owner handling; reset never clears debt.
