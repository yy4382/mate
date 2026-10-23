# Mate

- Read `docs/ARCHITECTURE.md` before any design or code change, and `docs/MODULE_TESTS.md` before writing tests, and `docs/DESIGN.md` before changing the web UI.
- Work through the pstack plugin's `/pstack:poteto-mode`.
- Name things with the terms in `GLOSSARY.md`; add a term there when you introduce a new concept.
- Tests drive a module only through its public interface and assert only what that interface exposes. Unit tests are out of scope.
- Fix a recurring class of bug by changing the structure until it cannot occur, not by adding a guard for one case.
- When a decision changes, update the docs in the same commit and delete the code it supersedes.
- Use pnpm.
- Commit to local branches. A minor improvement or bug fix ships without asking: open a PR, merge it once CI is green, then push the next `v*` tag, which deploys it (`docs/DEPLOYMENT.md` 5.5); report the version. Anything larger, anything that migrates a store, and changes to the deploy itself wait for the user on the PR.
- Talk to the user in Chinese.
