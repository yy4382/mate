# Mate

- CODE AS SOURCE OF TRUTH. If documentation or this memory file conflict with code behaviour, obey the code. If you find a disagreement between code and documentation, search along git history/ GitHub issues and PR for context, and let the user decide.
- Read `docs/ARCHITECTURE.md` before any design or code change, and `docs/MODULE_TESTS.md` before writing tests, and `docs/DESIGN.md` before changing the web UI.
- Name things with the terms in `GLOSSARY.md`; add a term there when you introduce a new concept.
- Tests drive a module only through its public interface and assert only what that interface exposes. Unit tests are out of scope.
- Fix a recurring class of bug by changing the structure until it cannot occur, not by adding a guard for one case.
- When a decision changes, update the docs in the same commit and delete the code it supersedes.
- Use pnpm.
- Commit to local branches. A minor improvement or bug fix ships without asking: open a PR, merge it once CI is green, then push the next `v*` tag, which deploys it (`docs/DEPLOYMENT.md` 5.5); report the version. Anything larger, anything that migrates a store, and changes to the deploy itself wait for the user on the PR.
- Avoid spamming markdown files as documents, they often quickly become irrelevant or outdated.
  - Think twice before creating new project document (those that describe how to develop our project, e.g. `docs/ARCHITECTURE.md`, not those user-oriented documents that describe how to use our project), adding this kind of documentation requires user permission.
- Be curious about WHY. Find out why we want this change and why the previous code has such logic. Not only get an idea on what the logic (more specifically, code's control flow) is, but also care about why we did that in the past. This can avoid unnecessary changes or anomalies in the project’s expected behavior.

## Lessons from corrections

| Rule | How to apply and check it |
| --- | --- |
| Understand the reasons behind both the existing design and the new requirement before deciding what to change. | Trace actual calls to verify each concept's purpose, state ownership, and lifecycle; consult the original issue or PR when needed. Explain the observable outcome the user needs to change. Names and the latest implementation alone are not enough. |
| Shared paths or code do not imply shared responsibilities or lifecycles. | Before reusing code, compare creation, use, recovery, and failure behavior. Let responsibilities determine what is shared; reducing branches is not the goal. |
| Every behavior change needs a basis in the requirements. | Review the entire diff, including production code, protocols, tests, prompts, and documentation. Distinguish user requirements, necessary implementation changes, and assumptions. Convenience does not authorize expanding scope. |
| Tests protect requirements; they must not turn the current implementation into new requirements. | Explain whose behavior each assertion protects. Legitimate refactoring or unrelated initialization content should not break it. A dependency's guarantees do not automatically become Mate's testing responsibility. |
| When the user points out an example, examine the shared premise behind the mistake. | Revisit every change affected by that premise, including tests and documentation. Do not fix only the named location or replace the mistake with an excessive restriction in the opposite direction. |
| Passing tests and favorable reviews do not prove that the requirements were understood correctly. | Independently verify the basis for the requirements. Give independent reviewers the original goal and code entry points without steering their conclusions with the implementer's explanation. Distinguish verified facts, inferences, and unverified claims in reports. |
