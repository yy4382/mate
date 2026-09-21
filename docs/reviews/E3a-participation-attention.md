# E3a — participation and direct attention

Independent read-only reviewer `/root/review_e3a_participation`, fresh context. Initial revisions required; final PASS after P2 repair.

Implemented capability discovery, paginated public metadata candidates (no canonical binding or ACL), explicit public-channel join/external-channel leave, durable effect receipts and membership refresh; unsupported internal/DM controls explain attention alternatives. Concurrent membership changes fence late responses. Shared direct-request semantics allow personal mentions/DMs through ordinary mute while defer, resolve, current access and review-seat isolation retain their distinct meaning.

Reviewer reproduced P2: Slack leave `last_member` was wrongly unknown; observing still-member could never resolve it, permanently blocking further membership actions even after a second member joined. Expanded explicit documented rejection classification (including token_expired and platform ratelimited), added condition-change/new-intent retry regression. Network, internal/fatal and unrecognized errors stay unknown; positive desired-state observation can reconcile, negative observation alone does not authorize replay. Reviewer independently rechecked repair and ran 17 participation/attention tests, PASS.

Implementation validation: full pnpm test 271 passed, 7 environment-dependent skips; typecheck. Discovery-to-join/leave tested through actual ToolRouter; tests cover no discovery binding, receipt replay and same-ID conflicts, private/unsupported targets, unknown refresh, concurrent revoke, direct/muted/deferred delivery and attention. Official Slack join/leave/list contracts consulted, linked in PARTICIPATION.md. No real Slack/provider calls or deployment.

Software engineering verdict: platform rules stay in adapter, direct-request predicate shared, existing canonical action persistence reused, no new schema or generic orchestration framework needed. No unresolved blockers. Bounded search/history/around and coverage remain E3b.
