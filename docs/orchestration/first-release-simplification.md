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
| #34 | 建立统一格式检查并完成机械排版 | pending | `eb74e0e` | — |
| #35 | 用单一当前 schema 初始化新数据库 | pending | — | — |
| #36 | 让所有入口使用当前数据库格式 | pending | — | — |
| #37 | 统一应用装配与关闭流程 | pending | — | — |
| #38 | 由任务模块负责消息关联任务的完整发布流程 | pending | — | — |
| #39 | 让工具输入类型和领域授权各有明确归属 | pending | — | — |
| #40 | 交付有界且可继续的历史查询 | pending | — | — |
| #41 | 保留注意力与持久投递的独立状态 | pending | — | — |
| #42 | 让提醒独立于关联任务继续运行 | pending | — | — |
| #43 | 将会话发现收敛到现有成员空间 | pending | — | — |
| #44 | 让频道内 Agent 邀请另一名团队 Agent | pending | — | — |
| #45 | 在工作进程协议中保留故障类别与阶段 | pending | — | — |
| #46 | 对暂时模型故障持久退避并自动继续 | pending | — | — |
| #47 | 保持正常让位后的持久继续与恢复输入 | pending | — | — |
| #48 | 使进程查询与停止可取消且不阻塞 daemon | pending | — | — |
| #49 | 让内部应用在 Slack 离线时启动和运行 | pending | — | — |
| #50 | 按安装和目标范围恢复 Slack 操作 | pending | — | — |
| #51 | 给 owner 提供分范围、可操作的故障诊断 | pending | — | — |
| #52 | 统一 Linux 维护所用的宿主操作与路径事实 | pending | — | — |
| #53 | 验证完整 Linux 安装、升级、备份与恢复 | pending | — | — |

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
