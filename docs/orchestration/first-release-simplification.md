# Orchestration ledger: spec #33 first-release simplification

This file is the durable progress record for the 20 tickets (issues #34–#53) that
implement [spec #33](https://github.com/chris/mate/issues/33). One ticket is
implemented per fresh sub-agent context; the orchestrator (not the ticket
implementer) owns sequencing, dependency order and the final reconciliation.

## Fixed point and baseline

- Branch: `codex/first-release-simplification`
- Baseline commit at orchestration start: `eb74e0e` (`docs: record first-release simplification decisions (#33)`)
- Baseline `pnpm typecheck`: clean.
- Baseline `pnpm check`: 61 test files / 411 tests passing, 6.4s.

## Dependency levels

Levels are computed from each ticket's `Blocked by` section. A ticket may start
only when every blocker is committed on the branch.

| Level | Tickets |
|---|---|
| 1 | #34 |
| 2 | #35, #48, #52 |
| 3 | #36, #37 (needs #34+#36), #45 |
| 4 | #38, #39, #49 |
| 5 | #40, #41, #42, #43, #46, #47 |
| 6 | #44, #50 |
| 7 | #51 |
| 8 | #53 |

## Execution rules

1. One ticket per sub-agent context, running the `/implement` skill end to end.
2. Tickets execute in dependency order. Only work whose blockers are already
   committed on the branch may start. Independent tickets may be implemented in
   parallel in separate git worktrees, then merged back one at a time; every
   ticket keeps its own commit referencing its issue number.
3. This ledger is owned by the orchestrator. Ticket implementers never edit it,
   so parallel tickets cannot conflict on it.
4. Every sub-agent finishes with `/code-review` against the ticket's starting
   commit: Engineering and Spec axes as two parallel read-only sub-agents that
   did not write the code. Blocking findings are fixed and re-checked before the
   ticket is done.
5. The ticket commit message references the ticket (`#N`). The commit is the
   durable trace; review reports stay in the sub-agent conversation.
6. A sub-agent stops for the orchestrator only when the work genuinely needs the
   user: a requirement change, a cross-ticket or spec-level finding, or access
   this machine cannot provide. Missing real Slack/provider/VPS connectivity is
   not such a blocker — those paths are validated with the real application,
   real SQLite and scripted model/transport replacements.
7. The specification is the source of truth for acceptance. Acceptance criteria
   are never rewritten to match what was built.

## Progress

| Ticket | Title | Status | Starting commit | Landing commit |
|---|---|---|---|---|
| #34 | 建立统一格式检查并完成机械排版 | **done** | `eb74e0e` | `a8b00ce` + `e85a3ca` + `7c6e061` + `a91edb4` |
| #35 | 用单一当前 schema 初始化新数据库 | **done** | `d049b00` | `b1fcca9` + `beb5fdd` + `12aab7b` + `6b9d256` |
| #36 | 让所有入口使用当前数据库格式 | **done** | `b1fcca9` | `a2288ce` + `3751639` + `6395c75` + `8abca0d` + `2b1c0fb` + `2b56276` |
| #37 | 统一应用装配与关闭流程 | **done** | `fab5692` | `f8612ed` + `3c5e9db` + `c4592d7` + `1066f1c` |
| #38 | 由任务模块负责消息关联任务的完整发布流程 | **done** | `02dafa9` (re-applied) | `113241f`, merged as `8c729e6` |
| #39 | 让工具输入类型和领域授权各有明确归属 | **done** | `1066f1c` (worktree `.worktrees/t39`) | `f96c1a2` + `4cc68c9`, merged as `e898228`; follow-up `412aac5` was a sibling of `4cc68c9`, so its 14-line delta is being re-checked against #42 on the merged base |
| #40 | 交付有界且可继续的历史查询 | **done** | `02dafa9` (re-applied; worktree `.worktrees/t40`) | `9eda16a`, merged as `013be6c` |
| #41 | 保留注意力与持久投递的独立状态 | **done** | `612f35e` (worktree `.worktrees/t41`) | `44e7c9c`+`383fe7e`+`a2844d2`, merged as `8782568` |
| #42 | 让提醒独立于关联任务继续运行 | **done** | `e898228` (worktree `.worktrees/t42`) | `1c51589`, merged as `0f71592`; sibling `1909d03` (extra tests) being reconciled on the merged base |
| #43 | 将会话发现收敛到现有成员空间 | **done** | `ddd86b4` (worktree `.worktrees/t43`) | `1c206f4`, merged as `6a25110` |
| #44 | 让频道内 Agent 邀请另一名团队 Agent | **done** | `02dafa9` (worktree `.worktrees/t44`) | `cd13f9a`, merged as `9076ccb` |
| #45 | 在工作进程协议中保留故障类别与阶段 | **done** | `9c7e2e3` (main tree) | `b64a2e7` (final revision; an earlier `0e7b6f8` re-commit sits in history) |
| #46 | 对暂时模型故障持久退避并自动继续 | **done** | `16f1bf9` (worktree `.worktrees/t46`) | `db305eb` merged as `d9c5f68` (one orchestrator-resolved conflict in `src/storage/store.ts`); review fix `a3d5b9b` cherry-picked as `635d859` |
| #47 | 保持正常让位后的持久继续与恢复输入 | **done** | `d412adf` (worktree `.worktrees/t47`) | `ad456b1` merged as `612f35e`; reconciliation `4f95df6` merged as `16f1bf9`; follow-up `9eb40e0` cherry-picked as `5172463` |
| #48 | 使进程查询与停止可取消且不阻塞 daemon | **done** | `fab5692` (worktree `.worktrees/t48`) | `9e69c30`, merged as `3838cad` |
| #49 | 让内部应用在 Slack 离线时启动和运行 | **done** | `d412adf` (worktree `.worktrees/t49`) | `367bb2a` merged as `b933b52`; review fix `3451ce5` cherry-picked as `1f4e6c1` |
| #50 | 按安装和目标范围恢复 Slack 操作 | **done** | `fc977cf` (worktree `.worktrees/t50`) | `b7a5fdf` (re-applied into #49's readiness model), merged as `066e317` |
| #51 | 给 owner 提供分范围、可操作的故障诊断 | **done** | `066e317` (worktree `.worktrees/t51`) | `b34e6c4` merged as `5ad7fab`; review fixes `6efe101`/`4ee4e9f`/`e289c2c` cherry-picked as `b79c516`/`206f9c9`/`00dec88` |
| #52 | 统一 Linux 维护所用的宿主操作与路径事实 | **done** | `6395c75` (worktree `.worktrees/t52`) | `aac16f1`, merged as `fab5692` |
| #53 | 验证完整 Linux 安装、升级、备份与恢复 | **done** | `5ad7fab` (worktree `.worktrees/t53`) | `4cdd744`+`352d789`+`ff07110`, merged as `490da12` |

## Quota interruption and recovery

The account's model quota was exhausted mid-flight and four implementer sessions stopped
without a final report. Recovery was done by inventory rather than assumption:

| Ticket | State at interruption | Recovery |
|---|---|---|
| #38 | commits `85bc876`, `8f9fbd7` forked from `1066f1c` | worktree reset to main `02dafa9`; original session resumed to re-apply as one commit |
| #40 | commit `b4b85d6` forked from `e898228` | same |
| #43 | its extra `31a38a2` duplicated content already merged as `6a25110` | nothing to redo; verified already an ancestor-equivalent |
| #44 | nothing committed (agent died before its first commit) | same session resumed with the full ticket brief |

Merge safety held throughout: the merge that was interrupted mid-conflict was aborted, and
the branch tip was a committed, green merge, so no half-merged state survived. Lesson
recorded: resuming a stopped implementer session is cheaper than re-implementing, and a
ticket is not "done" until its commit is an ancestor of the branch tip.

## Orchestrator incident: destructive git commands in the shared tree

While merging #38 I ran `git stash -u` (intended to protect the tree before an isolated
verification) followed by `git stash pop`, then a `git reset --hard` on the main tree. The
stash was a no-op, and the reset discarded the TRACKED, uncommitted edits that ticket #45's
implementer had in the shared tree at that moment. The implementer's untracked files
(`src/runtime/fault.ts`, `tests/helpers/fault-worker.ts`, `tests/runtime/worker-fault.test.ts`)
and its compiled `dist/src/runtime/fault.js` / `worker.js` survived, which is the recovery
source. The implementer was told immediately, in plain terms, and asked to report what it
finds before reconstructing.

Rules added:
- Never run `git stash`, `git reset --hard`, `git checkout -- .` or `git clean` in the MAIN
  tree while an implementer is working in it. Those commands are only safe in a worktree that
  no one else is using, or after the implementer has stopped.
- To verify a merge without disturbing anything, write the merged index as a tree
  (`git write-tree`), archive that tree into a temporary directory and validate there. This
  needs no stash and no reset, and it measures exactly the merge result.
- Protection before a risky step belongs in a copy (archive, worktree), not in the shared tree.

## Verification hazard (orchestrator, corrected once)

While a ticket is being implemented in the MAIN tree, a `pnpm check` run there measures that
ticket's in-flight files as well as the merge, so a red result cannot be attributed to the
merge. This produced one false alarm: a format failure from ticket #45's untracked
`tests/runtime/worker-fault.test.ts` was briefly read as a broken #40 merge. The merge commit
was in fact green, confirmed afterwards in an isolated `git archive` copy. Rule: verify a
merge commit in an isolated copy whenever another ticket is editing the main tree, and only
treat a shared-tree failure as merge damage after that.

## Outcome

All 20 tickets of spec #33 landed on `codex/first-release-simplification`. Final integration at
`490da12`: `pnpm typecheck` exit 0 and `pnpm check` exit 0 — **72 test files / 579 tests**, format
check + build + full suite, at the pinned Node 24.21.0 (baseline was 61 files / 411 tests, so the
effort added 11 test files and 168 tests while deleting 13 obsolete schema/migration modules).

Honest limits of this result, recorded so nobody mistakes it for more than it is:
- Native Linux validation (real Agent UID, directory ownership/modes, systemd slice/scope,
  `/proc`+cgroup ownership, disk/inode enforcement) was NOT executed: this host is macOS. It is a
  runnable procedure against the project's real commands and must be run by a person on a
  resettable Linux host before the first release is called deployable.
- Real Slack, model-provider and VPS connectivity were never exercised; every Slack/provider path
  is covered with the real application plus a controllable transport or a scripted model, and no
  simulated result is presented as a real integration.

## Tracker synchronization

Every ticket is closed on GitHub as it lands, with a comment recording its landing commit and
the orchestrator's independent verification (pinned Node 24.21.0: `pnpm typecheck` exit 0 and
`pnpm check` exit 0 on the merged tree), plus the acceptance evidence and any honest limitation
(native-Linux-only checks in #48/#52/#53). #53 stays open while it is being implemented, with a
comment stating that its native half cannot run on this macOS host and must be executed by a
person on a resettable Linux host before the first release is called deployable.

## Findings escalated to the user

None yet.

## Orchestration notes

- Independent tickets run in separate git worktrees forked from the branch commit
  that satisfies their blockers, with `node_modules` symlinked to the main
  checkout (verified: full suite green in a worktree). Their commits are merged
  back into the branch one at a time, so each ticket still lands as its own
  commit referencing its issue number.
- The orchestrator verifies every sub-agent claim from the git tree and the real
  `pnpm check` / `pnpm typecheck` output; a ticket is only marked done here after
  its commit is on the branch and the suite is green at that commit.
- Stall criterion for a running ticket implementer (refined after observing the
  actual cadence): a gap of a few minutes with no repository write is normal for
  reconnaissance plus a full validation run (the suite alone is ~6s across 61
  files, plus `tsc` and build). Intervene only after roughly ten minutes with no
  repository write, no commit and no completion notification — and prefer
  re-briefing over a blind retry, so finished reconnaissance is not thrown away.
- Baselines that later tickets may shrink but must not silently break: the
  current-checkpoint, backup and restore tests, restart/recovery tests, and the
  architecture/dependency contract tests in `tests/contracts/`. Tests that exist
  only for the removed migration chain, old tool entry points and old config
  compatibility are expected to leave with their tickets.

## Findings escalated by ticket #34 (recorded, not a blocker)

- `tests/deployment/diagnostics.test.ts:209-232` asserts the verbatim source text of a Slack
  registration statement in `src/slack/runtime.ts`. That is a source-shape assertion rather
  than a behaviour assertion, contrary to spec Testing Decision #1, and it forced both the
  `// prettier-ignore` and the `printWidth: 100` choice in #34. It must not outlive the
  refactor; the ticket that owns that surface should assert the observable behaviour instead.
- `pnpm format` is not yet documented in `docs/DEVELOPMENT.md`, and `*.md` / `docs/` are
  deliberately outside the format pass. Documentation work for the maintenance flow
  (tickets #52/#53) should mention the formatting commands.
- Prettier 3.9.9 is not perfectly idempotent for one file (`src/storage/operations-schema.ts`):
  a single `pnpm format` run may need a second run. Worth revisiting only if it causes a real
  failure; the check gate itself is reliable.

## Incidents and traps (verified)

- **Shared-index contamination (#35 and #36).** Ticket #35's follow-up commit `beb5fdd`
  briefly captured files #36 had staged in the one shared index (`src/daemon/migrate.ts`,
  `src/slack/*-migration.ts`, ten `src/storage/*-schema.ts`). `12aab7b` restored those files
  from `b1fcca9` without rewriting history, and #36's working tree kept its deletions, so no
  work was lost. Lesson recorded: tickets running in the MAIN tree share one index, so a
  ticket must stage its own paths (`git add -A` only when every pending change is its own).
  From here on, independent tickets get their own worktree.
- **Node version (orchestrator trap).** The default `node` on this machine is v26 while the
  project pins Node 24.21.0. Under v26, `fs-ext` fails with `NODE_MODULE_VERSION 147 ...
  requires 137` and ten test files error out, which reads as a broken ticket but is not. All
  acceptance runs use `PATH=/Users/chris/.n/bin:$PATH` (node v24.21.0).
- **Merge ordering.** Parallel ticket worktrees cannot be merged into the main tree while
  another ticket is mid-edit there; merges wait until the main-tree ticket commits and the
  tree is clean. Merge commits require a green `pnpm check` before the merge is committed
  (verified with `git merge --no-commit`).
- **Sibling-commit drift (twice).** When an implementer keeps working after I merge its
  stable commit, its next commit is a SIBLING (same parent), not a successor, so it never
  contains the merged tree. Both times the agent was asked to re-check its delta against the
  current base and land only what was genuinely missing: #39's follow-up turned out to be a
  rename plus a regression test proving `reminders.cancel` still works after the task ends
  (work-container activity, not task status, gates it), and #42's follow-up is extra test
  hardening. Rule for the remaining tickets: treat a ticket as still open until its
  implementer reports, and reconcile by re-checking the delta on the merged base.
- **Per-worktree git index (hardening, verified).** By default every linked worktree of one
  repository shares `.git/index`, so parallel tickets race on `index.lock` and can stage each
  other's files (the same failure mode as the #35/#36 contamination, but across worktrees).
  Each worktree now sets `extensions.worktreeConfig` plus a worktree-local
  `core.indexFile = <gitdir>/index.worktree`, so a ticket's `git add`/`git commit` cannot
  touch the main index or another worktree's. Verified by committing a probe file in
  `.worktrees/t45`: the main HEAD, the main index and every sibling worktree were unaffected;
  the probe commit was then reset away.
- **Parallelism policy (revised after two failed merges).** Tickets #48 and #52 were
  implemented in worktrees forked from `d049b00` while #35/#36 restructured the storage
  layer. Both produced genuine semantic conflicts (modify/delete on `src/daemon/migrate.ts`,
  and conflicts in `src/main.ts`, `src/execution/linux-processes.ts`,
  `src/runtime/tool-contract.ts`, `src/deployment/*`): the parallel base was a moving
  target. Decision: the critical-path chain runs serially in the main tree, and a worktree
  is used only for a ticket whose files are demonstrably disjoint from everything still in
  flight. When a worktree ticket does conflict, the original implementer re-applies it onto
  the new base as one fresh commit (recording the replaced range), rather than the
  orchestrator forcing a merge that mixes two tickets in one commit.

## Orchestrator verification results (run by the orchestrator, pinned Node 24.21.0)

| Ticket | Commit(s) | Command | Result |
|---|---|---|---|
| #34 | `a91edb4` | `pnpm check` / `pnpm typecheck` | 61 files / 411 tests, exit 0; negative control: unformatted line makes the gate exit 1; formatter idempotent on the tree |
| #35 | `b1fcca9`…`6b9d256` | `pnpm check` at `b1fcca9` | 62 files / 416 tests, exit 0 (agent reports 418 at `6b9d256`) |
| #48 | `c4a69a7` (worktree) | `pnpm check` in `.worktrees/t48` | 61 files / 425 tests, exit 0 (first base) |
| #48 (reworked) | `9e69c30`, merged `3838cad` | `pnpm typecheck` + `pnpm check` on the merged MAIN tree before committing the merge | 59 files / 431 tests, exit 0 |
| #37 | `3c5e9db` | `pnpm typecheck` + `pnpm check` in an isolated `git archive` copy | 59 files / 417 tests, exit 0; the assembly test covers both entries, the ordered shutdown, and no repeated confirmed external operation after restart |
| #37 (final) | `1066f1c` | `pnpm typecheck` + `pnpm check` on the MAIN tree | 59 files / 432 tests, exit 0 (agent reports the same) |
| #42 | `1c51589`, merged `0f71592` | `pnpm typecheck` + `pnpm check` on the merged MAIN tree before committing the merge | 58 files / 435 tests, exit 0; conflict-free |
| #43 | `1c206f4`, merged `6a25110` | `pnpm typecheck` + `pnpm check` on the merged MAIN tree before committing the merge | 58 files / 441 tests, exit 0; conflict-free; the merge preserved the orchestrator's ledger file |
| #40 | `9eda16a`, merged `013be6c` | `pnpm check` in an isolated `git archive` copy of the merge commit | 58 files / 454 tests, exit 0; the retired `messages.recent/read/search` names are absent from the tool modules and the exact-catalogue assertion pins `history.*` |
| #38 | `113241f`, merged `8c729e6` | `pnpm typecheck` + `pnpm check` on the exact merged tree (written with `git write-tree`, archived, validated in a temp dir) | 59 files / 461 tests, exit 0; legacy anchor-less state absent from `src/` |
| #44 | `cd13f9a`, merged `9076ccb` | same isolated-tree method | 60 files / 479 tests, exit 0; the invite suite covers human invite, non-member, self-invite, non-team target, already-in-channel, refusal, timeout and query recovery |
| #45 (final) | `b64a2e7` | `pnpm typecheck` + `pnpm check` in an isolated `git archive` copy | 61 files / 485 tests, exit 0; the revision is the branch tip |
| #47 | `ad456b1`, merged `612f35e` | isolated-tree method on the merged tree | 62 files / 493 tests, exit 0 |
| #49 | `367bb2a`, merged `b933b52` | isolated-tree method on the merged tree | 66 files / 507 tests, exit 0 |
| #41 | `a2844d2`, merged `8782568` | isolated-tree method on the merged tree | 66 files / 517 tests, exit 0 |
| #46 | `db305eb` + `a3d5b9b`, merged `d9c5f68` / cherry-picked `635d859` | isolated-tree method on the merged tree | 68 files / 541 tests, exit 0 after the orchestrator combined both sides of one `Store.finish` conflict (#46's `clearResume`-on-yield and `recordResume` plus #47's corrected `lastStopReason` query) |
| main after cherry-picks | `635d859` | `pnpm typecheck` + `pnpm check` in an isolated archive | 68 files / 543 tests, exit 0 |
| #47 (follow-up) | `9eb40e0`, cherry-picked as `5172463` | `pnpm typecheck` + `pnpm check` on the main tree with no other ticket mid-edit | 66 files / 519 tests, exit 0; the follow-up makes the yield-resumption wording reachable (it had been dead because `lastStopReason` never excluded the current run) |
| #46 | `ae6f4fe` | worktree green (63 files / 498 tests) but the MERGE broke one of its own assertions | found and blocked before merging: the #45 reason filter rewrites `api key <value>` to `[redacted]`, so an exact-string expectation in `tests/runtime/resume.test.ts` was stale; sent back for a test-only fix |
| #45 | `0e7b6f8` | `pnpm typecheck` + `pnpm check` in an isolated `git archive` copy | 61 files / 484 tests, exit 0; `src/runtime/fault.ts` is the one shared result (7 stages, the five required categories plus `aborted`, and a `retryDisposition`), and the protocol test spawns the compiled worker fixture through the production `WorkerClient` over IPC rather than an in-memory stub |
| #44 (hardening) | `47b6227`, merged `d412adf` | re-applied on `0e7b6f8` after the sibling `c15f754` was rejected; 2 files; isolated-tree verification 61 files / 484 tests, exit 0 |
| #39 | `4cc68c9`, merged `e898228` | `pnpm typecheck` + `pnpm check` on the merged MAIN tree before committing the merge | 58 files / 431 tests, exit 0; conflict-free; type seam checked by hand (`ToolHandler<Schema>`/`ToolAuthorize<Schema>` both derive from the one zod schema) and the architecture test asserts the removed research reader, its host allow-list, its prompt hints and `daemon/research.ts` are gone |
| #52 | `053a643` (worktree) | `pnpm check` in `.worktrees/t52` | 62 files / 419 tests, exit 0 — merge pending #36 finishing |
| #36 | `a2288ce` | `pnpm check` in an isolated `git archive` copy | 57 files / 398 tests, exit 0; all preserved-baseline tests confirmed present; old schema modules fully unreferenced; `Store` is the single entry onto `openCurrentDatabase` |
| #36 (final) | `2b56276` | `pnpm typecheck` + `pnpm check` in the MAIN tree | 57 files / 402 tests, exit 0; 62→57 file and 416→402 test drop is exactly the migration-path tests; every preserved-baseline test confirmed present by path |
| #52 (reworked) | `aac16f1`, merged `fab5692` | `pnpm typecheck` + `pnpm check` on the merged MAIN tree before committing the merge | 58 files / 409 tests, exit 0; merge was conflict-free after re-application |

## Re-application log (cross-ticket conflicts)

| Ticket | First landing | Conflict cause | Re-applied as | Merged as |
|---|---|---|---|---|
| #48 | `8e5c3c8`..`c4a69a7` @ `d049b00` | #36 deleted the migration/schema chain #48's base still had | `5ed6bc2` @ `6395c75` | — |
| #48 | `5ed6bc2` @ `6395c75` | #52 replaced the ad-hoc `LinuxInstallerHost` seam with the single `HostOperations` entry while #48 called `new LinuxProcessManager(...)` directly | `9e69c30` @ `fab5692` | `3838cad` (one mechanical conflict in `tests/operations/view.test.ts`, resolved by the orchestrator: #48's `await` + #37's `f.local!` fixture) |
| #52 | `dffb1d3`..`053a643` @ `d049b00` | #36 deleted the migration path #52 had modified | `aac16f1` @ `6395c75` | `fab5692` |
| #36 | `a2288ce` @ `b1fcca9` | none | — | `2b56276` (6 commits kept) |

Lesson that held throughout: when a worktree ticket conflicts, the fix is a re-application by its
own implementer onto the new base, never a merge that mixes two tickets in one commit.
