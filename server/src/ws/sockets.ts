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
  /**
   * This socket understands `presence-delta` and applies it under the sequence
   * rule in `@pqp/shared`'s `presenceDeltaSchema` — the same rule as the voice
   * roster's, on purpose. Without it a socket keeps receiving the whole viewer
   * list of a channel every time anybody opens or closes it, which is what
   * every client did before.
   */
  presenceDelta: "presence-delta",
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

/**
 * How many sockets are authenticated, and how many of them negotiated a given
 * capability. Exists for the operator dashboard: a wire feature that clients
 * are not actually asking for is the failure mode that looks exactly like
 * success (pitfall 9 in CLAUDE.md, where Cloudflare TURN was configured,
 * deployed and never once used), and a fraction is the only thing that tells
 * the two apart from outside.
 */
export function countAuthenticatedSockets(cap: string): {
  sockets: number;
  withCap: number;
} {
  let withCap = 0;
  for (const entry of sockets.values()) {
    if (entry.caps.has(cap)) {
      withCap += 1;
    }
  }
  return { sockets: sockets.size, withCap };
}

export function forEachAuthenticatedSocket(
  callback: (socket: WebSocket, user: DbUser, caps: ReadonlySet<string>) => void,
): void {
  for (const entry of sockets.values()) {
    callback(entry.socket, entry.user, entry.caps);
  }
}
