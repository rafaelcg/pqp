import { useSyncExternalStore } from "react";
import {
  NUDGE_COOLDOWN_MS,
  isFreshNudge,
  nudgesAllowed,
  type MessageSystemKind,
  type NudgeRefusalReason,
  type UserPreferences,
} from "@pqp/shared";
import { apiFetch } from "@/lib/api";
import { onConfigRefresh } from "@/lib/config-refresh";
import { getNotificationState, resolveNotificationLevel } from "@/lib/notifications";
import { createSendNonce } from "@/lib/outbox";
import { queuePreferenceSync } from "@/lib/preferences";
import { playCue } from "@/lib/sounds";

/**
 * CHAMAR A ATENÇÃO ON THE WEB: everything the nudge needs that is not drawing.
 *
 * Kept in one module, with no React tree of its own, so the pieces that do
 * draw (the header button, the line in the log, the shaking pane, the
 * settings switch) can sit wherever their surface lives and read the same
 * state. The DM header is being redesigned in parallel; the button only needs
 * this module and a send function, so it moves with the header.
 *
 * The server is the authority on every rule (`server/src/services/nudge.ts`).
 * What this keeps is presentation: the flag, the person's own switch, the
 * cooldown the last answer implied, the last refusal, and which pane should
 * shake. Nothing here guesses a refusal the server did not send, with one
 * exception: a click inside a cooldown the server already announced is
 * answered locally instead of spending a round trip on a known "no".
 */

// --------------------------------------------------------------- the flag

let enabled = false;
const flagListeners = new Set<() => void>();

function applyEnabled(next: boolean): void {
  if (next === enabled) {
    return;
  }
  enabled = next;
  for (const listener of flagListeners) {
    listener();
  }
}

/** Anything but an explicit `true` is off: an older API answers 404. */
export function nudgeFromConfig(answer: { nudge?: unknown }): boolean {
  return answer.nudge === true;
}

export const fetchFunConfig = () => apiFetch<{ nudge?: boolean }>("/api/fun/config");

let asked = 0;
let applied = 0;

export async function loadFunConfig(
  fetcher: () => Promise<{ nudge?: unknown }> = fetchFunConfig,
): Promise<void> {
  asked += 1;
  const mine = asked;
  try {
    const next = nudgeFromConfig(await fetcher());
    if (mine > applied) {
      applied = mine;
      applyEnabled(next);
    }
  } catch {
    // An older API or a blip: keep the last answer.
  }
}

/** Ask now and on every config refresh. Returns the teardown. */
export function startFunConfig(): () => void {
  void loadFunConfig();
  const stop = onConfigRefresh(() => {
    void loadFunConfig();
  });
  return () => {
    stop();
    asked += 1;
    applied = asked;
    applyEnabled(false);
  };
}

export function isNudgeEnabled(): boolean {
  return enabled;
}

export function useNudgeEnabled(): boolean {
  return useSyncExternalStore(
    (listener) => {
      flagListeners.add(listener);
      return () => {
        flagListeners.delete(listener);
      };
    },
    () => enabled,
    // Same answer off the DOM: this app never hydrates, and a static render
    // (the tests) should draw what the store holds.
    () => enabled,
  );
}

/** Test seam. */
export function setNudgeEnabledForTests(on: boolean): void {
  applyEnabled(on);
}

// ------------------------------------------------------- my own switch

/**
 * `allowNudges`, synced like every other preference: local first so the first
 * render is right, the account copy wins on read (`adoptAllowNudges`), and a
 * change is sent at once. Off means off in both directions, which the server
 * enforces; this only draws the switch and words the refusal.
 */
export const ALLOW_NUDGES_STORAGE_KEY = "pqp-allow-nudges";

function readStoredAllow(): boolean {
  try {
    return localStorage.getItem(ALLOW_NUDGES_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

let allow = typeof localStorage === "undefined" ? true : readStoredAllow();
const allowListeners = new Set<() => void>();

function commitAllow(next: boolean): boolean {
  if (next === allow) {
    return false;
  }
  allow = next;
  try {
    localStorage.setItem(ALLOW_NUDGES_STORAGE_KEY, String(next));
  } catch {
    // Persistence is a convenience.
  }
  for (const listener of allowListeners) {
    listener();
  }
  return true;
}

export function getAllowNudges(): boolean {
  return allow;
}

/** The person flipped the switch. */
export function setAllowNudges(next: boolean): void {
  commitAllow(next);
  queuePreferenceSync({ allowNudges: next }, { immediate: true });
}

/** The account copy from `/api/me`. Never written back. */
export function adoptAllowNudges(
  preferences: Pick<UserPreferences, "allowNudges"> | null | undefined,
): void {
  if (!preferences) {
    return;
  }
  commitAllow(nudgesAllowed(preferences));
}

export function useAllowNudges(): boolean {
  return useSyncExternalStore(
    (listener) => {
      allowListeners.add(listener);
      return () => {
        allowListeners.delete(listener);
      };
    },
    () => allow,
    () => allow,
  );
}

// --------------------------------------------------- per conversation

export interface NudgeNotice {
  reason: NudgeRefusalReason;
  /** When it was said, for the line's key and for clearing it. */
  at: number;
}

export interface NudgeChannelState {
  /** A frame is on the wire and nothing has answered it yet. */
  pending: boolean;
  /** Epoch ms before which the server has said no. 0 when free. */
  cooldownUntil: number;
  /** The last refusal, shown as a local line under the log until cleared. */
  notice: NudgeNotice | null;
  /** Bumped when my nudge lands, so the button can play its little shake. */
  landed: number;
}

const IDLE: NudgeChannelState = {
  pending: false,
  cooldownUntil: 0,
  notice: null,
  landed: 0,
};

/** No answer in this long: the button is let go (the socket is down or slow). */
export const NUDGE_PENDING_TIMEOUT_MS = 8_000;

/** How long a refusal line stays under the log. */
export const NUDGE_NOTICE_MS = 8_000;

const channels = new Map<string, NudgeChannelState>();
const pendingNonces = new Map<string, string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const channelListeners = new Set<() => void>();

function stateOf(channelId: string): NudgeChannelState {
  return channels.get(channelId) ?? IDLE;
}

function update(channelId: string, patch: Partial<NudgeChannelState>): void {
  channels.set(channelId, { ...stateOf(channelId), ...patch });
  for (const listener of channelListeners) {
    listener();
  }
}

function later(key: string, ms: number, run: () => void): void {
  const existing = timers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      run();
    }, ms),
  );
}

function setNotice(channelId: string, reason: NudgeRefusalReason, now: number): void {
  update(channelId, { notice: { reason, at: now } });
  later(`notice:${channelId}`, NUDGE_NOTICE_MS, () => {
    if (stateOf(channelId).notice?.at === now) {
      update(channelId, { notice: null });
    }
  });
}

export function getNudgeChannelState(channelId: string): NudgeChannelState {
  return stateOf(channelId);
}

export function useNudgeChannelState(channelId: string | null): NudgeChannelState {
  return useSyncExternalStore(
    (listener) => {
      channelListeners.add(listener);
      return () => {
        channelListeners.delete(listener);
      };
    },
    () => (channelId ? stateOf(channelId) : IDLE),
    () => (channelId ? stateOf(channelId) : IDLE),
  );
}

/** Put a conversation's line away (the person dismissed it, or wrote something). */
export function clearNudgeNotice(channelId: string): void {
  if (stateOf(channelId).notice) {
    update(channelId, { notice: null });
  }
}

export type NudgeSendOutcome = "sent" | "pending" | "cooldown" | "self-off" | "offline";

export interface NudgeSendOptions {
  /** `transport.sendChat`, or anything that puts a frame on the socket. */
  send: (frame: { type: "nudge"; channelId: string; nonce: string }) => void;
  /** Whether the socket is up. A nudge queued for later would arrive stale. */
  connected: boolean;
  now?: number;
}

/**
 * The click. Answers locally only for what is already known: a frame still in
 * flight, a cooldown the server announced, my own switch being off, or no
 * socket at all (a nudge is only worth anything now). Everything else is the
 * server's call.
 */
export function sendNudge(channelId: string, options: NudgeSendOptions): NudgeSendOutcome {
  const now = options.now ?? Date.now();
  const current = stateOf(channelId);
  if (current.pending) {
    return "pending";
  }
  if (current.cooldownUntil > now) {
    setNotice(channelId, "cooldown", now);
    return "cooldown";
  }
  if (!allow) {
    setNotice(channelId, "self-off", now);
    return "self-off";
  }
  if (!options.connected) {
    setNotice(channelId, "unavailable", now);
    return "offline";
  }
  const nonce = createSendNonce();
  pendingNonces.set(channelId, nonce);
  update(channelId, { pending: true, notice: null });
  try {
    options.send({ type: "nudge", channelId, nonce });
  } catch {
    // The socket went away between the check and the send. Nothing is on the
    // wire, so let the button go at once and say so.
    pendingNonces.delete(channelId);
    update(channelId, { pending: false });
    setNotice(channelId, "unavailable", now);
    return "offline";
  }
  later(`pending:${channelId}`, NUDGE_PENDING_TIMEOUT_MS, () => {
    if (pendingNonces.get(channelId) === nonce) {
      pendingNonces.delete(channelId);
      update(channelId, { pending: false });
    }
  });
  return "sent";
}

export interface NudgeRefusedFrame {
  channelId: string;
  reason: NudgeRefusalReason;
  retryAfterMs?: number;
  nonce?: string;
}

/** The server said no. */
export function handleNudgeRefused(frame: NudgeRefusedFrame, now: number = Date.now()): void {
  const inFlight = pendingNonces.get(frame.channelId);
  // An answer to a request this tab is no longer waiting for (it timed out,
  // or a newer one is in flight) must not settle or speak over anything: the
  // person already got their button back. Only an answer without a nonce
  // (another client's) or to the request in flight counts.
  if (frame.nonce && inFlight !== frame.nonce) {
    return;
  }
  pendingNonces.delete(frame.channelId);
  const cooldownUntil =
    frame.reason === "cooldown"
      ? now + (frame.retryAfterMs && frame.retryAfterMs > 0 ? frame.retryAfterMs : NUDGE_COOLDOWN_MS)
      : stateOf(frame.channelId).cooldownUntil;
  update(frame.channelId, { pending: false, cooldownUntil });
  setNotice(frame.channelId, frame.reason, now);
}

// ------------------------------------------------------------- effects

export interface NudgeMessageLike {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  systemKind?: MessageSystemKind | null;
}

export interface NudgeArrivalContext {
  viewerId: string | null;
  /** The conversation on screen, if any. */
  openChannelId: string | null;
  /** `document.visibilityState === "visible"`. */
  visible: boolean;
  /**
   * The conversation's notification level is not "all": muted, or mentions
   * only (a nudge is not a mention). The same rule the toast, the banner and
   * the push already apply to it.
   */
  muted: boolean;
  now?: number;
}

export interface NudgeEffects {
  /** My own nudge landed: start the cooldown, play the button's little shake. */
  landed: boolean;
  /** Shake the open conversation (or pulse it, under reduced motion). */
  shake: boolean;
  /** Play the nudge cue (still gated by the sound settings). */
  sound: boolean;
}

const NONE: NudgeEffects = { landed: false, shake: false, sound: false };

/**
 * What a nudge arriving on the live socket should do. Pure, so the rules can be
 * read and tested in one place:
 *
 *  - mine (this tab or another of my devices): the cooldown starts, nothing
 *    shakes, no sound;
 *  - somebody else's, but stale (a replay, a slow socket): the line only;
 *  - a muted conversation, or one set to mentions only: the line only (D10;
 *    a nudge is not a mention, and the toast, banner and push say the same);
 *  - otherwise, in the conversation that is open: the cue plays, and the pane
 *    shakes if the tab is visible. Any other conversation is left to the
 *    `channel-activity` path (toast, banner, cue), so the cue never plays
 *    twice; the server only sends that frame for a conversation that is not
 *    open, which is why the open one, hidden tab included, is played here.
 */
export function nudgeEffects(message: NudgeMessageLike, context: NudgeArrivalContext): NudgeEffects {
  if (message.systemKind !== "nudge") {
    return NONE;
  }
  const now = context.now ?? Date.now();
  if (context.viewerId && message.authorId === context.viewerId) {
    const age = now - Date.parse(message.createdAt);
    return { ...NONE, landed: Number.isFinite(age) && age < NUDGE_COOLDOWN_MS };
  }
  if (!isFreshNudge(message, context.viewerId, now) || context.muted) {
    return NONE;
  }
  const open = context.openChannelId === message.channelId;
  return { landed: false, shake: open && context.visible, sound: open };
}

/** Apply the bookkeeping half of `nudgeEffects` for my own landed nudge. */
export function noteOwnNudgeLanded(channelId: string, now: number = Date.now()): void {
  pendingNonces.delete(channelId);
  update(channelId, {
    pending: false,
    cooldownUntil: now + NUDGE_COOLDOWN_MS,
    notice: null,
    landed: stateOf(channelId).landed + 1,
  });
}

/**
 * A nudge just arrived on the live socket: work out what it should do and do
 * it. The conversation's own notification level decides `muted` (a
 * conversation has no server, so only its own entry and the DM default
 * apply; anything but "all" is quiet). Never called for history, which is
 * what keeps a reload still.
 */
export function applyNudgeArrival(
  message: NudgeMessageLike,
  context: Omit<NudgeArrivalContext, "muted">,
): NudgeEffects {
  const muted =
    resolveNotificationLevel(getNotificationState(), null, message.channelId) !== "all";
  const effects = nudgeEffects(message, { ...context, muted });
  if (effects.landed) {
    noteOwnNudgeLanded(message.channelId, context.now);
  }
  if (effects.shake) {
    triggerNudgeShake(message.channelId);
  }
  if (effects.sound) {
    playCue("nudge");
  }
  return effects;
}

// ------------------------------------------------------------- the shake

const shakes = new Map<string, number>();
const shakeListeners = new Set<() => void>();

/** Ask the pane showing this conversation to shake once. */
export function triggerNudgeShake(channelId: string): void {
  shakes.set(channelId, (shakes.get(channelId) ?? 0) + 1);
  for (const listener of shakeListeners) {
    listener();
  }
}

/** A number that changes every time the pane should shake; 0 before the first. */
export function useNudgeShakeTick(channelId: string | null): number {
  return useSyncExternalStore(
    (listener) => {
      shakeListeners.add(listener);
      return () => {
        shakeListeners.delete(listener);
      };
    },
    () => (channelId ? (shakes.get(channelId) ?? 0) : 0),
    () => 0,
  );
}

// ----------------------------------------------------------- /nudge

/**
 * The conversation the `/nudge` command acts on: registered by the header
 * button while it is on screen, so the command exists exactly where the button
 * does and needs no wiring of its own through the composer.
 */
export interface NudgeTarget {
  channelId: string;
  trigger: () => NudgeSendOutcome;
}

let target: NudgeTarget | null = null;

export function setNudgeTarget(next: NudgeTarget | null): void {
  target = next;
}

export function getNudgeTarget(): NudgeTarget | null {
  return enabled ? target : null;
}

/** Test seam: forget every conversation, timer and registration. */
export function resetNudgeStateForTests(): void {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
  channels.clear();
  pendingNonces.clear();
  shakes.clear();
  target = null;
  allow = true;
  applyEnabled(false);
}
