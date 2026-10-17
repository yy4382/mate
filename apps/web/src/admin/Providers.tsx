import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { del, put } from "../shell/api.ts";
import { ConfirmButton, ErrorLine } from "../shell/ui.tsx";
import { adminKeys, useProviders } from "./data.ts";

function CredentialsForm({ provider }: { provider: string }) {
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [error, setError] = useState<unknown>(null);
  return (
    <form
      className="form inline"
      onSubmit={async (event) => {
        event.preventDefault();
        try {
          await put(`/api/admin/providers/${provider}/credentials`, {
            apiKey,
            ...(baseUrl.trim() === "" ? {} : { baseUrl: baseUrl.trim() }),
          });
          setApiKey("");
          setBaseUrl("");
          setError(null);
          await qc.invalidateQueries({ queryKey: ["admin"] });
        } catch (cause) {
          setError(cause);
        }
      }}
    >
      <label>
        API key
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          required
        />
      </label>
      <label>
        接口地址（可选）
        <input
          type="url"
          placeholder="https://…"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </label>
      <button className="button primary" type="submit">
        保存
      </button>
      <ErrorLine error={error} />
    </form>
  );
}

export function Providers() {
  const qc = useQueryClient();
  const providers = useProviders();
  const [error, setError] = useState<unknown>(null);
  return (
    <section>
      <h2>模型提供商</h2>
      <p className="hint">保存 API key 后，这家提供商的模型才能用在 Agent 上。</p>
      <ErrorLine error={providers.error ?? error} />
      {providers.data?.map((provider) => (
        <article key={provider.provider} className="card" data-provider={provider.provider}>
          <header>
            <h3>{provider.name}</h3>
            <span className={provider.credentials === null ? "tag" : "tag ok"}>
              {provider.credentials === null ? "未设置" : "已设置"}
            </span>
          </header>
          {provider.credentials === null ? null : (
            <p>
              API key <code>{provider.credentials.apiKey}</code>
              {provider.credentials.baseUrl === null ? null : (
                <>
                  {" "}
                  · 接口地址 <code>{provider.credentials.baseUrl}</code>
                </>
              )}
            </p>
          )}
          <CredentialsForm provider={provider.provider} />
          {provider.credentials === null ? null : (
            <ConfirmButton
              label="删除 key"
              danger
              onConfirm={async () => {
                try {
                  await del(`/api/admin/providers/${provider.provider}/credentials`);
                  await qc.invalidateQueries({ queryKey: ["admin"] });
                } catch (cause) {
                  setError(cause);
                }
              }}
            />
          )}
        </article>
      ))}
    </section>
  );
}
