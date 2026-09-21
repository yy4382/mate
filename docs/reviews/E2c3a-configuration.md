# E2c3a — deployment configuration and stable identities

Independent reviewer: `/root/review_e2c3a_configuration` (fresh context, read-only; did not implement this module). Final disposition: PASS after P1 repair.

Scope: version 2 pure team definitions plus optional Slack/local adapter configuration; legacy parser normalization shared by daemon, CLI, persisted snapshots and offline migration; installation subset independent from team membership; stable human mappings separate from owner grants; adapter identity reverse mapping for friendly human IDs. Full local daemon and adapter lifecycle remain c3b, not claimed by this gate.

Implementation checks: typecheck; full pnpm test 252 passed, 7 environment-dependent tests skipped. Reviewer independently ran 37 targeted configuration/migration/daemon integration tests and constructed a populated local-origin store to verify exact canonical message preservation after Slack bootstrap. No real Slack calls or provider credentials used.

P1: adding the first Slack installation to a canonical local store successfully migrated its configuration but failed daemon construction because the existing format branch required a legacy Slack migration marker. Repaired the branch to distinguish canonical local provenance without inventing history, while requiring legacy provenance when old message/effect payloads exist. Added first-installation migration followed by two daemon constructions and missing-legacy-provenance rejection regressions. Reviewer reproduced and rechecked the repaired path.

Author also found and repaired explicit friendly human principal IDs failing Slack DM reverse lookup. Shared Slack identity helpers now round-trip explicit mappings, reject aliases to another user's default identity, and preserve old fallback IDs. Owner removal retains author identity; installation/human rebinding is rejected. Removed the reviewer's nonblocking trailing whitespace finding.

Engineering verdict: single normalization entrance, pure runtime team, adapter-specific binding and reverse identity logic, no unnecessary plugin framework; API and migration contracts cohesive. c3b must still deliver complete optional lifecycle, local input/query/control entry, durable room ACLs, partial start cleanup and platform failure isolation.
