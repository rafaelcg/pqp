import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  CONNECTION_PROVIDERS,
  type ConnectionConfig,
  type ConnectionProvider,
  type ConnectionVisibility,
  type OwnConnection,
} from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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
  SettingsSkeletonRows,
  inlineErrorMessage,
  useInlineSave,
} from "@/components/settings/kit";
import {
  disconnectConnection,
  fetchConnectionConfig,
  fetchMyConnections,
  startConnection,
  updateConnectionVisibility,
} from "@/lib/api";
import { takeConnectionErrorFromWindow } from "@/lib/connection-callback";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

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

/** Splits "Conectado como {name}" so the name can be drawn on its own. */
const NAME_SLOT = "\u0000";

/** A busy button keeps focus: it looks disabled and ignores the click. */
const BLOCKED_BUTTON = "cursor-not-allowed opacity-40 active:scale-100";

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
            message: inlineErrorMessage(caught, t("settings.connections.loadFailed")),
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
    ...CONNECTION_PROVIDERS.filter((provider) => !rowProviders.includes(provider)),
    ...UPCOMING_CONNECTION_PROVIDERS,
  ];

  return (
    <div className="space-y-6">
      <SettingsGroup title={linkedTitle} description={linkedDescription}>
        {callbackNotice}
        {load.kind === "loading" ? (
          <SettingsSkeletonRows
            label={t("settings.connections.loading")}
            leading="tile"
            count={3}
          />
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

      {/* Drawn once the config is known, so the list does not grow when the
          providers this server has not set up join it. */}
      {ready ? (
        <SettingsGroup title={t("settings.connections.comingSoon")}>
          <ul className="flex flex-wrap gap-x-5 gap-y-2 px-4 py-3">
            {soonProviders.map((provider) => (
              <li
                key={provider}
                className="flex items-center gap-2 text-sm text-text-tertiary"
              >
                <ConnectionGlyph
                  provider={provider}
                  className="h-5 w-5 opacity-60"
                />
                {t(PROVIDER_NAME[provider])}
              </li>
            ))}
          </ul>
        </SettingsGroup>
      ) : null}
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
  const nameId = useId();
  const visibility = useInlineSave();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The option just picked, shown while its write runs, so the select does
  // not snap back to the old value under "Salvando…".
  const [pending, setPending] = useState<ConnectionVisibility | null>(null);
  const latestSave = useRef(0);
  // The row's Conectar or Desconectar button. The confirm dialog cannot hand
  // focus back on its own (it opens onto its autofocused Cancel), and a
  // successful disconnect swaps Desconectar for Conectar, so the row does it.
  const actionRef = useRef<HTMLButtonElement>(null);
  const refocusAction = useRef(false);
  const name = t(PROVIDER_NAME[provider]);

  useEffect(() => {
    if (refocusAction.current && linked === null) {
      refocusAction.current = false;
      actionRef.current?.focus();
    }
  }, [linked]);

  const saving = visibility.state.kind === "saving";
  // Busy buttons stay focusable (aria-disabled, click ignored) so keyboard
  // focus does not drop to the page while the request runs.
  const buttonsBlocked = busy || saving;

  async function connect() {
    if (buttonsBlocked) return;
    onAction();
    setActionError(null);
    setBusy(true);
    try {
      const { url } = await startConnection(provider);
      window.location.assign(url);
    } catch (caught) {
      setBusy(false);
      setActionError(inlineErrorMessage(caught, t("settings.connections.connectFailed")));
    }
  }

  function changeVisibility(next: ConnectionVisibility) {
    onAction();
    setActionError(null);
    setPending(next);
    const save = ++latestSave.current;
    void visibility.run(async () => {
      try {
        const { connection } = await updateConnectionVisibility(provider, next);
        if (save === latestSave.current) onChanged(provider, connection);
      } finally {
        if (save === latestSave.current) setPending(null);
      }
    }, t("settings.connections.saveFailed"));
  }

  async function disconnect() {
    onAction();
    setActionError(null);
    setBusy(true);
    try {
      await disconnectConnection(provider);
      refocusAction.current = true;
      onChanged(provider, null);
    } catch (caught) {
      setActionError(
        inlineErrorMessage(caught, t("settings.connections.disconnectFailed")),
      );
    } finally {
      setBusy(false);
    }
  }

  const status = actionError ? (
    <SettingsInlineStatus state={{ kind: "error", message: actionError }} />
  ) : (
    <SettingsInlineStatus state={visibility.state} />
  );

  const blockedProps = buttonsBlocked
    ? { "aria-disabled": true as const, className: BLOCKED_BUTTON }
    : {};

  // The provider's name, so each row's select and buttons are told apart
  // ("Quem vê isso, Steam") while the visible text stays the same.
  const nameSpan = (
    <span id={nameId} hidden>
      {name}
    </span>
  );

  const control = linked ? (
    <div className="flex flex-col gap-1.5">
      {nameSpan}
      <label htmlFor={selectId} className="text-xs text-text-tertiary @lg:sr-only">
        {t("settings.connections.visibility.label")}
      </label>
      <div className="flex flex-wrap items-center gap-2 @lg:flex-col @lg:items-end @lg:gap-1">
        <SettingsSelect
          id={selectId}
          aria-describedby={nameId}
          className="basis-full @lg:w-auto @lg:basis-auto"
          value={pending ?? linked.visibility}
          disabled={busy}
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
          ref={actionRef}
          variant="ghost"
          size="sm"
          aria-describedby={nameId}
          aria-busy={busy || undefined}
          {...blockedProps}
          className={cn("shrink-0 text-sm", blockedProps.className)}
          onClick={() => {
            if (!buttonsBlocked) setConfirming(true);
          }}
        >
          {busy ? <Spinner /> : null}
          {t("settings.connections.disconnect")}
        </Button>
      </div>
    </div>
  ) : (
    <>
      {nameSpan}
      <Button
        type="button"
        ref={actionRef}
        variant="secondary"
        size="sm"
        aria-describedby={nameId}
        aria-busy={busy || undefined}
        {...blockedProps}
        onClick={() => void connect()}
      >
        {busy ? <Spinner /> : null}
        {t("settings.connections.connect")}
      </Button>
    </>
  );

  return (
    <>
      <SettingsRow
        id={provider}
        label={name}
        searchable={false}
        leading={
          <ConnectionGlyph
            provider={provider}
            className="h-9 w-9 rounded-[var(--radius-card)] p-2"
          />
        }
        description={
          linked ? (
            <LinkedAs name={linked.displayName} />
          ) : (
            t("settings.connections.notLinked")
          )
        }
        control={control}
        // On a wide pane the select sits beside the label with Desconectar
        // under it, which fits the longest option; on a phone both go under
        // the label at full width. Conectar stays beside the label always.
        wideControl={linked !== null}
        keepInline={linked === null}
        status={status}
      />
      <ConfirmDialog
        open={confirming}
        title={t("settings.connections.disconnectConfirm.title", { provider: name })}
        description={t("settings.connections.disconnectConfirm.body")}
        confirmLabel={t("settings.connections.disconnectConfirm.confirm")}
        cancelLabel={t("settings.connections.disconnectConfirm.cancel")}
        onConfirm={() => void disconnect()}
        onClose={() => {
          setConfirming(false);
          window.setTimeout(() => actionRef.current?.focus(), 0);
        }}
      />
    </>
  );
}

/** "Conectado como {name}", with the account's own name set in mono. */
function LinkedAs({ name }: { name: string }) {
  const { t } = useTranslation();
  const [before, after = ""] = t("settings.connections.linkedAs", {
    name: NAME_SLOT,
  }).split(NAME_SLOT);
  return (
    <>
      {before}
      <span className="font-mono break-all text-text-secondary">{name}</span>
      {after}
    </>
  );
}

function Spinner() {
  return <Loader2 aria-hidden className="h-3.5 w-3.5 motion-safe:animate-spin" />;
}
