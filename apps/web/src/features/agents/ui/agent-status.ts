import type { AgentSummary } from "../agent-responses.js";

export const agentStageLabels: Record<AgentSummary["stage"], string> = {
  queued: "等待节点处理",
  checking_account: "检查运行账号",
  preparing_workspace: "准备默认工作区",
  verifying_workspace: "核验工作区与记忆入口",
  complete: "工作区与会话已核验",
  failed: "创建未完成",
};

export function agentStatusLabel(agent: Pick<AgentSummary, "pausedReason" | "status">) {
  if (agent.pausedReason === "manual") return "已停用";
  if (agent.pausedReason === "credentials") return "凭据或模型错误";
  if (agent.pausedReason === "context") return "上下文压缩待处理";
  if (agent.status === "waiting_credentials") return "等待凭据";
  if (agent.status === "provisioning") return "正在创建";
  if (agent.status === "ready") return "已就绪";
  return "创建失败";
}
