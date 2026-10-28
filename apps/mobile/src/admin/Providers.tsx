import { t, thinkingText, listText } from "../i18n";
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
      {providers.error != null && (
        <Button title={t("management.reload")} onPress={providers.refresh} />
      )}
      <Loading loading={providers.loading && !providers.data} />
      {providers.data && (
        <Section footer={t("management.credentials_are_stored_on_the_server_saving")}>
          {providers.data.map((p) => (
            <Row
              key={p.provider}
              title={p.name}
              value={p.credentials ? t("management.saved") : t("management.not_set")}
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
      <Stack.Screen options={{ title: provider?.name ?? t("management.provider") }} />
      <ErrorLine error={providers.error} />
      <Loading loading={providers.loading && !providers.data} />
      {providers.error != null && (
        <Button title={t("management.reload")} onPress={providers.refresh} />
      )}
      {providers.data && !provider && <Empty title={t("management.provider_not_found")} />}
      {provider && (
        <>
          <Section
            title={t("management.credentials")}
            footer={t("management.changes_take_effect_with_the_next_model")}
          >
            <Row
              title={t("management.api_key")}
              value={provider.credentials ? t("management.saved") : t("management.not_set")}
            />
            {provider.credentials && (
              <Row title={t("management.saved_key")} subtitle={provider.credentials.apiKey} />
            )}
            <Row
              title={t("management.api_endpoint")}
              subtitle={provider.credentials?.baseUrl ?? t("management.provider_default_endpoint")}
            />
            <Row
              title={
                provider.credentials
                  ? t("management.edit_credentials")
                  : t("management.set_credentials")
              }
              onPress={() => {
                operation.reset();
                setBaseUrl(provider.credentials?.baseUrl ?? "");
                setEditing(true);
              }}
            />
          </Section>
          <Section>
            <Row
              title={t("management.model_catalog")}
              subtitle={t("management.model_ids_context_windows_and_thinking_levels")}
              onPress={() => onOpenCatalog(provider.provider)}
            />
          </Section>
          {!editing && <Outcome operation={operation} />}
          {provider.credentials && (
            <ConfirmButton
              title={t("management.delete_credentials")}
              question={t("management.delete_provider_credentials", { name: provider.name })}
              message={t("management.agents_using_this_provider_cannot_request_models")}
              confirmLabel={t("management.delete_credentials")}
              danger
              disabled={operation.busy}
              onConfirm={() => {
                void operation
                  .run(() => client.request(path, "DELETE"), t("management.credentials_deleted"))
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
            title={t("management.edit_provider_credentials", { name: provider.name })}
            visible={editing}
            onClose={() => setEditing(false)}
          >
            <Card>
              <Field
                label={t("management.api_key")}
                hint={t("management.enter_the_full_key_each_time_you")}
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
                label={t("management.api_endpoint_optional")}
                hint={t("management.leave_blank_to_use_the_default_endpoint")}
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
              title={operation.busy ? t("settings.saving") : t("management.save_credentials")}
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
      <Stack.Screen
        options={{
          title: t("management.provider_catalog", {
            name: provider?.name ?? t("management.provider"),
          }),
        }}
      />
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
              <Button title={t("management.reload")} onPress={refresh} />
            )}
            <Loading
              loading={
                (providers.loading && !providers.data) ||
                (!!provider?.credentials && models.loading && !models.data)
              }
            />
            {provider?.credentials && (
              <Field
                label={t("management.search_models")}
                placeholder={t("management.name_or_full_model_id")}
                value={query}
                onChangeText={setQuery}
                clearButtonMode="while-editing"
              />
            )}
            {providers.data && !provider && <Empty title={t("management.provider_not_found")} />}
            {provider && !provider.credentials && (
              <Empty
                title={t("management.set_credentials_first")}
                message={t("management.save_this_providers_api_key_to_view")}
              >
                <Button title={t("management.back_to_provider")} onPress={() => router.back()} />
              </Empty>
            )}
            {provider?.credentials && models.data && catalog.length === 0 && (
              <Empty
                title={t("management.no_matching_models")}
                message={t("common.try_another_keyword")}
              />
            )}
          </View>
        }
        renderItem={({ item }) => (
          <Row
            title={item.name}
            subtitle={item.modelId}
            value={t("management.token_count", { count: item.contextWindow })}
            onPress={() => setSelected(item)}
          />
        )}
        ListFooterComponent={
          provider?.credentials ? (
            <View style={{ padding: 16 }}>
              <Caption>{t("management.browsing_the_catalog_does_not_change_the")}</Caption>
            </View>
          ) : (
            <></>
          )
        }
      />
      <Sheet
        title={t("management.model_details")}
        visible={selected !== null}
        onClose={() => setSelected(null)}
      >
        {selected && (
          <>
            <Copy title>{selected.name}</Copy>
            <Section title={t("management.model_id")}>
              <View style={{ padding: 16 }}>
                <Copy mono>{selected.modelId}</Copy>
              </View>
            </Section>
            <Section>
              <Row title={t("management.provider")} value={provider?.name ?? id} />
              <Row
                title={t("management.context_window")}
                value={t("management.token_count", { count: selected.contextWindow })}
              />
              <Row
                title={t("management.thinking_level")}
                subtitle={
                  listText(selected.thinkingLevels.map(thinkingText)) || t("management.default")
                }
              />
            </Section>
          </>
        )}
      </Sheet>
    </SafeAreaView>
  );
}
