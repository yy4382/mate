# Palace

- CODE AS SOURCE OF TRUTH. If documentation or this memory file conflict with code behaviour, obey the code. If you find a disagreement between code and documentation, search along git history/ GitHub issues and PR for context, and let the user decide.
- Read `docs/ARCHITECTURE.md` before any design or code change, plus the `ARCHITECTURE.md` of each package or app you touch. Read `docs/MODULE_TESTS.md` and the package's `TESTS.md` before writing tests, and `docs/DESIGN.md` before changing the web UI.
- Name things with the terms in `GLOSSARY.md`; add a term there when you introduce a new concept.
- Fix a recurring class of bug by changing the structure until it cannot occur, not by adding a guard for one case.
- When a decision changes, update the docs in the same commit and delete the code it supersedes.
- Use pnpm.
- Avoid spamming markdown files as documents, they often quickly become irrelevant or outdated.
  - Think twice before creating new project document (those that describe how to develop our project, e.g. `docs/ARCHITECTURE.md`, not those user-oriented documents that describe how to use our project), adding this kind of documentation requires user permission.
- Be curious about WHY. Find out why we want this change and why the previous code has such logic. Not only get an idea on what the logic (more specifically, code's control flow) is, but also care about why we did that in the past. This can avoid unnecessary changes or anomalies in the project’s expected behavior.

## Autonomy

- The agent is free to merge PR or directly push to main branch.
- For changes that doesn't change the deploy process, the agent is free to release a new server version (push a `v*` tag). 
  - For iOS versions, agent is free to release testflight versions, but not that frequently.
    - Only a big enough iOS change triggers a testflight release.
    - When there are other work still going, wait them to finish and the batch the changes in 1 release.
    - The frequency should be around 3 per day, if we do have more important changes to release, this is not a hard limit.

## Tests

- Tests drive a module only through its public interface and assert only what that interface exposes. Unit tests are out of scope.
- Keep tests and CI fast. Avoid unnecessary sleeps in tests and duplicate checks across CI workflows.
- Smoke tests are often unnecessary or even misleading. They may run in a slightly different environment or test a slightly different version of the code, making their results less representative and quick to become outdated. It is fine to use smoke tests during development, but do not commit them to Git as permanent tests that run on every change.


## Lessons from corrections

| Rule | How to apply and check it |
| --- | --- |
| Understand the reasons behind both the existing design and the new requirement before deciding what to change. | Trace actual calls to verify each concept's purpose, state ownership, and lifecycle; consult the original issue or PR when needed. Explain the observable outcome the user needs to change. Names and the latest implementation alone are not enough. |
| Shared paths or code do not imply shared responsibilities or lifecycles. | Before reusing code, compare creation, use, recovery, and failure behavior. Let responsibilities determine what is shared; reducing branches is not the goal. |
| Every behavior change needs a basis in the requirements. | Review the entire diff, including production code, protocols, tests, prompts, and documentation. Distinguish user requirements, necessary implementation changes, and assumptions. Convenience does not authorize expanding scope. |
| Tests protect requirements; they must not turn the current implementation into new requirements. | Explain whose behavior each assertion protects. Legitimate refactoring or unrelated initialization content should not break it. A dependency's guarantees do not automatically become Palace's testing responsibility. |
| When the user points out an example, examine the shared premise behind the mistake. | Revisit every change affected by that premise, including tests and documentation. Do not fix only the named location or replace the mistake with an excessive restriction in the opposite direction. |
| Passing tests and favorable reviews do not prove that the requirements were understood correctly. | Independently verify the basis for the requirements. Give independent reviewers the original goal and code entry points without steering their conclusions with the implementer's explanation. Distinguish verified facts, inferences, and unverified claims in reports. |
