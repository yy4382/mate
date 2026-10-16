# Mate

- Read `docs/rewrite/ARCHITECTURE.md` before any design or code change. Read `docs/rewrite/MODULE_TESTS.md` before writing tests.
- Name things with the terms in `GLOSSARY.md`; add a term there when you introduce a new concept.
- Tests drive a module only through its public interface and assert only what that interface exposes. Unit tests are out of scope.
- Fix a recurring class of bug by changing the structure until it cannot occur, not by adding a guard for one case.
- When a decision changes, update the docs in the same commit and delete the code it supersedes.
- Use pnpm.
- Commit to local branches. Push only when the user asks.
- Talk to the user in Chinese.
