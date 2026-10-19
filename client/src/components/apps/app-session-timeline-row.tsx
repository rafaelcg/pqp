import { memo, useCallback, useMemo, useState } from "react";
import { AppSessionCard, AppSessionSystemLine } from "@/components/apps/app-session-card";
import { useNow } from "@/hooks/use-now";
import { useAppsConfig } from "@/hooks/use-apps-config";
import {
  endedSessionOfMessage,
  focusAppPane,
  leaveAppSession,
  liveSessionOfMessage,
  requestAppJoin,
  useAppSessions,
} from "@/lib/apps/app-sessions-store";
import { buildCardModel, type CardPerson } from "@/lib/apps/card-model";
import { NUDGE_FRESH_MS } from "@pqp/shared";
import { useTranslation } from "@/lib/i18n";

/**
 * What a timeline message of kind `app_session` draws: the system line and, once
 * this tab knows the server's apps and its live sessions, the card. Until then
 * (or with `apps` off for the server) only the line, which says what the plain
 * body says, so a conversation never shows a card it cannot back up.
 */

export interface AppSessionPeople {
  displayName?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
}

export interface AppSessionTimelineRowProps {
  messageId: string;
  channelId: string;
  serverId: string | null;
  createdAt: string;
  authorName: string;
  viewerId: string | null;
  /** The server's roster, for names and pictures. */
  authors?: ReadonlyMap<string, AppSessionPeople>;
  registerRow?: (messageId: string, node: HTMLElement | null) => void;
}

export const AppSessionTimelineRow = memo(function AppSessionTimelineRow({
  messageId,
  channelId,
  serverId,
  createdAt,
  authorName,
  viewerId,
  authors,
  registerRow,
}: AppSessionTimelineRowProps) {
  const { locale } = useTranslation();
  const config = useAppsConfig(serverId);
  const live = useAppSessions((state) => liveSessionOfMessage(state, channelId, createdAt));
  const ended = useAppSessions((state) => endedSessionOfMessage(state, channelId, createdAt));
  const sessionId = live?.id ?? ended?.sessionId ?? null;
  const join = useAppSessions((state) => (sessionId ? state.join.get(sessionId) : undefined));
  const online = useAppSessions((state) => state.online);
  const offlineSince = useAppSessions((state) => state.offlineSince);
  const loaded = useAppSessions((state) => (serverId ? state.loadedServers.has(serverId) : false));

  // A second for the handoff countdown, half a minute for "há N min", and
  // nothing for a card with nothing that counts.
  const now = useNow(live ? (live.handoff ? 1000 : 30_000) : null);

  const [fresh] = useState(() => {
    const age = Date.now() - Date.parse(createdAt);
    return Number.isFinite(age) && age >= -NUDGE_FRESH_MS && age < NUDGE_FRESH_MS;
  });

  const person = useCallback(
    (userId: string): CardPerson | undefined => {
      const known = authors?.get(userId);
      if (!known) {
        return undefined;
      }
      return {
        userId,
        displayName: known.displayName || known.username || "?",
        avatarUrl: known.avatarUrl ?? null,
      };
    },
    [authors],
  );

  const app = useMemo(
    () => config.apps.find((one) => one.id === (live?.appId ?? ended?.appId)),
    [config.apps, live?.appId, ended?.appId],
  );

  const model = useMemo(
    () =>
      config.enabled && loaded
        ? buildCardModel({
            message: { authorName, createdAt },
            live,
            ended,
            app,
            viewerId,
            person,
            join,
            online,
            offlineSince,
            now,
            locale,
          })
        : null,
    [
      config.enabled,
      loaded,
      authorName,
      createdAt,
      live,
      ended,
      app,
      viewerId,
      person,
      join,
      online,
      offlineSince,
      now,
      locale,
    ],
  );

  return (
    <div
      ref={(node) => registerRow?.(messageId, node)}
      data-message-id={messageId}
      data-testid="app-session-row"
      tabIndex={-1}
      className="px-5 pb-1 pt-3 focus:outline-none"
    >
      <div className="flex flex-col gap-2 md:pl-12">
        <AppSessionSystemLine name={authorName} />
        {model ? (
          <AppSessionCard
            model={model}
            fresh={fresh}
            onJoin={
              sessionId
                ? (options) => requestAppJoin(sessionId, options)
                : undefined
            }
            onLeave={sessionId ? () => leaveAppSession(sessionId) : undefined}
            onFocusApp={sessionId ? () => focusAppPane(sessionId) : undefined}
          />
        ) : null}
      </div>
    </div>
  );
});
