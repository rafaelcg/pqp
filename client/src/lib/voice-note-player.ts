import { useSyncExternalStore } from "react";
import { fetchAttachmentUrl, markVoiceNoteListened } from "@/lib/api";

/**
 * The one voice note player for the whole tab.
 *
 * One `<audio>` element, created on first play and never attached to the
 * React tree, so:
 *
 * - only one note plays at a time (pressing play on another stops this one);
 * - a note keeps playing when the reader switches channel, because no card
 *   unmounting can take the element with it;
 * - auto-continue is allowed by the browser: the element already had a user
 *   gesture, and an `ended` handler starting the next note on the SAME element
 *   is not an autoplay.
 *
 * Cards register what they show (`registerVoiceNote`), which is the catalogue
 * auto-continue walks: the next note in the same channel, newer than the one
 * that ended, from somebody else, that this reader has not heard.
 */

export type PlaybackRate = 1 | 1.5 | 2;
export const PLAYBACK_RATES: readonly PlaybackRate[] = [1, 1.5, 2];

/** Past this much playback a note counts as heard. */
export const LISTENED_AFTER_MS = 1000;

export interface VoiceNoteEntry {
  attachmentId: string;
  messageId: string;
  channelId: string;
  createdAt: string;
  authorId: string;
  authorName: string;
  url: string;
  durationMs: number;
  /** What the server said when the message was read. */
  listenedByMe: boolean;
}

export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "error";

export interface PlayerState {
  current: VoiceNoteEntry | null;
  status: PlayerStatus;
  positionMs: number;
  rate: PlaybackRate;
  /** Whether a card for the current note is on screen; the mini player hides
   * when it is. */
  currentMounted: boolean;
}

// ------------------------------------------------------------ pure helpers

/**
 * The note auto-continue moves to once `current` ends, or null. Pure, so the
 * ordering is pinned by a test rather than by a browser.
 */
export function nextUnheardNote(
  entries: Iterable<VoiceNoteEntry>,
  current: Pick<VoiceNoteEntry, "attachmentId" | "channelId" | "createdAt" | "messageId">,
  viewerId: string | null,
  isListened: (entry: VoiceNoteEntry) => boolean = (entry) => entry.listenedByMe,
): VoiceNoteEntry | null {
  let best: VoiceNoteEntry | null = null;
  for (const entry of entries) {
    if (
      entry.channelId !== current.channelId ||
      entry.attachmentId === current.attachmentId ||
      entry.authorId === viewerId ||
      isListened(entry) ||
      compareNotes(entry, current) <= 0
    ) {
      continue;
    }
    if (!best || compareNotes(entry, best) < 0) {
      best = entry;
    }
  }
  return best;
}

/** Chronological, message id as the tie-break (one message, one note). */
function compareNotes(
  a: Pick<VoiceNoteEntry, "createdAt" | "messageId">,
  b: Pick<VoiceNoteEntry, "createdAt" | "messageId">,
): number {
  const at = Date.parse(a.createdAt);
  const bt = Date.parse(b.createdAt);
  if (at !== bt) {
    return at - bt;
  }
  return a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;
}

/** The next speed the pill steps to: 1x, 1.5x, 2x, then back to 1x. */
export function nextRate(rate: PlaybackRate): PlaybackRate {
  const index = PLAYBACK_RATES.indexOf(rate);
  return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length]!;
}

export function parseRate(raw: string | null | undefined): PlaybackRate {
  const value = Number(raw);
  return (PLAYBACK_RATES as readonly number[]).includes(value) ? (value as PlaybackRate) : 1;
}

// ------------------------------------------------------------------ store

let viewerId: string | null = null;
let state: PlayerState = {
  current: null,
  status: "idle",
  positionMs: 0,
  rate: 1,
  currentMounted: false,
};
const listeners = new Set<() => void>();
const catalog = new Map<string, Map<string, VoiceNoteEntry>>();
const mounted = new Map<string, number>();
/** Notes this tab has heard (or been told were heard on another socket). */
const heardHere = new Set<string>();
/** Notes whose listen this tab already reported, so it goes out once. */
const reported = new Set<string>();
/** One URL refresh per note per page load; a dead object fails again. */
const refreshed = new Set<string>();
let audio: HTMLAudioElement | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function setState(patch: Partial<PlayerState>) {
  state = { ...state, ...patch };
  emit();
}

export function subscribeVoiceNotes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPlayerState(): PlayerState {
  return state;
}

function rateKey(userId: string): string {
  return `pqp:voice-note-rate:${userId}`;
}

/**
 * Who is listening. The speed is remembered per account, so two people
 * sharing a computer (or the dev-bypass suffix accounts) keep their own.
 */
export function setVoiceNoteViewer(userId: string | null): void {
  if (userId === viewerId) {
    return;
  }
  const previous = viewerId;
  viewerId = userId;
  // A different account in the same tab (or a sign-out) starts from nothing:
  // what the last one heard, reported or had playing is theirs, not this
  // one's. The first sign-in has nothing to clear.
  if (previous !== null) {
    forgetViewerState();
  }
  let rate: PlaybackRate = 1;
  if (userId) {
    try {
      rate = parseRate(localStorage.getItem(rateKey(userId)));
    } catch {
      // Storage denied: 1x.
    }
  }
  if (audio) {
    audio.playbackRate = rate;
  }
  setState({ rate });
}

export function getVoiceNoteViewer(): string | null {
  return viewerId;
}

export function setPlaybackRate(rate: PlaybackRate): void {
  if (viewerId) {
    try {
      localStorage.setItem(rateKey(viewerId), String(rate));
    } catch {
      // Remembered for this page only.
    }
  }
  if (audio) {
    audio.playbackRate = rate;
  }
  setState({ rate });
}

/** A card says what it shows. Called on every render that changes the entry. */
export function registerVoiceNote(entry: VoiceNoteEntry): void {
  let channel = catalog.get(entry.channelId);
  if (!channel) {
    channel = new Map();
    catalog.set(entry.channelId, channel);
  }
  channel.set(entry.attachmentId, entry);
  // A fresher presigned URL for the note playing keeps the next error away.
  if (state.current?.attachmentId === entry.attachmentId && state.current.url !== entry.url) {
    state = { ...state, current: { ...state.current, url: entry.url } };
  }
}

/** A card mounted or unmounted. Returns the unmount half. */
export function mountVoiceNote(attachmentId: string): () => void {
  mounted.set(attachmentId, (mounted.get(attachmentId) ?? 0) + 1);
  syncMounted();
  return () => {
    const count = (mounted.get(attachmentId) ?? 1) - 1;
    if (count <= 0) {
      mounted.delete(attachmentId);
    } else {
      mounted.set(attachmentId, count);
    }
    syncMounted();
  };
}

function syncMounted() {
  const currentMounted = state.current ? mounted.has(state.current.attachmentId) : false;
  if (currentMounted !== state.currentMounted) {
    setState({ currentMounted });
  }
}

function isHeard(entry: VoiceNoteEntry): boolean {
  return entry.listenedByMe || heardHere.has(entry.attachmentId);
}

function ensureAudio(): HTMLAudioElement {
  if (audio) {
    return audio;
  }
  const element = new Audio();
  element.preload = "auto";
  // A voice at 2x should sound like the same person talking faster, not a
  // chipmunk. On by default in every engine today; set anyway, with the
  // prefixed names older WebKit and Gecko read.
  element.preservesPitch = true;
  (element as unknown as { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
  (element as unknown as { mozPreservesPitch?: boolean }).mozPreservesPitch = true;
  element.addEventListener("playing", () => {
    setState({ status: "playing" });
    startTicker();
  });
  element.addEventListener("pause", () => {
    if (state.status === "playing" || state.status === "loading") {
      setState({ status: "paused", positionMs: element.currentTime * 1000 });
    }
    stopTicker();
  });
  element.addEventListener("waiting", () => {
    if (state.status === "playing") {
      setState({ status: "loading" });
    }
  });
  element.addEventListener("ended", onEnded);
  element.addEventListener("error", onError);
  audio = element;
  return element;
}

function startTicker() {
  stopTicker();
  ticker = setInterval(() => {
    if (!audio || !state.current) {
      return;
    }
    const positionMs = audio.currentTime * 1000;
    if (positionMs >= LISTENED_AFTER_MS) {
      noteListened(state.current);
    }
    setState({ positionMs });
  }, 100);
}

function stopTicker() {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function onEnded() {
  stopTicker();
  const finished = state.current;
  if (finished) {
    noteListened(finished);
  }
  const next = finished
    ? nextUnheardNote(catalog.get(finished.channelId)?.values() ?? [], finished, viewerId, isHeard)
    : null;
  if (next) {
    startNote(next, 0);
    return;
  }
  setState({ status: "paused", positionMs: 0 });
}

function onError() {
  const current = state.current;
  if (!audio || !current || !audio.getAttribute("src")) {
    return;
  }
  // Presigned URLs expire. The first failure asks for a fresh one, the same
  // contract the image tiles keep; the second is a dead object.
  if (refreshed.has(current.attachmentId)) {
    stopTicker();
    setState({ status: "error" });
    return;
  }
  refreshed.add(current.attachmentId);
  const resumeAt = state.positionMs;
  const wasPlaying = state.status !== "paused";
  void fetchAttachmentUrl(current.attachmentId)
    .then((fresh) => {
      if (state.current?.attachmentId !== current.attachmentId || !audio) {
        return;
      }
      state = { ...state, current: { ...current, url: fresh.url } };
      audio.src = fresh.url;
      seekElement(audio, resumeAt);
      if (wasPlaying) {
        void audio.play().catch(() => setState({ status: "paused" }));
      }
    })
    .catch(() => {
      // Only if that note is still the one playing: the reader may have
      // moved on to another while this request was out.
      if (state.current?.attachmentId === current.attachmentId) {
        setState({ status: "error" });
      }
    });
}

function seekElement(element: HTMLAudioElement, positionMs: number) {
  const apply = () => {
    try {
      element.currentTime = positionMs / 1000;
    } catch {
      // Not seekable yet; it starts from the top.
    }
  };
  if (element.readyState >= 1) {
    apply();
  } else {
    element.addEventListener("loadedmetadata", apply, { once: true });
  }
}

function startNote(entry: VoiceNoteEntry, fromMs: number) {
  const element = ensureAudio();
  element.pause();
  element.src = entry.url;
  element.playbackRate = state.rate;
  element.defaultPlaybackRate = state.rate;
  if (fromMs > 0) {
    seekElement(element, fromMs);
  }
  state = {
    ...state,
    current: entry,
    status: "loading",
    positionMs: fromMs,
    currentMounted: mounted.has(entry.attachmentId),
  };
  emit();
  void element.play().catch(() => {
    if (state.current?.attachmentId === entry.attachmentId && state.status === "loading") {
      setState({ status: "paused" });
    }
  });
}

/** Play `entry`, or pause it when it is the one playing. */
export function toggleVoiceNote(entry: VoiceNoteEntry): void {
  registerVoiceNote(entry);
  const element = ensureAudio();
  if (state.current?.attachmentId === entry.attachmentId) {
    if (state.status === "playing" || state.status === "loading") {
      element.pause();
      setState({ status: "paused", positionMs: element.currentTime * 1000 });
      return;
    }
    if (state.status === "error") {
      refreshed.delete(entry.attachmentId);
      startNote(entry, state.positionMs);
      return;
    }
    // A note played to its end starts over; a paused one picks up.
    const atEnd = state.positionMs >= entry.durationMs - 50;
    if (!element.getAttribute("src") || atEnd) {
      startNote(entry, atEnd ? 0 : state.positionMs);
      return;
    }
    element.playbackRate = state.rate;
    void element.play().catch(() => setState({ status: "paused" }));
    setState({ status: "loading" });
    return;
  }
  startNote(entry, 0);
}

/**
 * Jump to a point. On the note playing, it seeks. On any other, it makes that
 * note current, paused at the point, so the next play starts there.
 */
export function seekVoiceNote(entry: VoiceNoteEntry, positionMs: number): void {
  const clamped = Math.max(0, Math.min(entry.durationMs, positionMs));
  if (state.current?.attachmentId === entry.attachmentId && audio) {
    seekElement(audio, clamped);
    setState({ positionMs: clamped });
    return;
  }
  audio?.pause();
  if (audio) {
    audio.removeAttribute("src");
    audio.load();
  }
  state = {
    ...state,
    current: entry,
    status: "paused",
    positionMs: clamped,
    currentMounted: mounted.has(entry.attachmentId),
  };
  emit();
}

/**
 * Everything that belongs to the account that was signed in: the note
 * playing, what it heard and reported, receipts it was shown, and the
 * catalogue built from its reads (which carries its `listenedByMe`).
 */
function forgetViewerState(): void {
  stopTicker();
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  for (const timer of retryTimers.values()) {
    clearTimeout(timer);
  }
  retryTimers.clear();
  catalog.clear();
  heardHere.clear();
  reported.clear();
  refreshed.clear();
  listened.clear();
  state = { ...state, current: null, status: "idle", positionMs: 0, currentMounted: false };
  emit();
}

/** Pause whatever is playing, keeping its place. Recording calls this. */
export function pauseVoiceNote(): void {
  if (audio && !audio.paused) {
    audio.pause();
  }
}

/** Stop and forget the current note (the mini player's close). */
export function stopVoiceNote(): void {
  stopTicker();
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  setState({ current: null, status: "idle", positionMs: 0, currentMounted: false });
}

// --------------------------------------------------------------- listened

/** Receipts per note: who, and when, as this tab knows them. */
export interface ListenedRecord {
  me: boolean;
  by: ReadonlyMap<string, string | null>;
}

const listened = new Map<string, ListenedRecord>();

function updateListened(attachmentId: string, change: (record: ListenedRecord) => ListenedRecord) {
  const before = listened.get(attachmentId) ?? { me: false, by: new Map() };
  listened.set(attachmentId, change(before));
  emit();
}

/**
 * This reader heard `entry`. Optimistic: the dot goes now, and the POST is
 * fire and forget. It is idempotent on the server, and a failure costs the
 * receipt on another device, never the reader's own view.
 */
function noteListened(entry: VoiceNoteEntry) {
  if (heardHere.has(entry.attachmentId) && reported.has(entry.attachmentId)) {
    return;
  }
  heardHere.add(entry.attachmentId);
  if (!listened.get(entry.attachmentId)?.me) {
    updateListened(entry.attachmentId, (record) => ({ ...record, me: true }));
  }
  // `reported` means sent or on its way; a failure takes it back out so a
  // retry (below) or the next play can send it again.
  if (entry.listenedByMe || entry.authorId === viewerId || reported.has(entry.attachmentId)) {
    reported.add(entry.attachmentId);
    return;
  }
  reported.add(entry.attachmentId);
  reportListened(entry.attachmentId, viewerId, 0);
}

/** Network errors and 5xx are worth another go; a refusal is not. */
export function isRetryableListenError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== "number") {
    return true;
  }
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

const LISTEN_RETRY_DELAYS_MS = [2_000, 8_000, 30_000];
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function reportListened(attachmentId: string, forViewer: string | null, attempt: number) {
  void markVoiceNoteListened(attachmentId).catch((error: unknown) => {
    if (viewerId !== forViewer) {
      return;
    }
    const delay = LISTEN_RETRY_DELAYS_MS[attempt];
    if (delay === undefined || !isRetryableListenError(error)) {
      // Given up: the next time this note plays past a second it tries again.
      reported.delete(attachmentId);
      return;
    }
    retryTimers.set(
      attachmentId,
      setTimeout(() => {
        retryTimers.delete(attachmentId);
        if (viewerId === forViewer) {
          reportListened(attachmentId, forViewer, attempt + 1);
        }
      }, delay),
    );
  });
}

/** The `voice-note-listened` frame, as far as the client relies on it. */
export interface VoiceNoteListenedFrame {
  type: "voice-note-listened";
  channelId: string;
  messageId: string;
  attachmentId: string;
  userId: string;
  listenedAt: string;
}

export function isVoiceNoteListenedFrame(message: unknown): message is VoiceNoteListenedFrame {
  if (!message || typeof message !== "object") {
    return false;
  }
  const frame = message as Record<string, unknown>;
  return (
    frame.type === "voice-note-listened" &&
    typeof frame.attachmentId === "string" &&
    typeof frame.userId === "string"
  );
}

/**
 * Somebody heard a note. The listener's own other sockets get this so their
 * dot goes everywhere at once; the author's get it for the "ouviu" line.
 */
export function applyVoiceNoteListened(frame: VoiceNoteListenedFrame): void {
  if (frame.userId === viewerId) {
    heardHere.add(frame.attachmentId);
    reported.add(frame.attachmentId);
    updateListened(frame.attachmentId, (record) => ({ ...record, me: true }));
    return;
  }
  updateListened(frame.attachmentId, (record) => {
    const by = new Map(record.by);
    by.set(frame.userId, typeof frame.listenedAt === "string" ? frame.listenedAt : null);
    return { ...record, by };
  });
}

export function getListened(attachmentId: string): ListenedRecord | undefined {
  return listened.get(attachmentId);
}

// ------------------------------------------------------------------ hooks

const NOT_CURRENT = Object.freeze({
  isCurrent: false as const,
  status: "idle" as PlayerStatus,
  positionMs: 0,
});

export type CardPlayback =
  | typeof NOT_CURRENT
  | { isCurrent: true; status: PlayerStatus; positionMs: number };

let currentCardSnapshot: { isCurrent: true; status: PlayerStatus; positionMs: number } | null = null;

function cardSnapshot(attachmentId: string): CardPlayback {
  if (state.current?.attachmentId !== attachmentId) {
    return NOT_CURRENT;
  }
  if (
    !currentCardSnapshot ||
    currentCardSnapshot.status !== state.status ||
    currentCardSnapshot.positionMs !== state.positionMs
  ) {
    currentCardSnapshot = { isCurrent: true, status: state.status, positionMs: state.positionMs };
  }
  return currentCardSnapshot;
}

/** This card's playback. Cards that are not current never re-render on ticks. */
export function useCardPlayback(attachmentId: string): CardPlayback {
  return useSyncExternalStore(
    subscribeVoiceNotes,
    () => cardSnapshot(attachmentId),
    () => NOT_CURRENT,
  );
}

export function usePlaybackRate(): PlaybackRate {
  return useSyncExternalStore(
    subscribeVoiceNotes,
    () => state.rate,
    () => 1 as PlaybackRate,
  );
}

export function useListened(attachmentId: string): ListenedRecord | undefined {
  return useSyncExternalStore(
    subscribeVoiceNotes,
    () => listened.get(attachmentId),
    () => undefined,
  );
}

export function usePlayerState(): PlayerState {
  return useSyncExternalStore(subscribeVoiceNotes, getPlayerState, getPlayerState);
}

/** Tests only: back to a fresh page. */
export function resetVoiceNotePlayerForTests(): void {
  stopTicker();
  audio = null;
  viewerId = null;
  catalog.clear();
  mounted.clear();
  heardHere.clear();
  reported.clear();
  refreshed.clear();
  listened.clear();
  for (const timer of retryTimers.values()) {
    clearTimeout(timer);
  }
  retryTimers.clear();
  state = { current: null, status: "idle", positionMs: 0, rate: 1, currentMounted: false };
}
