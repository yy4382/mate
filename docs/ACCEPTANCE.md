# First-release acceptance

Acceptance is based on the current spec and tickets in GitHub Issues, not results from an abandoned execution design. Use `pnpm check` and `pnpm typecheck`, then two focused seams:

1. A scripted Agent request traverses Mate's approval, execution, and receipt path, including rejection and unavailable UI for system-privileged commands.
2. On Debian 13, two real Agent UIDs demonstrate private memory isolation, shared work access, protected Mate control data, and ordinary background process listing/stopping.

Local mocks do not establish real Slack/provider connectivity or target-VPS deployment. Those remain separate final checks.
