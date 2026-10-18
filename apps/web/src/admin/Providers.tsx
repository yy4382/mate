import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ProviderView } from "@mate/admin";
import { del, put } from "../shell/api.ts";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  ConfirmDialog,
  ErrorLine,
  Field,
  Input,
  PageHeader,
} from "../shell/ui.tsx";
import { useProviders } from "./data.ts";

function ProviderCard({ provider }: { provider: ProviderView }) {
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const { credentials } = provider;
  return (
    <Card data-provider={provider.provider}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await put(`/api/admin/providers/${provider.provider}/credentials`, {
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
        <CardBody>
          <div className="grid gap-1">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold">{provider.name}</h2>
              <Badge tone={credentials === null ? "neutral" : "success"}>
                {credentials === null ? "未设置" : "已设置"}
              </Badge>
            </div>
            {credentials === null ? null : (
              <p className="break-all font-mono text-xs text-muted">
                API key {credentials.apiKey}
                {credentials.baseUrl === null ? "" : ` · 接口地址 ${credentials.baseUrl}`}
              </p>
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="API key">
              <Input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                required
              />
            </Field>
            <Field label="接口地址（可选）">
              <Input
                type="url"
                placeholder="https://…"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </Field>
          </div>
          <ErrorLine error={error} />
        </CardBody>
        <CardFooter>
          {credentials === null ? (
            <span />
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="-ml-3 text-danger"
              onClick={() => setConfirming(true)}
            >
              删除 key
            </Button>
          )}
          <Button type="submit" variant="primary">
            保存
          </Button>
        </CardFooter>
      </form>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`删除 ${provider.name} 的 key？`}
        description="用这家提供商模型的 Agent 会收不到回复，直到你再保存一个 key。"
        confirmLabel="删除 key"
        onConfirm={async () => {
          try {
            await del(`/api/admin/providers/${provider.provider}/credentials`);
            setError(null);
            await qc.invalidateQueries({ queryKey: ["admin"] });
          } catch (cause) {
            setError(cause);
          }
        }}
      />
    </Card>
  );
}

export function Providers() {
  const providers = useProviders();
  return (
    <>
      <PageHeader
        title="模型提供商"
        description="保存 API key 后，这家提供商的模型才能用在 Agent 上。"
      />
      <ErrorLine error={providers.error} />
      <div className="grid gap-6">
        {providers.data?.map((provider) => (
          <ProviderCard key={provider.provider} provider={provider} />
        ))}
      </div>
    </>
  );
}
