import { useCallback, useEffect, useState } from "react";
import {
  CONNECTION_PROVIDERS,
  type ConnectionConfig,
  type ConnectionProvider,
  type ConnectionVisibility,
  type OwnConnection,
} from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { ConnectionGlyph } from "@/components/connections/connection-badges";
import {
  ApiError,
  disconnectConnection,
  fetchConnectionConfig,
  fetchMyConnections,
  startConnection,
  updateConnectionVisibility,
} from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";

const PROVIDER_NAME: Record<ConnectionProvider, MessageKey> = {
  steam: "connections.provider.steam",
  battlenet: "connections.provider.battlenet",
  twitch: "connections.provider.twitch",
};

const VISIBILITY_LABEL: Record<ConnectionVisibility, MessageKey> = {
  hidden: "settings.connections.visibility.hidden",
  shared: "settings.connections.visibility.shared",
  public: "settings.connections.visibility.public",
};

export function ConnectionsSection() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<ConnectionConfig | null>(null);
  const [connections, setConnections] = useState<OwnConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ConnectionProvider | null>(null);

  const reload = useCallback(async () => {
    const [nextConfig, mine] = await Promise.all([
      fetchConnectionConfig(),
      fetchMyConnections(),
    ]);
    setConfig(nextConfig);
    setConnections(mine.connections);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await reload();
      } catch (caught) {
        if (!alive) {
          return;
        }
        setError(
          caught instanceof ApiError
            ? caught.message
            : t("settings.connections.loadFailed"),
        );
        setConfig({ steam: false, battlenet: false, twitch: false });
        setConnections([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [reload, t]);

  const byProvider = new Map(
    (connections ?? []).map((row) => [row.provider, row]),
  );
  const anyEnabled =
    config?.steam || config?.battlenet || config?.twitch;

  async function connect(provider: ConnectionProvider) {
    setError(null);
    setBusy(provider);
    try {
      const { url } = await startConnection(provider);
      window.location.assign(url);
    } catch (caught) {
      setBusy(null);
      setError(
        caught instanceof ApiError
          ? caught.message
          : t("settings.connections.connectFailed"),
      );
    }
  }

  async function setVisibility(
    provider: ConnectionProvider,
    visibility: ConnectionVisibility,
  ) {
    setError(null);
    setBusy(provider);
    try {
      const { connection } = await updateConnectionVisibility(
        provider,
        visibility,
      );
      setConnections((current) =>
        (current ?? []).map((row) =>
          row.provider === provider ? connection : row,
        ),
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : t("settings.connections.saveFailed"),
      );
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(provider: ConnectionProvider) {
    setError(null);
    setBusy(provider);
    try {
      await disconnectConnection(provider);
      setConnections((current) =>
        (current ?? []).filter((row) => row.provider !== provider),
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : t("settings.connections.disconnectFailed"),
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-paper-muted">
        {t("settings.connections.intro")}
      </p>
      {!anyEnabled && config && (
        <p className="text-sm text-paper-muted">
          {t("settings.connections.unconfigured")}
        </p>
      )}
      <ul className="space-y-3">
        {CONNECTION_PROVIDERS.map((provider) => {
          const enabled = config?.[provider] === true;
          const linked = byProvider.get(provider);
          return (
            <li
              key={provider}
              className="rounded-lg border border-ink-4 bg-ink-3/40 px-3 py-3"
            >
              <div className="flex items-start gap-3">
                <ConnectionGlyph provider={provider} className="mt-0.5 h-6 w-6" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-paper">
                    {t(PROVIDER_NAME[provider])}
                  </p>
                  {linked ? (
                    <p className="mt-0.5 truncate font-mono text-xs text-signal">
                      {linked.displayName}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-xs text-paper-muted">
                      {enabled
                        ? t("settings.connections.notLinked")
                        : t("settings.connections.providerOff")}
                    </p>
                  )}
                </div>
                {linked ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={busy === provider}
                    onClick={() => void disconnect(provider)}
                  >
                    {t("settings.connections.disconnect")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    disabled={!enabled || busy === provider}
                    onClick={() => void connect(provider)}
                  >
                    {t("settings.connections.connect")}
                  </Button>
                )}
              </div>
              {linked && (
                <label className="mt-3 flex flex-col gap-1 text-xs text-paper-muted">
                  {t("settings.connections.visibility.label")}
                  <select
                    className="h-9 rounded-md border border-ink-4 bg-ink px-2 text-sm text-paper"
                    value={linked.visibility}
                    disabled={busy === provider}
                    onChange={(event) =>
                      void setVisibility(
                        provider,
                        event.target.value as ConnectionVisibility,
                      )
                    }
                  >
                    {(["hidden", "shared", "public"] as const).map((value) => (
                      <option key={value} value={value}>
                        {t(VISIBILITY_LABEL[value])}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
