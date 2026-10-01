import { z } from "zod";
import { workspaceVersionSchema as workspaceVersion } from "@mate/protocol/workspace";
import {
  WORKSPACE_WRITE_BYTES_BASE64_MAX_CHARS,
  WORKSPACE_WRITE_MAX_BYTES,
  MAX_NODE_MESSAGE_BYTES,
} from "@mate/protocol";
const workspacePath = z.string().max(4096);

export const workspaceToolDefinitions = {
  "workspace.list": {
    description:
      "列出工作区中的目录。使用 path 指定路径，相对路径从你的工作区开始；也用同伴的 Agent ID（见 agents.list）列出同伴工作区中的目录。支持 offset 和 limit 分页。",
    schema: z
      .object({
        path: workspacePath,
        offset: z.number().int().min(0).max(1_000_000).default(0),
        limit: z.number().int().min(1).max(32).default(32),
      })
      .strict(),
  },
  "workspace.stat": {
    description: "查看工作区中文件或目录的类型和大小；路径规则与 workspace.read 相同。",
    schema: z.object({ path: workspacePath }).strict(),
  },
  "workspace.read": {
    description:
      "读取工作区中不超过 8 KiB 的 UTF-8 文本文件；相对路径从你的工作区开始，也可以用同伴的 Agent ID（见 agents.list）按路径读取同伴工作区中的文件。更大的文件使用 read_chunk 分页读取。",
    schema: z.object({ path: workspacePath }).strict(),
  },
  "workspace.read_chunk": {
    description:
      "分块读取工作区中的文件，路径规则与 workspace.read 相同；每次最多 8 KiB，并用返回的 version 继续读取同一版本。",
    schema: z
      .object({
        path: workspacePath,
        offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        length: z.number().int().min(1).max(8192).default(8192),
        version: workspaceVersion.optional(),
      })
      .strict(),
  },
  "workspace.write": {
    description:
      "在你的工作区中写入或替换不超过 700 KiB 的 UTF-8 文本文件，且完整请求必须适合 1 MiB 节点消息。每次修改会由控制面记录并使用持久收据。",
    schema: z
      .object({
        path: workspacePath,
        content: z
          .string()
          .max(WORKSPACE_WRITE_MAX_BYTES)
          .refine((value) => Buffer.byteLength(value, "utf8") <= WORKSPACE_WRITE_MAX_BYTES),
      })
      .strict()
      .superRefine((input, context) => {
        const worstCaseRequest = {
          type: "control.workspace.operation",
          requestId: "00000000-0000-4000-8000-000000000000",
          agentId: "00000000-0000-4000-8000-000000000000",
          operationId: "00000000-0000-4000-8000-000000000000",
          mode: "agent_action",
          operation: { kind: "write", ...input },
        };
        if (Buffer.byteLength(JSON.stringify(worstCaseRequest), "utf8") > MAX_NODE_MESSAGE_BYTES)
          context.addIssue({
            code: "custom",
            message: "完整 workspace.write 请求超过 1 MiB 节点消息上限，请缩小文本。",
          });
      }),
  },
  "workspace.write_bytes": {
    description:
      "在你的工作区中写入或替换不超过 700 KiB 的二进制文件，内容使用标准 base64；更大的附件请使用流式附件发布。",
    schema: z
      .object({
        path: workspacePath,
        base64: z
          .string()
          .max(WORKSPACE_WRITE_BYTES_BASE64_MAX_CHARS)
          .refine((value) => Buffer.from(value, "base64").toString("base64") === value)
          .refine((value) => Buffer.from(value, "base64").byteLength <= WORKSPACE_WRITE_MAX_BYTES),
      })
      .strict(),
  },
  "workspace.edit": {
    description:
      "expectedHash 必须在编辑检查时匹配、oldText 必须唯一出现；Mate 工作区写操作会串行并在提交前复核，但普通命令、后台进程或绕过 Mate 的同 UID 写入仍可能与最终替换竞争。",
    schema: z
      .object({
        path: workspacePath,
        expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
        oldText: z.string().min(1).max(1_000_000),
        newText: z.string().max(1_000_000),
      })
      .strict(),
  },
  "workspace.mkdir": {
    description: "在你的工作区中创建目录。",
    schema: z.object({ path: z.string().min(1).max(4096) }).strict(),
  },
  "workspace.move": {
    description: "在你的工作区内移动或重命名文件；源和目标都必须留在你的工作区。",
    schema: z
      .object({ path: z.string().min(1).max(4096), destination: z.string().min(1).max(4096) })
      .strict(),
  },
  "workspace.remove": {
    description: "删除你工作区中的文件；如提供 expectedHash，文件必须仍与该摘要相符。",
    schema: z
      .object({
        path: z.string().min(1).max(4096),
        expectedHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict(),
  },
};
