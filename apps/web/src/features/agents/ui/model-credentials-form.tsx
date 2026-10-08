import type { ModelCredentialSummary, ModelProviderSummary } from "@mate/protocol/owner";
import type { useModelCredentials } from "../data/use-model-credentials.js";

export function ModelCredentialsForm({
  providers,
  credentials,
  controls,
  refresh,
}: {
  providers: ModelProviderSummary[];
  credentials: ModelCredentialSummary[];
  controls: Omit<ReturnType<typeof useModelCredentials>, "reconcileProviders">;
  refresh: () => Promise<void>;
}) {
  const {
    credentialProvider,
    setCredentialProvider,
    credentialKey,
    setCredentialKey,
    credentialBusy,
    credentialError,
    credentialSaved,
    submitCredential,
    revokeCredential,
  } = controls;
  return (
    <section className="agent-form-section" aria-labelledby="model-credentials-title">
      <div className="agents-section-heading">
        <h2 id="model-credentials-title">模型服务凭据</h2>
      </div>
      <p className="agents-intro">
        每家服务保存一份 API key。页面只显示已配置状态；运行开始时控制面才会把 key 发送给节点。
      </p>
      <form className="agent-form" onSubmit={(event) => void submitCredential(event, refresh)}>
        <label>
          模型服务
          <select
            required
            value={credentialProvider}
            disabled={credentialBusy || providers.length === 0}
            onChange={(event) => setCredentialProvider(event.target.value)}
          >
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          API key
          <input
            type="password"
            autoComplete="new-password"
            required
            value={credentialKey}
            disabled={credentialBusy || providers.length === 0}
            onChange={(event) => setCredentialKey(event.target.value)}
          />
        </label>
        {credentialError && (
          <p className="form-error" role="alert">
            {credentialError}
          </p>
        )}
        {credentialSaved && (
          <p className="agent-field-hint" role="status">
            凭据已保存；服务列表不会显示 key。
          </p>
        )}
        <ul className="model-credential-list" aria-label="已配置模型服务">
          {credentials.map((credential) => (
            <li key={credential.provider}>
              {providers.find((provider) => provider.id === credential.provider)?.name ??
                credential.provider}
              <span>已配置</span>
              <button
                type="button"
                disabled={credentialBusy}
                onClick={() => void revokeCredential(credential.provider, refresh)}
              >
                撤销 API key
              </button>
            </li>
          ))}
        </ul>
        <button type="submit" disabled={credentialBusy || !credentialProvider || !credentialKey}>
          {credentialBusy ? "正在保存…" : "保存或替换 API key"}
        </button>
      </form>
    </section>
  );
}
