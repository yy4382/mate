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
      <Menu label={`更多：${name}`}>
        {agent.state === "open" ? (
          <MenuItem
            icon={<Pause aria-hidden />}
            onClick={() => run(() => post(`/api/admin/agents/${agent.agentId}/pause`))}
          >
            暂停
          </MenuItem>
        ) : null}
        {agent.state === "paused" ? (
          <MenuItem
            icon={<Play aria-hidden />}
            onClick={() => run(() => post(`/api/admin/agents/${agent.agentId}/resume`))}
          >
            恢复
          </MenuItem>
        ) : null}
        <MenuItem tone="danger" icon={<Trash2 aria-hidden />} onClick={() => setConfirming(true)}>
          删除 Agent
        </MenuItem>
      </Menu>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`删除 ${name}？`}
        description="它的设置和对话记录会被删除，聊天账号停用，无法恢复。已经发出的消息会保留。"
        confirmLabel="删除"
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
