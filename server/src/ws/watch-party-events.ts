import {
  canPerformWatchPartyAction,
  watchPartyRole,
  type WatchParty,
} from "@pqp/shared";
import {
  getWatchPartyRow,
  invalidateActiveWatchParty,
  legacyWatchPartyStageOf,
  loadCohostRows,
  loadWatchPartyGuestRows,
  mapWatchParty,
  markWatchPartyHostBack,
  markWatchPartyHostGone,
  prepareWatchPartyGuests,
  shapeWatchPartyGuests,
  watchPartyOptionsOf,
  type PreparedWatchPartyGuests,
} from "../services/watch-parties.js";
import {
  invalidateWatchPartySeat,
  rememberWatchPartySeatSnapshot,
} from "../services/watch-party-seat-cache.js";
import { getChannelAudience } from "../services/servers.js";
import { computeMemberPermissions } from "../services/permissions.js";
import { canAccessChannel } from "../services/users.js";
import { forEachAuthenticatedSocket, userHasAuthenticatedSocket } from "./sockets.js";
import { hasClusterSocket } from "./status.js";
import { logEvent } from "../lib/log.js";
import { noteWatchPartyState } from "./watch-party-live.js";
import { z } from "zod";
import {
  isBusEnabled,
  publishToCluster,
  subscribeToCluster,
} from "../lib/bus.js";

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

/**
 * THE LAST GUEST SNAPSHOT THIS PROCESS SUCCESSFULLY LOADED, per session.
 *
 * A transient load failure (`loadWatchPartyGuestRows` catching and returning
 * null, previously) used to fall through to `mapWatchParty`'s default
 * parameter -- an EMPTY guests object -- and broadcast that to every
 * recipient as if it were the truth. For a 500-viewer party mid-Saturday
 * that reads as every guest going silent and every pending request
 * vanishing, to everyone, on one Postgres hiccup. Keeping the last value
 * this process actually confirmed and falling back to it on a failure is
 * "never emit empty" made literal: a stale-but-real answer beats a fresh
 * lie. Cleared when the party goes terminal, so a long-dead session cannot
 * hold memory forever; a live party overwrites its entry on every
 * successful load, so staleness is bounded by how often mutations happen,
 * which on a running party is constantly.
 */
const lastKnownGuestRows = new Map<
  string,
  Awaited<ReturnType<typeof loadWatchPartyGuestRows>>
>();

async function loadGuestRowsForBroadcast(
  sessionId: string,
): Promise<Awaited<ReturnType<typeof loadWatchPartyGuestRows>> | null> {
  try {
    const rows = await loadWatchPartyGuestRows(sessionId);
    lastKnownGuestRows.set(sessionId, rows);
    return rows;
  } catch (error) {
    const fallback = lastKnownGuestRows.get(sessionId);
    console.error(
      "[watch-party] guest rows load failed for a broadcast; " +
        (fallback ? "using the last known snapshot" : "no prior snapshot to fall back to") +
        ":",
      error,
    );
    return fallback ?? null;
  }
}

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
/**
 * THE PARTY'S STATE, TO THE OTHER MACHINE. `broadcastWatchParty` walks
 * `forEachAuthenticatedSocket`, which is this process's sockets only, and
 * production runs two `pqp-api` machines with no session affinity. So until
 * 2026-09-14 a party going live on machine A (or ending, or a guest change)
 * reached only the half of its audience whose socket happened to be on A; the
 * other half kept yesterday's block until their own next action refetched it.
 * The frame is the session id and nothing else: the receiving instance runs
 * its own `broadcastWatchParty`, which re-reads the row, resolves the party
 * per recipient and stamps nothing it did not compute itself. Gated on the
 * bus alone, like the seat cache's own invalidations: there is no row the
 * frame could be a rumour about, the row IS what the receiver reads.
 */
export const WATCH_PARTY_STATE_TOPIC = "watchParty.state";

const watchPartyStateFrameSchema = z.object({
  sessionId: z.string().uuid(),
});

/**
 * `watchParty.state` frames since boot, on `GET /api/admin/metrics` via
 * `watchPartyStateFrameCounters`. `relayed` is what this instance published;
 * `fromBus` is what it applied. Zero on one machine, both climbing on two.
 */
const watchPartyStateFrames = { relayed: 0, fromBus: 0 };

export function watchPartyStateFrameCounters(): {
  relayed: number;
  fromBus: number;
} {
  return { ...watchPartyStateFrames };
}

export function resetWatchPartyStateFrameCountersForTests(): void {
  watchPartyStateFrames.relayed = 0;
  watchPartyStateFrames.fromBus = 0;
}

/**
 * A RELAYED FRAME IS THE ONLY NOTICE THIS MACHINE GETS. The local caller that
 * published it has already finished; nothing here will be told again. So a
 * receiver whose Postgres blinks while reading the row would otherwise
 * consume the notification and leave its half of the audience on yesterday's
 * party until somebody's next mutation. `broadcastWatchParty` reports whether
 * it could read the row at all (an absent row is an answer, an unreadable one
 * is not), and an unreadable one is retried a few times with a widening gap.
 */
const WATCH_PARTY_RELAY_ATTEMPTS = 4;
const WATCH_PARTY_RELAY_BACKOFF_MS = 500;

/**
 * ONE WALK PER SESSION AT A TIME, plus at most one waiting behind it. A burst
 * of changes to the same party (a guest accepted, the stage changed, the host
 * went live) publishes a frame each, and each frame is a full audience walk
 * with a permission read per recipient; run concurrently they multiply that
 * cost for an answer every one of them re-reads from the same row anyway. The
 * pending one is not a queue: the row it will read is whatever the row is
 * when it runs, which is exactly the coalescing the roster already does.
 */
const relayedWalks = new Map<string, { pending: boolean }>();

function applyRelayedWatchPartyState(sessionId: string, attempt: number): void {
  const running = relayedWalks.get(sessionId);
  if (running) {
    running.pending = true;
    return;
  }
  const entry = { pending: false };
  relayedWalks.set(sessionId, entry);
  runRelayedWatchPartyWalk(sessionId, attempt, entry);
}

function runRelayedWatchPartyWalk(
  sessionId: string,
  attempt: number,
  entry: { pending: boolean },
): void {
  const done = (retry: string | null) => {
    relayedWalks.delete(sessionId);
    if (entry.pending) {
      // Something changed while this walk was running: one more walk, from
      // the top, which re-reads the row and so covers every frame that
      // arrived in the meantime.
      applyRelayedWatchPartyState(sessionId, 1);
      return;
    }
    if (retry === null) {
      return;
    }
    if (attempt >= WATCH_PARTY_RELAY_ATTEMPTS) {
      console.error("[watch-party] relayed state dropped:", sessionId, retry);
      return;
    }
    setTimeout(
      () => applyRelayedWatchPartyState(sessionId, attempt + 1),
      WATCH_PARTY_RELAY_BACKOFF_MS * attempt,
    ).unref?.();
  };
  void broadcastWatchParty(sessionId, { fromBus: true })
    .then((told) => {
      done(told ? null : "row or audience unreadable");
    })
    // A REJECTION IS A FAILED WALK TOO. `broadcastWatchParty` reports the two
    // failures it expects, but the permission and cohost reads inside it can
    // still throw; a caught-and-logged rejection would consume this machine's
    // only notice of the party exactly as a swallowed `false` would.
    .catch((error: unknown) => {
      console.error("[watch-party] relayed state broadcast failed:", error);
      done("broadcast threw");
    });
}

subscribeToCluster(WATCH_PARTY_STATE_TOPIC, (data) => {
  const parsed = watchPartyStateFrameSchema.safeParse(data);
  if (!parsed.success) {
    return;
  }
  watchPartyStateFrames.fromBus += 1;
  // The origin guard in `lib/bus.ts` already dropped this instance's own
  // frames; `fromBus` keeps the local walk from publishing in turn, which is
  // the other half of never letting two instances answer each other forever.
  applyRelayedWatchPartyState(parsed.data.sessionId, 1);
});

export async function broadcastWatchParty(
  sessionId: string,
  options: {
    /**
     * This walk was asked for by a `watchParty.state` frame from the other
     * machine: run the local half only. The seat cache is skipped too, because
     * the cache relays its own invalidations (`watch-party-seat-cache.ts`) and
     * this instance already dropped its copy when the originating walk ran.
     */
    fromBus?: boolean;
  } = {},
): Promise<boolean> {
  // This read follows a write to the SAME row moments earlier (the mutation
  // that made this call happen at all), so a failure here is almost always
  // a transient blip rather than a real absence — and giving up after one
  // try would also skip every invalidation below, including the read-cache
  // entry, leaving a stale "party is live" (or "no party") answer up to its
  // fresh-plus-stale window with nothing else positioned to catch it: this
  // function is the one place every mutation passes through. One retry
  // costs nothing on the common path and meaningfully narrows that gap.
  //
  // The answer says whether this walk actually happened: `false` means the
  // row could not be READ (both attempts threw) or the audience could not be
  // loaded, both of which a relayed frame retries, while a row that is simply
  // not there is a real answer and reported as one.
  let row: Awaited<ReturnType<typeof getWatchPartyRow>> = null;
  try {
    row = await getWatchPartyRow(sessionId).catch(() =>
      getWatchPartyRow(sessionId),
    );
  } catch (error) {
    console.error("[watch-party] session row unreadable:", error);
    return false;
  }
  if (!row) {
    return true;
  }
  const terminal = row.status === "ended" || row.status === "cancelled";
  // THE SEAT CACHE. Every mutation fans out through here, including a Voz
  // toggle that leaves `status` alone (so `noteWatchPartyState` is a no-op
  // for it). Drop the snapshot so the next join cannot keep a stale "voice
  // off" after the host turned it on, or a stale "voice on" after they
  // turned it off. A party that just ended is remembered as "none", which
  // is what lets the channel join like an ordinary voice room again without
  // another round trip. Before the audience walk on purpose: a fan-out
  // that bails must not leave the join gate holding yesterday's answer.
  if (terminal) {
    if (!options.fromBus) {
      rememberWatchPartySeatSnapshot(row.channel_id, null);
    }
    // Nothing left to fall back to for a party that is over; hold the
    // snapshot no longer than the party itself.
    lastKnownGuestRows.delete(row.id);
  } else if (!options.fromBus) {
    invalidateWatchPartySeat(row.channel_id);
  }
  // Published before the audience walk and before anything below can fail:
  // the other machine's walk must not depend on this one's audience load or
  // permission reads succeeding. Its own re-read of the row is the truth.
  if (!options.fromBus && isBusEnabled()) {
    watchPartyStateFrames.relayed += 1;
    publishToCluster(WATCH_PARTY_STATE_TOPIC, { sessionId: row.id });
  }
  // Same reasoning as the seat cache just above: this is the one place every
  // party mutation passes through, so one call here covers `getActiveWatchPartyRow`'s
  // read-cache entry for every caller (the HTTP read and the reconnect
  // announcer both go through it) rather than one invalidation per write
  // call site in `services/watch-parties.ts`.
  invalidateActiveWatchParty(row.channel_id);
  const audience = await getChannelAudience(row.channel_id).catch(() => null);
  if (!audience) {
    // Nobody was told. A relayed frame retries this; a local caller's own
    // mutation already failed loudly enough for its own path.
    return false;
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
  // ONE PAIR OF QUERIES FOR THE WHOLE FAN-OUT, not one per recipient: who is
  // on air, invited or asking is the same two rows for every socket this
  // broadcasts to. `prepareWatchPartyGuests` does the one sort and the one
  // pass of person-mapping ONCE here too; `shapeWatchPartyGuests` per
  // recipient below is then map lookups and array reuse, no query and no
  // sort of its own.
  //
  // SKIPPED ENTIRELY when `guests` is `off` -- the overwhelming common case,
  // since every ordinary voice-repurposed watch party (and every party
  // before this feature existed at all) never turns Convidados on. An "off"
  // party's `guests`/`stage` fields are `mapWatchParty`'s own defaults
  // (the correct, empty answer, proven byte-identical by
  // watch-party-options.test.ts), so there is nothing this query could add.
  // Also skipped for a terminal party, which sends `null` and needs no
  // guests at all.
  const guestsOff = watchPartyOptionsOf(row).guests === "off";
  const preparedGuests: PreparedWatchPartyGuests | null =
    terminal || guestsOff
      ? null
      : await loadGuestRowsForBroadcast(row.id).then((rows) =>
          rows ? prepareWatchPartyGuests(rows) : null,
        );

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
      // BUG THIS FIXES (2026-09-14): this call used to pass no guests
      // argument at all, so `mapWatchParty`'s default parameter
      // (`WATCH_PARTY_EMPTY_GUESTS`) shipped to every socket on every
      // mutation -- a request, an accept, a join. The ACTOR of a guest
      // action saw their own change (the HTTP response uses
      // `presentWatchParty`, which does this correctly), and everyone else
      // watching the same party over the open socket saw an empty queue
      // and an empty stage until their own next unrelated action refreshed
      // it. "The audience finds out without reloading anything" was true
      // for exactly one person per action: the one who took it.
      //
      // `undefined` here (guests off, or a load failure with no prior
      // snapshot to fall back to) triggers `mapWatchParty`'s own default,
      // the correct empty answer for the "off" case and the least-wrong
      // answer for the never-loaded-once case.
      const guests = preparedGuests
        ? shapeWatchPartyGuests(preparedGuests, role, target.userId)
        : undefined;
      party = mapWatchParty(
        row,
        cohosts,
        role,
        false,
        guests && legacyWatchPartyStageOf(guests),
        guests,
      );
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
  return true;
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
 * How often this instance declined to start a grace clock because the host
 * was still connected on ANOTHER machine. Zero on one machine, and on two it
 * is the number that says this check is doing something — the shape of
 * pitfall 12 in CLAUDE.md, where a cross-instance path shipped and never once
 * ran. Read by the tests; the `watchParty.hostSocketElsewhere` line beside it
 * is what says so in production's logs.
 */
const hostPresence = { heldElsewhere: 0 };

/** Test seam. */
export function readHostPresenceCounters(): { heldElsewhere: number } {
  return { ...hostPresence };
}

export function resetHostPresenceCountersForTests(): void {
  hostPresence.heldElsewhere = 0;
  for (const timer of recheckTimers.values()) {
    clearTimeout(timer);
  }
  recheckTimers.clear();
}

/**
 * Whether the host is still connected ANYWHERE — this process or any other.
 *
 * THE LOCAL MAP IS ASKED FIRST AND IS STILL THE FAST ANSWER: it is exact for
 * this process with no window, since `deleteAuthenticatedSocket` has already
 * run by the time we are called. What it cannot see is the other machine, and
 * on two API instances a host with the laptop on A and the phone on B closing
 * the laptop used to read, on B, as a host who had gone away: B started the
 * grace clock and the sweep ended a party whose host was sitting right there.
 *
 * The cluster half is the status registry, which merges every instance's
 * contribution over the bus and is the same source `push.ts` asks before it
 * wakes somebody's phone. With one machine (or the bus off) it can only see
 * this process's own sockets, so the answer is exactly what it always was.
 */
function hostIsConnectedAnywhere(userId: string): boolean {
  if (userHasAuthenticatedSocket(userId)) {
    return true;
  }
  if (!hasClusterSocket(userId)) {
    return false;
  }
  hostPresence.heldElsewhere += 1;
  logEvent("watchParty.hostSocketElsewhere", { userId });
  return true;
}

/**
 * How long after "still connected elsewhere" to ask again.
 *
 * THE ONE RACE A MERGED PRESENCE VIEW INTRODUCES. Each instance's
 * contribution reaches the others over the bus, so it is behind by the
 * propagation delay — and if the host's last socket on A and their last
 * socket on B close in the same instant, each process can have removed its
 * own and still be holding the other's not-yet-withdrawn contribution. Both
 * answer "connected", neither stamps, and nothing else in the system would
 * ever ask again: the party stays live with no grace clock and the sweep
 * never ends it. Asking once more, after long enough for the withdrawal to
 * have landed, closes it. `markWatchPartyHostGone` is idempotent
 * (`host_disconnected_at IS NULL`), so the common case — a host who really
 * does still have a tab open — costs one presence read and writes nothing.
 */
let hostPresenceRecheckMs = 5_000;

/** Test seam: the re-check is a clock, and a test needs it to be short. */
export function setHostPresenceRecheckMsForTests(ms: number): void {
  hostPresenceRecheckMs = ms;
}

/** One pending re-check per person, so N closing tabs cost one timer. */
const recheckTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleHostPresenceRecheck(userId: string): void {
  if (recheckTimers.has(userId)) {
    return;
  }
  const timer = setTimeout(() => {
    recheckTimers.delete(userId);
    if (hostIsConnectedAnywhere(userId)) {
      return;
    }
    void markWatchPartyHostGone(userId)
      .then(announceChannels)
      .catch((error: unknown) => {
        console.error("[watch-party] host presence re-check failed:", error);
      });
  }, hostPresenceRecheckMs);
  // Never a reason to keep the process alive: a shutdown drops every socket
  // anyway, and the next instance to see this host answers the question.
  timer.unref?.();
  recheckTimers.set(userId, timer);
}

/**
 * A socket closed. If it was this person's LAST socket ANYWHERE and they host
 * a live party, start the grace clock.
 *
 * THE "LAST SOCKET" CHECK IS WHY THIS IS NOT IN THE SERVICE. Somebody with
 * the app open on a laptop and a phone closes one of them constantly; only
 * the transition to zero sockets is a host going away, and the presence
 * registries are the only thing that knows.
 */
export async function onHostSocketClosed(userId: string): Promise<void> {
  if (hostIsConnectedAnywhere(userId)) {
    scheduleHostPresenceRecheck(userId);
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
