# How we work

Distilled from poteto's pstack. Read this before starting any implementation task.

## Design before code

- **Shape first.** Name the data shape before writing logic. Encode the domain in a structure (state machine, discriminated union, table, registry) instead of conditionals spread across files. A second boolean that must stay in sync with the first means the shape is wrong.
- **Usage first.** For code that crosses a module boundary, write the caller's usage, then derive the types and signatures from it, with `not implemented` bodies. Sketch at least two structurally different designs and keep the one with the smaller interface hiding more behaviour (a _deep_ module).
- **Red flags.** Screen every design for:
  - a shallow module (callers coordinate several calls to do one thing);
  - information leakage (one internal decision visible in two modules);
  - temporal decomposition (modules named after steps such as load, validate, save instead of the knowledge they own);
  - pass-through methods;
  - split ownership (two writers of one piece of state);
  - two ways to do one task;
  - importable internals;
  - hand-synced lists.
- **Scrap signal.** The same shaped workaround appearing twice, edge cases that each need their own branch, or casts needed to compile all mean the design is wrong. Redesign as if the new constraint had been there from day one, smaller than before, and build from that.
- **Subtract first.** Remove before adding. Build for the behaviour the docs require, and guard only what crosses a boundary.

## Boundaries and state

- **Parse at the boundary.** HTTP, WebSocket, CLI, files and provider responses are parsed into Zod-derived domain types where they enter. Code inside trusts those types.
- **Idempotent by construction.** For every state change, answer two questions: what happens if it runs twice, and what happens if the previous run died at any point. Derive the next step from the state that exists.
- **Separate before serialising.** When two actors could write the same thing, give each its own target. Add a lock only when one shared writer is a real invariant.

## Executing

- **Verifiable units.** Work in small units. Each one ends in a check that is green before the next unit starts. Commit each unit, and order the commits so they read as an argument: scaffold before feature, harness before the code it checks.
- **Build the lever.** When work is more than a couple of obvious edits, write the script, generator or check that does or proves it, and commit it when it outlives the session.
- **Prove it works.** Check the real artifact: run it, read the actual value, inspect the diff. A verdict is VERIFIED, NOT VERIFIED or INCONCLUSIVE, and inconclusive is not a pass.
- **Test behaviour.** Judge each test by two imagined edits. If you break the behaviour, the test must fail. If you restructure the internals without changing behaviour, the test must still pass. Derive expected values from the requirement, never from a run of the code.
- **Root causes.** Reproduce first. Fix where the system first went wrong, not where the symptom surfaced. When two fixes built on one premise have failed, write the premise down and test it before attempting a third.
- **Autonomy.** Proceed on reversible work and report what you did. Pause for irreversible actions: pushing, deleting user data, external messages. Ask the user only about product or preference calls that no experiment can settle; settle everything else by prototyping. An honest "no" or "this doesn't earn its place" is a valid answer.

## Delegating and review

- **You own delegated work.** Give each subagent a consolidated brief (file paths, the data shape, success criteria). Read its diff and write your own summary. Start a fresh subagent for each new round rather than resuming an old one.
- **Independent review.** Before each milestone is done, a subagent that did not write the code reviews it through a code-quality lens:
  - hunt for "code judo" restructurings that delete whole branches;
  - flag a file that grows past about 1000 lines;
  - flag ad-hoc branching added to an existing flow;
  - flag wrappers and casts;
  - flag logic placed in the wrong module.

  Fix blocking findings before moving on.
- **Decision trail.** On long autonomous runs, keep a local `decisions.tsv` with one row per decision (`ts, phase, decision, why, evidence, result`). It is append-only, and evidence is a pointer, never prose.

## Writing

- Comments explain a non-obvious _why_ that the code cannot show. Tests narrate their steps through assertion messages.
- In reports, label every claim measured, inferred or guessed, and attach its evidence. Explain impact for whoever uses the work, then for whoever maintains it next.
