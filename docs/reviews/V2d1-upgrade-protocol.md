# V2d1 upgrade protocol review

## Scope

V2d1 adds the versioned deployment journal, topology/config/release identities, daemon and maintenance gates, the shared offline migration transaction with durable per-attempt database markers, and the deployment-only cross-configuration restore boundary. It does not add the root upgrade orchestrator or expose an upgrade command.

## Validation before review

- `pnpm typecheck`: pass.
- `pnpm test`: 409 passed, 10 skipped before the final review repairs.
- Focused V2d1 suite after repairs: 31 passed across deployment upgrade, migration and checkpoint tests.

The tests cover damaged and dangling journal paths, persistent transition monotonicity, candidate startup before Store/container recovery, exact activated start identity, ordinary maintenance denial, topology file and backing identity drift, database marker atomic rollback, exact replay without a second session rotation, a later migration attempt, strict ordinary restore, and old-target/new-current checkpoint verification in the deployment-only rollback API.

## Independent reviewer

Reviewer: `review_e2b2b_storage`, independent and read-only for this module. The reviewer inspected the implementation and tests and ran the focused suite.

### Round 1 — FAIL

- **P1:** `writeDeploymentJournal` accepted an `activated/true` journal followed by `candidate/false`, so `everActivated` was only internally consistent per file and was not monotonic across durable writes.
- **P1:** an existing dangling `deployment-v1.json` symlink was treated as absence by `existsSync`, failing open.
- **P1:** deployment rollback compared configs with the journal's in-memory topology snapshot but did not re-read manifest, service unit and mount unit identities from disk.
- **P2:** one database marker keyed only by the overall upgrade ID made activated A→B followed by fix-forward B→C impossible.

### Repairs

- Added a persistent transition table. Original upgrade, topology and rollback identities cannot change; activation cannot be cleared; rollback cannot be regained. Initial journal creation must start in `preparing`.
- Journal lookup now uses `lstat`; only `ENOENT` means absence. Reads use `O_NOFOLLOW` and compare the opened inode and stable file facts. Dangling or substituted paths fail closed.
- Start and rollback re-read protected manifest/service/mount files and bind backing device/inode. Managed restore still verifies the live ext4 workspace boundary.
- Split the overall `upgradeId` from `attempt{id, previous}`. SQLite markers are keyed by attempt ID and record both IDs plus old/new config and topology hashes. Fix-forward keeps the original transaction and irreversible state while advancing through independently replayable attempts.

### Round 2 — PASS

The reviewer independently reran 31 focused tests and found no remaining V2d1 correctness or engineering blocker. Dependency direction, transaction boundaries, ordinary/deployment API separation and the V2d2 extension surface were accepted.

## Deferred to V2d2

Replacing a fix-forward attempt that failed before its SQLite commit needs explicit evidence: the abandoned attempt has no database marker and the persisted configuration still equals its recorded previous identity. V2d2 must implement and test that transition while retaining `everActivated=true` and permanently denying checkpoint rollback.

## Disposition

PASS. V2d2 may begin.
