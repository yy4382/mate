import { useCallback, useState, type FormEvent } from "react";
import type { ModelProviderSummary } from "@mate/protocol/owner";
import { redirectToLogin } from "../../navigation.js";
import { errorMessage } from "./agent-requests.js";

export function useModelCredentials() {
  const [credentialProvider, setCredentialProvider] = useState("openai");
  const [credentialKey, setCredentialKey] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [credentialSaved, setCredentialSaved] = useState(false);
  const reconcileProviders = useCallback((providers: ModelProviderSummary[]) => {
    setCredentialProvider((current) =>
      providers.some((provider) => provider.id === current) ? current : (providers[0]?.id ?? ""),
    );
  }, []);
  async function submitCredential(event: FormEvent<HTMLFormElement>, refresh: () => Promise<void>) {
    event.preventDefault();
    if (!credentialProvider || !credentialKey) return;
    setCredentialBusy(true);
    setCredentialError(null);
    setCredentialSaved(false);
    try {
      const response = await fetch(
        `/api/owner/model-credentials/${encodeURIComponent(credentialProvider)}`,
        {
          method: "PUT",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: credentialKey }),
        },
      );
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(result, "无法保存模型凭据，请重试。"));
      setCredentialKey("");
      setCredentialSaved(true);
      await refresh();
    } catch (reason) {
      setCredentialError(reason instanceof Error ? reason.message : "无法保存模型凭据，请重试。");
    } finally {
      setCredentialBusy(false);
    }
  }

  async function revokeCredential(provider: string, refresh: () => Promise<void>) {
    setCredentialBusy(true);
    setCredentialError(null);
    try {
      const response = await fetch(`/api/owner/model-credentials/${encodeURIComponent(provider)}`, {
        method: "DELETE",
        headers: { Accept: "application/json" },
      });
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      if (!response.ok) throw new Error("无法撤销模型服务凭据。");
      await refresh();
    } catch (reason) {
      setCredentialError(reason instanceof Error ? reason.message : "无法撤销模型服务凭据。");
    } finally {
      setCredentialBusy(false);
    }
  }

  return {
    credentialProvider,
    setCredentialProvider,
    credentialKey,
    setCredentialKey,
    credentialBusy,
    credentialError,
    credentialSaved,
    reconcileProviders,
    submitCredential,
    revokeCredential,
  };
}
