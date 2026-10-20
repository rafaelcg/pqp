import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Switch } from "@/components/ui/switch";
import {
  fetchAppsEnabled,
  fetchServerApps,
  setServerAppOwnerSwitch,
  type ServerAppDto,
} from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";

/**
 * Whether the apps platform is on for a server, asked of
 * `GET /api/apps/config`, which answers a quiet `{ enabled: false }` while the
 * `apps` flag is off. Fails closed (no section) and asks again when the server
 * or the dialog changes.
 */
export function useServerAppsEnabled(serverId: string | null, ready: boolean): boolean {
  const [state, setState] = useState<{ serverId: string; enabled: boolean } | null>(null);
  useEffect(() => {
    if (!ready || !serverId) {
      return;
    }
    let active = true;
    fetchAppsEnabled(serverId)
      .then((config) => {
        if (active) {
          setState({ serverId, enabled: config.enabled });
        }
      })
      .catch(() => {
        if (active) {
          setState({ serverId, enabled: false });
        }
      });
    return () => {
      active = false;
    };
  }, [serverId, ready]);
  return Boolean(serverId) && state?.serverId === serverId && state.enabled;
}

/** The text in the reader's language, English next, then whatever there is. */
export function appLabel(
  strings: Record<string, string>,
  locale: string,
  fallback: string,
): string {
  return strings[locale] ?? strings.en ?? Object.values(strings)[0] ?? fallback;
}

/**
 * Settings, Apps: the apps the operator released for this server, each with a
 * switch the owner can only turn OFF (mock 05, state 8). Switching off ends the
 * sessions running here, so with any it asks first and says how many. A switch
 * changes at once and goes back, with a sentence, if the server says no.
 */
export function AppsSettingsSection({ serverId }: { serverId: string }) {
  const { t, locale } = useTranslation();
  const [apps, setApps] = useState<ServerAppDto[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ServerAppDto | null>(null);
  const seq = useRef(0);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Another server on the same mounted page: nothing of the last one may stay.
  const [shownServer, setShownServer] = useState(serverId);
  if (shownServer !== serverId) {
    setShownServer(serverId);
    setApps(null);
    setLoadFailed(false);
    setError(null);
    setConfirming(null);
  }

  const load = useCallback(() => {
    const mine = ++seq.current;
    setLoadFailed(false);
    fetchServerApps(serverId)
      .then((answer) => {
        if (mine === seq.current) {
          setApps(answer.apps);
        }
      })
      .catch(() => {
        if (mine === seq.current) {
          setLoadFailed(true);
        }
      });
  }, [serverId]);

  useEffect(() => {
    load();
    return () => {
      seq.current += 1;
      if (savedTimer.current) {
        clearTimeout(savedTimer.current);
      }
    };
  }, [load]);

  async function write(app: ServerAppDto, enabled: boolean): Promise<void> {
    setBusyId(app.id);
    setError(null);
    setSaved(false);
    // A read still in flight (the load, or the re-read after a failed write)
    // saw the state before this write: it must not draw over it.
    seq.current += 1;
    // At once; put back below if the server says no.
    setApps((list) =>
      list ? list.map((a) => (a.id === app.id ? { ...a, enabled } : a)) : list,
    );
    try {
      const result = await setServerAppOwnerSwitch(serverId, app.id, enabled ? null : false);
      setApps((list) =>
        list
          ? list.map((a) =>
              a.id === app.id
                ? { ...a, enabled: result.enabled, liveSessions: enabled ? a.liveSessions : 0 }
                : a,
            )
          : list,
      );
      setSaved(true);
      if (savedTimer.current) {
        clearTimeout(savedTimer.current);
      }
      savedTimer.current = setTimeout(() => setSaved(false), 3000);
    } catch {
      setApps((list) =>
        list ? list.map((a) => (a.id === app.id ? { ...a, enabled: app.enabled } : a)) : list,
      );
      setError(t("serverSettings.apps.saveFailed"));
      // A failure after the server committed the switch (the cleanup of its
      // sessions can fail on its own) must not leave the old position drawn:
      // ask again what the server holds, quietly (a failed read changes nothing).
      const mine = ++seq.current;
      fetchServerApps(serverId)
        .then((answer) => {
          if (mine === seq.current) {
            setApps(answer.apps);
          }
        })
        .catch(() => {});
    } finally {
      setBusyId(null);
    }
  }

  function toggle(app: ServerAppDto) {
    if (busyId) {
      return;
    }
    // Off is the only one that ends anything, so it is the only one that asks,
    // and only when somebody is inside.
    if (app.enabled && app.liveSessions > 0) {
      setConfirming(app);
      return;
    }
    void write(app, !app.enabled);
  }

  const name = (app: ServerAppDto) => appLabel(app.names, locale, app.id);
  /** What the app is, then where it stands here, in one line under the name. */
  const description = (app: ServerAppDto): string => {
    const statusKey: MessageKey = !app.enabled
      ? "serverSettings.apps.off"
      : app.paused
        ? "serverSettings.apps.paused"
        : "serverSettings.apps.released";
    const parts = [appLabel(app.descriptions, locale, ""), t(statusKey)];
    if (app.liveSessions > 0) {
      parts.push(
        t("serverSettings.apps.running", { count: app.liveSessions }),
      );
    }
    return parts.filter(Boolean).join(" ");
  };

  return (
    <div className="space-y-4">
      {apps === null && !loadFailed && (
        <p className="text-sm text-paper-muted">{t("serverSettings.apps.loading")}</p>
      )}

      {loadFailed && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
          <span>{t("serverSettings.apps.loadFailed")}</span>
          <Button type="button" variant="secondary" onClick={load}>
            {t("serverSettings.apps.retry")}
          </Button>
        </div>
      )}

      {apps !== null && apps.length === 0 && (
        <div className="rounded-lg border border-ink-4 p-5">
          <h4 className="font-display text-sm font-bold text-paper">
            {t("serverSettings.apps.empty.title")}
          </h4>
          <p className="mt-1 text-sm text-paper-muted">{t("serverSettings.apps.empty.body")}</p>
        </div>
      )}

      {apps !== null && apps.length > 0 && (
        <ul className="divide-y divide-ink-4 rounded-lg border border-ink-4">
          {apps.map((app) => (
            <li key={app.id} className="flex items-start gap-3 p-3">
              <span
                aria-hidden
                className="mt-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-ink-3 font-display text-sm font-bold text-paper"
              >
                {name(app).slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <Switch
                  checked={app.enabled}
                  label={name(app)}
                  description={description(app)}
                  busy={busyId !== null}
                  onCheckedChange={() => toggle(app)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      <p role="status" aria-live="polite" className="min-h-4 text-xs text-paper-muted">
        {saved ? t("serverSettings.apps.saved") : ""}
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <p className="text-xs text-paper-muted">{t("serverSettings.apps.footnote")}</p>

      <ConfirmDialog
        open={confirming !== null}
        title={confirming ? t("serverSettings.apps.confirm.title", { name: name(confirming) }) : ""}
        description={
          confirming
            ? t("serverSettings.apps.confirm.body", { count: confirming.liveSessions })
            : undefined
        }
        confirmLabel={t("serverSettings.apps.confirm.confirm")}
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          const app = confirming;
          setConfirming(null);
          if (app) {
            void write(app, false);
          }
        }}
      />
    </div>
  );
}
