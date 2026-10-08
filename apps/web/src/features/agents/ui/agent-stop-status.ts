import type { AgentStop } from "@mate/protocol/owner";

/** Mirrors the node's stop scope (apps/node/src/processes/operation-ledger.ts) across the API boundary. */
const thisNodeRunScope = "this_node_run";

/** The owner-visible sentences for one stop result; never claims more than the receipt proves. */
export interface AgentStopStatus {
  summary: string;
  retryLabel: string;
  awaitingProcessReceipts: boolean;
}

/**
 * The node's command tracker is per-node-process memory, so a stop only ever covers what that node
 * process started and can still signal. Whatever it could not prove is named plainly, so the owner
 * never reads the stop's success as "everything is gone".
 */
export function agentStopStatus(stop: AgentStop | null | undefined): AgentStopStatus {
  const unconfirmed = stop?.unconfirmedOperationIds?.length ?? 0;
  // The node names its own scope; anything else is only "ordinary commands", not a wider claim.
  const scope = stop?.scope === thisNodeRunScope ? "本次节点运行启动的普通命令" : "普通命令";
  // The count includes commands whose originating node run or termination cannot be confirmed.
  const unproven = `${unconfirmed} 条命令的终止无法确认`;
  const status = { retryLabel: "重新请求停止普通命令", awaitingProcessReceipts: false };
  if (stop?.state === "succeeded")
    return {
      ...status,
      summary:
        unconfirmed === 0
          ? `${scope}已确认停止。`
          : `本次节点运行中可确认的普通命令已停止；另有 ${unproven}。`,
    };
  if (stop?.state === "failed")
    return {
      ...status,
      summary:
        unconfirmed === 0
          ? "有普通命令的终止无法确认；请查看动态中的收据与节点诊断后重试。"
          : `本次节点运行中仍有 ${unproven}；请查看动态中的收据与节点诊断后重试。`,
    };
  if (
    typeof stop?.receipt === "object" &&
    stop.receipt !== null &&
    "reason" in stop.receipt &&
    stop.receipt.reason === "pending_process_receipts"
  )
    return {
      ...status,
      awaitingProcessReceipts: true,
      summary: "普通操作收据待对账；完成后将再次请求停止。",
    };
  return { ...status, summary: `${scope}停止结果未知；请检查节点与动态记录。` };
}
