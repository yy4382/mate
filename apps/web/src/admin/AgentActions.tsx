import { t } from "../i18n.ts";
import { useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import type { AgentView } from "@mate/admin";
import { del, post } from "../shell/api.ts";
import { ConfirmDialog, Menu, MenuItem } from "../shell/ui.tsx";
import { adminKeys } from "./data.ts";

/** The 更多 menu of an Agent: pause or resume it, or delete it after a confirmation. */
export function AgentActions({
  agent,
  onError,
  onDeleted,
}: {
  agent: AgentView;
  onError: (error: unknown) => void;
  onDeleted?: () => void;
}) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
      onError(null);
      await qc.invalidateQueries({ queryKey: adminKeys.agents });
    } catch (cause) {
      onError(cause);
    }
  };
  const name = agent.displayName ?? agent.agentId;
  return (
    <>
      <Menu label={t("common.moreFor", { name: name })}>
        {agent.state === "open" ? (
          <MenuItem
            icon={<Pause aria-hidden />}
            onClick={() => run(() => post(`/api/admin/agents/${agent.agentId}/pause`))}
          >
            {t("AgentActions.pause")}
          </MenuItem>
        ) : null}
        {agent.state === "paused" ? (
          <MenuItem
            icon={<Play aria-hidden />}
            onClick={() => run(() => post(`/api/admin/agents/${agent.agentId}/resume`))}
          >
            {t("AgentActions.resume")}
          </MenuItem>
        ) : null}
        <MenuItem tone="danger" icon={<Trash2 aria-hidden />} onClick={() => setConfirming(true)}>
          {t("AgentActions.deleteAgent")}
        </MenuItem>
      </Menu>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("AgentActions.deleteNamed", { name })}
        description={t("AgentActions.itsSettingsAndConversationHistoryWillBeDeleted")}
        confirmLabel={t("AgentActions.delete")}
        onConfirm={() =>
          run(async () => {
            await del(`/api/admin/agents/${agent.agentId}`);
            onDeleted?.();
          })
        }
      />
    </>
  );
}
