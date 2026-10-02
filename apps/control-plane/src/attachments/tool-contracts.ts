import { z } from "zod";
const conversationId = z.string().uuid();

export const attachmentToolDefinitions = {
  "attachments.list": {
    description: "查看一个对话中的附件；公开频道无需加入即可查看，私有对话和私信仅限成员。",
    schema: z.object({ conversationId }).strict(),
  },
  "attachments.read_chunk": {
    description:
      "分块读取对话中的 UTF-8 文本附件；公开频道无需加入，私有对话和私信仅限成员。每次请求最多 8 KiB，字符边界各最多扩展 3 字节；返回 content、实际 offset/nextOffset 和 requestedOffset/requestedLength。上传图片或二进制只返回类型与不可读取提示，不受声明 MIME 或模型图片能力影响。",
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
