# Research sources

The current product direction is [PROJECT_DIRECTION](PROJECT_DIRECTION.md), and the current development rules are in [AGENTS.md](../AGENTS.md). Earlier plans and prompts are research evidence, not instructions to implement an abandoned deployment path. In particular, separate unprivileged Linux users now provide the everyday file and command boundary with less complexity than a sandbox; system-level commands still require explicit user approval.

The original Raft workspace and Codex records are local, read-only evidence:

- Agent workspace: `/Users/chris/.slock/agents/37f87e44-d8cb-429a-80aa-0a5c4f40c0ea` (`MEMORY.md` and `notes/`).
- Newer Codex session: `/Users/chris/.codex/sessions/2026/09/14/rollout-2026-09-14T17-19-45-01a09f37-200a-7c71-a165-68bc822d6cee.jsonl`.
- Earlier Codex session: `/Users/chris/.codex/sessions/2026/08/02/rollout-2026-08-02T15-44-05-019fc16e-18f2-7730-bb92-9b646f3d76ec.jsonl`.
- Research extraction directory: `/Users/chris/Documents/Codex/2026-09-19/s-l/outputs`.
- Public API/source snapshots: `/Users/chris/Documents/Codex/2026-09-19/s-l/work/sources`.

Selected excerpts are under `docs/reference/raft-*.md` and intentionally gitignored. Do not modify the running Raft workspace or copy private memory into tracked tests or documents. The extracted Raft developer prompt is not an undisclosed platform system prompt; logs do not expose model reasoning.
