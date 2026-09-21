# E2c3b — shared daemon and local/Slack lifecycle

Independent reviewer `/root/review_e2c3b_lifecycle`, fresh read-only context. Final PASS, including the shutdown repair recheck.

Scope: same daemon/Supervisor/core with optional Slack runtime; Slack sockets, background maintenance, projections and attachment/service implementations owned by the adapter; trusted JSONL local input/query/owner controls; persisted local room identity and explicit migration of membership deltas; unavailable external publication rejected before intent/revision; internal spaces remain discoverable during external failure; separate internal/external output queues and authority filtering before ready LIMIT; background HTTP maintenance does not block core scheduling. Constructor DB initialization is transactional; partial startup and shutdown preserve resource/lock ordering.

Checks: implementation full pnpm test 262 passed, 7 environment-dependent tests skipped; typecheck and diff whitespace checks pass. Reviewer independently ran full 261-test state and typecheck, 32 local/integration checks, then all 10 local-runtime tests after the final cleanup patch. Tests include actual built CLI process and persistent local message/Supervisor/tool/gate path with a scripted worker. Slack and provider transport were not contacted; Linux isolation is not claimed.

Author cleanup finding during review: a rejecting adapter.close in a single try/finally could skip later drains. Repaired cleanup to collect errors while still waiting startup, loop, background, runs, supervisor and backend, releasing SQLite/lock last. Added fault test: close rejects while network maintenance remains pending; DB usable and singleton lock held until drain. Independent reviewer rechecked latest code and PASS.

Engineering review: accepted dependency direction, single business runtime, explicit lifecycle contract, room ACL migration without revocation reset, platform-independent canonical controls and no unnecessary plugin framework. No unresolved gate blockers. V1/V2 still own Linux execution, resource admission and deployment/backup acceptance.
