import { t } from "../i18n.ts";
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
                {credentials === null ? t("Providers.notSet") : t("Providers.configured")}
              </Badge>
            </div>
            {credentials === null ? null : (
              <p className="break-all font-mono text-xs text-muted">
                {t("Providers.maskedKey", { key: credentials.apiKey })}
                {credentials.baseUrl === null
                  ? ""
                  : t("Providers.endpoint", { url: credentials.baseUrl })}
              </p>
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t("common.apiKey")}>
              <Input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                required
              />
            </Field>
            <Field label={t("Providers.apiEndpointOptional")}>
              <Input
                type="url"
                placeholder={t("common.urlPlaceholder")}
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
              {t("Providers.deleteKey")}
            </Button>
          )}
          <Button type="submit" variant="primary">
            {t("Providers.save")}
          </Button>
        </CardFooter>
      </form>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("Providers.deleteNamedKey", { name: provider.name })}
        description={t("Providers.agentsUsingThisProvidersModelsWillNotReceive")}
        confirmLabel={t("Providers.deleteKey")}
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
        title={t("Providers.modelProviders")}
        description={t("Providers.saveAnApiKeyToUseThisProviders")}
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
