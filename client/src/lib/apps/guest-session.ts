import type { JsonValue } from "@pqp/shared";
import { openBrowserDeviceStore, type DeviceStore } from "./device-store";
import { applyMergePatch } from "./merge-patch";
import type {
  AppSessionHandlers,
  AppSessionTransport,
  AppUserDirectory,
  SessionSnapshot,
} from "./types";

/**
 * THE GUEST SESSION: what stands in for the server when nobody is signed in
 * (`pqp.gg/locadora/jogar`, `pages/locadora-guest-page.tsx`).
 *
 * The bridge host (`bridge-host.ts`) talks to a session through an
 * `AppSessionTransport`; a signed-in frame gets the `/ws` one. A guest gets
 * this: a session that lives in the page and ends with it. One participant,
 * the guest, who is the host and a player. No socket, no route, no row: a join
 * answers at once, a state patch is applied here, an event reaches nobody
 * because nobody else is in the room, and ending it is the page's own
 * business. So the guest player makes no request of its own to the API at all
 * (the frame host still fetches the app's assets from the apps origin, the
 * same as for anybody).
 *
 * The seat id is random per page load, in the alphabet the bridge requires.
 * The "user id" below never leaves this file: the host maps it to a name and
 * builds the participant from scratch, as for any session.
 */

export const GUEST_SESSION_ID = "guest";
const GUEST_USER_ID = "guest";

const SEAT_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** 22 random base64url characters, the shape of a real seat id. */
export function randomGuestSeatId(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(22));
  let out = "";
  for (const byte of bytes) out += SEAT_ALPHABET[byte & 63];
  return out;
}

export interface GuestTransport extends AppSessionTransport {
  /** The page is going away (or the person left): tell the frame the session is over. */
  close(): void;
}

export function createGuestTransport(seatId: string = randomGuestSeatId()): GuestTransport {
  let handlers: AppSessionHandlers | null = null;
  let state: { rev: number; value: JsonValue } = { rev: 0, value: null };
  let closed = false;

  const snapshot = (): SessionSnapshot => ({
    sessionId: GUEST_SESSION_ID,
    seatId,
    role: "player",
    isHost: true,
    state,
    participants: [{ seatId, userId: GUEST_USER_ID, role: "player", isHost: true, connection: "present" }],
  });

  return {
    join() {
      return Promise.resolve(snapshot());
    },
    leave() {
      // nothing to release: the seat only ever existed in this page
    },
    patchState(patch) {
      state = { rev: state.rev + 1, value: applyMergePatch(state.value, patch) };
      const { rev, value } = state;
      // after the answer, like the server's `app-state` that follows the ack
      queueMicrotask(() => handlers?.onState(rev, value));
      return Promise.resolve({ rev });
    },
    sendEvent() {
      // one person in the room: an event has nobody to reach
    },
    end() {
      if (!closed) {
        closed = true;
        handlers?.onEnded("host");
      }
      return Promise.resolve();
    },
    subscribe(next) {
      handlers = next;
      return () => {
        if (handlers === next) handlers = null;
      };
    },
    close() {
      if (closed) return;
      closed = true;
      handlers?.onEnded("host");
    },
  };
}

/** The one person in a guest session: a name, never an avatar (there is no account to have one). */
export function guestUserDirectory(displayName: () => string): AppUserDirectory {
  return {
    resolve: (userId) => (userId === GUEST_USER_ID ? { displayName: displayName(), avatarUrl: null } : null),
  };
}

/**
 * The guest's device store: the same IndexedDB database, rules and cap as a
 * signed-in frame's (`device-store.ts`), under ITS OWN object store,
 * `guest:<app id>`. A guest's cartridges and saves are therefore never mixed
 * with those of an account used in the same browser, in either direction:
 * signing up does not move them and signing in does not show them here. The
 * upsell says it plainly ("tuas fitas ficam neste navegador").
 */
export const GUEST_STORE_PREFIX = "guest:";

export function guestStoreName(appId: string): string {
  return `${GUEST_STORE_PREFIX}${appId}`;
}

export function openGuestDeviceStore(appId: string, capBytes: number): DeviceStore | null {
  return openBrowserDeviceStore(guestStoreName(appId), capBytes);
}
