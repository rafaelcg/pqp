import {
  canPerformWatchPartyAction,
  watchPartyRole,
  type WatchParty,
} from "@pqp/shared";
import {
  getWatchPartyRow,
  loadCohostRows,
  mapWatchParty,
  markWatchPartyHostBack,
  markWatchPartyHostGone,
} from "../services/watch-parties.js";
import { getChannelAudience } from "../services/servers.js";
import { computeMemberPermissions } from "../services/permissions.js";
import { canAccessChannel } from "../services/users.js";
import { forEachAuthenticatedSocket, userHasAuthenticatedSocket } from "./sockets.js";
import { noteWatchPartyState } from "./watch-party-live.js";

/**
 * The `watch-party-update` fan-out, and the host's connection.
 *
 * Kept out of both `services/watch-parties.ts` (which owns the SQL and must
 * stay testable without a socket) and `ws/voice.ts` (which is already the
 * largest file in the server and owns the media path). This module is the
 * seam between them: one frame type, one audience rule, one clock.
 *
 * THE AUDIENCE RULE IS THE WHOLE POINT OF THIS FILE. A party in `draft` is
 * invisible, and "invisible" cannot be implemented by the sender picking a
 * list once: whether a given person may see a given party depends on their
 * role in it, which depends on per-channel permission overwrites. So the
 * frame is resolved per recipient, exactly like `channel-live` stamps a token
 * per recipient, and a socket that may not see this state is sent nothing at
 * all rather than a redacted version.
 */

/** Per-user permission answers, valid for one broadcast. */
type PermissionCache = Map<string, bigint>;

async function permissionsFor(
  cache: PermissionCache,
  serverId: string,
  userId: string,
  channelId: string,
): Promise<bigint> {
  const key = `${userId}:${channelId}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const perms = await computeMemberPermissions(serverId, userId, channelId);
  cache.set(key, perms);
  return perms;
}

/**
 * Tell everyone who may see it what this party looks like now.
 *
 * `party` is resolved per recipient because `viewerRole` and `reminding` are
 * per person. That is more work than one encoded frame, and it is bounded by
 * the number of people who can see the channel, which is the same bound
 * `broadcastChannelLive` already accepts on a much hotter path (every 30
 * seconds, versus this one, which fires on a state change a human caused).
 *
 * A TERMINAL PARTY IS BROADCAST AS `null`. The sidebar block and the channel
 * header both key off "is there a party", and an `ended` object sitting in
 * that slot would keep the block on screen after the show. Sending null is
 * how the block disappears.
 */
export async function broadcastWatchParty(sessionId: string): Promise<void> {
  const row = await getWatchPartyRow(sessionId).catch(() => null);
  if (!row) {
    return;
  }
  const audience = await getChannelAudience(row.channel_id).catch(() => null);
  if (!audience) {
    return;
  }
  // THE ONE PLACE THAT SEES EVERY STATE CHANGE, which is why the egress's
  // "is the party over" mark is set from here rather than from each of the
  // seven callers. Before the audience walk and before any `await` that could
  // fail: the mark must be set even for a party nobody is left to tell.
  // See `watch-party-live.ts` for why this exists and why it fails open.
  // THE ONE PLACE THAT SEES EVERY STATE CHANGE, which is why the egress's
  // "is the party over" mark is set from here rather than from each of the
  // seven callers. Before the audience walk and before any `await` that could
  // fail: the mark must be set even for a party nobody is left to tell.
  // See `watch-party-live.ts` for why this exists and why it fails open.
  noteWatchPartyState(row.channel_id, row.status);
  const cohosts = await loadCohostRows(row.id).catch(() => []);
  const cohostIds = cohosts.map((c) => c.user_id);
  const cache: PermissionCache = new Map();
  const terminal = row.status === "ended" || row.status === "cancelled";

  const targets: { socket: import("ws").WebSocket; userId: string }[] = [];
  forEachAuthenticatedSocket((socket, user) => {
    if (socket.readyState !== 1 || !audience.has(user.id)) {
      return;
    }
    targets.push({ socket, userId: user.id });
  });

  for (const target of targets) {
    let party: WatchParty | null = null;
    if (!terminal && row.server_id) {
      const permissions = await permissionsFor(
        cache,
        row.server_id,
        target.userId,
        row.channel_id,
      );
      const role = watchPartyRole({
        userId: target.userId,
        hostUserId: row.host_user_id,
        cohostUserIds: cohostIds,
        permissions,
      });
      if (
        !canPerformWatchPartyAction({
          action: "view",
          role,
          state: row.status,
        })
      ) {
        // A draft, seen by someone who is not running it. They are told
        // nothing at all, not even that it ended: as far as this socket is
        // concerned the party has never existed.
        continue;
      }
      party = mapWatchParty(row, cohosts, role, false);
    }
    if (party === null && !terminal) {
      continue;
    }
    try {
      target.socket.send(
        JSON.stringify({
          type: "watch-party-update",
          channelId: row.channel_id,
          party,
        }),
      );
    } catch {
      // A socket that died between the walk and the send is the close
      // handler's problem, not this one's.
    }
  }
}

/**
 * Every party this person may see, for a socket that just authenticated.
 *
 * The same catch-up `sendAllVoiceRosters` does for rosters and `channel-live`,
 * and for the same reason: a client that connects in the middle of a show must
 * not have to wait for the next state change to learn there is one. Without
 * this, refreshing during a watch party loses the sidebar block until the host
 * touches something.
 *
 * Scoped to the servers this person is in, and re-checked per channel: a
 * membership row is not VIEW on every channel in it.
 */
export async function catchUpWatchParties(
  socket: import("ws").WebSocket,
  userId: string,
): Promise<void> {
  const { listServersForUser } = await import("../services/servers.js");
  const { listActiveWatchPartiesForServer } = await import(
    "../services/watch-parties.js"
  );
  const servers = await listServersForUser(userId);
  for (const server of servers) {
    if (socket.readyState !== 1) {
      return;
    }
    const cache: PermissionCache = new Map();
    const parties = await listActiveWatchPartiesForServer(server.id, {
      userId,
      permissionsFor: (channelId) =>
        permissionsFor(cache, server.id, userId, channelId),
    }).catch(() => [] as WatchParty[]);
    for (const party of parties) {
      if (!(await canAccessChannel(party.channelId, userId))) {
        continue;
      }
      if (socket.readyState !== 1) {
        return;
      }
      socket.send(
        JSON.stringify({
          type: "watch-party-update",
          channelId: party.channelId,
          party,
        }),
      );
    }
  }
}

// ------------------------------------------------------- the host's presence

/**
 * A socket authenticated. If this person hosts a live party whose grace clock
 * was running, they are back and the clock stops.
 *
 * Fire and forget from `ws/index.ts`: a reconnect must not wait on a write,
 * and the worst case of a lost clear is that the sweep ends a party whose
 * host is present, which the host can see and restart. The opposite (a lost
 * *stamp*) is the one that must not silently happen, and that path is a
 * single UPDATE on close.
 */
export async function onHostSocketOpened(userId: string): Promise<void> {
  const channels = await markWatchPartyHostBack(userId);
  await announceChannels(channels);
}

/**
 * A socket closed. If it was this person's LAST socket and they host a live
 * party, start the grace clock.
 *
 * THE "LAST SOCKET" CHECK IS WHY THIS IS NOT IN THE SERVICE. Somebody with
 * the app open on a laptop and a phone closes one of them constantly; only
 * the transition to zero sockets is a host going away, and the socket
 * registry is the only thing that knows.
 */
export async function onHostSocketClosed(userId: string): Promise<void> {
  if (userHasAuthenticatedSocket(userId)) {
    return;
  }
  const channels = await markWatchPartyHostGone(userId);
  await announceChannels(channels);
}

async function announceChannels(channelIds: readonly string[]): Promise<void> {
  for (const channelId of channelIds) {
    const { getActiveWatchPartyRow } = await import(
      "../services/watch-parties.js"
    );
    const row = await getActiveWatchPartyRow(channelId).catch(() => null);
    if (row) {
      await broadcastWatchParty(row.id);
    }
  }
}
