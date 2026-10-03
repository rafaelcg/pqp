import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import {
  CONNECTION_PROVIDERS,
  type ConnectionConfig,
  type ConnectionProvider,
  type ConnectionVisibility,
  type OwnConnection,
} from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ConnectionGlyph,
  UPCOMING_CONNECTION_PROVIDERS,
  type ConnectionGlyphProvider,
} from "@/components/connections/connection-badges";
import {
  SettingsGroup,
  SettingsInlineStatus,
  SettingsNotice,
  SettingsRow,
  SettingsSelect,
  useInlineSave,
} from "@/components/settings/kit";
import {
  ApiError,
  disconnectConnection,
  fetchConnectionConfig,
  fetchMyConnections,
  startConnection,
  updateConnectionVisibility,
} from "@/lib/api";
import { takeConnectionErrorFromWindow } from "@/lib/connection-callback";
import { useTranslation, type MessageKey } from "@/lib/i18n";

const PROVIDER_NAME: Record<ConnectionGlyphProvider, MessageKey> = {
  steam: "connections.provider.steam",
  battlenet: "connections.provider.battlenet",
  twitch: "connections.provider.twitch",
  youtube: "connections.provider.youtube",
  riot: "connections.provider.riot",
  roblox: "connections.provider.roblox",
  github: "connections.provider.github",
};

const VISIBILITY_LABEL: Record<ConnectionVisibility, MessageKey> = {
  hidden: "settings.connections.visibility.hidden",
  shared: "settings.connections.visibility.shared",
  public: "settings.connections.visibility.public",
};

const VISIBILITIES = ["hidden", "shared", "public"] as const;

/** An `ApiError` says what the server refused; anything else gets our sentence. */
function apiMessage(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback;
}

type Load =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; config: ConnectionConfig; connections: OwnConnection[] };

export function ConnectionsSection() {
  const { t } = useTranslation();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const linkedTitle = t("settings.connections.group.linked.title");
  const linkedDescription = t("settings.connections.group.linked.description");

  useEffect(() => {
    const stashed = takeConnectionErrorFromWindow();
    if (stashed) {
      setCallbackError(stashed);
    }
  }, []);

  const reload = useCallback(
    async (isAlive: () => boolean = () => true) => {
      setLoad({ kind: "loading" });
      try {
        const [config, mine] = await Promise.all([
          fetchConnectionConfig(),
          fetchMyConnections(),
        ]);
        if (isAlive()) {
          setLoad({ kind: "ready", config, connections: mine.connections });
        }
      } catch (caught) {
        if (isAlive()) {
          setLoad({
            kind: "failed",
            message: apiMessage(caught, t("settings.connections.loadFailed")),
          });
        }
      }
    },
    [t],
  );

  useEffect(() => {
    let alive = true;
    void reload(() => alive);
    return () => {
      alive = false;
    };
  }, [reload]);

  const replace = useCallback((provider: ConnectionProvider, next: OwnConnection | null) => {
    setLoad((current) => {
      if (current.kind !== "ready") {
        return current;
      }
      return {
        ...current,
        connections: next
          ? current.connections.map((row) => (row.provider === provider ? next : row))
          : current.connections.filter((row) => row.provider !== provider),
      };
    });
  }, []);

  const clearCallbackError = useCallback(() => setCallbackError(null), []);

  const callbackNotice = callbackError ? (
    <SettingsNotice tone="danger" inGroup>
      {callbackError}
    </SettingsNotice>
  ) : null;

  // A provider shows as a row when this server can link it, or when the
  // account already has it linked (it can still be hidden or removed).
  // Everything else is "Em breve", the same as today's "Em breve" line.
  const ready = load.kind === "ready" ? load : null;
  const byProvider = new Map(
    (ready?.connections ?? []).map((row) => [row.provider, row]),
  );
  const rowProviders = ready
    ? CONNECTION_PROVIDERS.filter(
        (provider) => ready.config[provider] === true || byProvider.has(provider),
      )
    : [];
  const anyEnabled = ready
    ? CONNECTION_PROVIDERS.some((provider) => ready.config[provider] === true)
    : false;
  const soonProviders: ConnectionGlyphProvider[] = [
    ...(ready
      ? CONNECTION_PROVIDERS.filter((provider) => !rowProviders.includes(provider))
      : []),
    ...UPCOMING_CONNECTION_PROVIDERS,
  ];

  return (
    <div className="space-y-6">
      <SettingsGroup title={linkedTitle} description={linkedDescription}>
        {callbackNotice}
        {load.kind === "loading" ? (
          <div aria-busy="true" aria-label={t("settings.connections.loading")}>
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="flex min-h-12 items-center gap-3 border-border px-4 py-3 [&:not(:first-child)]:border-t"
              >
                <Skeleton className="h-9 w-9 shrink-0 rounded-[var(--radius-card)]" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-3 w-40" />
                </div>
                <Skeleton className="h-[var(--control-sm)] w-20" />
              </div>
            ))}
          </div>
        ) : null}
        {load.kind === "failed" ? (
          <SettingsNotice
            tone="danger"
            inGroup
            action={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  clearCallbackError();
                  void reload();
                }}
              >
                {t("settings.connections.retry")}
              </Button>
            }
          >
            {load.message}
          </SettingsNotice>
        ) : null}
        {ready && !anyEnabled ? (
          <SettingsNotice tone="info" inGroup>
            {t("settings.connections.unconfigured")}
          </SettingsNotice>
        ) : null}
        {ready
          ? rowProviders.map((provider) => (
              <ProviderRow
                key={provider}
                provider={provider}
                linked={byProvider.get(provider) ?? null}
                onChanged={replace}
                onAction={clearCallbackError}
              />
            ))
          : null}
      </SettingsGroup>

      <SettingsGroup title={t("settings.connections.comingSoon")}>
        <ul className="flex flex-wrap gap-x-5 gap-y-2 px-4 py-3">
          {soonProviders.map((provider) => (
            <li
              key={provider}
              className="flex items-center gap-2 text-sm text-text-tertiary"
            >
              <ConnectionGlyph provider={provider} className="h-5 w-5" />
              {t(PROVIDER_NAME[provider])}
            </li>
          ))}
        </ul>
      </SettingsGroup>
    </div>
  );
}

function ProviderRow({
  provider,
  linked,
  onChanged,
  onAction,
}: {
  provider: ConnectionProvider;
  linked: OwnConnection | null;
  onChanged: (provider: ConnectionProvider, next: OwnConnection | null) => void;
  onAction: () => void;
}) {
  const { t } = useTranslation();
  const selectId = useId();
  const visibility = useInlineSave();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const name = t(PROVIDER_NAME[provider]);
  const saving = visibility.state.kind === "saving";
  const disabled = busy || saving;

  async function connect() {
    onAction();
    setActionError(null);
    setBusy(true);
    try {
      const { url } = await startConnection(provider);
      window.location.assign(url);
    } catch (caught) {
      setBusy(false);
      setActionError(apiMessage(caught, t("settings.connections.connectFailed")));
    }
  }

  function changeVisibility(next: ConnectionVisibility) {
    onAction();
    setActionError(null);
    const fallback = t("settings.connections.saveFailed");
    void visibility.run(async () => {
      try {
        const { connection } = await updateConnectionVisibility(provider, next);
        onChanged(provider, connection);
      } catch (caught) {
        throw new Error(apiMessage(caught, fallback));
      }
    }, fallback);
  }

  async function disconnect() {
    onAction();
    setActionError(null);
    setBusy(true);
    try {
      await disconnectConnection(provider);
      onChanged(provider, null);
    } catch (caught) {
      setActionError(apiMessage(caught, t("settings.connections.disconnectFailed")));
    } finally {
      setBusy(false);
    }
  }

  const status = actionError ? (
    <SettingsInlineStatus state={{ kind: "error", message: actionError }} />
  ) : (
    <SettingsInlineStatus state={visibility.state} />
  );

  const control = linked ? (
    <div className="flex w-full flex-col gap-1.5 @lg:w-auto">
      <label
        htmlFor={selectId}
        className="text-xs text-text-tertiary @lg:sr-only"
      >
        {t("settings.connections.visibility.label")}
      </label>
      <div className="flex items-center gap-2">
        <SettingsSelect
          id={selectId}
          className="min-w-0 flex-1 @lg:w-56 @lg:flex-none"
          value={linked.visibility}
          disabled={disabled}
          onChange={(event) =>
            changeVisibility(event.target.value as ConnectionVisibility)
          }
        >
          {VISIBILITIES.map((value) => (
            <option key={value} value={value}>
              {t(VISIBILITY_LABEL[value])}
            </option>
          ))}
        </SettingsSelect>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 text-sm"
          disabled={disabled}
          onClick={() => setConfirming(true)}
        >
          {busy ? <Spinner /> : null}
          {t("settings.connections.disconnect")}
        </Button>
      </div>
    </div>
  ) : (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      disabled={disabled}
      onClick={() => void connect()}
    >
      {busy ? <Spinner /> : null}
      {t("settings.connections.connect")}
    </Button>
  );

  return (
    <div className="flex items-start gap-3 pl-4 @lg:items-center">
      <ConnectionGlyph
        provider={provider}
        className="mt-3 h-9 w-9 rounded-[var(--radius-card)] p-2 @lg:mt-0"
      />
      <div className="min-w-0 flex-1 [&>[data-settings-row]]:pl-0">
        <SettingsRow
          id={provider}
          label={name}
          description={
            linked
              ? t("settings.connections.linkedAs", { name: linked.displayName })
              : t("settings.connections.notLinked")
          }
          control={control}
          status={status}
        />
      </div>
      <ConfirmDialog
        open={confirming}
        title={t("settings.connections.disconnectConfirm.title", { provider: name })}
        description={t("settings.connections.disconnectConfirm.body")}
        confirmLabel={t("settings.connections.disconnectConfirm.confirm")}
        cancelLabel={t("settings.connections.disconnectConfirm.cancel")}
        onConfirm={() => void disconnect()}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}

function Spinner() {
  return <Loader2 aria-hidden className="h-3.5 w-3.5 motion-safe:animate-spin" />;
}
