import { RoomServiceClient, TrackType } from "livekit-server-sdk";
import { logEvent } from "../lib/log.js";
import {
  isLiveKitConfigured,
  mintedAtFromParticipantMetadata,
  TOKEN_TTL_SECONDS,
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
 *
 * WHY ONE REMOVAL IS NOT ENOUGH (see `scheduleResweep`)
 * `removeParticipant` disconnects; it does not bar a return. LiveKit's own docs
 * say the participant "can still re-join", and the token they were handed
 * seconds earlier is all they need. The `revokeTokenTs` field is supposed to
 * close that, and it does — on LiveKit Cloud, which is the only place it is
 * implemented. Against a self-hosted livekit-server (measured on v1.13.5) the
 * API accepts the field, answers 200, and then admits the removed participant
 * again on the very next connect. So the removal is repeated for as long as a
 * pre-eviction token could still be replayed.
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
  /**
   * When this participant's token was minted, unix seconds. Null for a token
   * predating the field, which every caller must read as "old", never "new".
   */
  mintedAt: number | null;
}

/**
 * How long after an eviction a token minted before it could still be replayed,
 * and therefore how long the room keeps being re-swept. Exactly the token TTL:
 * one second later every pre-eviction token is expired and LiveKit refuses it
 * on its own.
 */
const RESWEEP_WINDOW_MS = TOKEN_TTL_SECONDS * 1000;

/**
 * Gap between re-sweeps — the worst case for how long a rejoin with a stale
 * token is audible before it is ejected again. Five seconds costs at most
 * ~180 `listParticipants` calls per evicted room over the whole window, on a
 * connection the deployment already holds open.
 */
const RESWEEP_INTERVAL_MS = 5_000;

/** Live re-sweep timers, keyed so repeated evictions of one room coalesce. */
const resweeps = new Map<string, ReturnType<typeof setInterval>>();

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Which pass a predicate is running in. The first one runs against the room as
 * the eviction found it and must not exempt anybody; the repeats run against a
 * room that may since have refilled with people who are supposed to be there.
 */
type SweepPass = "first" | "resweep";

/**
 * True when this participant is still riding the token they held at eviction
 * time — the only thing a repeat pass is entitled to remove.
 *
 * A token minted *after* the eviction cleared the ban list and the channel
 * access check on its way out of `POST /api/voice/token`, so its holder was
 * re-authorised in the meantime (unbanned, re-invited, channel made public
 * again) and must be left alone. `mintedAt === null` is a token issued before
 * the field existed, hence older than any eviction that can observe it.
 *
 * The comparison is `<=`, not `<`, for the same reason `revokeTokenTs` is sent
 * as `now + 1`: both stamps have one-second resolution, so a token minted in
 * the same wall-clock second as the eviction raced it and counts as stale.
 */
function staleFor(
  pass: SweepPass,
  evictedAt: number,
  participant: ParticipantView,
): boolean {
  if (pass === "first") {
    return true;
  }
  return (participant.mintedAt ?? 0) <= evictedAt;
}

/**
 * Re-run `sweep` every `RESWEEP_INTERVAL_MS` until pre-eviction tokens have all
 * expired.
 *
 * The timer is `unref`'d: this is cleanup for an action that has already been
 * committed and answered, and it must never be the reason a process refuses to
 * exit. A deploy that lands inside the window drops the remaining sweeps, which
 * is the same exposure a deployment without this had all the time.
 *
 * Keyed by `key` (room + intent) so banning five people in one channel leaves
 * one timer, not five, and a second ban simply restarts the window.
 */
function scheduleResweep(key: string, sweep: () => Promise<void>): void {
  const existing = resweeps.get(key);
  if (existing) {
    clearInterval(existing);
  }
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - startedAt >= RESWEEP_WINDOW_MS) {
      clearInterval(timer);
      resweeps.delete(key);
      return;
    }
    void sweep();
  }, RESWEEP_INTERVAL_MS);
  timer.unref?.();
  resweeps.set(key, timer);
}

/** Cancel every pending re-sweep. Tests use this; nothing in the app does. */
export function stopSfuResweeps(): void {
  for (const timer of resweeps.values()) {
    clearInterval(timer);
  }
  resweeps.clear();
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
  // `revokeTokenTs` is meant to close that, invalidating every token for this
  // room+identity whose `nbf` predates it.
  //
  // It is sent on every removal, but it is NOT what makes eviction stick:
  // LiveKit implements the field on Cloud only. Verified against a self-hosted
  // livekit-server v1.13.5 — the RPC logs `revokeTokenTs` and answers 200, and
  // the removed participant reconnects with the same token immediately
  // afterwards, even for a timestamp an hour in the future. `scheduleResweep`
  // is what actually keeps them out on a self-hosted deployment; this field is
  // the thing that makes one removal enough on Cloud.
  //
  // +1s because the boundary is strict (`nbf < ts`) and `nbf` has one-second
  // resolution: a token minted in the same wall-clock second as the ban would
  // otherwise survive it. Overshooting is safe — minting a *new* token needs a
  // live WS voice peer (already removed) and a passing channel-access check
  // (already failing), so there is no legitimate token in that window to void.
  const revokeTokenTs = BigInt(nowSeconds() + 1);

  await Promise.all(
    participants.map(async (participant) => {
      const identity = participant.identity;
      const userId =
        userIdFromParticipantMetadata(participant.metadata) ??
        knownIdentities.get(identity) ??
        null;
      const mintedAt = mintedAtFromParticipantMetadata(participant.metadata);
      if (!shouldEvict({ identity, userId, mintedAt })) {
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
  const sweep = () => sweepRoom(client, room, "channel", new Map(), () => true);
  // No `mintedAt` test: the channel is gone, so `POST /api/voice/token` can
  // never issue a token for this room again and every participant a repeat
  // pass can find is by definition replaying a pre-deletion one.
  scheduleResweep(`room:${room}`, sweep);
  return track(sweep());
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
  const evictedAt = nowSeconds();
  const sweep = (pass: SweepPass) =>
    sweepRoom(
      client,
      room,
      "channel-private",
      knownIdentities,
      (participant) =>
        staleFor(pass, evictedAt, participant) &&
        (participant.userId === null || !allowedUserIds.has(participant.userId)),
    );
  scheduleResweep(`private:${room}`, () => sweep("resweep"));
  return track(sweep("first"));
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

  const evictedAt = nowSeconds();
  const sweep = async (pass: SweepPass) => {
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
          (participant) =>
            participant.userId === userId &&
            staleFor(pass, evictedAt, participant),
        ),
      ),
    );
  };

  // Keyed on the user rather than a room: the scope is "wherever they are", and
  // a second ban of the same person should restart one window, not open a
  // second one beside it.
  scheduleResweep(`user:${userId}`, () => sweep("resweep"));
  return track(sweep("first"));
}

// --- voice moderation ---------------------------------------------------------

/**
 * Server-side mute of one user's audio in one SFU room — the only place a real
 * server mute exists in this product. In mesh mode the media never touches any
 * server, so there is nothing here to mute and the API route refuses before
 * calling this; do not "fix" that by pretending.
 *
 * Deliberately UNLIKE the evictions above in its failure contract: this is not
 * post-commit cleanup for an action that already happened, it IS the action.
 * The route awaits it and turns `false` into an honest error, so it reports
 * failure instead of logging-and-resolving. It still never *rejects*.
 *
 * Also honest about what it is: LiveKit's `mutePublishedTrack` mutes the track
 * at the SFU, and the participant is free to unmute themselves afterwards.
 * That makes this a "shut off the hot mic" tool, not a sticky sanction — the
 * sticky ones remain timeout and disconnect. The UI copy says so.
 *
 * Returns true when at least one audio track was muted (or unmuted).
 */
export async function setSfuUserMuted(
  room: string,
  userId: string,
  muted: boolean,
  knownIdentities: ReadonlyMap<string, string>,
): Promise<boolean> {
  const client = getRoomService();
  if (!client) {
    return false;
  }

  let participants;
  try {
    participants = await client.listParticipants(room);
  } catch (error) {
    logEvent("voice.sfuMuteFailed", {
      room,
      userId,
      stage: "list",
      error: describeError(error),
    });
    return false;
  }

  let changed = false;
  await Promise.all(
    participants.map(async (participant) => {
      const identity = participant.identity;
      const participantUserId =
        userIdFromParticipantMetadata(participant.metadata) ??
        knownIdentities.get(identity) ??
        null;
      // Fails open, like `evictSfuUser`: this targets an individual, and
      // muting a participant we cannot identify would silence a bystander.
      if (participantUserId !== userId) {
        return;
      }
      // Every audio track, not just the microphone source: a moderator muting
      // somebody means "this account is silent", and screen-share audio is
      // audio.
      const audioTracks = (participant.tracks ?? []).filter(
        (track) => track.type === TrackType.AUDIO,
      );
      for (const audioTrack of audioTracks) {
        try {
          await client.mutePublishedTrack(room, identity, audioTrack.sid, muted);
          changed = true;
          logEvent("voice.sfuMuted", {
            room,
            identity,
            userId,
            trackSid: audioTrack.sid,
            muted,
          });
        } catch (error) {
          logEvent("voice.sfuMuteFailed", {
            room,
            identity,
            userId,
            stage: "mute",
            error: describeError(error),
          });
        }
      }
    }),
  );
  return changed;
}

// --- end voice moderation -----------------------------------------------------
