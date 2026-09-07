import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * OPTIONAL WIRE FEATURES A CLIENT DECLARES AT `auth`.
 *
 * The packaged desktop shell and the two native apps update on their own
 * schedule, and a person in a call is the last person to want a forced
 * refresh, so the server may never assume a client understands a frame that
 * did not exist when that client was built. Negotiating per socket is what
 * makes a wire change deployable at all: an old build keeps the exact bytes it
 * already handles, a new build opts in, and there is no flag day.
 *
 * Declared as an array of strings on the `auth` frame (`caps`), unknown
 * entries ignored, absent meaning none. Kept on the socket rather than the
 * user: the same account can hold an old phone and a new tab at once, and they
 * are not owed the same frames.
 */
export const SOCKET_CAPS = {
  /**
   * This socket understands `voice-roster-delta` and applies it under the
   * sequence rule in `@pqp/shared`'s `voiceRosterDeltaMessageSchema`. Without
   * it a socket keeps receiving a whole `voice-roster` every time anything in
   * the room changes, which is what every client did before.
   */
  voiceRosterDelta: "voice-roster-delta",
} as const;

export interface AuthenticatedSocket {
  socket: WebSocket;
  user: DbUser;
  /** What this client declared it understands. Empty for every older build. */
  caps: ReadonlySet<string>;
}

const sockets = new Map<WebSocket, AuthenticatedSocket>();

const NO_CAPS: ReadonlySet<string> = new Set();

export function setAuthenticatedSocket(
  socket: WebSocket,
  user: DbUser,
  caps: readonly string[] = [],
): void {
  sockets.set(socket, {
    socket,
    user,
    caps: caps.length > 0 ? new Set(caps) : NO_CAPS,
  });
}

export function getSocketUser(socket: WebSocket): DbUser | null {
  return sockets.get(socket)?.user ?? null;
}

export function getAuthenticatedSocket(
  socket: WebSocket,
): AuthenticatedSocket | undefined {
  return sockets.get(socket);
}

/** Whether this socket declared the named capability at `auth`. */
export function socketHasCap(socket: WebSocket, cap: string): boolean {
  return sockets.get(socket)?.caps.has(cap) ?? false;
}

export function deleteAuthenticatedSocket(socket: WebSocket): void {
  sockets.delete(socket);
}

export function forEachAuthenticatedSocket(
  callback: (socket: WebSocket, user: DbUser, caps: ReadonlySet<string>) => void,
): void {
  for (const entry of sockets.values()) {
    callback(entry.socket, entry.user, entry.caps);
  }
}
