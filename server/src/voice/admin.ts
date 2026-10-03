import {
  RoomServiceClient,
  TrackSource,
  TrackType,
  type ParticipantInfo,
  type Room,
  type UpdateParticipantOptions,
} from "livekit-server-sdk";
import { z } from "zod";
import { logEvent } from "../lib/log.js";
import {
  isLiveKitConfigured,
  liveKitPublishGrant,
  mintedAtFromParticipantMetadata,
  TOKEN_TTL_SECONDS,
  userIdFromParticipantMetadata,
} from "./backends.js";
import {
  claimVoiceResweeps,
  deleteVoiceResweep,
  hasLiveVoiceResweeps,
  isVoiceRegistryEnabled,
  readVoiceRoomRegions,
  upsertVoiceResweep,
} from "./registry.js";
import {
  homeRegionId,
  pinnedRoomRegion,
  sfuRegions,
  type SfuRegion,
} from "./regions.js";
import {
  classifyError,
  isNotFound,
  logPartialCoverage,
  regionScopingEnabled,
  resetSfuControlPlane,
  runRegionCall,
  type RegionCallMode,
} from "./sfu-control-plane.js";

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

/**
 * Bound on every RoomService RPC (`listRooms`, `listParticipants`,
 * `removeParticipant`, `mutePublishedTrack`, `updateParticipant`).
 *
 * WHY 5s AND NOT THE SDK DEFAULT. `livekit-server-sdk`'s Twirp client
 * (`TwirpRpc`, `dist/TwirpRPC.js`) defaults `requestTimeout` to 10 SECONDS per
 * call, and — because `sfu.pqp.gg` is not a `*.livekit.cloud` host —
 * `failoverAttempts` is 1, so that single attempt really does get the full
 * 10s before the SDK itself gives up. Production evidence from 2026-09-23: a
 * `listRooms` from the API to the SFU took ~2.5s at 18:32-18:41 while the SFU
 * box measured 7-9% CPU, i.e. genuinely slow, not merely un-awaited — and
 * every caller of `getRoomService()` up to that point had NO client-side
 * bound at all beyond the SDK's own 10s, so a slow RPC could sit on the
 * connection for the SDK's full window before this process moved on. 5s
 * keeps a real recovery window (measured healthy round trips are 350-450ms)
 * while capping the worst case at half the SDK default, and matches the
 * 3s-order-of-magnitude timeouts `ready.ts` and `sfu-stats.ts` already use
 * for the same box.
 */
const REQUEST_TIMEOUT_SECONDS = 5;

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
 * Keyed, because with SFU regions there is one client per box.
 */
const clients = new Map<string, RoomServiceClient>();

function clientFor(config: LiveKitConfig): RoomServiceClient {
  const key = [config.url, config.apiKey, config.apiSecret].join("\u0000");
  let client = clients.get(key);
  if (!client) {
    // RoomServiceClient rewrites a ws(s):// host to http(s):// itself, so
    // LIVEKIT_URL is handed over unchanged — no second env var, no drift
    // between the URL the client dials and the one we administer.
    client = new RoomServiceClient(config.url, config.apiKey, config.apiSecret, {
      requestTimeout: REQUEST_TIMEOUT_SECONDS,
    });
    clients.set(key, client);
  }
  return client;
}

/** The subset of `RoomServiceClient` moderation uses. */
type SfuRoomService = Pick<
  RoomServiceClient,
  "listRooms" | "listParticipants" | "removeParticipant" | "mutePublishedTrack"
> & {
  /** The options form only; the positional overload is not used here. */
  updateParticipant(
    room: string,
    identity: string,
    options: UpdateParticipantOptions,
  ): Promise<ParticipantInfo>;
};

/**
 * The HOME box's client: the one `LIVEKIT_URL` names. `pingSfu`,
 * `listSfuRooms` and everything watch-party-shaped only ever mean this one.
 */
function getHomeRoomService(): RoomServiceClient | null {
  const config = liveKitConfig();
  return config ? clientFor(config) : null;
}

/**
 * One box a moderation call may be sent to, with a client bound to that box
 * alone. In single-region mode this is the home client itself and nothing
 * else changes; with `LIVEKIT_REGIONS` every method goes through
 * `runRegionCall`, which measures, bounds and fences it (see
 * `sfu-control-plane.ts`).
 */
interface RegionTarget {
  id: string;
  client: SfuRoomService;
  /**
   * True with `LIVEKIT_REGIONS` set. "Not found" is then the ordinary answer
   * of a box that does not hold the room, not something to report.
   */
  regional: boolean;
  /** Pinned: the room is known to live here. Speculative: asked in case. */
  mode: RegionCallMode;
}

function sfuConfigured(): boolean {
  return liveKitConfig() !== null;
}

function regionalService(
  region: SfuRegion,
  caller: string,
  mode: RegionCallMode,
): SfuRoomService {
  const client = clientFor(region);
  const guard = <T>(call: string, room: string | undefined, run: () => Promise<T>) =>
    runRegionCall({
      region: region.id,
      home: region.home,
      call,
      caller,
      room,
      mode,
      run,
    });
  return {
    listRooms: (names) => guard("listRooms", undefined, () => client.listRooms(names)),
    listParticipants: (room) =>
      guard("listParticipants", room, () => client.listParticipants(room)),
    removeParticipant: (room, identity, options) =>
      guard("removeParticipant", room, () =>
        client.removeParticipant(room, identity, options),
      ),
    mutePublishedTrack: (room, identity, trackSid, muted) =>
      guard("mutePublishedTrack", room, () =>
        client.mutePublishedTrack(room, identity, trackSid, muted),
      ),
    updateParticipant: (room, identity, options) =>
      guard("updateParticipant", room, () =>
        client.updateParticipant(room, identity, options),
      ),
  };
}

/** One lookup failure line per this long, so a database blip is not a line per sweep. */
const LOOKUP_LOG_INTERVAL_MS = 10_000;
let lookupLoggedAt = 0;

/**
 * The registry read, bounded: it runs on the moderator's request path and the
 * main pool's own query timeout is 15 s. Past `REGION_LOOKUP_BUDGET_MS` the
 * room counts as unknown, which asks every box, never fewer.
 */
const REGION_LOOKUP_BUDGET_MS = 500;

async function boundedRegionRead(
  rooms: readonly string[],
): Promise<Map<string, string | null>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readVoiceRoomRegions(rooms),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`region lookup over ${REGION_LOOKUP_BUDGET_MS} ms`)),
          REGION_LOOKUP_BUDGET_MS,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Which regions these rooms are known to live on: the room's pin in this
 * process, the registry row (so the other instance's rooms count), and any
 * `hint` the caller captured earlier. Null means at least one room is unknown,
 * which the caller must read as "ask every box".
 *
 * Unknown is a real and common state, not an error: a room's row goes when its
 * last peer leaves, while a banned account's LiveKit connection can outlive
 * that (see the block comment on `targetsFor`). A lookup that fails is unknown
 * too: moderation fails open to MORE boxes, never fewer.
 */
async function knownRegionIds(
  rooms: readonly string[],
  regions: readonly SfuRegion[],
  hint: readonly string[] = [],
): Promise<Set<string> | null> {
  if (rooms.length === 0) {
    return null;
  }
  const home = regions[0]!.id;
  // A region id this deployment no longer runs means home, the same rule as
  // `resolveSfuRegion`: a room pinned to a box an operator removed has
  // nowhere else to be.
  const configured = (id: string) => (regions.some((region) => region.id === id) ? id : home);
  // Every source is unioned, the hint included: a hint is a box the room WAS
  // on, and a room that has since been re-pinned elsewhere can still hold
  // somebody on the old box with a token minted before the eviction.
  let rows = new Map<string, string | null>();
  if (isVoiceRegistryEnabled()) {
    try {
      rows = await boundedRegionRead(rooms);
    } catch (error) {
      const now = Date.now();
      if (now - lookupLoggedAt >= LOOKUP_LOG_INTERVAL_MS) {
        lookupLoggedAt = now;
        logEvent("voice.sfuRegionLookupFailed", { error: describeError(error) });
      }
    }
  }
  const known = new Set<string>();
  for (const room of rooms) {
    const ids = new Set<string>();
    const pinned = pinnedRoomRegion(room);
    if (pinned) {
      ids.add(configured(pinned));
    }
    if (rows.has(room)) {
      ids.add(configured(rows.get(room) ?? home));
    }
    for (const hinted of hint) {
      ids.add(configured(hinted));
    }
    if (ids.size === 0) {
      return null;
    }
    ids.forEach((id) => known.add(id));
  }
  return known;
}

/**
 * The boxes a moderation call about `rooms` goes to.
 *
 * Single-region mode: the home box, exactly as before regions existed.
 *
 * With `LIVEKIT_REGIONS`, a room whose region is KNOWN goes to that box alone,
 * except when `wide` (the first pass of an eviction, and one repeat in a
 * half minute), which also looks at the other boxes. Before this, every call asked every box and waited for the slowest, so the
 * two remote boxes (14 of 754 rooms between them) decided how long moderation
 * took for the rooms in Sao Paulo, and a heavy tail on the long-haul path
 * produced ~870 timeouts in eleven days (`sfu-control-plane.ts`).
 *
 * A room whose region is NOT known (`rooms === null` for "wherever they are",
 * or no pin and no hint) still asks every box, because a banned account's
 * LiveKit connection outlives its WebSocket and so the room's pin, and the
 * boxes themselves are then the only authority on who is in a room (see
 * "WHY THE SWEEP IS UNCONDITIONAL" at the top). Those calls are speculative:
 * a remote box gets a short budget and a circuit, and every box is asked
 * independently, so a sick one delays only its own answer.
 *
 * The runtime flag `sfu_region_scoped_calls` off restores the old
 * ask-everyone behaviour without a deploy.
 */
async function targetsFor(
  caller: string,
  rooms: readonly string[] | null,
  hint: readonly string[] = [],
  /** False for a caller nothing will repeat: it then never gets a budget or a skip. */
  repeats = true,
  /**
   * Ask the boxes the room is NOT known to be on as well, as the fallback
   * mode. A known pin says where the room is now, not where somebody with a
   * pre-eviction token still is (a ghost on the old box after the room was
   * re-pinned), so an eviction looks everywhere once, and its repeats look
   * everywhere every `WIDE_SWEEP_PERIOD_S`.
   */
  wide = false,
): Promise<RegionTarget[]> {
  const regions = sfuRegions();
  if (!regions) {
    const home = getHomeRoomService();
    return home
      ? [{ id: homeRegionId(), client: home, regional: false, mode: "pinned" }]
      : [];
  }
  const known =
    regionScopingEnabled() && rooms !== null
      ? await knownRegionIds(rooms, regions, hint)
      : null;
  const fallback: RegionCallMode = repeats ? "speculative" : "oneshot";
  return regions
    .filter((region) => known === null || wide || known.has(region.id))
    .map((region) => {
      const mode: RegionCallMode = known?.has(region.id) ? "pinned" : fallback;
      return {
        id: region.id,
        client: regionalService(region, caller, mode),
        regional: true,
        mode,
      };
    });
}

/** How one box fared in a call that went to several. */
type RegionOutcome = "ok" | "failed" | "skipped";

function outcomeOf(error: unknown): RegionOutcome {
  return classifyError(error) === "circuit-open" ? "skipped" : "failed";
}

/**
 * Say, once per ten seconds, when a result was built from fewer boxes than
 * were asked. A sweep that covered two boxes of three must never be mistaken
 * for one that covered all three.
 */
function noteCoverage(
  caller: string,
  call: string,
  room: string | undefined,
  outcomes: readonly { id: string; outcome: RegionOutcome }[],
): void {
  logPartialCoverage({
    caller,
    call,
    room,
    answered: outcomes.filter((entry) => entry.outcome === "ok").map((entry) => entry.id),
    skipped: outcomes.filter((entry) => entry.outcome === "skipped").map((entry) => entry.id),
    failed: outcomes.filter((entry) => entry.outcome === "failed").map((entry) => entry.id),
  });
}

/** Drop the cached admin client. Tests use this after changing LiveKit env. */
export function resetSfuAdminClient(): void {
  clients.clear();
  resetSfuControlPlane();
}

/**
 * The cheapest authenticated round-trip the SFU offers: `listRooms`. Resolves
 * when it answered, rejects when it did not or when LiveKit is not
 * configured. `services/ready.ts` owns the timeout and the cache; this is
 * deliberately just the call. The HOME box: see `pingSfuRegion` for the rest.
 */
export async function pingSfu(): Promise<void> {
  await listSfuRooms();
}

/**
 * Every room the SFU currently holds, for the operator dashboard's counts
 * (`voice/sfu-stats.ts`). Same call as `pingSfu`, with the answer kept.
 * Rejects when LiveKit is not configured or the SFU did not answer; the
 * caller owns the timeout and the cache. The HOME box only.
 */
export async function listSfuRooms(): Promise<Room[]> {
  const client = getHomeRoomService();
  if (!client) {
    throw new Error("LiveKit is not configured");
  }
  const regions = sfuRegions();
  if (!regions) {
    return client.listRooms();
  }
  // Measured like every other call to the box, so the home region has a
  // latency window and counters beside the remote ones.
  return runRegionCall({
    region: regions[0]!.id,
    home: true,
    call: "listRooms",
    caller: "probe",
    mode: "pinned",
    run: () => client.listRooms(),
  });
}

/** `listSfuRooms` against one configured region. Rejects for an unknown id. */
export async function listSfuRoomsInRegion(regionId: string): Promise<Room[]> {
  const region = sfuRegions()?.find((candidate) => candidate.id === regionId);
  if (!region) {
    throw new Error(`SFU region ${regionId} is not configured`);
  }
  // The dashboard and `/ready` probes: never skipped by the circuit (they are
  // how a recovered region is noticed), and their successes feed the latency
  // window the budgets are sized from.
  return runRegionCall({
    region: region.id,
    home: region.home,
    call: "listRooms",
    caller: "probe",
    mode: "pinned",
    run: () => clientFor(region).listRooms(),
  });
}

/** `pingSfu` against one configured region, for `/ready`. */
export async function pingSfuRegion(regionId: string): Promise<void> {
  await listSfuRoomsInRegion(regionId);
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

/**
 * Flag-off re-sweep timers, keyed so repeated evictions of one room coalesce.
 * With the registry on this map stays empty: the sweeps are rows (below).
 */
const resweeps = new Map<string, ReturnType<typeof setInterval>>();

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * True for a LiveKit participant that is not a pqp voice peer at all — the
 * room's own HLS egress, joined to composite the presenter's stream for the
 * watch-party transcode. Never a moderation target: the channel-private sweep
 * exists to remove people who lost access to a channel, and an egress has no
 * `userId` to lose it. Live production evidence (2026-09-12): a channel's own
 * transcoder got evicted every 5 s by the resweep that a permission save
 * scheduled, because `evictSfuUsersExcept`'s `allowedUserIds` never includes
 * it and its `userId` resolves to null, which the "fails closed" comment on
 * `evictSfuUsersExcept` turns into "remove it".
 *
 * `EG_` is the prefix LiveKit's own Track/RoomComposite egress assigns to the
 * participant identity it creates for itself — a pqp voice peer's identity
 * (a `randomUUID()`, `server/src/ws/voice.ts`) can never collide with it, so
 * the check is exact rather than a shape guess that could exempt a real
 * account whose identity happens to look unfamiliar.
 */
function isEgressIdentity(identity: string): boolean {
  return identity.startsWith("EG_");
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
 * Everything a repeat pass needs, as data. With the registry on this is the
 * `scope` column of `voice_resweeps`, so an instance that never saw the
 * eviction (or this one after a restart) can rebuild the sweep from the row.
 * `knownIdentities` rides along for the same reason: a participant on a
 * pre-metadata token is only resolvable from the roster the acting instance
 * snapshotted before the mesh peers were dropped.
 */
const resweepSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("room"),
    room: z.string().min(1),
    /** The box(es) the room was on when it was evicted; see `stampRegions`. */
    regions: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("private"),
    room: z.string().min(1),
    allowedUserIds: z.array(z.string()),
    knownIdentities: z.record(z.string(), z.string()),
    regions: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("user"),
    userId: z.string().min(1),
    rooms: z.array(z.string()).nullable(),
    knownIdentities: z.record(z.string(), z.string()),
  }),
]);
type ResweepSpec = z.infer<typeof resweepSpecSchema>;

function specFrom(
  key: string,
  scope: unknown,
): ResweepSpec | null {
  const parsed = resweepSpecSchema.safeParse(scope);
  if (!parsed.success) {
    logEvent("voice.sfuResweepBadScope", { key });
    return null;
  }
  return parsed.data;
}

/**
 * Seconds between the repeats that also look at the boxes a room is not
 * known to be on. Stateless on purpose (a five-second window out of every
 * thirty, so about one claimed tick lands in it): a repeat that is every
 * sixth by count would need a counter per row shared by both instances.
 */
const WIDE_SWEEP_PERIOD_S = 30;
const WIDE_SWEEP_WINDOW_S = 5;

function widePassNow(): boolean {
  return Math.floor(Date.now() / 1000) % WIDE_SWEEP_PERIOD_S < WIDE_SWEEP_WINDOW_S;
}

/** The boxes one pass of `spec` is sent to. */
function sweepTargets(spec: ResweepSpec, pass: SweepPass): Promise<RegionTarget[]> {
  // The first pass is the eviction itself and nothing has repeated it yet, so
  // it is never skipped or cut short; only the repeats are speculative.
  const repeats = pass === "resweep";
  const wide = pass === "first" || widePassNow();
  switch (spec.kind) {
    case "room":
      return targetsFor("sweep-room", [spec.room], spec.regions, repeats, wide);
    case "private":
      return targetsFor("sweep-private", [spec.room], spec.regions, repeats, wide);
    case "user":
      return targetsFor("sweep-user", spec.rooms, [], repeats, wide);
  }
}

/**
 * One pass of the sweep `spec` describes. See the three `evictSfu*` entry
 * points for what each selects.
 *
 * Every box runs the pass INDEPENDENTLY and in parallel: the home box is done
 * the moment it answers, whatever a remote one is doing, and a remote box that
 * is slow or skipped costs only its own share. (The old shape merged the boxes
 * behind one client and waited for the slowest.) Never rejects.
 */
async function runSweep(
  spec: ResweepSpec,
  pass: SweepPass,
  evictedAt: number,
): Promise<void> {
  let targets: RegionTarget[];
  try {
    targets = await sweepTargets(spec, pass);
  } catch (error) {
    // Resolving the boxes cannot fail in practice (the registry lookup
    // already falls back to "ask every box"), but a pass that rejects would
    // reject the claim tick that ran it.
    logEvent("voice.sfuEvictFailed", {
      room: spec.kind === "user" ? undefined : spec.room,
      stage: "route",
      error: describeError(error),
    });
    return;
  }
  const outcomes = await Promise.all(
    targets.map(async (target) => ({
      id: target.id,
      outcome: await runSweepOn(target, spec, pass, evictedAt),
    })),
  );
  if (targets.some((target) => target.mode !== "pinned")) {
    noteCoverage(
      `sweep-${spec.kind}`,
      spec.kind === "user" ? "listRooms" : "listParticipants",
      spec.kind === "user" ? undefined : spec.room,
      outcomes,
    );
  }
}

function runSweepOn(
  target: RegionTarget,
  spec: ResweepSpec,
  pass: SweepPass,
  evictedAt: number,
): Promise<RegionOutcome> {
  switch (spec.kind) {
    case "room":
      // No `mintedAt` test: the channel is gone, so `POST /api/voice/token`
      // can never issue a token for this room again and every participant a
      // repeat pass can find is by definition replaying a pre-deletion one.
      return sweepRoom(target, spec.room, "channel", new Map(), () => true);
    case "private": {
      const allowed = new Set(spec.allowedUserIds);
      return sweepRoom(
        target,
        spec.room,
        "channel-private",
        new Map(Object.entries(spec.knownIdentities)),
        (participant) =>
          staleFor(pass, evictedAt, participant) &&
          (participant.userId === null || !allowed.has(participant.userId)),
      );
    }
    case "user":
      return sweepUserRooms(target, spec, pass, evictedAt);
  }
}

async function sweepUserRooms(
  target: RegionTarget,
  spec: Extract<ResweepSpec, { kind: "user" }>,
  pass: SweepPass,
  evictedAt: number,
): Promise<RegionOutcome> {
  const { userId, rooms } = spec;
  const { client } = target;
  const knownIdentities = new Map(Object.entries(spec.knownIdentities));
  // One listing narrows an arbitrary number of candidate channels down to
  // the rooms that actually exist, so a 50-channel server costs 1 + (live
  // voice rooms) calls instead of 50.
  let active;
  try {
    active = await client.listRooms(rooms === null ? undefined : [...rooms]);
  } catch (error) {
    const outcome = outcomeOf(error);
    if (outcome === "failed") {
      logEvent("voice.sfuEvictFailed", {
        userId,
        region: target.regional ? target.id : undefined,
        stage: "listRooms",
        error: describeError(error),
      });
    }
    return outcome;
  }

  const outcomes = await Promise.all(
    active.map((room) =>
      sweepRoom(
        target,
        room.name,
        "user",
        knownIdentities,
        (participant) =>
          participant.userId === userId &&
          staleFor(pass, evictedAt, participant),
      ),
    ),
  );
  // A listing that answered followed by participant reads the circuit skipped
  // is not full coverage of this box, and must not be reported as such.
  if (outcomes.includes("failed")) {
    return "failed";
  }
  return outcomes.includes("skipped") ? "skipped" : "ok";
}

/**
 * Re-run the sweep every `RESWEEP_INTERVAL_MS` until pre-eviction tokens have
 * all expired.
 *
 * FLAG OFF: an `unref`'d interval per key. This is cleanup for an action
 * that has already been committed and answered, and it must never be the
 * reason a process refuses to exit. A deploy that lands inside the window
 * drops the remaining sweeps, which is the same exposure a deployment
 * without this had all the time. Keyed by `key` (room + intent) so banning
 * five people in one channel leaves one timer, not five, and a second ban
 * simply restarts the window.
 *
 * REGISTRY ON: the sweep is a `voice_resweeps` row instead (section 5.4 of
 * the plan). This process keeps one claim ticker running while it knows of
 * a live row, and every instance also ticks after each heartbeat
 * (`runVoiceReconcile`), so a row outlives the process that wrote it and is
 * swept by whoever claims it, at most one sweeper per key per claim window.
 * The upsert is tracked, so `settleSfuEvictions` covers it.
 */
function scheduleResweep(
  key: string,
  spec: ResweepSpec,
  evictedAt: number,
): Promise<void> {
  if (isVoiceRegistryEnabled()) {
    ensureClaimTicker();
    return upsertVoiceResweep(
      key,
      spec,
      new Date(evictedAt * 1000),
      new Date(Date.now() + RESWEEP_WINDOW_MS),
    ).catch((error: unknown) => {
      logEvent("voice.sfuResweepRowFailed", {
        key,
        error: describeError(error),
      });
    });
  }
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
    if (sfuConfigured()) {
      void runSweep(spec, "resweep", evictedAt);
    }
  }, RESWEEP_INTERVAL_MS);
  timer.unref?.();
  resweeps.set(key, timer);
  return Promise.resolve();
}

/** The registry-on process ticker: one per process, alive while a row is. */
let claimTicker: ReturnType<typeof setInterval> | null = null;
let claimInFlight: Promise<number> | null = null;

function ensureClaimTicker(): void {
  if (claimTicker) {
    return;
  }
  const timer = setInterval(() => {
    void tickSfuResweeps().then(async (swept) => {
      if (swept > 0 || claimTicker !== timer) {
        return;
      }
      // Nothing won: stop when nothing is left to win. A row another
      // instance holds keeps this ticker alive, so it can take over if
      // that instance dies inside the window.
      let live = true;
      try {
        live = await hasLiveVoiceResweeps();
      } catch {
        // Unknown: keep ticking, the next tick will find out.
      }
      if (!live && claimTicker === timer) {
        clearInterval(timer);
        claimTicker = null;
      }
    });
  }, RESWEEP_INTERVAL_MS);
  timer.unref?.();
  claimTicker = timer;
}

/**
 * One claim tick: expired rows are deleted, unclaimed live rows are claimed
 * for `RESWEEP_CLAIM_MS`, and exactly the rows this call won are swept once.
 * Run by the process ticker above and by `runVoiceReconcile` after every
 * heartbeat, on every instance. Returns how many rows were swept. Never
 * rejects; a no-op with the registry off or LiveKit unconfigured. One tick
 * at a time per process: a slow SFU must not stack them.
 */
export function tickSfuResweeps(): Promise<number> {
  if (claimInFlight) {
    return claimInFlight;
  }
  if (!isVoiceRegistryEnabled() || !sfuConfigured()) {
    return Promise.resolve(0);
  }
  const work = (async () => {
    let rows;
    try {
      rows = await claimVoiceResweeps();
    } catch (error) {
      logEvent("voice.sfuResweepClaimFailed", { error: describeError(error) });
      return 0;
    }
    await Promise.all(
      rows.map((row) => {
        const spec = specFrom(row.key, row.scope);
        if (!spec) {
          return Promise.resolve();
        }
        return runSweep(
          spec,
          "resweep",
          Math.floor(row.evictedAt.getTime() / 1000),
        );
      }),
    );
    return rows.length;
  })();
  claimInFlight = track(work.then(() => undefined)).then(() => work);
  void claimInFlight.finally(() => {
    claimInFlight = null;
  });
  return claimInFlight;
}

/** Cancel every pending re-sweep timer and the claim ticker. Tests use this; nothing in the app does. */
export function stopSfuResweeps(): void {
  for (const timer of resweeps.values()) {
    clearInterval(timer);
  }
  resweeps.clear();
  if (claimTicker) {
    clearInterval(claimTicker);
    claimTicker = null;
  }
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
  target: RegionTarget,
  room: string,
  reason: string,
  knownIdentities: ReadonlyMap<string, string>,
  shouldEvict: (participant: ParticipantView) => boolean,
): Promise<RegionOutcome> {
  const { client } = target;
  let participants;
  try {
    participants = await client.listParticipants(room);
  } catch (error) {
    // With several boxes, "room not found" is simply the answer of a box that
    // does not hold the room: the box answered, so there is nothing to report.
    if (target.regional && isNotFound(error)) {
      return "ok";
    }
    const outcome = outcomeOf(error);
    // A box skipped by its circuit is reported once, as partial coverage, by
    // the caller; a line per skipped sweep would be the noise the circuit
    // exists to remove.
    if (outcome === "failed") {
      // An SFU room only exists once somebody joined it over LiveKit, so
      // "room not found" is the ordinary case for a mesh-era channel. We
      // cannot tell that apart from an outage from here on a single box, and
      // an outage during a ban is exactly what must not pass silently, so it
      // is logged either way.
      logEvent("voice.sfuEvictFailed", {
        room,
        reason,
        region: target.regional ? target.id : undefined,
        stage: "list",
        error: describeError(error),
      });
    }
    return outcome;
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

  let removalFailed = false;
  await Promise.all(
    participants.map(async (participant) => {
      const identity = participant.identity;
      // Only the channel-private sweep is scoped by user identity in a way an
      // egress can never satisfy (see `isEgressIdentity`). The other two
      // reasons ("channel", "user") mean the room itself is gone or a
      // specific account is being ejected, and this deliberately does not
      // exempt an egress from either: a deleted channel's transcoder should
      // stop too.
      if (reason === "channel-private" && isEgressIdentity(identity)) {
        logEvent("voice.sfuEvictSkippedEgress", { room, identity, reason });
        return;
      }
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
        removalFailed = true;
        logEvent("voice.sfuEvictFailed", {
          room,
          identity,
          userId,
          reason,
          region: target.regional ? target.id : undefined,
          stage: "remove",
          error: describeError(error),
        });
      }
    }),
  );
  return removalFailed ? "failed" : "ok";
}

/**
 * Stamp the boxes a room is on into the spec, while they can still be read.
 *
 * A re-sweep runs every few seconds for fifteen minutes, and by its second
 * tick the room's registry row and this process's pin are usually gone (the
 * last peer left, which is exactly what an eviction causes). Without this, a
 * deleted channel's room, which lived in Sao Paulo, would be looked for on
 * every box for the whole window. The hint is only ever a way to ask FEWER
 * boxes about a room that was known; no hint (and nothing readable) means ask
 * them all. The spec is stored in `voice_resweeps.scope`, so the sibling that
 * claims the row has the same hint.
 */
async function stampRegions(
  spec: ResweepSpec,
  hint: string | null | undefined,
): Promise<ResweepSpec> {
  if (spec.kind === "user" || !regionScopingEnabled()) {
    return spec;
  }
  const regions = sfuRegions();
  if (!regions) {
    return spec;
  }
  const known = await knownRegionIds(
    [spec.room],
    regions,
    hint ? [hint] : [],
  );
  return known ? { ...spec, regions: [...known] } : spec;
}

/** The first pass now, the repeats scheduled; one tracked promise for both. */
function evict(
  key: string,
  spec: ResweepSpec,
  regionHint?: string | null,
): Promise<void> {
  const evictedAt = nowSeconds();
  return track(
    (async () => {
      const stamped = await stampRegions(spec, regionHint);
      await Promise.all([
        runSweep(stamped, "first", evictedAt),
        scheduleResweep(key, stamped, evictedAt),
      ]);
    })(),
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
export function evictSfuRoom(room: string, regionHint?: string | null): Promise<void> {
  if (!sfuConfigured()) {
    return Promise.resolve();
  }
  return evict(`room:${room}`, { kind: "room", room }, regionHint);
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
  regionHint?: string | null,
): Promise<void> {
  if (!sfuConfigured()) {
    return Promise.resolve();
  }
  return evict(
    `private:${room}`,
    {
      kind: "private",
      room,
      allowedUserIds: [...allowedUserIds],
      knownIdentities: Object.fromEntries(knownIdentities),
    },
    regionHint,
  );
}

/** How long to wait before retrying a failed `deleteVoiceResweep`. */
const RESWEEP_CANCEL_RETRY_MS = 250;

/**
 * Cancel an outstanding channel-private re-sweep — the channel just went
 * public, or its `@everyone` overwrite regained VIEW, so nobody needs to be
 * kept out of the window `evictSfuUsersExcept` opened. Clears both forms:
 * the in-process timer (flag off) and the `voice_resweeps` row (registry on).
 *
 * Idempotent and safe to call for a channel that never had one — callers are
 * expected to call this unconditionally whenever a channel's access widens,
 * rather than trying to know in advance whether a resweep is actually live.
 *
 * The registry delete gets one retry: a lost row here is not cosmetic, it is
 * the cluster resweep worker (`tickSfuResweeps`) going on evicting people for
 * up to `RESWEEP_WINDOW_MS` after they were supposed to be let back in. A
 * transient failure clears on the retry; a persistent one is logged
 * distinctly so it shows up as something other than an authorization change
 * that silently did nothing.
 */
export async function cancelSfuPrivateResweep(room: string): Promise<void> {
  const key = `private:${room}`;
  const existing = resweeps.get(key);
  if (existing) {
    clearInterval(existing);
    resweeps.delete(key);
  }
  if (!isVoiceRegistryEnabled()) {
    return;
  }
  try {
    await deleteVoiceResweep(key);
    return;
  } catch (error: unknown) {
    logEvent("voice.sfuResweepCancelFailed", { key, error: describeError(error) });
  }
  await new Promise((resolve) => setTimeout(resolve, RESWEEP_CANCEL_RETRY_MS));
  try {
    await deleteVoiceResweep(key);
  } catch (error: unknown) {
    logEvent("voice.sfuResweepCancelGaveUp", { key, error: describeError(error) });
  }
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
  if (!sfuConfigured()) {
    return Promise.resolve();
  }
  // An explicit empty scope means "no rooms", but `listRooms([])` means "all
  // rooms" to the SDK. Without this guard a server with zero channels would
  // sweep every room on the deployment.
  if (rooms !== null && rooms.length === 0) {
    return Promise.resolve();
  }
  // Keyed on the user rather than a room: the scope is "wherever they are", and
  // a second ban of the same person should restart one window, not open a
  // second one beside it.
  return evict(`user:${userId}`, {
    kind: "user",
    userId,
    rooms: rooms === null ? null : [...rooms],
    knownIdentities: Object.fromEntries(knownIdentities),
  });
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
  const targets = await targetsFor("mute", [room], [], false);
  if (targets.length === 0) {
    return false;
  }
  // Every box the room may be on, asked together: the answer is "did anybody
  // get muted", so a box that holds nobody (or is slow) cannot hold it up
  // beyond its own budget. A room whose region is known is one box.
  const results = await Promise.all(
    targets.map((target) => muteOn(target, room, userId, muted, knownIdentities)),
  );
  if (targets[0]!.mode !== "pinned") {
    noteCoverage(
      "mute",
      "listParticipants",
      room,
      results.map((result, index) => ({ id: targets[index]!.id, outcome: result.outcome })),
    );
  }
  return results.some((result) => result.changed);
}

async function muteOn(
  target: RegionTarget,
  room: string,
  userId: string,
  muted: boolean,
  knownIdentities: ReadonlyMap<string, string>,
): Promise<{ changed: boolean; outcome: RegionOutcome }> {
  const { client } = target;
  let participants;
  try {
    participants = await client.listParticipants(room);
  } catch (error) {
    if (target.regional && isNotFound(error)) {
      return { changed: false, outcome: "ok" };
    }
    const outcome = outcomeOf(error);
    if (outcome === "failed") {
      logEvent("voice.sfuMuteFailed", {
        room,
        userId,
        region: target.regional ? target.id : undefined,
        stage: "list",
        error: describeError(error),
      });
    }
    return { changed: false, outcome };
  }

  let changed = false;
  let failed = false;
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
          failed = true;
          logEvent("voice.sfuMuteFailed", {
            room,
            identity,
            userId,
            region: target.regional ? target.id : undefined,
            stage: "mute",
            error: describeError(error),
          });
        }
      }
    }),
  );
  return { changed, outcome: failed ? "failed" : "ok" };
}

/**
 * Grant or revoke one user's right to publish in one SFU room, live: the
 * enforcement half of `Permission.SPEAK` for a participant who is already
 * connected when the permission changes (a role edit, a channel overwrite).
 *
 * `updateParticipant` rewrites the LiveKit permission set atomically, so every
 * field is stated (the SDK note says as much: partial means "the rest become
 * false"). Revoking publish on a source makes the SFU refuse the next publish
 * of that source. A minted token is not consulted again after connect, so this
 * is also the only way to change the grant without a reconnect.
 *
 * Belt and braces on revoke: tracks the person may no longer publish are muted
 * first, so a LiveKit build that unpublishes lazily still goes quiet at once.
 *
 * Same contract as `setSfuUserMuted`: never rejects, fails open on a
 * participant it cannot identify, returns true when at least one participant
 * was updated. The voice room calls it fire-and-forget (the permission change
 * has already committed); anything that needs the outcome awaits it directly.
 */
export async function setSfuUserCanPublish(
  room: string,
  userId: string,
  grant: { canSpeak: boolean; canStream: boolean; canShowFace?: boolean },
  knownIdentities: ReadonlyMap<string, string>,
): Promise<boolean> {
  const targets = await targetsFor("publish-grant", [room], [], false);
  if (targets.length === 0) {
    return false;
  }
  const results = await Promise.all(
    targets.map((target) =>
      publishGrantOn(target, room, userId, grant, knownIdentities),
    ),
  );
  if (targets[0]!.mode !== "pinned") {
    noteCoverage(
      "publish-grant",
      "listParticipants",
      room,
      results.map((result, index) => ({ id: targets[index]!.id, outcome: result.outcome })),
    );
  }
  return results.some((result) => result.changed);
}

async function publishGrantOn(
  target: RegionTarget,
  room: string,
  userId: string,
  grant: { canSpeak: boolean; canStream: boolean; canShowFace?: boolean },
  knownIdentities: ReadonlyMap<string, string>,
): Promise<{ changed: boolean; outcome: RegionOutcome }> {
  const { client } = target;
  const publish = liveKitPublishGrant(grant);

  let participants;
  try {
    participants = await client.listParticipants(room);
  } catch (error) {
    if (target.regional && isNotFound(error)) {
      return { changed: false, outcome: "ok" };
    }
    const outcome = outcomeOf(error);
    if (outcome === "failed") {
      logEvent("voice.sfuPublishGrantFailed", {
        room,
        userId,
        region: target.regional ? target.id : undefined,
        canSpeak: grant.canSpeak,
        canStream: grant.canStream,
        stage: "list",
        error: describeError(error),
      });
    }
    return { changed: false, outcome };
  }

  let changed = false;
  let failed = false;
  await Promise.all(
    participants.map(async (participant) => {
      const identity = participant.identity;
      const participantUserId =
        userIdFromParticipantMetadata(participant.metadata) ??
        knownIdentities.get(identity) ??
        null;
      if (participantUserId !== userId) {
        return;
      }
      for (const published of participant.tracks ?? []) {
        if (!shouldMutePublishedTrack(published, grant)) {
          continue;
        }
        try {
          await client.mutePublishedTrack(room, identity, published.sid, true);
        } catch (error) {
          logEvent("voice.sfuPublishGrantFailed", {
            room,
            identity,
            userId,
            canSpeak: grant.canSpeak,
            canStream: grant.canStream,
            stage: "mute",
            trackSid: published.sid,
            error: describeError(error),
          });
          failed = true;
        }
      }
      try {
        await client.updateParticipant(room, identity, {
          permission: {
            canPublish: publish.canPublish ?? false,
            canSubscribe: true,
            canPublishData: false,
            ...(publish.canPublishSources
              ? { canPublishSources: publish.canPublishSources }
              : {}),
          },
        });
        changed = true;
        logEvent("voice.sfuPublishGrant", {
          room,
          identity,
          userId,
          canSpeak: grant.canSpeak,
          canStream: grant.canStream,
        });
      } catch (error) {
        logEvent("voice.sfuPublishGrantFailed", {
          room,
          identity,
          userId,
          canSpeak: grant.canSpeak,
          canStream: grant.canStream,
          stage: "update",
          error: describeError(error),
        });
        failed = true;
      }
    }),
  );
  return { changed, outcome: failed ? "failed" : "ok" };
}

function shouldMutePublishedTrack(
  track: { source?: TrackSource; type?: TrackType },
  grant: { canSpeak: boolean; canStream: boolean },
): boolean {
  if (!grant.canSpeak && !grant.canStream) {
    return true;
  }
  if (track.source === TrackSource.MICROPHONE) {
    return !grant.canSpeak;
  }
  if (
    track.source === TrackSource.CAMERA ||
    track.source === TrackSource.SCREEN_SHARE ||
    track.source === TrackSource.SCREEN_SHARE_AUDIO
  ) {
    return !grant.canStream;
  }
  if (track.type === TrackType.VIDEO) {
    return !grant.canStream;
  }
  if (track.type === TrackType.AUDIO) {
    return !grant.canSpeak;
  }
  return false;
}

// --- end voice moderation -----------------------------------------------------
