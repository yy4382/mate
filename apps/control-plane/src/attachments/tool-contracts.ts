import { z } from "zod";
const conversationId = z.string().uuid();

export const attachmentToolDefinitions = {
  "attachments.list": {
    description: "查看一个对话中的附件；公开频道无需加入即可查看，私有对话和私信仅限成员。",
    schema: z.object({ conversationId }).strict(),
  },
  "attachments.read_chunk": {
    description:
      "分块读取一个对话中的附件；公开频道无需加入即可读取，私有对话和私信仅限成员。每次最多 8 KiB。",
    schema: z
      .object({
        conversationId,
        attachmentId: z.string().uuid(),
        offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        length: z.number().int().min(1).max(8192).default(8192),
      })
      .strict(),
  },
  "attachments.publish": {
    description:
      "把你工作区中的一份文件发布到你已加入且明确指定的对话附件中；必须提供 conversationId。",
    schema: z
      .object({
        conversationId,
        path: z.string().min(1).max(4096),
        filename: z.string().max(255).optional(),
      })
      .strict(),
  },
};
