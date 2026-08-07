import { RoomServiceClient } from "livekit-server-sdk";
import { logEvent } from "../lib/log.js";
import {
  isLiveKitConfigured,
  userIdFromParticipantMetadata,
} from "./backends.js";

/**
 * LiveKit room administration — the SFU half of voice eviction.
 *
 * WHY THIS EXISTS
 * Mesh eviction (`ws/voice.ts`) drops a peer from the signaling map, which
 * makes every other client tear down its RTCPeerConnection to that peer. With
 * an SFU the media never touches this process at all, so dropping the signaling
 * peer does nothing to the audio: a kicked or banned account stays connected to
 * LiveKit and keeps talking until it chooses to leave. Mesh and SFU must never
 * disagree about who is allowed in a call — that asymmetry is the moderation
 * hole this module closes.
 *
 * INVARIANTS
 * 1. **No-op unless LiveKit is configured.** A mesh-only deployment (the
 *    default) never constructs a client and never makes a network call, so its
 *    behaviour is byte-for-byte what it was before this module existed.
 * 2. **Never throws, never rejects.** Every entry point returns a promise that
 *    always resolves. A ban must land even when the SFU is unreachable —
 *    letting an admin API call fail because LiveKit is down would mean the
 *    person stays *both* in the room and in the server. Failures are logged
 *    loudly (`[pqp] voice.sfuEvictFailed`) rather than swallowed, because a ban
 *    that half-worked is worse than one that failed visibly.
 * 3. **Fire-and-forget.** The mesh helpers that call this are synchronous and
 *    run inside request handlers that have already committed the moderation
 *    action. Tests (and only tests) await `settleSfuEvictions()`.
 *
 * WHY THE SWEEP IS UNCONDITIONAL
 * These functions do not consult the local peer map to decide *whether* to run.
 * With LiveKit configured a call legitimately spans instances (see the block
 * comment above `peers` in `ws/voice.ts`), and a client whose WebSocket dropped
 * keeps its LiveKit connection. So "no local peer for this user" does not mean
 * "not in the room"; the room itself is the only authority, and we ask it.
 */

interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

function liveKitConfig(): LiveKitConfig | null {
  if (!isLiveKitConfigured()) {
    return null;
  }
  return {
    url: process.env.LIVEKIT_URL!,
    apiKey: process.env.LIVEKIT_API_KEY!,
    apiSecret: process.env.LIVEKIT_API_SECRET!,
  };
}

/**
 * Cached per credential set rather than per process: env is read at call time
 * (not at import time) so a deployment that gains LiveKit config on restart —
 * and a test that sets it mid-run — both pick it up without a stale client.
 */
let cached: { key: string; client: RoomServiceClient } | null = null;

function getRoomService(): RoomServiceClient | null {
  const config = liveKitConfig();
  if (!config) {
    return null;
  }
  const key = [config.url, config.apiKey, config.apiSecret].join("\u0000");
  if (!cached || cached.key !== key) {
    // RoomServiceClient rewrites a ws(s):// host to http(s):// itself, so
    // LIVEKIT_URL is handed over unchanged — no second env var, no drift
    // between the URL the client dials and the one we administer.
    cached = {
      key,
      client: new RoomServiceClient(config.url, config.apiKey, config.apiSecret),
    };
  }
  return cached.client;
}

/** Drop the cached admin client. Tests use this after changing LiveKit env. */
export function resetSfuAdminClient(): void {
  cached = null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * In-flight sweeps, so tests can await work the production callers deliberately
 * do not await. Nothing in the request path reads this.
 */
const inFlight = new Set<Promise<void>>();

function track(work: Promise<void>): Promise<void> {
  const tracked = work.finally(() => {
    inFlight.delete(tracked);
  });
  inFlight.add(tracked);
  return tracked;
}

/** Test hook: resolve once every started sweep has finished. */
export async function settleSfuEvictions(): Promise<void> {
  // Looped: a sweep can start another (the room fan-out in evictSfuUser), so
  // one pass over the set is not enough to prove quiescence.
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

interface ParticipantView {
  identity: string;
  /** Resolved from token metadata, or from the local roster; null if unknown. */
  userId: string | null;
}

/**
 * Remove every participant of `room` that `shouldEvict` selects.
 *
 * `knownIdentities` (peer id → user id, taken from this instance's roster
 * before the mesh peers were dropped) is a fallback for participants whose
 * token predates the metadata this module relies on — i.e. sessions that
 * survive a rolling deploy. New tokens always carry the user id.
 */
async function sweepRoom(
  client: RoomServiceClient,
  room: string,
  reason: string,
  knownIdentities: ReadonlyMap<string, string>,
  shouldEvict: (participant: ParticipantView) => boolean,
): Promise<void> {
  let participants;
  try {
    participants = await client.listParticipants(room);
  } catch (error) {
    // An SFU room only exists once somebody joined it over LiveKit, so "room
    // not found" is the ordinary case for a mesh-era channel. We cannot tell
    // that apart from an outage from here, and an outage during a ban is
    // exactly what must not pass silently — so it is logged either way.
    logEvent("voice.sfuEvictFailed", {
      room,
      reason,
      stage: "list",
      error: describeError(error),
    });
    return;
  }

  // `removeParticipant` alone only disconnects: LiveKit's own docs note the
  // participant "can still re-join the room", and their access token — minted
  // before the ban and valid for TOKEN_TTL_SECONDS — is all they need to do it.
  // `revokeTokenTs` invalidates every token for this room+identity whose `nbf`
  // predates it, which turns the disconnect into an actual ejection.
  //
  // +1s because the boundary is strict (`nbf < ts`) and `nbf` has one-second
  // resolution: a token minted in the same wall-clock second as the ban would
  // otherwise survive it. Overshooting is safe — minting a *new* token needs a
  // live WS voice peer (already removed) and a passing channel-access check
  // (already failing), so there is no legitimate token in that window to void.
  const revokeTokenTs = BigInt(Math.floor(Date.now() / 1000) + 1);

  await Promise.all(
    participants.map(async (participant) => {
      const identity = participant.identity;
      const userId =
        userIdFromParticipantMetadata(participant.metadata) ??
        knownIdentities.get(identity) ??
        null;
      if (!shouldEvict({ identity, userId })) {
        return;
      }
      try {
        await client.removeParticipant(room, identity, { revokeTokenTs });
        logEvent("voice.sfuEvicted", { room, identity, userId, reason });
      } catch (error) {
        logEvent("voice.sfuEvictFailed", {
          room,
          identity,
          userId,
          reason,
          stage: "remove",
          error: describeError(error),
        });
      }
    }),
  );
}

/**
 * Eject everyone from a channel's SFU room — the channel (or its whole server)
 * is gone, or has just been made private with nobody carried over.
 *
 * The room itself is deliberately *not* deleted. Deleting it would also discard
 * the token revocations recorded above, and LiveKit re-creates a room the
 * moment anyone joins — so a deleted room plus a live token is a way back in.
 * An emptied room is reaped by LiveKit's own `emptyTimeout` anyway.
 */
export function evictSfuRoom(room: string): Promise<void> {
  const client = getRoomService();
  if (!client) {
    return Promise.resolve();
  }
  return track(sweepRoom(client, room, "channel", new Map(), () => true));
}

/**
 * Eject everyone from a channel's SFU room except the listed users — a channel
 * turned private keeps the people who still have access.
 *
 * Fails **closed**: a participant whose user id cannot be resolved is removed.
 * The alternative leaves an unidentifiable session inside a channel that was
 * just restricted, and the cost of being wrong is a rejoin.
 */
export function evictSfuUsersExcept(
  room: string,
  allowedUserIds: ReadonlySet<string>,
  knownIdentities: ReadonlyMap<string, string>,
): Promise<void> {
  const client = getRoomService();
  if (!client) {
    return Promise.resolve();
  }
  return track(
    sweepRoom(
      client,
      room,
      "channel-private",
      knownIdentities,
      ({ userId }) => userId === null || !allowedUserIds.has(userId),
    ),
  );
}

/**
 * Eject one user from the SFU — kick, ban, leaving a server, or losing access
 * to a private channel.
 *
 * `rooms` is the channel-id set the caller is revoking; `null` means "wherever
 * they are", which costs a full room listing and is only used by callers that
 * genuinely do not know the scope.
 *
 * Fails **open**: a participant whose user id cannot be resolved is left alone.
 * Unlike the privacy sweep above, this one targets an individual, and removing
 * a participant we cannot identify would eject bystanders from a call that is
 * still legitimately theirs.
 */
export function evictSfuUser(
  userId: string,
  rooms: readonly string[] | null,
  knownIdentities: ReadonlyMap<string, string>,
): Promise<void> {
  const client = getRoomService();
  if (!client) {
    return Promise.resolve();
  }
  // An explicit empty scope means "no rooms", but `listRooms([])` means "all
  // rooms" to the SDK. Without this guard a server with zero channels would
  // sweep every room on the deployment.
  if (rooms !== null && rooms.length === 0) {
    return Promise.resolve();
  }

  return track(
    (async () => {
      // One listing narrows an arbitrary number of candidate channels down to
      // the rooms that actually exist, so a 50-channel server costs 1 + (live
      // voice rooms) calls instead of 50.
      let active;
      try {
        active = await client.listRooms(rooms === null ? undefined : [...rooms]);
      } catch (error) {
        logEvent("voice.sfuEvictFailed", {
          userId,
          stage: "listRooms",
          error: describeError(error),
        });
        return;
      }

      await Promise.all(
        active.map((room) =>
          sweepRoom(
            client,
            room.name,
            "user",
            knownIdentities,
            (participant) => participant.userId === userId,
          ),
        ),
      );
    })(),
  );
}
