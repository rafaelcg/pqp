import type { BridgeUiActivityState, PublicGuestApp } from "@pqp/shared";
import type { AppRuntimeConfig } from "./apps/types";
import { judgePreviewAge, type PreviewAgeVerdict } from "./live-preview";
import { track } from "./track";

/**
 * LOCADORA WITHOUT AN ACCOUNT ("guest play"), the pure half.
 *
 * `pqp.gg/locadora/jogar` (and `pqp.gg/apps/locadora/play`) runs the real
 * Locadora bundle from the apps origin, in the same sandboxed frame a member
 * gets, for somebody with no account. Behind the global runtime flag
 * `locadora_guest` (and `apps_landing`), read from the public apps config, the
 * only request the page makes to the API. What it is NOT: a session on the
 * server, a socket, a cookie, an id. The frame host runs a session that lives
 * in the page (`apps/guest-session.ts`), the shelf and the saves live in this
 * browser's own guest store, and the game file never leaves the device.
 *
 * This module: the paths, the age check on the device, the sign-up card's
 * rules (when it may show, what it remembers), the runtime the frame host
 * gets, and the three closed events. The page is `pages/locadora-guest-page.tsx`.
 */

/** The canonical, short, shareable address. */
export const LOCADORA_GUEST_PATH = "/locadora/jogar";
/** The same page under the apps tree, in English, for links that follow `/apps/...`. */
export const LOCADORA_GUEST_ALIAS = "/apps/locadora/play";

// ------------------------------------------------------------- measurement

/**
 * The telemetry spec's guest events, names only: no property, no id, nothing
 * about the game. Through `track()`, which is inert without the hosted Umami
 * tag. The Google tag never loads on these paths (`google-ads-tag.ts`).
 */
export const LOCADORA_GUEST_EVENTS = {
  /** The player is up: the frame said hello after the age question. */
  start: "locadora_guest_start",
  /** The sign-up card was shown. */
  upsellShown: "locadora_guest_upsell_shown",
  /** A "Criar conta grátis" on the guest player was pressed (the top bar or the card). */
  signupClick: "locadora_guest_signup_click",
} as const;

export type LocadoraGuestEvent = (typeof LOCADORA_GUEST_EVENTS)[keyof typeof LOCADORA_GUEST_EVENTS];

export function trackLocadoraGuest(event: LocadoraGuestEvent): void {
  track(event);
}

// --------------------------------------------------------------------- age

/**
 * The age question, answered on the device exactly like the signed-out live
 * preview (`judgePreviewAge`: the account gate's rule and `MINIMUM_AGE_YEARS`).
 * The date is never sent and never stored; only the verdict is, on this
 * device: an adult is not asked again for `GUEST_AGE_OK_TTL_MS`, somebody under
 * the threshold is not offered the date again for a day.
 */
export const GUEST_AGE_OK_KEY = "pqp:locadora-guest-age-ok";
export const GUEST_AGE_DECLINED_KEY = "pqp:locadora-guest-age-declined";
export const GUEST_AGE_OK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const GUEST_AGE_DECLINED_TTL_MS = 24 * 60 * 60 * 1000;

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type GuestAgeMemory = "passed" | "declined" | null;

export function judgeGuestAge(isoDate: string | null, now: Date = new Date()): PreviewAgeVerdict {
  return judgePreviewAge(isoDate, now);
}

function stamp(storage: ReadStorage | null, key: string): number | null {
  const value = Number(storage?.getItem(key) ?? NaN);
  return Number.isFinite(value) ? value : null;
}

export function readGuestAgeMemory(local: ReadStorage | null, now: number = Date.now()): GuestAgeMemory {
  try {
    const declined = stamp(local, GUEST_AGE_DECLINED_KEY);
    if (declined !== null && now - declined < GUEST_AGE_DECLINED_TTL_MS) return "declined";
    const passed = stamp(local, GUEST_AGE_OK_KEY);
    if (passed !== null && now - passed < GUEST_AGE_OK_TTL_MS) return "passed";
  } catch {
    // storage denied: ask again. Nothing loads without an answer.
  }
  return null;
}

export function rememberGuestAge(verdict: "adult" | "minor", local: WriteStorage | null, now: number = Date.now()): void {
  try {
    if (verdict === "adult") {
      local?.setItem(GUEST_AGE_OK_KEY, String(now));
      local?.removeItem(GUEST_AGE_DECLINED_KEY);
    } else {
      local?.setItem(GUEST_AGE_DECLINED_KEY, String(now));
    }
  } catch {
    // denied storage forgets the answer, which only means asking again
  }
}

// ------------------------------------------------------------ the runtime

/** The frame host's view of the app, from the public config. Never shares, never syncs. */
export function guestRuntimeOf(app: PublicGuestApp): AppRuntimeConfig {
  return {
    id: app.id,
    version: app.version,
    entry: { url: app.entry.url },
    capabilities: {
      share: app.capabilities.share,
      localFiles: app.capabilities.localFiles,
      deviceStore: app.capabilities.deviceStore,
    },
    state: app.state,
    events: app.events,
    assets: app.assets.map((asset) => ({ ...asset })),
    shareAllowed: false,
  };
}

// ------------------------------------------------------ the sign-up card

/**
 * "Gostou da Locadora?": WHEN it may show.
 *
 * Never over a running game. It is offered only at a calm moment the app
 * itself reports through `ui.activity`, and only after the person really
 * played:
 *
 * - a pause, after `UPSELL_PAUSE_AFTER_MS` of play in this visit;
 * - an eject (a game that ran goes back to the shelf), after
 *   `UPSELL_EJECT_AFTER_MS` of play;
 * - the frame left idle: paused or on the shelf for `UPSELL_IDLE_MS` in a row,
 *   after any play at all.
 *
 * And only once per device per day (`UPSELL_SHOW_EVERY_MS`), once per visit,
 * and not for `UPSELL_DISMISS_MS` after "Agora não". The moment the app says
 * `playing` again, the card goes away (that is not a dismissal). Nothing here
 * knows which game it is; the three states are all the page is told.
 */
export const UPSELL_STORAGE_KEY = "pqp:locadora-guest-upsell";
export const UPSELL_SHOW_EVERY_MS = 24 * 60 * 60 * 1000;
export const UPSELL_DISMISS_MS = 7 * 24 * 60 * 60 * 1000;
export const UPSELL_PAUSE_AFTER_MS = 5 * 60 * 1000;
export const UPSELL_EJECT_AFTER_MS = 30 * 1000;
export const UPSELL_IDLE_MS = 60 * 1000;

interface UpsellMemory {
  shownAt?: number;
  dismissedAt?: number;
}

function readUpsellMemory(storage: ReadStorage | null): UpsellMemory {
  try {
    const raw = storage?.getItem(UPSELL_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: UpsellMemory = {};
    if (typeof parsed.shownAt === "number" && Number.isFinite(parsed.shownAt)) out.shownAt = parsed.shownAt;
    if (typeof parsed.dismissedAt === "number" && Number.isFinite(parsed.dismissedAt)) out.dismissedAt = parsed.dismissedAt;
    return out;
  } catch {
    return {};
  }
}

function writeUpsellMemory(storage: WriteStorage | null, memory: UpsellMemory): void {
  try {
    storage?.setItem(UPSELL_STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // denied storage: the card may show again next visit, never twice in this one
  }
}

/** Whether this device may see the card now (the day and the "Agora não" rules). */
export function upsellAllowed(storage: ReadStorage | null, now: number = Date.now()): boolean {
  const memory = readUpsellMemory(storage);
  if (memory.dismissedAt !== undefined && now - memory.dismissedAt < UPSELL_DISMISS_MS) return false;
  if (memory.shownAt !== undefined && now - memory.shownAt < UPSELL_SHOW_EVERY_MS) return false;
  return true;
}

export function rememberUpsellShown(storage: WriteStorage | null, now: number = Date.now()): void {
  writeUpsellMemory(storage, { ...readUpsellMemory(storage), shownAt: now });
}

export function rememberUpsellDismissed(storage: WriteStorage | null, now: number = Date.now()): void {
  writeUpsellMemory(storage, { ...readUpsellMemory(storage), dismissedAt: now });
}

export type UpsellDecision = "show" | "hide" | null;

/**
 * The moment machine: fed every `ui.activity` and a clock tick, it says when
 * to show the card (`show`), when to take it away (`hide`, the game is
 * running again) and otherwise nothing. Whether the device may see the card at
 * all (`upsellAllowed`) is the caller's check, at the moment of showing.
 */
export class UpsellMoments {
  private state: BridgeUiActivityState = "browsing";
  private since: number;
  private playedMs = 0;
  private playingSince: number | null = null;
  private played = false;
  private offered = false;

  constructor(now: number) {
    this.since = now;
  }

  /** Total play in this visit, counting a game still running. */
  playedFor(now: number): number {
    return this.playedMs + (this.playingSince === null ? 0 : now - this.playingSince);
  }

  activity(next: BridgeUiActivityState, now: number): UpsellDecision {
    const previous = this.state;
    if (next === previous) return null;
    if (this.playingSince !== null) {
      this.playedMs += now - this.playingSince;
      this.playingSince = null;
    }
    this.state = next;
    this.since = now;
    if (next === "playing") {
      this.playingSince = now;
      this.played = true;
      return "hide";
    }
    if (this.offered) return null;
    if (next === "paused" && this.playedMs >= UPSELL_PAUSE_AFTER_MS) return this.offer();
    const ejected = next === "browsing" && (previous === "playing" || previous === "paused");
    if (ejected && this.playedMs >= UPSELL_EJECT_AFTER_MS) return this.offer();
    return null;
  }

  /** Called every few seconds: a calm frame left alone long enough. */
  tick(now: number): UpsellDecision {
    if (this.offered || !this.played || this.state === "playing") return null;
    return now - this.since >= UPSELL_IDLE_MS ? this.offer() : null;
  }

  private offer(): UpsellDecision {
    this.offered = true;
    return "show";
  }

  get current(): BridgeUiActivityState {
    return this.state;
  }
}
