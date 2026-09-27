---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Read the ticket itself from the tracker (`gh issue view <n> --comments`) and treat it as the source of truth for acceptance; if you were handed a summary instead, go and read the original before writing code.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end; the project's commands are in `package.json`.

Once done, use /code-review with the fixed point set to the ticket's starting commit.

Work the findings: fix blockers and send the changed areas back to the reviewer. If a finding changes a requirement, take it to the user — a code defect is a code fix; a wrong ticket description is corrected on the tracker with a comment recording what changed and why; a cross-ticket or spec-level issue is escalated.

Commit your work to the current branch, with the ticket referenced in the message (`#N`) — that reference is how /code-review finds the Spec source.

If you are working one ticket of a larger spec whose other tickets are being run in parallel by an orchestrator, work only your own ticket and follow the write barriers your brief names; see /orchestrate-tickets for why those exist.
