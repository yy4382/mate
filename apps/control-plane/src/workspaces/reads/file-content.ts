/** Bounded byte classification, not a decoder or a guarantee about arbitrary unknown formats. */
export function fileType(bytes: Buffer, prefixContinues = false) {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  const header = bytes.subarray(0, 12).toString("latin1");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "image/webp";
  if (header.startsWith("%PDF-")) return "application/pdf";
  return decodeText(bytes, prefixContinues) === undefined
    ? "application/octet-stream"
    : "text/plain";
}

export function decodeText(bytes: Buffer, continues = false) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, {
      stream: continues,
    });
    return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) ? undefined : text;
  } catch {
    return undefined;
  }
}

export function unreadable(type: string, reason: string) {
  return {
    type,
    unreadable: `${reason} 可自行使用 process.exec 和已有本地工具处理；Mate 不会安装转换程序。`,
  };
}

/** The caller supplies up to three context bytes at either edge under the same file version. */
export function textRange(
  bytes: Buffer,
  {
    readOffset,
    offset,
    length,
    totalBytes,
  }: {
    readOffset: number;
    offset: number;
    length: number;
    totalBytes: number;
  },
) {
  let start = offset - readOffset;
  let end = Math.min(offset + length, totalBytes) - readOffset;
  const continuation = (index: number) => ((bytes[index] ?? 0) & 0xc0) === 0x80;
  while (start > 0 && continuation(start)) start--;
  while (end < bytes.length && continuation(end)) end++;
  const content = decodeText(bytes.subarray(start, end));
  return content === undefined
    ? unreadable("application/octet-stream", "请求范围不是可读取的 UTF-8 文本。")
    : {
        content,
        offset: readOffset + start,
        nextOffset: readOffset + end,
        requestedOffset: offset,
        requestedLength: length,
        totalBytes,
      };
}
