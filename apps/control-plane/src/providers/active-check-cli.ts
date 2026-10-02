import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { checkProviderProtocol } from "./active-check.js";
import { supportedModelProviders } from "./catalog.js";

const argumentsSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  "api-key-file": z.string().min(1).optional(),
  "timeout-ms": z.coerce.number().int().positive().max(300_000).default(30_000),
});

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  let values;
  try {
    values = parseArgs({
      options: {
        provider: { type: "string" },
        model: { type: "string" },
        "api-key-file": { type: "string" },
        "timeout-ms": { type: "string" },
        list: { type: "boolean" },
        help: { type: "boolean" },
      },
    }).values;
  } catch {
    print({ connection: "real", status: "unverified", reason: "configuration_invalid" });
    process.exitCode = 1;
    return;
  }
  if (values.help) {
    print({
      usage:
        "pnpm check:provider --provider <provider> --model <model> [--api-key-file <私密凭据文件>] [--timeout-ms 30000]",
      selection: "使用 --list 查看 Mate 支持的 provider/model。",
      authorization:
        "仅由所有者主动运行；指定凭据文件后会实际请求所选供应商。Ctrl+C 或 SIGTERM 取消。",
      evidence: "仅输出状态和协议观察，不保存完整提示、回复、工具标记或凭据。缺少凭据记为未验证。",
    });
    return;
  }
  if (values.list) {
    print({ providers: supportedModelProviders });
    return;
  }
  const parsed = argumentsSchema.safeParse(values);
  if (!parsed.success) {
    print({ connection: "real", status: "unverified", reason: "configuration_invalid" });
    process.exitCode = 1;
    return;
  }
  const selection = parsed.data;
  let apiKey;
  if (selection["api-key-file"]) {
    try {
      apiKey = (await readFile(selection["api-key-file"], "utf8")).trim();
    } catch {
      print({ connection: "real", status: "unverified", reason: "credential_unreadable" });
      return;
    }
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await checkProviderProtocol({
      provider: selection.provider,
      modelId: selection.model,
      ...(apiKey ? { apiKey } : {}),
      timeoutMs: selection["timeout-ms"],
      signal: controller.signal,
    });
    print(result);
    if (result.status === "failed") process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

await main();
