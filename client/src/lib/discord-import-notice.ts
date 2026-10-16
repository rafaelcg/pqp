import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/api";
import { browserStorage } from "@/lib/arrival";
import { onConfigRefresh } from "@/lib/config-refresh";
import { readHintValue, rememberHintValue } from "@/lib/hints";

/**
 * "VEIO DO DISCORD? TRAZ TEU SERVIDOR PRA CÁ": the invitation to import a
 * Discord server, drawn once in the main channel of a small, new server for
 * somebody who may manage it.
 *
 * WHY. About four people a day copy a Discord layout (`docs/DISCORD_IMPORT.md`)
 * and the door is three clicks deep (create dialog, third row, paste), or a
 * link only the `/vem` page writes. Somebody who already made an empty room
 * and has a Discord full of friends is the person who has not found it. The
 * card says the one thing that stops people trying: nothing is deleted, here
 * or on their Discord. It is honest about the size of the promise: it copies
 * the layout (categories and channels), not members or messages, so the copy
 * names categories and channels and nothing more.
 *
 * Behind the runtime flag `discord_import_notice` (global, default off),
 * answered by `GET /api/onboarding/config` as `discordImportNotice`; whether
 * a server came from an import is `imported` on the arrivals route. Off, or
 * with either answer missing, nothing on screen differs from before. The
 * rules are plain functions so a test can call each one.
 */

// ------------------------------------------------------------------ config

let noticeOn = false;
const listeners = new Set<() => void>();

function apply(next: boolean): void {
  if (next === noticeOn) {
    return;
  }
  noticeOn = next;
  for (const listener of listeners) {
    listener();
  }
}

/** Anything but an explicit `true` is off: an older API sends no field. */
export function noticeFromConfig(answer: { discordImportNotice?: unknown }): boolean {
  return answer.discordImportNotice === true;
}

export const fetchNoticeConfig = () =>
  apiFetch<{ discordImportNotice?: boolean }>("/api/onboarding/config");

/**
 * Asks can overlap (the first read and a focus refresh); only an answer newer
 * than the last one applied counts, so a slow stale `true` cannot undo a flip.
 */
let asked = 0;
let applied = 0;

export async function loadDiscordImportNoticeConfig(
  fetcher: () => Promise<{ discordImportNotice?: unknown }> = fetchNoticeConfig,
): Promise<void> {
  asked += 1;
  const mine = asked;
  try {
    const next = noticeFromConfig(await fetcher());
    if (mine > applied) {
      applied = mine;
      apply(next);
    }
  } catch {
    // An older API (404) or a blip: keep the last answer.
  }
}

/** Ask now and on every config refresh. Returns the teardown. */
export function startDiscordImportNoticeConfig(): () => void {
  void loadDiscordImportNoticeConfig();
  const stop = onConfigRefresh(() => {
    void loadDiscordImportNoticeConfig();
  });
  return () => {
    stop();
    // The answer belongs to the account that asked.
    asked += 1;
    applied = asked;
    apply(false);
  };
}

export function isDiscordImportNoticeOn(): boolean {
  return noticeOn;
}

export function useDiscordImportNoticeFlag(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => noticeOn,
    () => false,
  );
}

/** Test seam. */
export function setDiscordImportNoticeForTests(on: boolean): void {
  apply(on);
}

// ------------------------------------------------------------------- rules

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "Small and new". A Discord import pays off while a room is still nearly
 * empty: the owner has made it, has not built it out, and has not yet moved
 * anybody in. Past any one of these the person has settled where they are,
 * and a card telling them to start over reads as noise.
 *
 * - a month: a room made last week is the one with the question; a room made
 *   last year with three members is where somebody decided to stay;
 * - twenty people: three in four imports arrive under ten and the median
 *   room that was imported got two or three (`BRING_CREW_REMIND_BELOW`), so
 *   twenty is a room with a crowd in it already;
 * - eight channels: the default room has a text and a voice channel. Eight is
 *   a layout somebody already built by hand, which is what the import saves.
 */
export const NOTICE_MAX_SERVER_AGE_MS = 30 * DAY_MS;
export const NOTICE_MAX_MEMBERS = 20;
export const NOTICE_MAX_CHANNELS = 8;

/** After a close, how long until it may come back (once). */
export const NOTICE_REAPPEAR_AFTER_MS = 14 * DAY_MS;

/** A card that has been closed this many times never comes back. */
export const NOTICE_MAX_CLOSES = 2;

export interface NoticeRecord {
  /** How many times the person closed it, counting the first. */
  closes: number;
  /** When it was last closed, epoch ms. */
  lastClosedAt: number;
  /** The button was pressed: the question is answered, for good. */
  clicked: boolean;
}

const EMPTY_RECORD: NoticeRecord = { closes: 0, lastClosedAt: 0, clicked: false };

export function noticeKey(userId: string, serverId: string): string {
  return `pqp:discord-import-notice:${userId}:${serverId}`;
}

/** Whatever was stored, or nothing. Garbage reads as an empty record. */
export function parseNoticeRecord(raw: string | null): NoticeRecord {
  if (!raw) {
    return EMPTY_RECORD;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<NoticeRecord> | null;
    const closes = Number(parsed?.closes);
    const lastClosedAt = Number(parsed?.lastClosedAt);
    return {
      closes: Number.isInteger(closes) && closes > 0 ? closes : 0,
      lastClosedAt: Number.isFinite(lastClosedAt) && lastClosedAt > 0 ? lastClosedAt : 0,
      clicked: parsed?.clicked === true,
    };
  } catch {
    return EMPTY_RECORD;
  }
}

/**
 * May the card be on screen, given what this person did with it before?
 * Pressing the button ends it. Closing it once hides it for
 * `NOTICE_REAPPEAR_AFTER_MS`, then it may show a second time; closing it a
 * second time ends it. A close time in the future (a clock set back) reads as
 * "just closed", so a wrong clock cannot bring it back early.
 */
export function noticeAllowedByHistory(
  record: NoticeRecord,
  now: number = Date.now(),
): boolean {
  if (record.clicked || record.closes >= NOTICE_MAX_CLOSES) {
    return false;
  }
  if (record.closes === 0) {
    return true;
  }
  return now - record.lastClosedAt >= NOTICE_REAPPEAR_AFTER_MS;
}

export interface DiscordImportNoticeFacts {
  /** `discordImportNotice` from `/api/onboarding/config`. */
  flagOn: boolean;
  /** Owner or Manage Server on the open server. */
  canManage: boolean;
  /** The open server's `createdAt` (ISO). */
  serverCreatedAt: string | null | undefined;
  /** Members loaded for the open server; 0 means "not loaded yet". */
  memberCount: number;
  /** Text plus voice channels on the open server (categories are not counted). */
  channelCount: number;
  /**
   * `imported` from the arrivals route. Only an explicit `false` is "this
   * server was not made by an import": undefined (an older API, the route not
   * answered yet, a blip) is unknown, and unknown shows nothing.
   */
  imported: boolean | undefined;
  /** The open channel is the server's main text channel. */
  onMainTextChannel: boolean;
  /** A live watch party is on screen: the film is the welcome. */
  partyLive: boolean;
  /** This person is in a voice call. */
  inCall: boolean;
  /** Another onboarding strip, hint or card holds the slot or the corner. */
  otherCardUp: boolean;
  /** What this person did with it before. */
  record: NoticeRecord;
  /** The record could be read (hostile storage reads as "already handled"). */
  recordReadable: boolean;
}

export function isSmallAndNew(
  facts: Pick<
    DiscordImportNoticeFacts,
    "serverCreatedAt" | "memberCount" | "channelCount"
  >,
  now: number = Date.now(),
): boolean {
  if (!facts.serverCreatedAt) {
    return false;
  }
  const created = Date.parse(facts.serverCreatedAt);
  if (!Number.isFinite(created)) {
    return false;
  }
  const age = now - created;
  // A little slack for a skewed clock, none for a server from the future.
  if (age < -60_000 || age >= NOTICE_MAX_SERVER_AGE_MS) {
    return false;
  }
  return (
    facts.memberCount > 0 &&
    facts.memberCount <= NOTICE_MAX_MEMBERS &&
    facts.channelCount <= NOTICE_MAX_CHANNELS
  );
}

export function discordImportNoticeVisible(
  facts: DiscordImportNoticeFacts,
  now: number = Date.now(),
): boolean {
  return (
    facts.flagOn &&
    facts.canManage &&
    facts.imported === false &&
    facts.onMainTextChannel &&
    !facts.partyLive &&
    !facts.inCall &&
    !facts.otherCardUp &&
    facts.recordReadable &&
    noticeAllowedByHistory(facts.record, now) &&
    isSmallAndNew(facts, now)
  );
}

// ------------------------------------------------------------------- store

/**
 * The person's history with the card for one server, in the hints store
 * (`lib/hints.ts`: nothing persists on localhost unless `pqp:hints-persist`
 * is set, unreadable storage reads as handled). Keyed by user AND server: two
 * accounts on one browser each get their own answer, and a second server of
 * the same person asks again.
 */
export function readNoticeRecord(
  userId: string,
  serverId: string,
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
): { record: NoticeRecord; readable: boolean } {
  const { readable, value } = readHintValue(noticeKey(userId, serverId), storage);
  return { record: parseNoticeRecord(value), readable };
}

export function writeNoticeRecord(
  userId: string,
  serverId: string,
  record: NoticeRecord,
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
): void {
  rememberHintValue(noticeKey(userId, serverId), JSON.stringify(record), storage);
}

export function closedRecord(before: NoticeRecord, now: number = Date.now()): NoticeRecord {
  return { ...before, closes: before.closes + 1, lastClosedAt: now };
}

export function clickedRecord(before: NoticeRecord, now: number = Date.now()): NoticeRecord {
  return { ...before, clicked: true, lastClosedAt: now };
}

/**
 * The record for the open server, plus the two ways out. Holds the answer in
 * state as well as in storage, so on a host that does not persist (localhost)
 * closing it still hides it for the rest of the page.
 */
export function useDiscordImportNoticeRecord(
  userId: string | null,
  serverId: string | null,
): {
  record: NoticeRecord;
  readable: boolean;
  close: () => void;
  click: () => void;
} {
  const [state, setState] = useState<{
    key: string | null;
    record: NoticeRecord;
    readable: boolean;
  }>({ key: null, record: EMPTY_RECORD, readable: false });
  const key = userId && serverId ? noticeKey(userId, serverId) : null;

  useEffect(() => {
    if (!userId || !serverId) {
      setState({ key: null, record: EMPTY_RECORD, readable: false });
      return;
    }
    const read = readNoticeRecord(userId, serverId);
    setState({ key: noticeKey(userId, serverId), record: read.record, readable: read.readable });
  }, [userId, serverId]);

  // The latest state, so the write below runs once per press, not inside a
  // state updater (which React may call twice).
  const latest = useRef(state);
  latest.current = state;
  const settle = useCallback(
    (next: (before: NoticeRecord) => NoticeRecord) => {
      if (!userId || !serverId) {
        return;
      }
      const at = noticeKey(userId, serverId);
      const before = latest.current.key === at ? latest.current.record : EMPTY_RECORD;
      const record = next(before);
      writeNoticeRecord(userId, serverId, record);
      setState({ key: at, record, readable: true });
    },
    [userId, serverId],
  );

  const close = useCallback(() => settle((before) => closedRecord(before)), [settle]);
  const click = useCallback(() => settle((before) => clickedRecord(before)), [settle]);

  // A render after a server switch, before the effect above ran, must not
  // apply one server's history to another.
  const current = state.key === key && key !== null;
  return {
    record: current ? state.record : EMPTY_RECORD,
    readable: current ? state.readable : false,
    close,
    click,
  };
}
