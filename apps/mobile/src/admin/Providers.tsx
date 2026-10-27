import type { CatalogModel, ProviderView } from "@mate/admin";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { FlatList, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { useQueryClient } from "@tanstack/react-query";
import { useClient, useOperation, useResource } from "./session";
import { ErrorLine, Outcome } from "./ui";
import {
  Button,
  Card,
  Caption,
  ConfirmButton,
  Copy,
  Empty,
  Field,
  Loading,
  Row,
  Screen,
  Section,
  Sheet,
} from "../ui";

export function Providers({
  onOpenProvider = (provider) =>
    router.push({ pathname: "/admin/providers/[provider]", params: { provider } }),
}: {
  onOpenProvider?: (provider: ProviderView["provider"]) => void;
} = {}) {
  const providers = useResource<ProviderView[]>("/api/admin/providers");
  return (
    <Screen onRefresh={providers.refresh} refreshing={providers.loading}>
      <ErrorLine error={providers.error} />
      {providers.error != null && <Button title="重新读取" onPress={providers.refresh} />}
      <Loading loading={providers.loading && !providers.data} />
      {providers.data && (
        <Section footer="凭据保存在服务器。已保存不代表已验证连接。">
          {providers.data.map((p) => (
            <Row
              key={p.provider}
              title={p.name}
              value={p.credentials ? "已保存" : "未设置"}
              onPress={() => onOpenProvider(p.provider)}
            />
          ))}
        </Section>
      )}
    </Screen>
  );
}

export function ProviderDetail({
  onOpenCatalog = (provider) =>
    router.push({ pathname: "/admin/providers/catalog", params: { provider } }),
}: {
  onOpenCatalog?: (provider: ProviderView["provider"]) => void;
} = {}) {
  const { provider: id } = useLocalSearchParams<{ provider: string }>();
  const providers = useResource<ProviderView[]>("/api/admin/providers");
  const provider = providers.data?.find((p) => p.provider === id);
  const client = useClient();
  const queries = useQueryClient();
  const operation = useOperation();
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const path = `/api/admin/providers/${encodeURIComponent(id)}/credentials`;
  const refresh = () => {
    providers.refresh();
    void queries.invalidateQueries({ queryKey: ["/api/admin/models"] });
  };
  return (
    <Screen onRefresh={providers.refresh} refreshing={providers.loading}>
      <Stack.Screen options={{ title: provider?.name ?? "提供商" }} />
      <ErrorLine error={providers.error} />
      <Loading loading={providers.loading && !providers.data} />
      {providers.error != null && <Button title="重新读取" onPress={providers.refresh} />}
      {providers.data && !provider && <Empty title="找不到这个提供商" />}
      {provider && (
        <>
          <Section title="凭据" footer="修改从下一次模型请求起生效。">
            <Row title="API key" value={provider.credentials ? "已保存" : "未设置"} />
            {provider.credentials && (
              <Row title="已保存的密钥" subtitle={provider.credentials.apiKey} />
            )}
            <Row title="接口地址" subtitle={provider.credentials?.baseUrl ?? "提供商默认地址"} />
            <Row
              title={provider.credentials ? "编辑凭据" : "设置凭据"}
              onPress={() => {
                operation.reset();
                setBaseUrl(provider.credentials?.baseUrl ?? "");
                setEditing(true);
              }}
            />
          </Section>
          <Section>
            <Row
              title="模型目录"
              subtitle="模型标识、上下文窗口与思考级别"
              onPress={() => onOpenCatalog(provider.provider)}
            />
          </Section>
          {!editing && <Outcome operation={operation} />}
          {provider.credentials && (
            <ConfirmButton
              title="删除凭据"
              question={`删除 ${provider.name} 的凭据？`}
              message="使用这家提供商的 Agent 将无法请求模型，直到重新保存密钥。"
              confirmLabel="删除凭据"
              danger
              disabled={operation.busy}
              onConfirm={() => {
                void operation
                  .run(() => client.request(path, "DELETE"), "凭据已删除。")
                  .then((ok) => {
                    if (ok) {
                      setApiKey("");
                      refresh();
                    }
                  });
              }}
            />
          )}
          <Sheet
            title={`编辑 ${provider.name} 凭据`}
            visible={editing}
            onClose={() => setEditing(false)}
          >
            <Card>
              <Field
                label="API key"
                hint="每次保存都需要完整密钥，包括只修改接口地址时。"
                value={apiKey}
                onChangeText={(v) => {
                  operation.reset();
                  setApiKey(v);
                }}
                editable={!operation.busy}
                secureTextEntry
                textContentType="none"
                autoComplete="off"
              />
              <Field
                label="接口地址（可选）"
                hint="留空使用默认地址。填写时替换这家提供商所有模型的接口。"
                value={baseUrl}
                onChangeText={(v) => {
                  operation.reset();
                  setBaseUrl(v);
                }}
                editable={!operation.busy}
                keyboardType="url"
                placeholder="https://…"
              />
              <Outcome operation={operation} />
            </Card>
            <Button
              title={operation.busy ? "保存中…" : "保存凭据"}
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
                      setEditing(false);
                      refresh();
                    }
                  });
              }}
            />
          </Sheet>
        </>
      )}
    </Screen>
  );
}

export function ProviderCatalog() {
  const { provider: id } = useLocalSearchParams<{ provider: string }>();
  const providers = useResource<ProviderView[]>("/api/admin/providers");
  const models = useResource<CatalogModel[]>("/api/admin/models");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<CatalogModel | null>(null);
  const c = useTheme();
  const provider = providers.data?.find((p) => p.provider === id);
  const catalog = provider?.credentials
    ? (models.data?.filter(
        (m) =>
          m.provider === id &&
          `${m.name} ${m.modelId}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      ) ?? [])
    : [];
  const refresh = () => {
    providers.refresh();
    models.refresh();
  };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.background }} edges={["left", "right"]}>
      <Stack.Screen options={{ title: `${provider?.name ?? "提供商"} 模型目录` }} />
      <FlatList
        data={catalog}
        keyExtractor={(m) => m.modelId}
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        ListHeaderComponent={
          <View style={{ gap: 16, paddingBottom: 16 }}>
            <ErrorLine error={providers.error ?? models.error} />
            {(providers.error ?? models.error) != null && (
              <Button title="重新读取" onPress={refresh} />
            )}
            <Loading
              loading={
                (providers.loading && !providers.data) ||
                (!!provider?.credentials && models.loading && !models.data)
              }
            />
            {provider?.credentials && (
              <Field
                label="搜索模型"
                placeholder="名称或完整模型标识"
                value={query}
                onChangeText={setQuery}
                clearButtonMode="while-editing"
              />
            )}
            {providers.data && !provider && <Empty title="找不到这个提供商" />}
            {provider && !provider.credentials && (
              <Empty title="先设置凭据" message="保存这家提供商的 API key 后可查看模型目录。">
                <Button title="返回提供商" onPress={() => router.back()} />
              </Empty>
            )}
            {provider?.credentials && models.data && catalog.length === 0 && (
              <Empty title="没有匹配模型" message="换一个关键词试试。" />
            )}
          </View>
        }
        renderItem={({ item }) => (
          <Row
            title={item.name}
            subtitle={item.modelId}
            value={`${item.contextWindow.toLocaleString()} tokens`}
            onPress={() => setSelected(item)}
          />
        )}
        ListFooterComponent={
          provider?.credentials ? (
            <View style={{ padding: 16 }}>
              <Caption>浏览目录不会改变 Agent 的模型。</Caption>
            </View>
          ) : (
            <></>
          )
        }
      />
      <Sheet title="模型详情" visible={selected !== null} onClose={() => setSelected(null)}>
        {selected && (
          <>
            <Copy title>{selected.name}</Copy>
            <Section title="模型标识">
              <View style={{ padding: 16 }}>
                <Copy mono>{selected.modelId}</Copy>
              </View>
            </Section>
            <Section>
              <Row title="提供商" value={provider?.name ?? id} />
              <Row title="上下文窗口" value={`${selected.contextWindow.toLocaleString()} tokens`} />
              <Row title="思考级别" subtitle={selected.thinkingLevels.join("、") || "默认"} />
            </Section>
          </>
        )}
      </Sheet>
    </SafeAreaView>
  );
}
