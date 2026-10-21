import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppConfigEntry, AppSessionSummary } from "@pqp/shared";
import { AppIconTile } from "@/components/apps/app-icon";
import { AppJoinSheet } from "@/components/apps/app-join-sheet";
import type { AppSessionPeople } from "@/components/apps/app-session-layout";
import { useAppsConfig } from "@/hooks/use-apps-config";
import {
  clearAppJoin,
  isSeated,
  joinAppSession,
  leaveAppSession,
  registerAppJoinInterceptor,
  useAppSessions,
  type AppJoinOptions,
} from "@/lib/apps/app-sessions-store";
import { APP_UNBOUNDED_PLAYERS, appText } from "@/lib/apps/card-model";
import {
  acceptApp,
  ensureAppConsents,
  hasValidConsent,
  loadAppConsents,
} from "@/lib/apps/consents";
import {
  canWatchFull,
  failureOf,
  joinSheetFace,
  keepsOnAccount,
  keepsOnDevice,
  type JoinLocal,
} from "@/lib/apps/join-model";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Where the join sheet lives and what decides whether it shows.
 *
 * Every Entrar in the product (the card's, the strip's) asks `requestAppJoin`,
 * and the one thing registered to answer is this. The rule is the mock's:
 *
 *  - never accepted this app (or the app now asks for something it did not):
 *    the sheet, and nothing is sent until Entrar in it;
 *  - accepted before: straight in, and a toast that says so with Desfazer
 *    (which is Sair).
 *
 * The sheet reads the world as it is, not as it was when it opened: the room
 * can fill while a person reads, the session can end, the operator can switch
 * the app off, and each of those turns the sheet into the matching state
 * (mock 04, estados 5 to 7) by itself.
 *
 * Nothing here runs, loads or registers while the `apps` flag is off for the
 * open server.
 */

const TOAST_MS = 4_000;
const TOAST_LEAVE_MS = 150;

export interface AppJoinHostProps {
  serverId: string | null;
  viewerId: string | null;
  people: ReadonlyMap<string, AppSessionPeople>;
}

interface Target {
  sessionId: string;
  options: AppJoinOptions;
}

function findSession(
  live: ReadonlyMap<string, AppSessionSummary>,
  sessionId: string,
): AppSessionSummary | undefined {
  for (const session of live.values()) {
    if (session.id === sessionId) return session;
  }
  return undefined;
}

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

function countLine(session: AppSessionSummary, app: AppConfigEntry, t: T): string | null {
  if (session.players === 0) return null;
  const max = app.players.max;
  return max >= APP_UNBOUNDED_PLAYERS
    ? t("apps.card.countOpen", { count: session.players })
    : t("apps.card.countOf", { players: session.players, max, count: max });
}

export function AppJoinHost({ serverId, viewerId, people }: AppJoinHostProps) {
  const { t, locale } = useTranslation();
  const config = useAppsConfig(serverId);
  const live = useAppSessions((state) => state.live);
  const ended = useAppSessions((state) => state.ended);
  const joins = useAppSessions((state) => state.join);

  const [target, setTarget] = useState<Target | null>(null);
  const [local, setLocal] = useState<JoinLocal>({ phase: "idle" });
  const [identity, setIdentity] = useState(false);
  const [toast, setToast] = useState<{ sessionId: string; app: string; leaving: boolean } | null>(
    null,
  );
  const direct = useRef<{ sessionId: string; app: string } | null>(null);

  // The latest world, for the interceptor, which is registered once.
  const world = useRef({ live, config });
  world.current = { live, config };

  useEffect(() => {
    if (config.enabled) {
      void loadAppConsents();
    }
  }, [config.enabled]);

  const close = useCallback(() => {
    setTarget((current) => {
      if (current) clearAppJoin(current.sessionId);
      return null;
    });
    setLocal({ phase: "idle" });
    setIdentity(false);
  }, []);

  useEffect(() => {
    if (!config.enabled) return undefined;
    return registerAppJoinInterceptor((sessionId, options) => {
      void (async () => {
        const { live: liveNow, config: configNow } = world.current;
        const session = findSession(liveNow, sessionId);
        const app = session ? configNow.apps.find((one) => one.id === session.appId) : undefined;
        if (session && app?.available) {
          const consents = await ensureAppConsents();
          if (hasValidConsent(consents, app.id)) {
            direct.current = { sessionId, app: appText(app, locale, app.name) };
            joinAppSession(sessionId, options);
            return;
          }
        }
        setLocal({ phase: "idle" });
        setIdentity(false);
        setTarget({ sessionId, options });
      })();
    });
  }, [config.enabled, locale]);

  // The toast of the straight-in path appears when the seat does.
  useEffect(() => {
    const pending = direct.current;
    if (!pending) return;
    const session = findSession(live, pending.sessionId);
    if (session && isSeated(session, viewerId)) {
      direct.current = null;
      setToast({ sessionId: pending.sessionId, app: pending.app, leaving: false });
    }
  }, [live, viewerId]);

  useEffect(() => {
    if (!toast || toast.leaving) return undefined;
    const timer = window.setTimeout(
      () => setToast((current) => (current ? { ...current, leaving: true } : null)),
      TOAST_MS,
    );
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!toast?.leaving) return undefined;
    const timer = window.setTimeout(() => setToast(null), TOAST_LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [toast?.leaving]);

  const session = target ? findSession(live, target.sessionId) : undefined;
  const app = session ? config.apps.find((one) => one.id === session.appId) : undefined;
  const join = target ? joins.get(target.sessionId) : undefined;
  const face = target
    ? joinSheetFace({ session, app, viewerId, local, join })
    : null;

  // In: the sheet has nothing left to say.
  useEffect(() => {
    if (face === "done") close();
  }, [face, close]);

  const endedRecord = useMemo(() => {
    if (!target) return undefined;
    return ended.get(target.sessionId);
  }, [ended, target]);

  if (!config.enabled) {
    return null;
  }

  const viewerInfo = viewerId ? people.get(viewerId) : undefined;
  const viewer = {
    name: viewerInfo?.displayName || viewerInfo?.username || "?",
    avatarUrl: viewerInfo?.avatarUrl ?? null,
  };
  const nameOf = (userId: string | null | undefined): string => {
    if (!userId) return "?";
    const known = people.get(userId);
    return known?.displayName || known?.username || "?";
  };

  // What a face needs from an app that may no longer be in the list.
  const appName = app ? appText(app, locale, app.name) : (endedRecord?.appId ?? session?.appId ?? "app");
  const consentApp = app;
  const sheetApp = {
    name: appName,
    icon: app?.icon ?? "sparkles",
    notice: app?.notice ? appText(app, locale, app.notice) : null,
  };

  let endedLine: string | null = null;
  if (face === "ended" && endedRecord) {
    const who = nameOf(endedRecord.hostUserId);
    const minutes = Math.max(0, Math.round((Date.now() - endedRecord.endedAt) / 60_000));
    endedLine =
      minutes < 1
        ? t("apps.join.endedByNow", { name: who, app: appName })
        : t("apps.join.endedBy", { name: who, app: appName, minutes });
  }

  const fullLine =
    face === "full" && session && app
      ? session.spectators > 0
        ? t("apps.join.fullCountWatching", {
            players: session.players,
            max: app.players.max,
            count: session.spectators,
          })
        : t("apps.join.fullCount", { players: session.players, max: app.players.max })
      : null;

  const enter = (options: AppJoinOptions) => {
    if (!target || !consentApp) return;
    setLocal({ phase: "entering" });
    void acceptApp(consentApp.id, identity && consentApp.capabilities.identity === "user-id")
      .then(() => joinAppSession(target.sessionId, options))
      .catch(() => setLocal({ phase: "failed" }));
  };

  return (
    <>
      {target && face && face !== "done" ? (
        <AppJoinSheet
          open
          face={face}
          app={sheetApp}
          starterName={nameOf(session?.startedBy)}
          countLine={session && app ? countLine(session, app, t as T) : null}
          viewer={viewer}
          asksForId={consentApp?.capabilities.identity === "user-id"}
          keepsOnDevice={keepsOnDevice(consentApp)}
          keepsOnAccount={keepsOnAccount(consentApp)}
          identityChecked={identity}
          onIdentityChange={setIdentity}
          failure={failureOf(join)}
          canWatch={canWatchFull(app)}
          fullLine={fullLine}
          endedLine={endedLine}
          onEnter={() => enter(target.options)}
          onWatch={() => enter({ asSpectator: true })}
          onClose={close}
        />
      ) : null}
      {toast ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="app-join-toast"
          className={cn(
            "elevation-3 pointer-events-auto fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+72px)] z-40 flex items-center gap-3 rounded-[var(--radius-card)] p-3 sm:inset-x-auto sm:bottom-6 sm:left-1/2 sm:w-auto sm:-translate-x-1/2",
            toast.leaving ? "animate-toast-out" : "animate-toast-in",
          )}
        >
          <AppIconTile icon={app?.icon ?? "sparkles"} className="h-8 w-8 sm:h-8 sm:w-8" />
          <p className="min-w-0 flex-1 text-sm text-text">
            {t("apps.join.toast", { app: toast.app })}
          </p>
          <button
            type="button"
            className="rounded-[var(--radius-control)] px-2 py-1 text-xs font-semibold text-text-secondary hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            onClick={() => {
              leaveAppSession(toast.sessionId);
              setToast({ ...toast, leaving: true });
            }}
          >
            {t("apps.join.undo")}
          </button>
          <button
            type="button"
            aria-label={t("dmToast.dismiss")}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-control)] text-text-tertiary hover:bg-surface-2 hover:text-text"
            onClick={() => setToast({ ...toast, leaving: true })}
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>
      ) : null}
    </>
  );
}
