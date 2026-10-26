import type { WorkspaceListing } from "@mate/admin";
import { useState } from "react";
import { useResource } from "./session";
import { Button, Card, Copy, ErrorLine, Loading, bytesText } from "./ui";

export function Workspace({ agentId }: { agentId: string }) {
  const [path, setPath] = useState(".");
  const result = useResource<WorkspaceListing>(
    `/api/admin/agents/${encodeURIComponent(agentId)}/workspace?path=${encodeURIComponent(path)}`,
  );
  const data = result.data;
  const segments = path === "." ? [] : path.split("/");
  return (
    <>
      <Copy title>工作区</Copy>
      <Copy muted>只读浏览主 Node 上这个 Agent 的文件。</Copy>
      <Button title="根目录" disabled={path === "."} onPress={() => setPath(".")} />
      <Button
        title="上一级"
        disabled={path === "."}
        onPress={() => setPath(segments.length > 1 ? segments.slice(0, -1).join("/") : ".")}
      />
      <Copy mono>{path}</Copy>
      <Button title="重新读取工作区" disabled={result.loading} onPress={result.refresh} />
      <ErrorLine error={result.error} />
      <Loading loading={result.loading && !data} />
      {data?.kind === "directory" && (
        <Card>
          {data.entries.length === 0 && <Copy muted>空目录。</Copy>}
          {data.entries.map((entry) => (
            <Button
              key={entry.name}
              title={`${entry.kind === "directory" ? "目录" : entry.kind === "symlink" ? "链接" : "文件"} · ${entry.name}${entry.kind === "file" ? ` · ${bytesText(entry.size)}` : ""}`}
              onPress={() => setPath(path === "." ? entry.name : `${path}/${entry.name}`)}
            />
          ))}
          {data.truncated && <Copy muted>目录太大，只列出了一部分。</Copy>}
        </Card>
      )}
      {data && data.kind !== "directory" && (
        <Card>
          <Copy>
            {path.split("/").pop()} · {bytesText(data.size)}
          </Copy>
          {data.kind === "file" ? (
            <>
              <Copy mono>{data.content}</Copy>
              {data.truncated && <Copy muted>文件太大，只显示了开头。</Copy>}
            </>
          ) : (
            <Copy muted>二进制文件，不显示内容。</Copy>
          )}
        </Card>
      )}
    </>
  );
}
