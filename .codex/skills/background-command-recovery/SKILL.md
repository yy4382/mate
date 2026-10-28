---
name: background-command-recovery
description: Check that Mate never dispatches a background command twice after a crash. Use when changing background command checkpoints, recovery phases, workspace dispatch, or the Durable task lifecycle.
---

# Check background command recovery

Property. Mate invokes `node.run` at most once for each persisted background command task across crashes and reopens.

Harm. Repeating a command can repeat a deployment or a destructive file operation.

This is a TLA+ model checked by TLC, not a proof of the TypeScript implementation. Compare the model with the code before treating a pass as evidence about Mate. TLA+ fits because the question concerns the ordering of durable writes, external calls, and crashes.

## Confirm that the model describes the change

Last confirmed source commit: `a3dd75bd338c9c7762bdf11de0aea219ab445136`.

From the repository root, inspect committed and uncommitted changes since that commit:

```sh
git diff a3dd75bd338c9c7762bdf11de0aea219ab445136 -- packages/runtime/src/background-commands.ts packages/runtime/src/workspace-tools.ts packages/runtime/src/runtime.ts packages/runtime/src/lifetime.ts packages/runtime/src/storage.ts packages/runtime/package.json packages/manager/src/manager.ts pnpm-lock.yaml
```

Read `docs/ARCHITECTURE.md` sections 4.2, 4.4, and 4.5. Trace the changed calls against this coverage record:

| Code | Model or assumption |
| --- | --- |
| `packages/runtime/src/background-commands.ts`, `BackgroundCommand.initial` | `Init` starts with persisted phase `start`, before any dispatch. Task creation is outside the model. |
| `BackgroundCommand.phases.start`, first awaited `runtime.commit` | `SaveInterrupted` changes durable `checkpoint`. The volatile `continuation` then permits dispatch. These are separate steps. |
| `BackgroundCommand.phases.start`, `node.run` and its awaited result | `Dispatch` counts a workspace invocation. `ReceiveResult` resumes the local continuation. The external effect may survive a crash. |
| `BackgroundCommand.phases.interrupted` | `Reopen` selects `report` for the persisted interrupted phase. Recovery never dispatches. |
| `background-commands.ts`, `report` | `CommitReport` makes the task terminal. The real transaction also creates a delivery task via `assistants.ts:deliverInput`. Delivery and report contents are outside this property. |
| `packages/runtime/src/runtime.ts`, `openAgentRuntime`; `storage.ts`, `openAgentStorage`; `lifetime.ts` | `Crash` loses the continuation, preserves committed storage and past effects, and prevents the old runtime from continuing. `Reopen` resumes from durable state. |
| `packages/runtime/src/workspace-tools.ts`, `workspaceExtension` | Unsafe replay prevents an interrupted bash tool call from creating another background task. This is a dependency assumption, not a modeled guarantee. |
| `packages/manager/src/manager.ts`, lifecycle queue | One runtime owns a given Agent store at a time. Concurrent owners are outside the model. |
| `packages/runtime/package.json`, `pnpm-lock.yaml` | Durable 1.1.0 supplies atomic commits and persisted phase recovery. Recheck these assumptions after upgrades. |

`checkpoint` is persisted state. `continuation` is where the live JavaScript invocation will resume. Do not combine them. In particular, a crash after `SaveInterrupted` but before `Dispatch` can produce an interruption report without running the command.

Confirm each atomic model step matches a transaction or a single external-call boundary. A commit failure is represented by a crash before or after its atomic durable effect. If code moves the checkpoint after dispatch, reflect that ordering in the model before running it. An unchanged model passing against changed code is not verification.

Advance the source commit only after confirming that this mapping describes the new committed code and rerunning the check. Leave it unchanged while relevant source edits remain uncommitted. If changes alter the guarantee, ask the user to decide the requirement before changing the invariant.

## Run the model

Use Java 11 or later and the [TLC 1.7.4 release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4). Download `tla2tools.jar` from that release outside the repository. Set `TLA2TOOLS` to its absolute path. Set `JAVA` to the Java executable if it is not on `PATH`. The runner verifies the pinned jar checksum and puts temporary state outside the checkout.

From the repository root:

```sh
pnpm exec node .codex/skills/background-command-recovery/check.mjs
```

Read every result with the pstack `/statechart` skill. Give it `BackgroundCommand.tla` and `BackgroundCommand.cfg` from this folder in a scratch directory. Follow that installed skill's current instructions. On a pass, show its statechart. On a failure, explain its shortest path in Mate's terms. Do not copy `/statechart` commands or installation paths into this skill or its runner.

A successful run must exit zero, report no error, and finish with zero states left on the queue. A missing Java installation, checksum mismatch, parse failure, or interrupted run is not a pass or a counterexample.

## Interpret the scope

The model covers one existing background command task and one live runtime owner. It explores every reachable order of checkpoint commit, dispatch, result return, terminal commit, crash, and reopen. Crash and reopen cycles can repeat without a fixed count limit. The dispatch counter stops at two, which is already a violation. This is a finite-state safety check, not a proof for arbitrary implementations or multiple concurrent owners.

Assume Durable commits are atomic, successful commits survive restart, and recovery selects the saved phase. Assume a dead runtime cannot resume its old continuation. The model does not verify those dependency guarantees.

The model excludes task creation, `bash_stop`, graceful shutdown, concurrent commands, gateway transport, shell execution, report delivery, assistant replies, storage corruption, and eventual progress. In particular, it proves neither exactly-once shell execution nor rollback of command effects. A gateway retry could repeat execution even while this dispatch property holds. Changes to those excluded areas need their own checks.

## Demonstrate that the skill catches a break

Use a scratch checkout or preserve and restore the exact original file bytes. Never overwrite a user's edits.

1. In `packages/runtime/src/background-commands.ts`, move the first awaited `runtime.commit` in `phases.start` to immediately after the awaited `node.run`. Keep `AtMostOneDispatch` unchanged.
2. Repeat the source comparison above. Update a scratch copy of the model to match the changed ordering. `Init` and recovery from `start` now permit dispatch first. `ReceiveResult` leads to the checkpoint, and saving that checkpoint leads to the report.
3. Run TLC and use `/statechart` to read the violation. Expect a command dispatch, a crash before the checkpoint, a reopen at `start`, and a second dispatch.
4. Confirm the same break through the runtime's public interface using the existing recovery tests:

   ```sh
   pnpm exec vitest run packages/runtime/test/background-commands.test.ts
   ```

   Inspect the failed assertions and workspace calls. A timeout alone is insufficient evidence of duplicate dispatch. Add only a temporary public-interface probe if necessary, following `docs/MODULE_TESTS.md`.
5. Restore the product code and model. Rerun both commands. Report the negative control separately from findings in the unmodified code.

If a counterexample cannot occur in the real code, correct the model's atomicity or assumptions and explain why. If it does occur, preserve the property and report the finding. Do not change product code as part of this verification task.

Use `/maintain-formal-verification-skill` after changes that bypassed this comparison.

## Validation record

At the source commit above, TLC exhausted 12 distinct states with no invariant violation. All 12 existing background-command tests passed. An independent reader followed this skill on the reordered real code and found the four-step duplicate-dispatch counterexample. A temporary public-interface probe observed `dispatched again` instead of the expected recovery report. After restoring the code, that probe and all 12 existing tests passed. The probe was removed after validation.
