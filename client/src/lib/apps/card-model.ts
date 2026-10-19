import {
  appString,
  resolveAppLocale,
  type AppConfigEntry,
  type AppEndReason,
  type AppSessionSummary,
} from "@pqp/shared";
import {
  APP_RESUME_WINDOW_MS,
  isSeated,
  type AppJoinFailure,
  type AppJoinState,
  type EndedAppSession,
} from "@/lib/apps/app-sessions-store";

/**
 * What the timeline card says, decided from data and nothing else. The
 * component draws it; this file is where the nine states of mock 02 are told
 * apart, so a table of inputs pins every one of them.
 *
 *   open          live, tu ainda nao entrou (estado 1)
 *   inside        tu estas dentro (estado 2)
 *   full          sessao cheia, Assistir quando o app aceita (estado 3)
 *   reconnecting  tua conexao caiu, o lugar fica guardado por 90 s (estado 6)
 *   host-left     o host saiu, a contagem de quem assume (estado 7)
 *
 * and, layered on top of a live card, `join`: Entrando (estado 4) and a failed
 * join (estado 5). The quiet cards are `ended` (estado 8) and `disabled`
 * (estado 9), plus the same card without a summary for a session this tab only
 * heard end through `channel-app`.
 */

/** An app that takes this many players or more is "any size": no "cabem". */
export const APP_UNBOUNDED_PLAYERS = 32;
/** Avatars drawn on a card before the rest become "+N". */
export const CARD_AVATARS_SHOWN = 4;

export interface CardPerson {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface CardApp {
  id: string;
  name: string;
  icon: AppConfigEntry["icon"];
  category: AppConfigEntry["category"];
}

export type CardLivePhase = "open" | "inside" | "full" | "reconnecting" | "host-left";

export type CardSubtitle =
  | { kind: "started"; name: string; minutes: number }
  | { kind: "inside"; spectating: boolean }
  | { kind: "reconnecting" }
  | {
      kind: "handoff";
      host: string;
      /** Who takes over: a name, the viewer, or nobody (the app ends instead). */
      to: { kind: "person"; name: string } | { kind: "you" } | { kind: "none" };
      /** Seconds left, never below zero. */
      seconds: number;
    };

export type CardCount =
  | { kind: "none" }
  | { kind: "of"; players: number; max: number }
  | { kind: "open"; players: number }
  | { kind: "inside-full"; players: number }
  | { kind: "full"; players: number; max: number; watching: number };

export interface LiveCardModel {
  kind: "live";
  sessionId: string;
  app: CardApp;
  phase: CardLivePhase;
  subtitle: CardSubtitle;
  count: CardCount;
  people: readonly CardPerson[];
  /** People beyond the avatars drawn. */
  more: number;
  /** The room is full for this viewer (they are not seated). */
  full: boolean;
  /** Full and the app admits spectators here (D14 included). */
  canWatch: boolean;
  join:
    | { status: "idle" }
    | { status: "joining" }
    | { status: "failed"; code: AppJoinFailure };
}

export interface EndedCardModel {
  kind: "ended";
  app: CardApp;
  /**
   * Nothing on this tab says which app it was: the session ended before the tab
   * looked (a reload, a long-closed laptop). The message names only who started
   * it, so the card is the generic "terminou" and the component writes the title.
   */
  gone: boolean;
  /** The app was switched off, or is gone from the list, while it ran. */
  disabled: boolean;
  summary: { participants: number; durationSeconds: number } | null;
  starterName: string;
  startedAt: string;
  people: readonly CardPerson[];
  more: number;
}

export type CardModel = LiveCardModel | EndedCardModel;

export interface CardInput {
  /** The timeline message: its author is the starter, its time the start. */
  message: { authorName: string; createdAt: string };
  live?: AppSessionSummary;
  ended?: EndedAppSession;
  /** The app's config entry, undefined when it is no longer in the list. */
  app?: AppConfigEntry;
  viewerId: string | null;
  person: (userId: string) => CardPerson | undefined;
  join?: AppJoinState;
  online: boolean;
  offlineSince: number | null;
  now: number;
  locale: string;
}

/** The app's own words for this locale, then English, then the key. */
export function appText(app: AppConfigEntry, locale: string, key: string): string {
  const resolved = resolveAppLocale(locale);
  return (
    appString(app.i18n[resolved] ?? {}, key) ??
    appString(app.i18n.en ?? {}, key) ??
    key
  );
}

function cardApp(app: AppConfigEntry | undefined, appId: string, locale: string): CardApp {
  if (!app) {
    return { id: appId, name: appId, icon: "sparkles", category: "tool" };
  }
  return {
    id: app.id,
    name: appText(app, locale, app.name),
    icon: app.icon,
    category: app.category,
  };
}

function peopleOf(
  ids: readonly string[],
  person: CardInput["person"],
): { people: CardPerson[]; more: number } {
  const known = ids.map((id) => person(id) ?? { userId: id, displayName: "?", avatarUrl: null });
  return {
    people: known.slice(0, CARD_AVATARS_SHOWN),
    more: Math.max(0, known.length - CARD_AVATARS_SHOWN),
  };
}

/** Reasons the card reads as "the pqp turned it off", not "it ended". */
export function endedByOperatorSwitch(reason: AppEndReason | null): boolean {
  return reason === "app-disabled" || reason === "flag-off";
}

function wholeMinutesSince(iso: string, now: number): number {
  const started = Date.parse(iso);
  return Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 60_000)) : 0;
}

function countOf(
  players: number,
  max: number,
  phase: CardLivePhase,
  watching: number,
  fullForViewer: boolean,
): CardCount {
  if (fullForViewer) {
    return { kind: "full", players, max, watching };
  }
  if (players === 0) {
    return { kind: "none" };
  }
  if (phase === "inside" && players >= max) {
    return { kind: "inside-full", players };
  }
  if (max >= APP_UNBOUNDED_PLAYERS) {
    return { kind: "open", players };
  }
  return { kind: "of", players, max };
}

export function buildCardModel(input: CardInput): CardModel {
  const { live, ended, app } = input;

  if (live) {
    if (!app) {
      // Live, but the app is gone from the list the server released: the
      // operator switched it off under the session (mock 02, estado 9).
      return endedModel(input, live.appId, live.startedAt, live.startedBy, {
        summary: null,
        disabled: true,
        participantIds: live.participants.map((one) => one.userId),
      });
    }
    return liveModel(input, live, app);
  }

  if (ended) {
    return endedModel(input, ended.appId, ended.startedAt, ended.startedBy, {
      summary: ended.summary,
      disabled: endedByOperatorSwitch(ended.reason),
      participantIds: ended.participantIds,
    });
  }
  return goneModel(input);
}

function goneModel(input: CardInput): EndedCardModel {
  return {
    kind: "ended",
    app: { id: "", name: "", icon: "sparkles", category: "tool" },
    gone: true,
    disabled: false,
    summary: null,
    starterName: input.message.authorName,
    startedAt: input.message.createdAt,
    people: [],
    more: 0,
  };
}

function endedModel(
  input: CardInput,
  appId: string,
  startedAt: string,
  startedBy: string | null,
  extra: {
    summary: EndedCardModel["summary"];
    disabled: boolean;
    participantIds: readonly string[];
  },
): EndedCardModel {
  const starter = startedBy ? input.person(startedBy)?.displayName : undefined;
  const { people, more } = peopleOf(extra.participantIds, input.person);
  return {
    kind: "ended",
    app: cardApp(input.app, appId, input.locale),
    gone: false,
    disabled: extra.disabled,
    summary: extra.summary,
    starterName: starter ?? input.message.authorName,
    startedAt,
    people,
    more,
  };
}

function liveModel(
  input: CardInput,
  live: AppSessionSummary,
  app: AppConfigEntry,
): LiveCardModel {
  const { viewerId, now } = input;
  const seatedRow = viewerId
    ? live.participants.find((one) => one.userId === viewerId)
    : undefined;
  const offlineTooLong =
    !input.online &&
    input.offlineSince !== null &&
    now - input.offlineSince > APP_RESUME_WINDOW_MS;
  // Past the resume window the seat is gone, whatever this tab still believes.
  const seated = isSeated(live, viewerId) && !offlineTooLong;
  const max = app.players.max;
  const full = live.players >= max;

  let phase: CardLivePhase;
  if (seated) {
    const dropped = seatedRow?.connection === "reconnecting" || !input.online;
    phase = dropped ? "reconnecting" : "inside";
  } else if (live.handoff) {
    phase = "host-left";
  } else if (full) {
    phase = "full";
  } else {
    phase = "open";
  }

  const startedByName =
    (live.startedBy ? input.person(live.startedBy)?.displayName : undefined) ??
    input.message.authorName;

  let subtitle: CardSubtitle;
  if (phase === "inside") {
    subtitle = { kind: "inside", spectating: seatedRow?.role === "spectator" };
  } else if (phase === "reconnecting") {
    subtitle = { kind: "reconnecting" };
  } else if (phase === "host-left" && live.handoff) {
    const hostName =
      (live.hostUserId ? input.person(live.hostUserId)?.displayName : undefined) ??
      startedByName;
    const toUserId = live.handoff.toUserId;
    const to: Extract<CardSubtitle, { kind: "handoff" }>["to"] =
      toUserId === null
        ? { kind: "none" }
        : toUserId === viewerId
          ? { kind: "you" }
          : { kind: "person", name: input.person(toUserId)?.displayName ?? "?" };
    const at = Date.parse(live.handoff.at);
    subtitle = {
      kind: "handoff",
      host: hostName,
      to,
      seconds: Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : 0,
    };
  } else {
    subtitle = {
      kind: "started",
      name: startedByName,
      minutes: wholeMinutesSince(live.startedAt, now),
    };
  }

  const { people, more } = peopleOf(
    live.participants.map((one) => one.userId),
    input.person,
  );

  const joinState = input.join;
  const join: LiveCardModel["join"] =
    joinState?.status === "joining"
      ? { status: "joining" }
      : joinState?.status === "failed"
        ? { status: "failed", code: joinState.code }
        : { status: "idle" };

  return {
    kind: "live",
    sessionId: live.id,
    app: cardApp(app, app.id, input.locale),
    phase,
    subtitle,
    count: countOf(live.players, max, phase, live.spectators, !seated && full),
    people,
    more,
    full: !seated && full,
    canWatch: !seated && full && app.players.spectators && app.shareAllowed,
    join,
  };
}

/** `m:ss`, the way the countdown reads. */
export function formatCountdown(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/** "23 min", "1 h", "1 h 05 min": units that read the same in all three languages. */
export function formatSessionDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, "0")} min`;
}
