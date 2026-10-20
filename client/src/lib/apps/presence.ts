import {
  appString,
  formatAppPresence,
  resolveAppLocale,
  type AppConfigEntry,
} from "@pqp/shared";
import { settledAppsConfig } from "@/hooks/use-apps-config";
import {
  serverOfAppChannel,
  useAppSessions,
  type AppSessionsSnapshot,
} from "@/lib/apps/app-sessions-store";
import { useTranslation } from "@/lib/i18n";

/**
 * WHICH APP EACH PERSON IS IN, as a line under their name (decision D9).
 *
 * Computed on the client from the live sessions the store already holds, so it
 * is only ever about channels the viewer can see (the server sends `channel-app`
 * and the catch-up only for those), needs no new frame and writes nothing.
 *
 * Two shapes, both from the app's own manifest strings:
 *   - `short` ("Na Locadora") under a name that is already on screen: the member
 *     lists and the voice roster row;
 *   - `phrase` ("Raf tá na Locadora") where the line stands alone: the profile
 *     card.
 *
 * While somebody is in an app this line REPLACES their recado (decision 6) and
 * the recado comes back when they leave: that is the caller's rule, this module
 * only says whether there is an app line.
 */

export type AppPresenceMode = "short" | "phrase";

export interface AppPresenceEntry {
  userId: string;
  appId: string;
  channelId: string;
  sessionId: string;
  serverId: string | null;
  joinedAt: number;
}

/**
 * The session `userId` is seated in, or none. A person is in one app at a time
 * in practice; if two sessions on different channels both list them (a stale
 * seat on its way out), the one they joined last wins. `serverId` limits the
 * answer to one server's channels, which is what a server's member list wants:
 * the same person's activity elsewhere is not that list's business.
 */
export function appPresenceOf(
  state: Pick<AppSessionsSnapshot, "live">,
  userId: string,
  serverId?: string | null,
): AppPresenceEntry | null {
  let best: AppPresenceEntry | null = null;
  for (const [channelId, session] of state.live) {
    const seat = session.participants.find((one) => one.userId === userId);
    if (!seat) {
      continue;
    }
    const channelServer = serverOfAppChannel(channelId) ?? null;
    if (serverId && channelServer !== serverId) {
      continue;
    }
    const joinedAt = Date.parse(seat.joinedAt);
    const at = Number.isFinite(joinedAt) ? joinedAt : 0;
    if (!best || at > best.joinedAt) {
      best = {
        userId,
        appId: session.appId,
        channelId,
        sessionId: session.id,
        serverId: channelServer,
        joinedAt: at,
      };
    }
  }
  return best;
}

/** The app's presence template for this locale, English next, or null. */
export function presenceTemplate(
  app: Pick<AppConfigEntry, "i18n" | "presence">,
  locale: string,
  mode: AppPresenceMode,
): string | null {
  const key = app.presence[mode];
  const resolved = resolveAppLocale(locale);
  const text = appString(app.i18n[resolved] ?? {}, key) ?? appString(app.i18n.en ?? {}, key);
  return text && text.length > 0 ? text : null;
}

/**
 * The line for one person, or null when they are in no app, or the app is not
 * in the list this tab holds (switched off, or the config has not landed): a
 * line that cannot be written well is no line.
 */
export function appPresenceLine(
  state: Pick<AppSessionsSnapshot, "live">,
  userId: string,
  displayName: string,
  mode: AppPresenceMode,
  locale: string,
  serverId?: string | null,
  appsOf: (serverId: string | null) => readonly AppConfigEntry[] = configuredApps,
): string | null {
  const entry = appPresenceOf(state, userId, serverId);
  if (!entry) {
    return null;
  }
  const app = appsOf(entry.serverId).find((one) => one.id === entry.appId);
  if (!app) {
    return null;
  }
  const template = presenceTemplate(app, locale, mode);
  if (!template) {
    return null;
  }
  return mode === "phrase" ? formatAppPresence(template, displayName) : template;
}

function configuredApps(serverId: string | null): readonly AppConfigEntry[] {
  if (!serverId) {
    return [];
  }
  const config = settledAppsConfig(serverId);
  return config.enabled ? config.apps : [];
}

/**
 * The line under one person's name, live. A string selector, so a row only
 * re-renders when its own line changes, not on every `channel-app` frame.
 */
export function useAppPresenceLine(
  userId: string | null | undefined,
  displayName: string,
  mode: AppPresenceMode,
  serverId?: string | null,
): string | null {
  const { locale } = useTranslation();
  return useAppSessions((state) =>
    userId ? appPresenceLine(state, userId, displayName, mode, locale, serverId) : null,
  );
}
