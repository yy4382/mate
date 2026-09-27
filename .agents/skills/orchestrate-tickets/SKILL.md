---
name: orchestrate-tickets
description: "Drive a whole spec's ticket set to completion as the orchestrator, delegating exactly one ticket per fresh sub-agent context. Use when a spec has already been split into tickets and the user wants the backlog worked through autonomously by sub-agents, or asks you to orchestrate/parallelise ticket implementation. Prepared for the DeepSeek Harness (dsh) delegation tools."
disable-model-invocation: true
---

# Orchestrate Tickets

You are the **orchestrator**. You do not implement tickets. You keep the queue moving: decide what may start, start one fresh sub-agent per ticket, verify what it claims, and hand the user only the decisions that are genuinely theirs.

This skill assumes the tickets already exist on a tracker (see `docs/agents/issue-tracker.md`). Splitting a spec into tickets is `/to-tickets`; implementing one ticket is `/implement`.

## The one rule that matters most

**A ticket's sub-agent reads its own work.** Its brief must send it to the tracker (`gh issue view <n> --comments`) and to the `/implement` skill. Never paste a ticket's acceptance criteria into the brief as the source of truth, and never summarise them "so the agent doesn't have to look".

Why this is not a style preference:

- A transcribed criterion is a second copy that can silently drift from the tracker. The agent then implements the copy, review checks the copy, and the tracker — the only durable record — disagrees with reality.
- The agent loses the ticket's comments, its blocking edges, its labels, and any correction recorded after the ticket was written.
- It hands tracker authority to you. In a long run the orchestrator becomes a single point of failure for state, and mismatches like "ticket closed while its acceptance evidence says 'not executed'" become easy.

The brief you write adds only what the ticket cannot know: the dependency it is built on, the environment trap of this machine, where to work, and what not to touch.

## 1. Reconnoiter before dispatching anything

1. Read the spec issue and list its tickets. On GitHub, `gh issue list --state open` plus `gh issue view <n>` per ticket is enough.
2. Extract each ticket's `Blocked by` edges and compute dependency **levels**: level 1 is everything unblocked, level 2 is what becomes reachable when level 1 lands, and so on. Write the levels down.
3. Record a green baseline with the project's own commands (`package.json`; here `pnpm check`, `pnpm typecheck`) and note the test-file/test counts. Every later claim is compared against this.
4. Find the project's environment traps and write them into every brief. On this machine: the default `node` is v26 while the project pins Node 24.21.0, so validation needs `export PATH=/Users/chris/.n/bin:$PATH` — under the wrong runtime native modules fail with `NODE_MODULE_VERSION` errors that look exactly like a broken ticket.

## 2. One ticket, one fresh context

Give each ticket a sub-agent that did not work on any other ticket. The brief is short and has a fixed shape:

- `cd` to the working directory and read `AGENTS.md` and `README.md` — binding.
- Read **the ticket itself**: `gh issue view <n> --comments`. State that this is the source of truth for acceptance.
- Claim it on the tracker (assignee or the project's equivalent) **as the first tracker write**, and update its state on the tracker when done.
- Load `/implement` with the skill tool and follow it exactly; it calls `/tdd` and closes with `/code-review`.
- The fixed point: the exact starting commit SHA.
- Dependency context: which tickets just landed and what they changed, if that changes how this one must be built.
- Environment trap, working directory, and write barriers (below).
- The report format you need back.

Do not add: a restatement of the acceptance criteria, your own test plan, or an implementation sketch. Those either duplicate the ticket or do the agent's thinking for it.

## 3. Decide what may run, and where

**Dependency order is not negotiable; parallelism is a judgement call.** A ticket may start only when every blocker has landed on the branch.

Run the critical-path chain **serially in the main checkout**. Every ticket that rewrites a foundational surface — schema, app assembly, tool routing — invalidates work built on the older base. In this repository, two tickets built in parallel from an old base produced genuine semantic conflicts (a modify/delete on a deleted module, and two rewrites of the same `Store.finish` failure policy); both had to be re-applied onto the new base afterwards, which cost more than running them serially would have.

Use a worktree for a ticket only when its files are demonstrably disjoint from everything still in flight. The value of parallelism is real; the cost of a semantic conflict is larger.

If you use worktrees, prepare them so they cannot corrupt each other:

```sh
git worktree add -q --detach .worktrees/t<N> <base-sha>
ln -s <main-checkout>/node_modules .worktrees/t<N>/node_modules
```

and give each worktree its **own git index**, because linked worktrees otherwise share one `.git/index` and race on `index.lock` while staging each other's files:

```sh
gi=$(git -C .worktrees/t<N> rev-parse --git-dir)
cp "$gi/index" "$gi/index.worktree"
git -C .worktrees/t<N> config extensions.worktreeConfig true
git -C .worktrees/t<N> config core.indexFile "$gi/index.worktree"
```

Add `.worktrees/` to `.gitignore`, and give the worktree its own index in the same breath.

**Write barriers for the orchestrator.** While an implementer works in the main checkout, never run `git stash`, `git reset --hard`, `git checkout -- .` or `git clean` there. Those commands discard uncommitted work that is not yours. In this repository exactly that destroyed an implementer's tracked edits mid-ticket. If you need protection before a risky step, take a copy — `git archive` into a temp directory — never a stash.

## 4. Verify, do not collect reports

An implementer's `STATUS: done` is a claim. Before you mark a ticket done:

1. Confirm its commit is an **ancestor of the branch tip**, not merely mentioned in the log: `git merge-base --is-ancestor <sha> HEAD`.
2. Confirm the commit references the ticket (`#N`) and touches only areas that ticket owns.
3. Run the project's own validation on the merged result, not on the agent's worktree alone.
4. Check each acceptance criterion against named evidence — a test, a command, a document — rather than against the agent's prose.

**Verify a merge without disturbing anything.** While another ticket may be editing the main tree, a `pnpm check` there measures that work too, so a red result cannot be attributed to your merge. Write the merged index out as a tree and validate a copy instead:

```sh
TREE=$(git write-tree)                 # with the merge staged via `git merge --no-commit`
mkdir -p /tmp/verify && git archive $TREE | tar -x -C /tmp/verify
ln -s <main-checkout>/node_modules /tmp/verify/node_modules
cd /tmp/verify && pnpm typecheck && pnpm check
```

When that is green, commit the merge, and say in the commit message that the merge tree was verified in an isolated archive.

## 5. When a ticket conflicts, re-apply it — do not force it

A conflict between two tickets is normal. Classify it before acting:

- **Mechanical** (both sides edited the same region for different reasons; the combination is obvious): resolve it yourself, then verify. Here, #48's `await` plus #37's renamed fixture combined into one line.
- **Semantic** (one ticket changed the interface the other built on, or both rewrote the same rule): **abort the merge** and hand the ticket back to its original implementer to re-apply onto the new base as one fresh commit. Forcing it means you are now writing two tickets' code, and the review that accepted them no longer describes what landed.

Never fold two tickets into one merge commit. Each ticket's commit is the durable trace that `/code-review` and the tracker depend on.

A re-application brief says: the new base SHA, what landed and why it conflicts, that the worktree is reset and clean, where the old commits are still readable (`git show <sha>`), and that the fresh commit must note which range it replaces.

## 6. Watch out for these, all seen in practice

- **Sibling commits.** An implementer that keeps working after you merged its stable commit produces a commit whose parent is the OLD base, not the merged tree. It is not a successor and its diff against the branch is misleading. Check parentage (`git log -1 --format=%p`) before merging anything you already merged once; ask for a re-application restricted to what the branch genuinely still lacks.
- **Shared-index contamination.** Two tickets committing in one checkout can sweep each other's staged files into a commit. Tell implementers to stage explicit paths (`git add <paths>`), not `git add -A`, and to read `git diff --cached --stat` before committing.
- **Merge lock contention.** `git merge` refuses while the tree has other pending changes. That is correct behaviour: wait for the main-tree ticket to commit, then merge.
- **Environment flakes.** A test suite that fails once and passes five times in a row was contending with sibling suites over one `node_modules`. Re-run before blaming the ticket, and record it as an environment artefact rather than a product defect.
- **Test expectations that pin wording.** An assertion on an exact message string breaks when a later ticket legitimately filters or rewrites that message. Prefer asserting the contract (a category, a disposition, a prefix, a structured field).

## 7. Stop for the user, and only for the user

Keep working through the backlog until all locally feasible development and validation is complete. Escalate — with the concrete decision you need — when:

- A finding would **change a requirement**. Correct the ticket on the tracker with a comment recording what changed and why, or bring a cross-ticket/spec-level issue to the user. Never rewrite an acceptance criterion to match what was built.
- A **critical product or architecture decision** genuinely needs the user.
- The work needs access this machine cannot provide **and the user has asked for it**. Missing provider/VPS credentials are not blockers by default: the project's own testing decisions say real external integration sits outside the per-ticket loop, and a simulated check must stay clearly labelled as simulated.

Do not ask a person to perform manual environment validation unless they have asked for it. If a ticket's acceptance depends on hardware or an OS this machine is not, say so in the tracker as a stated limitation of the delivered half, and do not leave a "human task" ticket assigned to the user as if it were part of the queue.

## 8. Keep one durable ledger

Keep a single orchestrator-owned file (here `docs/orchestration/<effort>.md`) holding: the dependency levels, per-ticket starting and landing commits, your own verification results, incidents and how they were resolved, and any accepted deviation. Implementers must not edit it — that keeps parallel tickets from conflicting on it and keeps state in one place you can resume from.

Update it as tickets land, not at the end. When a session is interrupted (quota exhaustion, a crash), the ledger is what makes recovery a matter of inventory rather than memory: check what is committed, resume the implementer sessions that still hold context, and re-apply only what never landed.

## 9. Report to the user

Report in the user's language (here: Chinese). Cover: what landed and how you verified it, what is running, what you deliberately left undone, and any decision you need. Say plainly what you could not verify — a green simulated suite is not a real integration, and a delivered half is not the whole ticket. When the backlog is exhausted, close the loop on the tracker (comment the landing commit and the evidence, then close the tickets and the spec) so the tracker's state matches the repository's.
