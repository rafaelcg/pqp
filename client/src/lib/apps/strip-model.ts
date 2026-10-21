import type { AppConfigEntry, AppEndReason, AppSessionSummary } from "@pqp/shared";
import {
  APP_RESUME_WINDOW_MS,
  isSeated,
  type EndedAppSession,
} from "@/lib/apps/app-sessions-store";
import {
  APP_UNBOUNDED_PLAYERS,
  CARD_AVATARS_SHOWN,
  appText,
  endedByOperatorSwitch,
  type CardPerson,
} from "@/lib/apps/card-model";

/**
 * What the session strip says (mock 03), decided from data and nothing else.
 * The component draws it, and this file is where the twelve states of the
 * mock are told apart, so a table of inputs pins every one of them.
 *
 *   host            tu és o host                                  (estado 1, 2, 4)
 *   participant     Host: bia                                      (estado 3)
 *   spectator       Assistindo. Host: bia                          (estado 5)
 *   handoff-you     o host saiu, tu és o próximo, Assumir agora    (estado 6)
 *   handoff-other   o host saiu, outro assume                      (estado 7)
 *   reconnecting    sem conexão, o lugar fica guardado por 90 s    (estado 8)
 *   lost            os 90 s passaram: o lugar foi liberado
 *   outside         a sessão existe e tu não estás nela (a faixa não some)
 *   ended           terminou, com a razão                          (estado 9, 10)
 */

export type StripPhase =
  | "host"
  | "participant"
  | "spectator"
  | "handoff-you"
  | "handoff-other"
  | "reconnecting"
  | "lost"
  | "outside";

export type StripCount =
  | { kind: "none" }
  | { kind: "of"; players: number; max: number; watching: number }
  | { kind: "open"; players: number; watching: number };

export type StripRoleLine =
  | { kind: "host" }
  | { kind: "hostIs"; name: string }
  | { kind: "watching"; name: string }
  | { kind: "handoffYou"; host: string; seconds: number }
  | { kind: "handoffOther"; host: string; next: string; seconds: number }
  | { kind: "handoffNone"; host: string; seconds: number }
  | { kind: "reconnecting" }
  | { kind: "lost" };

export interface StripApp {
  id: string;
  name: string;
  icon: AppConfigEntry["icon"];
}

export interface LiveStripModel {
  kind: "live";
  sessionId: string;
  app: StripApp;
  phase: StripPhase;
  /** warn: the host is gone. off: no connection. normal: otherwise. */
  tone: "normal" | "warn" | "off";
  line: StripRoleLine;
  people: readonly CardPerson[];
  more: number;
  count: StripCount;
  /** Everybody seated, for "Ver quem está dentro". */
  roster: ReadonlyArray<{
    userId: string;
    name: string;
    avatarUrl: string | null;
    host: boolean;
    spectator: boolean;
    reconnecting: boolean;
  }>;
  seated: boolean;
  isHost: boolean;
  /** The seat is a spectator's (kept apart from `phase`, which a handoff overrides). */
  spectating: boolean;
  /** The pane is drawn only for a seated, connected person. */
  showPane: boolean;
  actions: {
    leave: boolean;
    end: boolean;
    enter: "join" | "watch" | null;
    takeHost: boolean;
    /** Hidden entirely unless the manifest says `pane` and the server allows it. */
    share: boolean;
  };
}

export interface EndedStripModel {
  kind: "ended";
  sessionId: string;
  app: StripApp;
  /** The operator switched the app off: its own line, no "N jogaram". */
  disabled: boolean;
  cause:
    | { kind: "host"; name: string; self: boolean }
    | { kind: "moderator" }
    | { kind: "idle" }
    | { kind: "host-gone" }
    | { kind: "empty" }
    | { kind: "max-duration" }
    | { kind: "channel-gone" }
    | { kind: "unknown" };
  summary: { participants: number; durationSeconds: number } | null;
}

export type StripModel = LiveStripModel | EndedStripModel;

export interface StripInput {
  live?: AppSessionSummary;
  ended?: EndedAppSession;
  app?: AppConfigEntry;
  viewerId: string | null;
  person: (userId: string) => CardPerson | undefined;
  online: boolean;
  offlineSince: number | null;
  now: number;
  locale: string;
  /** MANAGE_CHANNELS in this channel, or an instance moderator. */
  canModerate: boolean;
  channelType: "text" | "voice" | string;
  /** Phones never offer the pane share (RFC: not offered on phones). */
  phone: boolean;
  /** The person pressed Sair on this page and the summary has not caught up yet. */
  leftLocally: boolean;
}

function appOf(app: AppConfigEntry | undefined, appId: string, locale: string): StripApp {
  if (!app) {
    return { id: appId, name: appId, icon: "sparkles" };
  }
  return { id: app.id, name: appText(app, locale, app.name), icon: app.icon };
}

function nameOf(userId: string | null, person: StripInput["person"]): string {
  if (!userId) return "?";
  return person(userId)?.displayName ?? "?";
}

export function endedCause(
  reason: AppEndReason | null,
  hostName: string,
  hostIsViewer: boolean,
): EndedStripModel["cause"] {
  switch (reason) {
    case "host":
      return { kind: "host", name: hostName, self: hostIsViewer };
    case "moderator":
      return { kind: "moderator" };
    case "idle":
    case "host-gone":
    case "empty":
    case "max-duration":
    case "channel-gone":
      return { kind: reason };
    default:
      return { kind: "unknown" };
  }
}

/** Built for a session that has ended and that this person was seated in. */
export function buildEndedStrip(input: StripInput): EndedStripModel | null {
  const { ended, app } = input;
  if (!ended) return null;
  const hostName = nameOf(ended.hostUserId, input.person);
  return {
    kind: "ended",
    sessionId: ended.sessionId,
    app: appOf(app, ended.appId ?? "", input.locale),
    disabled: endedByOperatorSwitch(ended.reason) || ended.reason === "operator",
    cause: endedCause(ended.reason, hostName, ended.hostUserId === input.viewerId),
    summary: ended.summary,
  };
}

function secondsUntil(iso: string, now: number): number {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : 0;
}

export function buildLiveStrip(input: StripInput): LiveStripModel | null {
  const { live, app, viewerId, now } = input;
  if (!live) return null;

  const row = viewerId ? live.participants.find((one) => one.userId === viewerId) : undefined;
  const offlineTooLong =
    !input.online &&
    input.offlineSince !== null &&
    now - input.offlineSince > APP_RESUME_WINDOW_MS;
  const seatedByServer = isSeated(live, viewerId) && !input.leftLocally;
  const seated = seatedByServer && !offlineTooLong;
  const spectating = row?.role === "spectator";
  const isHost = viewerId !== null && live.hostUserId === viewerId && seated;
  const max = app?.players.max ?? APP_UNBOUNDED_PLAYERS;
  const hostName = nameOf(live.hostUserId, input.person);

  let phase: StripPhase;
  let tone: LiveStripModel["tone"] = "normal";
  let line: StripRoleLine;

  if (seatedByServer && offlineTooLong) {
    phase = "lost";
    tone = "off";
    line = { kind: "lost" };
  } else if (seated && (!input.online || row?.connection === "reconnecting")) {
    phase = "reconnecting";
    tone = "off";
    line = { kind: "reconnecting" };
  } else if (live.handoff) {
    tone = "warn";
    const seconds = secondsUntil(live.handoff.at, now);
    const toUserId = live.handoff.toUserId;
    if (toUserId === null) {
      phase = seated ? "handoff-other" : "outside";
      line = { kind: "handoffNone", host: hostName, seconds };
    } else if (toUserId === viewerId && seated) {
      phase = "handoff-you";
      line = { kind: "handoffYou", host: hostName, seconds };
    } else {
      phase = seated ? "handoff-other" : "outside";
      line = {
        kind: "handoffOther",
        host: hostName,
        next: nameOf(toUserId, input.person),
        seconds,
      };
    }
  } else if (!seated) {
    phase = "outside";
    line = { kind: "hostIs", name: hostName };
  } else if (isHost) {
    phase = "host";
    line = { kind: "host" };
  } else if (spectating) {
    phase = "spectator";
    line = { kind: "watching", name: hostName };
  } else {
    phase = "participant";
    line = { kind: "hostIs", name: hostName };
  }

  const known = live.participants.map(
    (one) => input.person(one.userId) ?? { userId: one.userId, displayName: "?", avatarUrl: null },
  );
  const full = live.players >= max;
  const count: StripCount =
    live.players === 0 && live.spectators === 0
      ? { kind: "none" }
      : max >= APP_UNBOUNDED_PLAYERS
        ? { kind: "open", players: live.players, watching: live.spectators }
        : { kind: "of", players: live.players, max, watching: live.spectators };

  const canShare =
    isHost &&
    !input.phone &&
    input.channelType === "voice" &&
    app?.capabilities.share === "pane" &&
    app.shareAllowed === true;

  const takeHost = phase === "handoff-you";
  const canWatch = !seated && full && app?.players.spectators === true && app.shareAllowed === true;
  const enter: LiveStripModel["actions"]["enter"] = seated
    ? null
    : full
      ? canWatch
        ? "watch"
        : null
      : "join";

  return {
    kind: "live",
    sessionId: live.id,
    app: appOf(app, live.appId, input.locale),
    phase,
    tone,
    line,
    people: known.slice(0, CARD_AVATARS_SHOWN),
    more: Math.max(0, known.length - CARD_AVATARS_SHOWN),
    count,
    roster: live.participants.map((one, index) => ({
      userId: one.userId,
      name: known[index]!.displayName,
      avatarUrl: known[index]!.avatarUrl,
      host: one.userId === live.hostUserId,
      spectator: one.role === "spectator",
      reconnecting: one.connection === "reconnecting",
    })),
    seated,
    isHost,
    spectating: seated && spectating,
    showPane: seated && phase !== "lost",
    actions: {
      leave: seated || phase === "lost",
      end: (isHost || input.canModerate) && phase !== "lost",
      enter,
      takeHost,
      share: canShare,
    },
  };
}

/**
 * The line of seconds a screen reader hears: only at 60, 30 and 10 s (mock 03:
 * the countdown text ticks every second, the announcement does not).
 */
export function announceHandoffAt(seconds: number): boolean {
  return seconds === 60 || seconds === 30 || seconds === 10;
}
