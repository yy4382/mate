import type { CatalogModel, ProviderView } from "@mate/admin";
import { useState } from "react";
import { useClient, useOperation, useResource } from "./session";
import {
  Button,
  Card,
  Copy,
  ErrorLine,
  Field,
  Loading,
  Outcome,
  Screen,
  ConfirmButton,
} from "./ui";

function Provider({ provider, refresh }: { provider: ProviderView; refresh: () => void }) {
  const client = useClient();
  const operation = useOperation();
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.credentials?.baseUrl ?? "");
  const [catalog, setCatalog] = useState(false);
  const models = useResource<CatalogModel[]>("/api/admin/models");
  const path = `/api/admin/providers/${encodeURIComponent(provider.provider)}/credentials`;
  return (
    <Card>
      <Copy title>{provider.name}</Copy>
      <Copy muted>
        {provider.credentials ? `已设置 · ${provider.credentials.apiKey}` : "尚未设置 API key"}
      </Copy>
      {provider.credentials?.baseUrl && (
        <Copy muted>当前接口 · {provider.credentials.baseUrl}</Copy>
      )}
      <Field
        label={`${provider.name} API key`}
        value={apiKey}
        onChangeText={(value) => {
          operation.reset();
          setApiKey(value);
        }}
        editable={!operation.busy}
        secureTextEntry
        textContentType="none"
        autoComplete="off"
      />
      <Field
        label={`${provider.name} 接口地址（可选）`}
        hint="留空使用提供商默认地址，填写时替换这家提供商所有模型的接口。"
        value={baseUrl}
        onChangeText={(value) => {
          operation.reset();
          setBaseUrl(value);
        }}
        editable={!operation.busy}
        keyboardType="url"
        placeholder="https://…"
      />
      <Outcome operation={operation} />
      <Button
        title={`保存 ${provider.name}`}
        primary
        disabled={operation.busy || !apiKey.trim()}
        onPress={() => {
          void operation
            .run(() =>
              client.request(path, "PUT", {
                apiKey,
                ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
              }),
            )
            .then((ok) => {
              if (ok) {
                setApiKey("");
                refresh();
                models.refresh();
              }
            });
        }}
      />
      {provider.credentials && (
        <ConfirmButton
          title={`删除 ${provider.name} key`}
          danger
          disabled={operation.busy}
          question={`删除 ${provider.name} 的 key？`}
          message="使用这家提供商的 Agent 将无法请求模型，直到重新保存 key。"
          confirmLabel="删除 key"
          onConfirm={() => {
            void operation
              .run(() => client.request(path, "DELETE"), "已删除 key。")
              .then((ok) => {
                if (ok) {
                  setApiKey("");
                  setBaseUrl("");
                  refresh();
                  models.refresh();
                }
              });
          }}
        />
      )}
      <Button
        title={catalog ? "收起模型目录" : `查看 ${provider.name} 模型目录`}
        onPress={() => setCatalog(!catalog)}
      />
      {catalog && (
        <>
          <ErrorLine error={models.error} />
          <Loading loading={models.loading} />
          {!provider.credentials && <Copy muted>保存 key 后可查看可用模型。</Copy>}
          {models.data
            ?.filter((model) => model.provider === provider.provider)
            .map((model) => (
              <Card key={model.modelId}>
                <Copy>{model.name}</Copy>
                <Copy muted>{model.modelId}</Copy>
                <Copy muted>上下文窗口 {model.contextWindow.toLocaleString()} tokens</Copy>
                <Copy muted>思考级别 · {model.thinkingLevels.join("、") || "默认"}</Copy>
              </Card>
            ))}
        </>
      )}
    </Card>
  );
}
export function Providers() {
  const providers = useResource<ProviderView[]>("/api/admin/providers");
  return (
    <Screen onRefresh={providers.refresh} refreshing={providers.loading}>
      <Copy muted>凭据保存在控制面。修改从下一次模型请求起生效。</Copy>
      <ErrorLine error={providers.error} />
      <Loading loading={providers.loading && !providers.data} />
      {providers.data?.map((provider) => (
        <Provider key={provider.provider} provider={provider} refresh={providers.refresh} />
      ))}
    </Screen>
  );
}
