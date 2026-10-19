import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppPane, type AppPaneHandle } from "@/components/apps/app-pane";
import { AppSessionStrip, type StripShareState } from "@/components/apps/app-session-strip";
import { useAppsConfig } from "@/hooks/use-apps-config";
import { useMdUp } from "@/hooks/use-md-up";
import { useNow } from "@/hooks/use-now";
import { endAppSessionRequest } from "@/lib/apps/api";
import {
  liveAppSession,
  registerAppPaneFocuser,
  requestAppJoin,
  useAppSessions,
  type EndedAppSession,
} from "@/lib/apps/app-sessions-store";
import type { CardPerson } from "@/lib/apps/card-model";
import { openPaneCapture, supportsRegionCapture } from "@/lib/apps/pane-share";
import { appSessionWire } from "@/lib/apps/session-wire-instance";
import { takeHostRequest } from "@/lib/apps/strip-api";
import { buildEndedStrip, buildLiveStrip } from "@/lib/apps/strip-model";
import type { AppUserDirectory } from "@/lib/apps/types";
import { isDesktopApp } from "@/lib/desktop";
import { useTranslation } from "@/lib/i18n";
import { resolveAvatarUrl } from "@/lib/avatar";
import { cn } from "@/lib/utils";

/**
 * Everything an open channel needs when an app is running in it: the strip
 * above, the app in the conversation's place and the chat in a 300 px column
 * (mock 03). With no session it draws NOTHING of its own and costs no request:
 * `children` (the call surface and the transcript) sit in the same place in the
 * same tree whether or not an app is up, so a layout change never unmounts what
 * is inside them (the call stage keeps its `<video>` bindings, pitfall about
 * `CallSplit`'s DOM order).
 *
 * The strip is for everybody who can see the session (D13), seated or not; the
 * pane is for the seated. A person who leaves, or who comes back to the channel
 * later, still has the strip, with Entrar.
 *
 * THE FRAME DOES NOT SURVIVE LEAVING THE CHANNEL. The pane is mounted here, so
 * going to another channel unmounts it and releases the seat (`leave`); coming
 * back finds the strip and Entrar. Keeping the frame alive across channels
 * would need the watch stage's dock; that is a later change, not this one.
 */

export interface AppSessionPeople {
  displayName?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
}

/** What the layout needs from the call this channel may have. */
export interface AppSessionVoice {
  /** Connected to THIS channel's call. */
  inCall: boolean;
  /** This account is sharing a screen in that call right now. */
  sharing: boolean;
  /** Other people in the call, to say who the share reaches. */
  others: number;
  /** Publish `stream` (or open the usual picker steered at a tab when absent). Resolves to whether it is out. */
  startShare(stream?: MediaStream): Promise<boolean>;
  stopShare(): void;
}

export interface AppSessionLayoutProps {
  serverId: string | null;
  channelId: string | null;
  channelType: string;
  viewerId: string | null;
  /** MANAGE_CHANNELS here, or an instance moderator. */
  canModerate: boolean;
  /** The roster, for names and pictures. */
  people: ReadonlyMap<string, AppSessionPeople>;
  voice: AppSessionVoice;
  children: ReactNode;
}

/** How long an ended strip stays before it collapses by itself (mock 03). */
export const ENDED_STRIP_MS = 8_000;
/** How recent an end must be to be drawn on arrival at the channel. */
const ENDED_FRESH_MS = 8_000;

function endedHere(
  ended: ReadonlyMap<string, EndedAppSession>,
  channelId: string | null,
  now: number = Date.now(),
): EndedAppSession | undefined {
  if (!channelId) return undefined;
  let found: EndedAppSession | undefined;
  for (const one of ended.values()) {
    // Only a session whose end THIS tab was told about (a participant gets the
    // reason): somebody who was never in it has no strip to close.
    if (one.channelId !== channelId || one.reason === null) continue;
    if (now - one.endedAt > ENDED_FRESH_MS) continue;
    if (!found || one.endedAt > found.endedAt) found = one;
  }
  return found;
}

export function AppSessionLayout(props: AppSessionLayoutProps) {
  const { serverId, channelId, channelType, viewerId, canModerate, people, voice, children } = props;
  const { locale, t } = useTranslation();
  const config = useAppsConfig(serverId);
  const md = useMdUp();
  const live = useAppSessions((state) => liveAppSession(state, channelId));
  const endedMap = useAppSessions((state) => state.ended);
  const online = useAppSessions((state) => state.online);
  const offlineSince = useAppSessions((state) => state.offlineSince);

  const enabled = config.enabled && channelId !== null;
  const now = useNow(enabled && (live?.handoff || !online) ? 1000 : enabled && live ? 15_000 : null);

  const [leftAt, setLeftAt] = useState<{ sessionId: string; at: number } | null>(null);
  const [dismissedEnded, setDismissedEnded] = useState<string | null>(null);
  const [collapseEnded, setCollapseEnded] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ join: boolean; takeHost: boolean }>({
    join: false,
    takeHost: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [sharePending, setSharePending] = useState(false);
  const paneRef = useRef<AppPaneHandle>(null);
  const joinedAs = useRef<{ sessionId: string; spectator: boolean } | null>(null);
  const ownedShare = useRef(false);
  const shareWholeTab = useRef(false);

  const person = useCallback(
    (userId: string): CardPerson | undefined => {
      const known = people.get(userId);
      if (!known) return undefined;
      return {
        userId,
        displayName: known.displayName || known.username || "?",
        avatarUrl: known.avatarUrl ?? null,
      };
    },
    [people],
  );

  const app = useMemo(
    () => config.apps.find((one) => one.id === live?.appId),
    [config.apps, live?.appId],
  );

  const leftLocally = leftAt !== null && live?.id === leftAt.sessionId;
  // Once the server's summary no longer lists this person, "left" has landed.
  useEffect(() => {
    if (leftAt && live && live.id === leftAt.sessionId) {
      const seated = viewerId !== null && live.participants.some((one) => one.userId === viewerId);
      if (!seated) setLeftAt(null);
    } else if (leftAt && (!live || live.id !== leftAt.sessionId)) {
      setLeftAt(null);
    }
  }, [leftAt, live, viewerId]);

  const endedRecord = enabled ? endedHere(endedMap, channelId) : undefined;

  const input = {
    live,
    app,
    viewerId,
    person,
    online,
    offlineSince,
    now,
    locale,
    canModerate,
    channelType,
    phone: !md,
    leftLocally,
  };
  const liveModel = enabled ? buildLiveStrip(input) : null;
  const endedModel =
    enabled && !liveModel && endedRecord && endedRecord.sessionId !== dismissedEnded
      ? buildEndedStrip({ ...input, ended: endedRecord, app: config.apps.find((one) => one.id === endedRecord.appId) })
      : null;
  const model = liveModel ?? endedModel;

  // The ended strip collapses on its own after 8 s, never moving focus.
  useEffect(() => {
    if (!endedModel) {
      setCollapseEnded(null);
      return;
    }
    const sessionId = endedModel.sessionId;
    const age = endedRecord ? Date.now() - endedRecord.endedAt : 0;
    const wait = Math.max(0, ENDED_STRIP_MS - age);
    const collapse = window.setTimeout(() => setCollapseEnded(sessionId), wait);
    const drop = window.setTimeout(() => setDismissedEnded(sessionId), wait + 200);
    return () => {
      window.clearTimeout(collapse);
      window.clearTimeout(drop);
    };
  }, [endedModel?.sessionId, endedRecord?.endedAt]);

  // A session that ends while focus is inside the pane moves focus to Fechar,
  // because the frame (and the focus with it) is about to disappear.
  const focusInPane = useRef(false);
  const wasPaneShown = useRef(false);
  const paneShown = liveModel?.showPane === true;
  useEffect(() => {
    if (wasPaneShown.current && !paneShown && endedModel && focusInPane.current) {
      focusInPane.current = false;
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(
            '[data-testid="app-session-strip"][data-state="ended"] button',
          )
          ?.focus();
      });
    }
    wasPaneShown.current = paneShown;
  }, [paneShown, endedModel]);

  useEffect(() => {
    const track = () => {
      const element = paneRef.current?.element();
      focusInPane.current = Boolean(
        element && document.activeElement && element.contains(document.activeElement),
      );
    };
    document.addEventListener("focusin", track);
    document.addEventListener("focusout", track);
    return () => {
      document.removeEventListener("focusin", track);
      document.removeEventListener("focusout", track);
    };
  }, []);

  // "Voltar pro app" on the card, and the strip's skip link.
  useEffect(() => {
    if (!live) return undefined;
    return registerAppPaneFocuser((sessionId) => {
      if (sessionId === live.id) paneRef.current?.focus();
    });
  }, [live]);

  const sessionId = live?.id ?? null;
  const transport = useMemo(
    () =>
      sessionId
        ? appSessionWire.transportFor(sessionId, async () => {
            await endAppSessionRequest(sessionId);
          })
        : null,
    [sessionId],
  );

  const users: AppUserDirectory = useMemo(
    () => ({
      resolve: (userId: string) => {
        const known = people.get(userId);
        if (!known) return null;
        return {
          displayName: known.displayName || known.username || "?",
          avatarUrl: resolveAvatarUrl(known.avatarUrl ?? null),
        };
      },
    }),
    [people],
  );

  // ---- share -------------------------------------------------------------

  const shareOn = ownedShare.current && voice.sharing;
  useEffect(() => {
    if (!voice.sharing) ownedShare.current = false;
  }, [voice.sharing]);

  // The share belongs to the session: leaving or losing the pane ends it.
  useEffect(() => {
    if (!paneShown && ownedShare.current) {
      ownedShare.current = false;
      voice.stopShare();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneShown]);

  const setShare = useCallback(
    async (on: boolean): Promise<boolean> => {
      if (!on) {
        ownedShare.current = false;
        voice.stopShare();
        return false;
      }
      if (!voice.inCall || sharePending) return false;
      setSharePending(true);
      setError(null);
      try {
        let started: boolean;
        const element = paneRef.current?.element() ?? null;
        if (!isDesktopApp() && element && supportsRegionCapture()) {
          const capture = await openPaneCapture(element);
          shareWholeTab.current = !capture.cropped;
          started = await voice.startShare(capture.stream);
          if (!started) {
            for (const track of capture.stream.getTracks()) track.stop();
          }
        } else {
          shareWholeTab.current = true;
          started = await voice.startShare(undefined);
        }
        ownedShare.current = started;
        return started;
      } catch {
        // the person cancelled the picker, or the browser refused
        return false;
      } finally {
        setSharePending(false);
      }
    },
    [voice, sharePending],
  );

  const share: StripShareState | undefined = liveModel?.actions.share
    ? {
        visible: true,
        on: shareOn,
        pending: sharePending,
        needsCall: !voice.inCall,
        viewers: voice.others,
        wholeTab: !supportsRegionCapture() || isDesktopApp(),
      }
    : undefined;

  // ---- actions -----------------------------------------------------------

  const onLeave = useCallback(() => {
    if (!sessionId) return;
    setLeftAt({ sessionId, at: Date.now() });
    // With the pane up, taking it down releases the seat (the frame's unmount
    // sends `app-leave`); without it (a seat the server still lists after the
    // 90 s) nothing else would.
    if (!liveModel?.showPane) appSessionWire.sendLeave(sessionId);
  }, [sessionId, liveModel?.showPane]);

  const onEnd = useCallback(() => {
    if (!sessionId) return;
    setError(null);
    void endAppSessionRequest(sessionId).catch(() => setError(t("apps.strip.endFailed")));
  }, [sessionId, t]);

  const onJoin = useCallback(
    (options: { asSpectator: boolean }) => {
      if (!sessionId) return;
      setBusy((current) => ({ ...current, join: true }));
      requestAppJoin(sessionId, options);
      window.setTimeout(() => setBusy((current) => ({ ...current, join: false })), 1200);
    },
    [sessionId],
  );

  const onTakeHost = useCallback(() => {
    if (!sessionId) return;
    setBusy((current) => ({ ...current, takeHost: true }));
    setError(null);
    takeHostRequest(sessionId)
      .catch(() => setError(t("apps.strip.takeFailed")))
      .finally(() => setBusy((current) => ({ ...current, takeHost: false })));
  }, [sessionId, t]);

  const paneVisible = Boolean(liveModel?.showPane && app && transport);
  // How this seat was taken, fixed when the pane first shows for a session: a
  // handoff changes what the strip says, never what the person is.
  if (paneVisible && sessionId && joinedAs.current?.sessionId !== sessionId) {
    joinedAs.current = { sessionId, spectator: liveModel?.spectating === true };
  } else if (!paneVisible && joinedAs.current) {
    joinedAs.current = null;
  }
  const chatBeside = paneVisible && md;
  const chatBelow = paneVisible && !md;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {model ? (
        <AppSessionStrip
          model={model}
          compact={!md}
          share={share}
          busy={busy}
          error={error}
          entering
          collapsing={model.kind === "ended" && collapseEnded === model.sessionId}
          onShareChange={(on) => void setShare(on)}
          onLeave={onLeave}
          onEnd={onEnd}
          onJoin={onJoin}
          onTakeHost={onTakeHost}
          onClose={() => {
            if (model.kind === "ended") setDismissedEnded(model.sessionId);
          }}
          onSkipToApp={() => paneRef.current?.focus()}
        />
      ) : null}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1",
          chatBelow ? "flex-col" : "flex-row",
        )}
      >
        {paneVisible && app && transport ? (
          <AppPane
            ref={paneRef}
            key={sessionId ?? undefined}
            app={app}
            origin={config.origin}
            title={model && model.kind === "live" ? model.app.name : app.id}
            transport={transport}
            users={users}
            locale={locale}
            asSpectator={joinedAs.current?.spectator === true}
            frozen={liveModel?.phase === "reconnecting"}
            canWatch={app.players.spectators && app.shareAllowed}
            onShare={setShare}
            className={chatBelow ? "basis-[46%] flex-none" : undefined}
          />
        ) : null}
        <div
          data-testid="app-chat-column"
          className={cn(
            "flex min-h-0 min-w-0 flex-col",
            chatBeside
              ? "w-[300px] flex-none border-l border-border"
              : chatBelow
                ? "flex-1 border-t border-border"
                : "flex-1",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
