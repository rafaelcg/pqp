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
import { Dialog, DialogBody } from "@/components/ui/dialog";
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
  fetchMe,
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

/**
 * Wider than a small screen, so a tap on Conectar is a 44 px target on touch.
 * The pointer media query keeps a mouse at the normal `sm` height.
 */
const TOUCH_TARGET = "pointer-coarse:h-11";

/**
 * Written just before the browser leaves for the provider, read when this tab
 * opens again. A person who backs out of Steam lands on /app with Settings
 * shut and no sign that anything happened; the marker lets Conexões say so.
 * sessionStorage is the same tab, which is the hop we actually make.
 */
const PENDING_KEY = "pqp.connection.pending";
const PENDING_MAX_AGE_MS = 30 * 60 * 1000;

function markConnectionPending(provider: ConnectionProvider) {
  try {
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ provider, at: Date.now() }),
    );
  } catch {
    // Private mode or quota: the cancelled note is a courtesy, not a need.
  }
}

/** Reads and clears the marker. Null when absent, stale or unreadable. */
function takePendingConnection(): ConnectionProvider | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_KEY);
    const parsed = JSON.parse(raw) as { provider?: unknown; at?: unknown };
    if (
      typeof parsed.at !== "number" ||
      Date.now() - parsed.at > PENDING_MAX_AGE_MS
    ) {
      return null;
    }
    return CONNECTION_PROVIDERS.find((provider) => provider === parsed.provider) ?? null;
  } catch {
    return null;
  }
}

type Load =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; config: ConnectionConfig; connections: OwnConnection[] };

export function ConnectionsSection() {
  const { t } = useTranslation();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [callbackError, setCallbackError] = useState<string | null>(null);
  // The person backed out of the provider's page without connecting.
  const [cancelled, setCancelled] = useState(false);
  // undefined until /api/me answers; null means the account has no @ yet.
  const [handle, setHandle] = useState<string | null | undefined>(undefined);
  const pendingRef = useRef<ConnectionProvider | null>(null);
  const linkedTitle = t("settings.connections.group.linked.title");
  const linkedDescription = t("settings.connections.group.linked.description");

  useEffect(() => {
    const stashed = takeConnectionErrorFromWindow();
    if (stashed) {
      setCallbackError(stashed);
    }
    pendingRef.current = pendingRef.current ?? takePendingConnection();
  }, []);

  // Back from the provider's page with this page kept alive (the browser's
  // back-forward cache): the Conectar button is still spinning, and nothing
  // else will say the trip ended.
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted && takePendingConnection()) {
        setCancelled(true);
      }
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  useEffect(() => {
    let alive = true;
    void fetchMe()
      .then((me) => {
        if (alive && me && "handle" in me) {
          setHandle(me.handle ?? null);
        }
      })
      .catch(() => {
        // Without the answer the hint about the public page stays hidden.
      });
    return () => {
      alive = false;
    };
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

  // The trip to the provider ended and the account is still not linked, with
  // no reason from the API: the person cancelled there. A linked account is a
  // success, and a stashed error already says what went wrong.
  useEffect(() => {
    const pending = pendingRef.current;
    if (load.kind !== "ready" || !pending) {
      return;
    }
    pendingRef.current = null;
    const linked = load.connections.some((row) => row.provider === pending);
    if (!linked && !callbackError) {
      setCancelled(true);
    }
  }, [load, callbackError]);

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

  const clearCallbackError = useCallback(() => {
    setCallbackError(null);
    setCancelled(false);
  }, []);

  const callbackNotice = callbackError ? (
    <SettingsNotice tone="danger" inGroup>
      {callbackError}
    </SettingsNotice>
  ) : cancelled ? (
    <SettingsNotice tone="info" inGroup>
      {t("settings.connections.cancelled")}
    </SettingsNotice>
  ) : null;

  // A provider shows as a row when this server can link it, or when the
  // account already has it linked (it can still be hidden or removed).
  // A provider this server has not set up is not "coming soon": it is not
  // offered here, and the person cannot do anything about it.
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
            count={2}
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
                handle={handle}
                onChanged={replace}
                onAction={clearCallbackError}
              />
            ))
          : null}
      </SettingsGroup>

      {/* Drawn once the config is known, so it does not jump in under the
          skeleton when the list arrives. */}
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
  handle,
  onChanged,
  onAction,
}: {
  provider: ConnectionProvider;
  linked: OwnConnection | null;
  /** The account's public @: null when it has none, undefined while unknown. */
  handle: string | null | undefined;
  onChanged: (provider: ConnectionProvider, next: OwnConnection | null) => void;
  onAction: () => void;
}) {
  const { t } = useTranslation();
  const selectId = useId();
  const nameId = useId();
  const hintId = useId();
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

  // Back from the provider's page with this page restored from the browser's
  // cache: the trip is over, so Conectar must not keep spinning.
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

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
      markConnectionPending(provider);
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
  ) : linked ? null : (
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

  // Someone with no @ has no public page, so the last option promises one that
  // is not there. Say how to get it; wait for the answer before saying it.
  const showHandleHint = handle === null;

  const control = linked ? (
    <>
      {nameSpan}
      <Button
        type="button"
        ref={actionRef}
        variant="ghost"
        size="sm"
        aria-describedby={nameId}
        aria-busy={busy || undefined}
        {...blockedProps}
        className={cn(
          "shrink-0 border border-border-strong text-sm text-danger hover:text-danger",
          TOUCH_TARGET,
          blockedProps.className,
        )}
        onClick={() => {
          if (!buttonsBlocked) setConfirming(true);
        }}
      >
        {busy ? <Spinner /> : null}
        {t("settings.connections.disconnect")}
      </Button>
    </>
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
        className={cn(TOUCH_TARGET, blockedProps.className)}
        onClick={() => void connect()}
      >
        {busy ? <Spinner /> : null}
        {t("settings.connections.connect")}
      </Button>
    </>
  );

  // The question is always visible, at every width, with the select under it
  // and lined up with the name (the tile is 2.25rem plus a 0.75rem gap).
  const visibilityControl = linked ? (
    <div className="flex max-w-[22.5rem] flex-col gap-1.5 @lg:ml-12">
      <label htmlFor={selectId} className="text-xs text-text-tertiary">
        {t("settings.connections.visibility.label")}
      </label>
      <SettingsSelect
        id={selectId}
        aria-describedby={
          showHandleHint ? `${nameId} ${hintId}` : nameId
        }
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
      {showHandleHint ? (
        <p id={hintId} className="text-xs text-pretty text-text-tertiary">
          {t("settings.connections.visibility.publicHint", {
            option: t(VISIBILITY_LABEL.public),
          })}
        </p>
      ) : null}
      <SettingsInlineStatus state={visibility.state} />
    </div>
  ) : null;

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
        // Conectar stays beside the name at every width. On a phone
        // Desconectar drops under the name instead, so a nick of ordinary
        // length is not cut to a few letters by the button beside it; wide,
        // it sits beside the name and a long nick is cut with an ellipsis
        // rather than wrapping.
        wideControl
        keepInline={linked === null}
        status={status}
      >
        {visibilityControl}
      </SettingsRow>
      <Dialog
        open={confirming}
        title={t("settings.connections.disconnectConfirm.title", { provider: name })}
        description={t("settings.connections.disconnectConfirm.body", {
          provider: name,
        })}
        size="sm"
        closeOnBackdrop={false}
        onClose={() => {
          setConfirming(false);
          window.setTimeout(() => actionRef.current?.focus(), 0);
        }}
        footer={
          <div className="grid w-full min-w-0 grid-cols-2 gap-2">
            <Button
              type="button"
              variant="ghost"
              autoFocus
              className="h-auto min-h-9 w-full min-w-0 whitespace-normal px-2 text-center"
              onClick={() => {
                setConfirming(false);
                window.setTimeout(() => actionRef.current?.focus(), 0);
              }}
            >
              {t("settings.connections.disconnectConfirm.cancel")}
            </Button>
            <Button
              type="button"
              variant="danger"
              className="h-auto min-h-9 w-full min-w-0 whitespace-normal px-2 text-center"
              onClick={() => {
                setConfirming(false);
                window.setTimeout(() => actionRef.current?.focus(), 0);
                void disconnect();
              }}
            >
              {t("settings.connections.disconnectConfirm.confirm")}
            </Button>
          </div>
        }
      >
        <DialogBody>
          <p className="text-xs text-pretty text-text-tertiary">
            {t("settings.connections.disconnectConfirm.visibilityNote", {
              provider: name,
              label: t("settings.connections.visibility.label"),
              option: t(VISIBILITY_LABEL.shared),
            })}
          </p>
        </DialogBody>
      </Dialog>
    </>
  );
}

/**
 * "Conectado como {name}", with the account's own name set in mono. One line:
 * a long name is cut with an ellipsis and shown whole in the tooltip.
 */
function LinkedAs({ name }: { name: string }) {
  const { t } = useTranslation();
  const [before, after = ""] = t("settings.connections.linkedAs", {
    name: NAME_SLOT,
  }).split(NAME_SLOT);
  return (
    <span className="block truncate" title={name}>
      {before}
      <span className="font-mono text-text-secondary">{name}</span>
      {after}
    </span>
  );
}

function Spinner() {
  return <Loader2 aria-hidden className="h-3.5 w-3.5 motion-safe:animate-spin" />;
}
