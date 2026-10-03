import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/** Only the filesystem reader creates this value; JSON returned by other tools cannot impersonate it. */
export class WorkspaceImage {
  constructor(
    readonly mimeType: string,
    private readonly data: string,
  ) {}

  content(vision: boolean): (TextContent | ImageContent)[] {
    return vision
      ? [{ type: "image", mimeType: this.mimeType, data: this.data }]
      : [{ type: "text", text: JSON.stringify(this.toJSON()) }];
  }

  toJSON() {
    return {
      type: this.mimeType,
      unreadable:
        "当前模型不支持图片输入。可自行使用 process.exec 和已有本地工具处理；Mate 不会安装转换程序。",
    };
  }
}
