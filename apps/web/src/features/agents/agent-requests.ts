import type { z } from "zod";
import { readResponseJSON, responseErrorMessage } from "../../http-json.js";
import { redirectToLogin } from "../../navigation.js";
import { nodesResponseSchema } from "../nodes/node-responses.js";
import {
  agentsResponseSchema,
  channelsResponseSchema,
  credentialsResponseSchema,
  providersResponseSchema,
} from "./agent-responses.js";

export async function readAgentDirectory(signal?: AbortSignal) {
  const [nodes, channels, invitableChannels, agents, providers, credentials] = await Promise.all([
    readJSON("/api/owner/nodes", nodesResponseSchema, signal),
    readJSON("/api/owner/channels", channelsResponseSchema, signal),
    readJSON("/api/owner/invitable-channels", channelsResponseSchema, signal),
    readJSON("/api/owner/agents", agentsResponseSchema, signal),
    readJSON("/api/owner/model-providers", providersResponseSchema, signal),
    readJSON("/api/owner/model-credentials", credentialsResponseSchema, signal),
  ]);
  return {
    nodes: nodes.nodes,
    channels: channels.channels,
    invitableChannels: invitableChannels.channels,
    agents: agents.agents,
    providers: providers.providers,
    credentials: credentials.credentials,
  };
}

async function readJSON<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal) {
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (response.status === 401) {
    redirectToLogin();
    throw new Error("登录状态已失效");
  }
  const result = await readResponseJSON(response);
  if (!response.ok) throw new Error(responseErrorMessage(result, "暂时无法读取控制面资料。"));
  const parsed = schema.safeParse(result);
  if (!parsed.success) throw new Error("暂时无法读取控制面资料。");
  return parsed.data;
}
