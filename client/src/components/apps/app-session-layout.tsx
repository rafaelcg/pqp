import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
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
import {
  AppColumnContext,
  INACTIVE_APP_COLUMN,
  registerAppChatToggler,
  type AppColumnState,
} from "@/components/apps/app-column";
import {
  appColumnLayout,
  chatUnreadSince,
  NO_UNREAD,
  readAppChatHidden,
  writeAppChatHidden,
  type AppCallShape,
  type UnreadMessage,
} from "@/lib/apps/app-chat-visibility";

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
  /**
   * What this channel's call stage draws: a card (`compact`) or pictures.
   * Decides where the call goes when the chat is put away. Absent reads as
   * `compact` while in the call.
   */
  callShape?: AppCallShape;
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
  /**
   * This channel's messages and who is reading, for the unread mark on the
   * chat toggle while the chat is put away.
   */
  chat?: { messages: readonly UnreadMessage[]; username: string | null };
  /** The chat toggle's keyboard shortcut as printed ("Ctrl + Shift + ."). */
  chatShortcut?: string | null;
  /** The app is on screen (or stops being): the page header stays up then. */
  onPaneChange?: (visible: boolean) => void;
  children: ReactNode;
}

/** Under this body width the column goes under the app instead of beside it. */
export const APP_COLUMN_SIDE_MIN_BODY_PX = 720;

/**
 * The share of the body a call's pictures may take when they sit under the app
 * with the chat away: the app is what the person made room for.
 */
export const APP_BELOW_STAGE_MAX_SHARE = 0.4;

/** An element's size, kept in step by a ResizeObserver; 0 until measured. */
function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const read = () =>
      setSize((previous) => {
        const width = Math.round(element.clientWidth);
        const height = Math.round(element.clientHeight);
        return previous.width === width && previous.height === height ? previous : { width, height };
      });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** How long an ended strip stays before it collapses by itself (mock 03). */
export const ENDED_STRIP_MS = 8_000;
/**
 * How recent an end must be to be drawn at all. Longer than the strip's own
 * life, so the collapse (which starts at `ENDED_STRIP_MS`) is what takes it
 * away and not this rule cutting it off a frame early.
 */
const ENDED_FRESH_MS = ENDED_STRIP_MS + 1_000;

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
  const {
    serverId,
    channelId,
    channelType,
    viewerId,
    canModerate,
    people,
    voice,
    chat,
    chatShortcut,
    onPaneChange,
    children,
  } = props;
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
  const endedId = endedModel?.sessionId ?? null;
  const endedAt = endedRecord?.endedAt ?? null;
  useEffect(() => {
    if (endedId === null) {
      setCollapseEnded(null);
      return undefined;
    }
    const age = endedAt === null ? 0 : Date.now() - endedAt;
    const wait = Math.max(0, ENDED_STRIP_MS - age);
    const collapse = window.setTimeout(() => setCollapseEnded(endedId), wait);
    const drop = window.setTimeout(() => setDismissedEnded(endedId), wait + 200);
    return () => {
      window.clearTimeout(collapse);
      window.clearTimeout(drop);
    };
  }, [endedId, endedAt]);

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

  // ---- the chat beside the app (app_pane_layout_v2) -----------------------

  // `false` is the only answer that turns it off: an API from before the flag
  // sends nothing, and the new layout is the default.
  const v2 = config.paneLayoutV2 !== false;
  const [chatHidden, setChatHiddenState] = useState(() => readAppChatHidden(!md));
  const columnRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { width: bodyWidth, height: bodyHeight } = useElementSize(bodyRef);
  const columnId = `app-chat-column-${channelId ?? "none"}`;
  const layout = appColumnLayout({
    paneVisible: v2 && paneVisible,
    // A desktop window with the channel list open can leave the body under
    // 720 px, and a 320 px column beside the app left the app 140 px wide
    // (a game the size of a stamp). There the column goes under the app, as on
    // a phone. Zero is "not measured yet", which keeps the desktop answer.
    md: md && (bodyWidth === 0 || bodyWidth >= APP_COLUMN_SIDE_MIN_BODY_PX),
    chatHidden,
    inCall: voice.inCall,
    callShape: voice.inCall ? (voice.callShape ?? "compact") : "none",
  });
  const appColumnOn = v2 && paneVisible;

  const setChatHidden = useCallback(
    (hidden: boolean, via: "toggle" | "shortcut" | "header") => {
      const column = columnRef.current;
      const chatPart = column?.querySelector<HTMLElement>("[data-call-split-chat]") ?? column;
      const focusInChat = Boolean(
        chatPart && document.activeElement && chatPart.contains(document.activeElement),
      );
      setChatHiddenState(hidden);
      writeAppChatHidden(hidden);
      requestAnimationFrame(() => {
        if (hidden && (focusInChat || via === "header")) {
          // What was focused is about to be display:none; the toggle that brings
          // it back is the sensible place to land.
          document.querySelector<HTMLElement>("[data-app-chat-toggle]")?.focus();
        } else if (!hidden && via === "shortcut") {
          columnRef.current
            ?.querySelector<HTMLElement>("[data-call-split-chat] textarea, [data-call-split-chat] [contenteditable='true']")
            ?.focus();
        }
      });
    },
    [],
  );

  const chatHiddenRef = useRef(chatHidden);
  chatHiddenRef.current = chatHidden;
  useEffect(() => {
    if (!appColumnOn) return undefined;
    return registerAppChatToggler(() => setChatHidden(!chatHiddenRef.current, "shortcut"));
  }, [appColumnOn, setChatHidden]);

  // The newest message when the chat went away; what came after is unread.
  const messages = chat?.messages;
  const awaySince = useRef<{ id: string | null } | null>(null);
  if (layout.chatAway && awaySince.current === null) {
    awaySince.current = { id: messages && messages.length > 0 ? messages[messages.length - 1]!.id : null };
  } else if (!layout.chatAway && awaySince.current !== null) {
    awaySince.current = null;
  }
  const unread =
    layout.chatAway && awaySince.current && messages
      ? chatUnreadSince(messages, awaySince.current.id, {
          id: viewerId,
          username: chat?.username ?? null,
        })
      : NO_UNREAD;

  useEffect(() => {
    onPaneChange?.(appColumnOn);
  }, [appColumnOn, onPaneChange]);
  useEffect(() => () => onPaneChange?.(false), [onPaneChange]);

  const columnState: AppColumnState = useMemo(
    () =>
      appColumnOn
        ? {
            active: true,
            chatAway: layout.chatAway,
            column: layout.column,
            belowCap:
              bodyHeight > 0 ? Math.round(bodyHeight * APP_BELOW_STAGE_MAX_SHARE) : undefined,
            hideChat: () => setChatHidden(true, "header"),
            showChat: () => setChatHidden(false, "toggle"),
          }
        : INACTIVE_APP_COLUMN,
    [appColumnOn, layout.chatAway, layout.column, bodyHeight, setChatHidden],
  );

  const columnHidden = layout.column === "hidden";
  const legacyColumn = chatBeside
    ? "w-[300px] flex-none border-l border-border"
    : chatBelow
      ? "flex-1 border-t border-border"
      : "flex-1";
  const v2Column: Record<typeof layout.column, string> = {
    full: "flex-1",
    side: "w-[320px] flex-none border-l border-border xl:w-[352px]",
    stage: "w-[320px] flex-none border-l border-border xl:w-[352px]",
    below: layout.chatAway
      ? "flex-none border-t border-border"
      : "flex-1 border-t border-border",
    bar: "flex-none border-t border-border",
    hidden: "hidden",
  };
  // One utility, not `basis-[46%] flex-none`: tailwind-merge drops a basis
  // that comes before a `flex-*`, so that pair was only ever `flex-none` and
  // the pane kept whatever height it first measured (the chat under it got
  // none on a phone).
  const paneClass = v2
    ? layout.column === "below" && !layout.chatAway
      ? "flex-[0_0_46%]"
      : undefined
    : chatBelow
      ? "basis-[46%] flex-none"
      : undefined;

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
          chat={
            appColumnOn
              ? {
                  hidden: chatHidden,
                  unread,
                  shortcut: chatShortcut ?? null,
                  controls: columnId,
                  onToggle: () => setChatHidden(!chatHidden, "toggle"),
                }
              : undefined
          }
        />
      ) : null}
      <div
        ref={bodyRef}
        className={cn(
          "flex min-h-0 min-w-0 flex-1",
          v2 ? (layout.direction === "column" ? "flex-col" : "flex-row") : chatBelow ? "flex-col" : "flex-row",
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
            className={paneClass}
          />
        ) : null}
        <div
          ref={columnRef}
          id={columnId}
          data-testid="app-chat-column"
          data-app-column={v2 ? layout.column : undefined}
          // Display none, so nothing in it can take focus or be read out; the
          // children stay mounted (scroll, drafts, the call's bindings).
          hidden={v2 && columnHidden ? true : undefined}
          className={cn(
            "flex min-h-0 min-w-0 flex-col",
            v2 ? v2Column[layout.column] : legacyColumn,
          )}
        >
          <AppColumnContext.Provider value={columnState}>{children}</AppColumnContext.Provider>
        </div>
      </div>
    </div>
  );
}
