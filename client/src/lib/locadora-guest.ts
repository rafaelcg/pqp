import type { BridgeUiActivityState, PublicGuestApp } from "@pqp/shared";
import type { AppRuntimeConfig } from "./apps/types";
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
 * This module: the paths, the cartridge handed over from the landing, the sign-up card's
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
  /** The player is up: the frame said hello. */
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

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// --------------------------------------------- the cartridge from the door

/**
 * "Botar a fita" on the landing: the person picks (or drops) a file there, and
 * the guest player opens with it already in, no second picker. The file is
 * read by the page under the manifest's rules (`readLocalFile`: accept list,
 * cap, bytes and an extension, never the name) and held HERE, in this
 * module's memory, for the one navigation to the player, which happens inside
 * the SPA with no reload. Never written to storage, never sent anywhere: a
 * reload or a new tab simply finds nothing and the player opens on the shelf.
 * The player takes it once; the frame's first `files.pickLocal` is answered
 * with it (`hello.pendingFile`).
 */
export interface PendingCartridge {
  bytes: ArrayBuffer;
  ext: string;
}

let pending: PendingCartridge | null = null;

export function holdCartridge(cartridge: PendingCartridge): void {
  pending = cartridge;
}

/** The cartridge held for the player, once; null when there is none. */
export function takeCartridge(): PendingCartridge | null {
  const out = pending;
  pending = null;
  return out;
}

/** Whether a cartridge is waiting, without taking it. */
export function hasCartridge(): boolean {
  return pending !== null;
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
