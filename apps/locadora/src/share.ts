import { PqpAppError } from "@pqp/app-sdk";

/**
 * Sharing the pane, and watching it. BUILT DARK: nothing here does anything
 * while the server's `locadora_share` flag is off (D14, `docs/APPS.md`), and
 * that flag stays off until Legal Gate L1b is answered in writing
 * (`docs/EMULATOR_ROOM.md`, item 7).
 *
 * How the app learns the flag is off: it does not read it. The host answers
 * `share.request` with `not-allowed` unless the manifest declares `share:
 * "pane"` AND the platform says the server may (`shareAllowed`, served by
 * `GET /api/apps/config`), so a single `share.request(false)` at the start (a
 * request to STOP sharing, which changes nothing when nothing is shared) is a
 * probe: an answer means the control may be drawn, anything else means it is
 * not drawn. The platform refuses the real request and the spectator joins
 * server side as well; hiding the control is the courtesy, not the lock.
 *
 * The pane is shared through pqp's own screen share flow, so the person
 * watching sees the existing share viewer, not something this app draws. What
 * this app adds for a watcher is only the line that says what they are looking
 * at (`spectatorNames`). Nothing here says or implies where a game came from.
 */

/** The slice of the SDK this uses, so a test can stand in for the host. */
export interface ShareHost {
  share: { request(on: boolean): Promise<boolean> };
}

/** Whether the control may be drawn, from one probe. */
export async function probeShare(host: ShareHost): Promise<boolean> {
  try {
    await host.share.request(false);
    return true;
  } catch {
    // not-allowed (the flag is off, or this is not a voice channel), unavailable (no share flow here),
    // anything else: either way there is nothing to offer
    return false;
  }
}

export type ShareOutcome = { kind: "shared"; on: boolean } | { kind: "refused" } | { kind: "failed" };

/** Asks to start or stop sharing. `refused` is the platform's no, `failed` is "not now, try again". */
export async function setShared(host: ShareHost, on: boolean): Promise<ShareOutcome> {
  try {
    return { kind: "shared", on: await host.share.request(on) };
  } catch (error) {
    if (error instanceof PqpAppError && error.code === "not-allowed") return { kind: "refused" };
    return { kind: "failed" };
  }
}

/** What the HUD's pill draws: `null` when sharing is not offered here. */
export type ShareView = { on: boolean; busy: boolean } | null;

/** The SDK surface the control needs: the request, and the page's push. */
export interface ShareControlHost extends ShareHost {
  on(event: "share", callback: (on: boolean) => void): () => void;
}

export interface ShareControl {
  /** Whether sharing is offered here (the probe's answer, or a refusal since). */
  readonly available: boolean;
  readonly sharing: boolean;
  readonly busy: boolean;
  /** The pill's press: start when off, stop when on. Resolves to what to say, if anything. */
  toggle(): Promise<"started" | "failed" | "refused" | null>;
  /** Called once the probe answered. */
  setAvailable(available: boolean): void;
  view(): ShareView;
  destroy(): void;
}

/**
 * ONE SOURCE OF TRUTH FOR THE SHARE. The page owns whether the pane is shared:
 * its switch above the pane, the call's own stop and this pill all change it,
 * and the page pushes every change (`share`). The pill shows that, never what
 * its own last request answered, so the two cannot disagree (Locadora feedback,
 * round 2: "Compartilhar" offered here while the page said the pane was shared).
 * A request's answer is applied too, for a page that predates the push.
 */
export function createShareControl(host: ShareControlHost, onChange: () => void): ShareControl {
  let available = false;
  let sharing = false;
  let busy = false;
  /** Counts the page's pushes, so a reply that lost a race to one is not applied. */
  let pushes = 0;
  const off = host.on("share", (on) => {
    pushes += 1;
    sharing = on;
    onChange();
  });
  return {
    get available() {
      return available;
    },
    get sharing() {
      return sharing;
    },
    get busy() {
      return busy;
    },
    setAvailable(next) {
      available = next;
      onChange();
    },
    view() {
      return available ? { on: sharing, busy } : null;
    },
    async toggle() {
      if (busy || !available) return null;
      const wantOn = !sharing;
      busy = true;
      onChange();
      const pushesBefore = pushes;
      const outcome = await setShared(host, wantOn);
      busy = false;
      let said: "started" | "failed" | "refused" | null = null;
      if (outcome.kind === "shared") {
        // A push that arrived while the request ran (the call bar's stop, the
        // switch above the pane) is newer than this answer: it wins, for the
        // state and for what is said (no "sharing" toast over a stopped share).
        if (pushes === pushesBefore) {
          sharing = outcome.on;
          if (outcome.on !== wantOn) said = "failed";
          else if (outcome.on) said = "started";
        }
      } else {
        said = outcome.kind;
        if (outcome.kind === "refused") available = false;
      }
      onChange();
      return said;
    },
    destroy: off,
  };
}

export interface Seat {
  displayName: string;
  role: string;
}

/** How many names the watcher's line spells out before "and N more". */
export const WATCHER_NAMES_SHOWN = 3;

/**
 * The people whose game a watcher is looking at: the players in the room
 * (a watcher is a spectator, so they are not in it). The names are what
 * strangers typed, so this only splits and counts, never builds markup.
 */
export function spectatorNames(participants: readonly Seat[]): { shown: string[]; more: number } {
  const players = participants.filter((person) => person.role === "player").map((person) => person.displayName);
  return { shown: players.slice(0, WATCHER_NAMES_SHOWN), more: Math.max(0, players.length - WATCHER_NAMES_SHOWN) };
}
