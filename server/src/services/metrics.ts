import { timingSafeEqual } from "node:crypto";
import { getPool } from "../db.js";
import { INSTANCE_ID } from "../lib/bus.js";
import {
  clusterTopologyTracked,
  readClusterSnapshot,
} from "../voice/registry.js";
import { runtimeSnapshot, type RuntimeMetrics } from "../lib/runtime.js";
import { checkReady, type ReadyReport } from "./ready.js";
import { readSfuStats, type SfuStats } from "../voice/sfu-stats.js";
import { readStatusHistory, type StatusHistory } from "./status.js";
import {
  getVoiceActivitySnapshot,
  localVoicePeerCount,
} from "../ws/voice.js";
import { watchPartyStateFrameCounters } from "../ws/watch-party-events.js";
import {
  watchPartyDraftTtlMinutes,
  watchPartyHostGoneMinutes,
  watchPartySweepCounters,
} from "./watch-parties.js";
import {
  isLiveHlsEnabled,
  liveHlsActivity,
  liveHlsConfig,
} from "../voice/hls-egress.js";
import { countDueSessions } from "../voice/hls-cleanup.js";
import { llHlsActivity } from "../voice/hls-remux.js";
import {
  hlsKeepWarmLoopsActive,
  hlsKeepWarmRenders,
  hlsPlaylistRejectionsByReason,
} from "../voice/hls-playlist-proxy.js";
import { callMetricsSnapshot, type CallMetrics } from "../voice/call-metrics.js";
import {
  streamQualityMetricsSnapshot,
  type StreamQualityMetrics,
} from "../voice/stream-quality-metrics.js";
import {
  pushDeliverySnapshot,
  type PushDelivery,
} from "./push-metrics.js";
import {
  hlsTelemetryActivity,
  type HlsTelemetryActivity,
} from "../voice/hls-latency-metrics.js";
import { processRole, runsColdJobs } from "../lib/process-role.js";
import { getPresenceFanoutStats } from "../ws/chat.js";
import {
  acquisitionReport,
  retentionBySource,
  type AcquisitionReport,
  type RetentionReport,
} from "./acquisition.js";
import { activationFunnel, type ActivationFunnel } from "./activation.js";
import {
  dbQueriesByRoute,
  dbQueryTotal,
  dbTxByPath,
} from "../lib/db-tx-metrics.js";
import { readCacheMetrics } from "../lib/read-cache.js";
import { callRatingSummary } from "./call-ratings.js";
import { isCommunitiesEnabled } from "./communities.js";
import { connectionAdoption, type ConnectionAdoption } from "./connections.js";
import type { CallRatingSummary, VoiceRoomTransport } from "@pqp/shared";

/**
 * The operator dashboard's one read: `GET /api/admin/metrics`.
 *
 * Aggregate counts, and never an id, a handle or an email.
 *
 * It is not *only* counts, and the exceptions are worth stating because they
 * are the reason the dashboard has a password on it:
 *  - server, community and channel **names**, in the "most active" tables;
 *  - free text people wrote about the product: call-rating notes and the last
 *    few feedback entries, both truncated, neither attributed to anybody.
 * There is still no row here that identifies a person. See
 * tools/admin-dashboard/README.md.
 *
 * Deliberately NOT on status.json, which carries no user counts of any kind
 * (see services/status.ts). This is a separate, authenticated endpoint.
 *
 * Two ways in, both resolved in api/index.ts:
 *  - an instance moderator with a Clerk session, same predicate as the
 *    acquisition report;
 *  - a machine caller (the Cloudflare Worker in front of the dashboard)
 *    presenting `Authorization: Bearer <ADMIN_METRICS_TOKEN>`, compared in
 *    constant time. With the variable unset that path does not exist.
 *
 * The counts are cached in memory for 30 seconds: the dashboard polls, and the
 * API is one machine in gru. Counts that lag by half a minute are still
 * counts; a scan of `messages` per page refresh is a self-inflicted incident.
 * The `runtime` block is the exception and is sampled per request — it costs
 * nothing and a stale one would be actively misleading. See `getAdminMetrics`.
 */

export const ADMIN_METRICS_PATH = "/api/admin/metrics";

/** Anything shorter is a guessable token, so it is treated as not set. */
export const ADMIN_METRICS_TOKEN_MIN_LENGTH = 16;

const CACHE_TTL_MS = 30_000;

/**
 * Max concurrent queries `computeAdminMetrics` runs at once. Production sets
 * `PG_POOL_MAX=22` per API replica. The two fan-outs below used to run
 * unbounded (`Promise.all` over every thunk at once) — up to 17 queries in
 * the second block alone — so a single metrics compute could grab 17 of 22
 * pool connections, leaving ~5 for real traffic. With a metrics exporter
 * scraping both replicas every 20s against a 30s cache, that burst reliably
 * overlapped normal load and exhausted the pool: `/ready` waited for a
 * connection, its latency crossed the 200ms alert threshold, and readiness
 * flapped false for about a minute at a time (2026-09-22 incident). This
 * endpoint is cached for `CACHE_TTL_MS` and read only by an exporter and an
 * operator dashboard, so its own latency is irrelevant; pool safety is what
 * matters. 4 keeps the compute comfortably parallel without threatening the
 * pool even if both replicas race each other.
 */
const METRICS_QUERY_CONCURRENCY = 4;

/**
 * Runs `thunks` with at most `limit` in flight at once, preserving result
 * order and each element's own type (the way `Promise.all` does for a tuple
 * literal) so callers can still destructure the results positionally. Any
 * thunk starts only when a slot is free, so the pool never sees more than
 * `limit` of these queries outstanding at a time. A rejection propagates
 * like `Promise.all` (the caller sees the first error); thunks still in
 * flight are not cancelled, but no new ones are started.
 */
export async function runWithConcurrencyLimit<T extends readonly unknown[]>(
  thunks: { [K in keyof T]: () => Promise<T[K]> },
  limit: number,
): Promise<T> {
  const results: unknown[] = new Array(thunks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= thunks.length) return;
      results[i] = await thunks[i]();
    }
  }

  const workerCount = Math.min(limit, thunks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results as unknown as T;
}

/** Accounts that are not people are excluded from every count here. */
const EXCLUDED_ACCOUNTS = ["webhook", "character"] as const;

export interface ClusterMetrics {
  /** Live instances, this one included. 1 when the voice registry is off. */
  instances: number;
  /** How many of those wrote a snapshot on their last heartbeat. */
  reporting: number;
  /**
   * Age in seconds of the OLDEST contributing heartbeat, measured against the
   * rows rather than assumed from the lease TTL. Zero when this process is the
   * only contributor. It is the honest answer to "how old is this number",
   * which matters because a sum built from 15-second beats is never `now` and
   * a dashboard that implies it is would be lying by omission.
   */
  maxStalenessSeconds: number;
  sockets: number;
  compressedSockets: number;
  voiceParticipants: number;
  hlsSessions: number;
  poolBusy: number;
  poolMax: number;
  /**
   * Distinct `APP_VERSION` values across live instances. More than one means
   * a deploy is mid-roll, which is the honest explanation for two machines
   * disagreeing about a counter and is otherwise invisible from here.
   */
  versions: string[];
}

export interface AdminMetrics {
  generatedAt: string;
  /**
   * Seconds the server will keep answering with these same *counts*.
   *
   * Not the whole payload: `runtime` is sampled per request and ignores this.
   */
  cacheTtlSeconds: number;
  /** The deployed commit (`APP_VERSION`), null when the process was not stamped. */
  version: string | null;
  excludedAccounts: readonly string[];
  /**
   * Live process pressure: open WebSockets and the connection pool.
   *
   * THE ONE BLOCK IN THIS PAYLOAD THAT IS NOT CACHED, and the one that costs
   * nothing — see `getAdminMetrics` for why those two facts are the same
   * decision. Everything in it is a property read (`wss.clients.size`, the
   * pool's own counters); there is no query behind it. See lib/runtime.ts.
   */
  runtime: RuntimeMetrics;
  /**
   * Which machine answered this request.
   *
   * With one machine the question never came up. With two behind one hostname
   * every number in `runtime` above belongs to whichever one the load balancer
   * picked, and a dashboard that refreshes flips between two halves of the
   * answer with nothing on the page to say so. This field is the "nothing on
   * the page" half of that fixed.
   */
  instanceId: string;
  /** Instances whose `voice_instances` lease is live. 1 when the registry is off. */
  instanceCount: number;
  /**
   * THE SAME LIVE COUNTERS, SUMMED ACROSS THE CLUSTER.
   *
   * `runtime` stays exactly what it was — this machine, sampled now — because
   * "is THIS machine in trouble" is a real question with a different answer.
   * This block answers the other one: how big is the service. It is built from
   * the per-instance snapshot each process writes into its own
   * `voice_instances` row on its 15-second heartbeat (lib/instance-snapshot.ts),
   * so it costs one small SELECT here and no extra write anywhere.
   *
   * Up to 15 seconds stale by construction, and `reporting` says how many of
   * `instances` actually contributed — a worker holds no sockets and an
   * instance that has not beaten since the column was added contributes
   * nothing, so a sum with `reporting < instances` is a floor, not a total.
   */
  cluster: ClusterMetrics;
  /**
   * The verdict `GET /ready` gives an external monitor, verbatim, so the
   * dashboard and UptimeRobot never disagree. Not cached here: ready.ts
   * bounds its own cost (one SELECT 1; remote probes cached for 30 s).
   */
  ready: ReadyReport;
  /**
   * The SFU as the SFU sees itself: which host this process is configured
   * with (hostname only), whether it answered, and its room and participant
   * counts. Its own 10-second cache, in voice/sfu-stats.ts, not this one:
   * `voice` below is the API's peer map from the 30-second cache, and the two
   * are meant to be compared, not confused.
   */
  sfu: SfuStats;
  /**
   * Per-component latency over the last 24 hours, bucketed, plus each
   * component's own p50 and p95.
   *
   * Deliberately here and not on `/status.json`: a latency curve is a load
   * curve, and the public page is allowed to say only "up" and "how often".
   * See services/status.ts. Null when the history query failed, which must
   * not cost the dashboard its counts.
   */
  statusHistory: StatusHistory | null;
  users: {
    total: number;
    last24h: number;
    /** 24 hourly buckets, oldest first; the last one is the current hour. */
    byHour: number[];
  };
  servers: { total: number; last24h: number };
  messages: {
    last24h: number;
    /** The 24 hours before those, for a like-for-like delta. */
    previous24h: number;
    lastHour: number;
    /** Webhook and character messages in the last 24h, reported, not counted. */
    automated24h: number;
    byHour: number[];
    /**
     * The `last24h` total split by where it was sent: a server channel, a
     * DM (1:1 conversation) or a group conversation. `dm + group + server`
     * equals `last24h`. This is the only place "DMs sent" is broken out — the
     * growth signal for private messaging as against server activity — and it
     * is DB-derived from the same query as `last24h`, so it costs no extra
     * round trip.
     */
    byScope24h: { dm: number; group: number; server: number };
  };
  distinctSenders24h: number;
  activeTextChannels24h: number;
  channels: { text: number; voice: number; category: number; thread: number };
  /**
   * `db.tx.byPath`: Postgres round trips since boot, by labelled call site.
   *
   * Born from the 2026-09-12 watch party postmortem (A2): ~330 tx/s against
   * 60-90 seated users killed a shared-CPU database, and nothing said which
   * query path was responsible. Not every `pool.query` call in the app —
   * only the voice / presence / registry call sites that investigation
   * needed: `registry.*` (server/src/voice/registry.ts, every write and
   * roster read), `users.canAccessChannel` (the roster membership check),
   * and `bus.publish` / `bus.publishBatch` (server/src/lib/bus-postgres.ts).
   * A label absent from the map has not fired since boot, not "zero"; see
   * `dbTxByPath` in lib/db-tx-metrics.ts.
   */
  dbTx: {
    byPath: Record<string, number>;
  };
  /**
   * `db.queries.total` and `db.queries.byRoute`: EVERY Postgres round trip
   * this process has run since boot, wrapped once at the pool itself
   * (`db.ts`'s `getPool`) rather than at individual call sites — unlike
   * `dbTx.byPath` above, nothing has to remember to instrument a new query
   * for this to see it. `byRoute` breaks the total down by the HTTP route
   * the query happened inside (`GET /api/servers/:serverId/members`, the
   * path template, never an interpolated id), via an AsyncLocalStorage
   * context `handleApi` sets once per request (`lib/route-context.ts`). Two
   * reserved labels stand outside the route table: `"auth"` is Bearer
   * resolution and the age-gate/timeout gates, which run before any route
   * has matched and are shared across every request rather than belonging
   * to whichever endpoint follows — folding them into `"other"` would have
   * hidden a real cost center (53k auth-resolution writes alone) behind the
   * same label used for background work; `"other"` itself is left for a WS
   * handler, a cold job, or anything at boot. Added alongside the 2026-09-13
   * Vultr cutover cache work (member list, auth-write skip, webhook poll
   * backoff, per-request permission caches) specifically so the drop from
   * that work is a number on this endpoint, not a guess from query-log
   * sampling the way the 785k figure that motivated it was.
   */
  dbQueries: {
    total: number;
    byRoute: Record<string, number>;
  };
  /**
   * `read-cache.ts`'s counters, cumulative since boot: `coalesce` calls that
   * found a fresh entry (`hits`), that had to run the loader (`misses`),
   * that joined an already-running load instead of starting a second one
   * (`coalesced` — the number that collapses during a reload storm), and
   * that were served a stale-but-within-window value while a background
   * refresh ran (`staleServed`). `size` is the current entry count and
   * `bytes` the approximate resident size, each bounded by its own eviction
   * trigger in the module (an entry-count LRU cap and a byte budget — a
   * cache full of large message pages gives up entries sooner than one full
   * of small watch-party rows would). Born from the same 2026-09-12
   * postmortem (A2) as `dbTx` above: this is the read side of that fix,
   * caching the latest message page, a server's channel list, and a
   * channel's watch-party state. Off (falling back to `misses` for
   * everything) when `READ_CACHE=off`.
   */
  readCache: {
    hits: number;
    misses: number;
    coalesced: number;
    staleServed: number;
    size: number;
    bytes: number;
  };
  /**
   * What the channel-presence fan-out is doing since the last deploy: frames
   * that went out as a delta against frames that went out as a whole viewer
   * list, and how many connected sockets asked for deltas at all.
   *
   * Same pair, and the same reasoning, as `voice.roster`. The denominator is
   * the half that distinguishes "the optimisation is running" from "no client
   * negotiated it and every frame is still a whole list", which look identical
   * from the server's side.
   */
  presence: {
    deltas: number;
    snapshots: number;
    sockets: number;
    socketsOnDeltas: number;
  };
  /**
   * WHAT HAPPENS WHEN SOMEBODY TRIES TO BE IN A CALL. Server-truth outcome
   * counts, cumulative since this process booted (a rate is Prometheus's to
   * derive), on the instance that answered — the same convention as
   * `voice.roster` and `dbTx`. The server routes every call, so the outcome is
   * known for certain here and nowhere else. See `voice/call-metrics.ts`.
   *
   *  - `joinAttempts` / `joinConnected`: `join-voice-room` frames tried and
   *    seated. `joinAttempts - joinConnected` is the refusal total, of which
   *    `joinRefusedByReason` is the explained part (mesh cap, no access, a
   *    client that cannot run the room's transport, ...). This is the number
   *    the MoonKase spike (2026-09-05) had no way to show: 212 signups whose
   *    calls the mesh cap refused, invisible until after the fact.
   *  - `joinConnectedByTransport` / `...ByScope`: mesh vs livekit, and dm vs
   *    group vs server — "how many mesh DM calls connected".
   *  - the ring block: DM/group ring outcomes — started, answered, declined,
   *    and unanswered ends (`timeout` rang out, `cancelled` room emptied).
   */
  calls: CallMetrics;
  /**
   * SCREEN-SHARE / WATCH-PARTY VIDEO QUALITY, folded from client-reported
   * `getStats()` samples (`POST /api/stream-quality/telemetry`) into bounded
   * histograms since this process booted. fps, bitrate and resolution are
   * each split by role (presenter/viewer) and transport (mesh/livekit);
   * `limitationReasons` is WebRTC's own `qualityLimitationReason`
   * (`none`/`cpu`/`bandwidth`/`other`), presenter-only -- the field that
   * tells a starved uplink apart from an overloaded encoder, which a raw fps
   * number cannot. See `voice/stream-quality-metrics.ts`.
   */
  streamQuality: StreamQualityMetrics;
  voice: {
    activeRooms: number;
    participants: number;
    largestRoomNow: number;
    peakRoomSizeToday: number;
    /** ISO; the peak resets on deploy and at São Paulo midnight. */
    peakTrackedSince: string;
    backend: "mesh" | "livekit";
    /**
     * Voice frames over the cluster bus since the last deploy, on the
     * instance that answered: published for sockets held on another
     * machine, and received from the bus for sockets held here. Both zero
     * on one machine; both climbing within a minute of two machines
     * sharing a room. Zero after a flip is a bus that is not delivering.
     */
    cluster: {
      framesRelayed: number;
      framesReceived: number;
    };
    /** Registry writes issued in the trailing 60 seconds. See `ws/voice.ts`'s
     *  `VoiceActivitySnapshot.registry`. Zero when `VOICE_REGISTRY` is off. */
    registry: {
      writesPerMinute: number;
      /**
       * `VOICE_REGISTRY_BATCH`: the write coalescer, since the last deploy,
       * on the instance that answered. `rowsCoalesced` over `batchFlushes` is
       * the compression ratio and the only number that says the flag is
       * buying anything — about one means every flush carried one row, which
       * is the unbatched cost plus latency. `flushFailures` (a flush that
       * failed twice and fell back to per-row writes) and `staleDropped` (a
       * seat that left between a write being asked for and the flush issuing
       * it) both belong at zero. Null when batching is off.
       */
      batch: {
        batchFlushes: number;
        rowsCoalesced: number;
        maxBatch: number;
        flushMsP95: number;
        flushFailures: number;
        staleDropped: number;
        pending: number;
        maxPending: number;
      } | null;
    };
    /**
     * WHETHER ANYBODY IS SITTING IN A CALL THEY LEFT.
     *
     * `idleOverAnHour` counts seats nothing has written to in an hour, and
     * `oldestIdleMinutes` is the worst of them. A seat is written on join, on
     * every state change and on resume, so a row untouched that long is
     * either somebody genuinely silent or a seat with nobody behind it. The
     * night of 2026-09-08 had ten of them, one fifteen hours old, and no
     * number anywhere on this dashboard said so.
     *
     * `staleRowWritesRefused` and `ghostsSwept` are the mechanism, since the
     * last deploy, on the instance that answered: a write that would have
     * resurrected a deleted seat, and one that got through and had to be
     * swept. Both belong at zero.
     *
     * Null when `VOICE_REGISTRY` is off: no rows, nothing to read, and a zero
     * would claim an all-clear the deployment cannot give.
     */
    seats: {
      idleOverAnHour: number;
      oldestIdleMinutes: number | null;
      staleRowWritesRefused: number;
      ghostsSwept: number;
      /**
       * Mesh seats released at once instead of held, because the socket never
       * declared `mesh-resume`. Zero until `VOICE_MESH_RESUME_REQUIRES_CAP`
       * is on; after the flip it is what says the rule is doing something,
       * and the `mesh-resume` socket fraction is what says whether it still
       * needs to.
       */
      meshHoldsRefused: number;
      /**
       * Sockets declaring `mesh-resume`, against `voice.roster.sockets`. What
       * an operator reads before flipping `VOICE_MESH_RESUME_REQUIRES_CAP`:
       * phones never declare it, so this converges on the browser share, not
       * on the total.
       */
      meshResumeSockets: number;
      /** Authenticated sockets right now: the denominator for the line above. */
      sockets: number;
    } | null;
    /**
     * What the roster fan-out is doing since the last deploy: how many frames
     * went out as a delta against how many went out whole, and how many
     * sockets asked for deltas at all. The second pair is the denominator that
     * distinguishes "the optimisation is running" from "no client negotiated
     * it and every frame is still a whole roster".
     */
    roster: {
      deltas: number;
      snapshots: number;
      /**
       * How many of `snapshots` went to somebody who is not in the call.
       *
       * Says whether the remaining whole-roster cost belongs to the room or to
       * the sidebar, which is the difference between "make the roster smaller"
       * and "stop sending it to the audience" as the next thing to do.
       */
      audienceSnapshots: number;
      sockets: number;
      socketsOnDeltas: number;
    };
    /**
     * The rooms that have somebody in them right now, largest first.
     *
     * A DM call has no server channel behind it, so `channel` is null there
     * and the dashboard labels it a conversation rather than inventing a name.
     */
    rooms: {
      channel: string | null;
      server: string | null;
      participants: number;
      sharingScreen: number;
      /**
       * The room's media path, mesh or livekit. Absent only when a caller is
       * still on the previous shape of this payload — added additively so the
       * currently deployed dashboard, which does not read it, keeps working.
       */
      transport: VoiceRoomTransport;
      /** ISO, or null when this process cannot say cheaply (see voice.ts). */
      openedAt: string | null;
    }[];
  };
  /**
   * LIVE HLS: WHETHER A WATCH PARTY EVER ACTUALLY TRANSCODED, AND WHETHER ITS
   * RECORDINGS ARE BEING DELETED.
   *
   * This block exists because the feature could be fully deployed, fully
   * configured, and silently doing nothing, with no number anywhere saying so.
   * `/ready` answers whether the bucket is reachable; this answers whether it
   * is being used. The three that matter, in the order to read them:
   *
   *  - `enabled` / `configured`: the flag, and the flag plus every secret the
   *    egress needs. `enabled: true, configured: false` is the shape where an
   *    operator turned it on and nothing can ever start.
   *  - `sessions` / `rungs`: transcodes running on the instance that
   *    answered, right now. Zero during a live watch party means the egress
   *    is not starting and the audience is looking at a blank pane.
   *  - `uncleaned`: finished sessions past their retention window that still
   *    hold objects. **This is the one that catches a dead sweep.** It belongs
   *    at zero and self-corrects within a minute of each party ending. It
   *    climbs forever, silently, on a deployment where the process that runs
   *    the sweep cannot reach the bucket, which is exactly what the
   *    `WORKER_MODE=api` / `pqp-worker` split produced: `pqp-api` has
   *    `LIVE_HLS_S3_*` and skips every batch job, `pqp-worker` runs them and
   *    had none of those secrets. Nothing else in this product would have
   *    shown that except the R2 bill.
   *
   * `sweepsHere` says whether the process answering this request is the one
   * that runs the sweep at all, so a zero can be read as "clean" rather than
   * "not my job". On the split deployment it is false on `pqp-api`, and the
   * number to trust for `uncleaned` is still true and shared, because it is a
   * database count rather than a process counter.
   */
  /**
   * THE PARTY SESSION'S OWN SWEEPS, which are not the stream's.
   * `liveHls.*` below is about transcodes; this is about `channel_sessions`
   * rows, and the two go wrong independently (that is the first paragraph of
   * `docs/WATCH_PARTY_LIFECYCLE.md`).
   *
   * `sweptDrafts` climbing is the abandoned-setup-sheet case being cleaned
   * up rather than blocking a channel. `sweptHostGone` is a party that
   * outlived its host. `heldByLiveStream` is the safety guard REFUSING to
   * end a party because something is still playing on it: a number that
   * climbs while `sweptHostGone` stays flat is the guard working, and one
   * that climbs forever with no parties on air is a leaked `hls_sessions`
   * row. `streamCheckFailures` above zero means the guard has been failing
   * safe, which holds parties open.
   */
  watchParty: {
    sweptDrafts: number;
    sweptHostGone: number;
    heldByLiveStream: number;
    streamCheckFailures: number;
    /** The live values of the two knobs. `0` means that sweep is off. */
    draftTtlMinutes: number;
    hostGoneMinutes: number;
  };
  liveHls: {
    enabled: boolean;
    configured: boolean;
    /** Whether `LIVE_HLS_SERVER_ALLOWLIST` confines it to named servers. */
    allowlisted: boolean;
    /**
     * `watchParty.state` frames since boot: `relayed` is what this instance
     * published for the other machine after a party changed state here,
     * `fromBus` is what it applied. Both zero on one machine; on two, both
     * climb with every party going live, ending or changing guests. The
     * stream's own relay is `voice.liveHls.audienceFramesRelayed` /
     * `audienceFramesFromBus`.
     */
    stateFrames: { relayed: number; fromBus: number; retries: number };
    /** Rung names this deployment would encode, lowest first. */
    ladder: string[];
    sessions: number;
    /** `LIVE_HLS_MAX_SESSIONS`: what `sessions` is refused at. */
    maxSessions: number;
    rungs: number;
    oldestSessionMinutes: number | null;
    /**
     * Live sessions whose transcode has no audio track at all: the share was
     * picked without its own audio, so the seatless audience is watching a
     * silent film while the seated room hears every microphone. Not an error
     * on its own, and the number to look at during a film night.
     */
    silentSessions: number;
    /**
     * Leftover transcodes the monitor has stopped since this process started:
     * handlers still running on the media box for a room whose session this
     * process had already replaced. Belongs at zero; anything else is a leak
     * whose only other symptom is the box getting slower.
     */
    orphansStopped: number;
    /**
     * `hls_sessions` rows this process did NOT adopt, end or stop because
     * another API instance whose `voice_instances` heartbeat is still fresh
     * owns them. Zero on a one-machine deployment; on two, a zero while a
     * party is running through a deploy means the `instance_id` stamp is not
     * landing and the boot sweep is free to kill the other machine's stream.
     */
    skippedOwnedElsewhere: number;
    /**
     * Teardowns waiting on an ownership answer because the lookup failed. Zero
     * on a healthy deployment; anything else is a database that is not
     * answering while this process wants to stop a transcode.
     */
    deferredStops: number;
    /**
     * Live sessions writing the host's voice to its own file beside the
     * segments (`LIVE_HLS_MIC_ARCHIVE`). Zero while the flag is off, which is
     * every deployment until somebody sets it. Zero WITH the flag on and
     * `sessions` above zero is the number that says it is not working: either
     * the host's browser has not picked up the bundle that publishes the
     * `mic-archive` track, or the Track Egress request is being refused
     * (`voice.hlsMicArchiveFailed`).
     */
    micArchive: number;
    /**
     * Sessions carrying a SECOND, video-only 360p30 transcode of the
     * presenter's camera, on top of that party's ladder: roughly 0.2 to 0.3 of
     * a core apiece. What turns "the box feels slow" into "three hosts have
     * their webcams on". Zero with `LIVE_HLS_CAMERA=false`.
     */
    cameraSessions: number;
    /** Sessions past retention that still hold objects. Belongs at zero. */
    uncleaned: number;
    /** Whether this process runs the retention sweep (`WORKER_MODE`). */
    sweepsHere: boolean;
    /**
     * Live sessions this process is polling from the server side so every
     * rung stays widened, not just the ones a viewer happens to be watching.
     * See `hls-playlist-proxy.ts`'s keep-warm loop. Should track `sessions`
     * closely; a persistent gap below it means a rung's window can go stale
     * between viewers switching to it.
     */
    keepWarmLoops: number;
    /** Warm (non-viewer) renders performed by those loops since boot. */
    keepWarmRenders: number;
    /**
     * BROADCAST_PIPELINE B0.5/B0.6: what sampled viewers report about their
     * own playback. `byRung[].p50Ms`/`p95Ms` are encode-to-paint, computed
     * from `hls-latency-metrics.ts`'s histogram, never mixed with the
     * capture-to-encode estimate (that estimate is not reported here at all
     * -- see the T0-T4 row of B0.3's table). In-process only: a restart
     * clears it, same as `keepWarmRenders` above.
     */
    latency: HlsTelemetryActivity;
    /**
     * Live `pqp-remux` sessions (`docs/plans/LL_HLS.md` L1.5), this process,
     * right now. Zero on every deployment with `LIVE_HLS_LL` unset, which is
     * every deployment until an operator sets it -- this is the "is the
     * flag doing anything" counter for the second delivery mode, the same
     * role `sessions` plays for the conventional ladder.
     */
    llSessions: number;
    /**
     * `POST /sessions` to the control API failed, or the control plane was
     * not configured at all, since this process started. Belongs at zero
     * once configured; a start requested (the flag, the allowlist and the
     * party's own toggle all say yes) that never produces a session shows up
     * here rather than as a silent nothing.
     */
    llStartFailures: number;
    /**
     * A `DELETE /sessions/:id` to the control API failed, at either the
     * normal stop path or a retry. Belongs at zero; a nonzero, growing
     * number is a session `stopLlSession`/`retryStopOpenLlRow` cannot yet
     * confirm the box has actually released.
     */
    llStopFailures: number;
    /**
     * An LL session was demoted back to the conventional ladder by `L1.6`'s
     * watchdog, which does not exist yet -- this reads zero on every
     * deployment until that task ships. Reserved here now so the dashboard
     * panel and this counter's meaning are fixed before the code that
     * increments it exists.
     */
    llDemoted: number;
    /**
     * WATCH-PARTY TRANSCODE LIFECYCLE since this process booted (cumulative,
     * per instance — a rate is Prometheus's to derive). `startsTotal` /
     * `stopsTotal` are sessions that began (`voice.hlsStarted`) and were torn
     * down (`voice.hlsStopped`). `restartsScheduled` is a rung that died and
     * is being brought back; `restartsExhausted` is `scheduleRestart` giving
     * up (`voice.hlsFailed`) — an audience left on a blank pane. A rising
     * `restartsScheduled` during one party is a stream that will not stay up,
     * which pitfall 15 was and which no gauge here could show before.
     */
    startsTotal: number;
    stopsTotal: number;
    restartsScheduled: number;
    restartsExhausted: number;
    /**
     * Playlist requests refused by the viewer capability, by reason
     * (`missing` / `expired` / `bad-signature` / ...), cumulative. Counts EVERY
     * rejection, ahead of the per-channel log suppression, so a rolling
     * `expired` wave (pitfall 16, which stalled every web viewer) is a true
     * level an alert can read rather than a rate-limited log line. Only reasons
     * actually seen appear.
     */
    playlistRejectedByReason: Record<string, number>;
  };
  topServers24h: {
    name: string;
    tagline: string | null;
    channels: number;
    members: number;
    messages24h: number;
  }[];
  acquisition: AcquisitionReport;
  /**
   * The activation funnel: of the accounts that signed up in a window, how many
   * reached each step (age gate, handle, first join, first message, first
   * voice, first watch party), and the step-to-step conversion. Sits beside
   * `acquisition` and `retention` because it is the third face of the same
   * question -- arrivals, the ones who stayed, and the ones who got going. Built
   * from `user_activation` in one query inside this same snapshot. Aggregate
   * only, never a person; see services/activation.ts and docs/MONITORING.md.
   */
  activation: ActivationFunnel;
  /**
   * Which channels bring people who stay, over a 30-day cohort.
   *
   * Sits beside `acquisition` because it is the other half of the same
   * question: that block counts arrivals, this one counts the ones still
   * here. A channel is only worth its cost per signup if the signups last.
   */
  retention: RetentionReport;
  /** Prompted call quality, last 7 days. Counts only; see call-ratings.ts. */
  callRatings: CallRatingSummary;
  /**
   * Linked Steam / Battle.net / Twitch accounts; see connections.ts.
   *
   * `ofUsers` is the denominator for every share drawn from this block, and it
   * is `users.total` above, from the same snapshot: all human accounts that
   * exist, not accounts created in some window and not accounts that were
   * active. "12 of 400" here means twelve of everyone who ever signed up.
   */
  connections: ConnectionAdoption & { ofUsers: number };

  // ------------------------------------------------------------ tab detail
  // Everything below backs one tab each on the operator dashboard. It is
  // computed in the same 30-second snapshot as the headline numbers above,
  // rather than behind its own endpoint, because at this instance's size the
  // extra queries cost less than a second round trip would and the tabs can
  // then switch with no network at all.

  /** Backs the "canais" tab. */
  channelDetail: {
    /** Server text channels with the private allowlist on. */
    privateText: number;
    /** Channels with no server behind them: direct and group conversations. */
    conversations: { dm: number; group: number };
    serversWithChannels: number;
    maxChannelsInServer: number;
    /** Server text channels that have never received a message. */
    emptyText: number;
    topText24h: {
      channel: string;
      server: string;
      messages24h: number;
      senders24h: number;
    }[];
  };

  /** Backs the "usuários" tab. Adoption and activity, never a person. */
  userDetail: {
    /** Distinct human senders over 7 days (the 24h figure is above). */
    active7d: number;
    withHandle: number;
    withAvatar: number;
    withBanner: number;
    ageChecked: number;
    /** Accounts inside the art. 18 deletion grace window. */
    deletionPending: number;
    /** Oldest first, São Paulo days, up to 14 of them. */
    signupsByDay: { day: string; n: number }[];
    /**
     * The closest thing to retention this schema can answer honestly.
     *
     * `eligible` is every account older than 24 hours; `active` is how many of
     * those sent a message in the last 7 days. It is not a cohort curve and it
     * should not be read as one: somebody who reads without posting counts as
     * inactive here, because messages are the only per-user activity this
     * database records.
     */
    returning7d: { eligible: number; active: number };
  };

  /** Backs the "comunidades" tab. */
  communities: {
    /**
     * `COMMUNITIES_ENABLED`. With it off every count below is zero because the
     * feature is off, not because nobody used it, and the dashboard says so
     * rather than drawing an empty state that looks like a result.
     */
    enabled: boolean;
    total: number;
    listed: number;
    suspended: number;
    withSlug: number;
    byCategory: { category: string; n: number }[];
    list: {
      name: string;
      slug: string | null;
      category: string;
      members: number;
      channels: number;
      messages24h: number;
      suspended: boolean;
    }[];
  };

  /**
   * Product surfaces that are not users / messages / voice.
   *
   * Friends, attachments, invites and push sit in the same snapshot as the
   * rest so the dashboard can draw them without a second read. Counts only.
   */
  product: {
    friendships: number;
    pendingFriendRequests: number;
    attachments: { total: number; last24h: number };
    invites: {
      created24h: number;
      uses: number;
      /**
       * Joins through an invite link in the last 7 days, by the `?ref=` tag the
       * link carried (`server_members.join_ref`): `convite` for a shared
       * invite, `discord` for the one a Discord import hands out. Joins with no
       * tag are not listed. At most ten tags, largest first.
       */
      joinsByRef7d: Record<string, number>;
    };
    push: { web: number; apns: number; fcm: number };
    /**
     * PUSH SEND OUTCOMES per platform since boot (cumulative, per instance),
     * NOT subscription counts — `push` above is how many devices could be
     * reached, this is what happened when the server actually sent. `sent` is
     * accepted by the vendor, `pruned` is a dead token garbage-collected
     * (normal, not a failure), `failed` is everything else (auth/config/outage
     * — the one an alert watches). See `services/push-metrics.ts`.
     */
    pushDelivery: PushDelivery;
  };

  /**
   * Discord layout imports (`server.discord_import` audit rows), and whether
   * the servers they made ever filled up. The campaign that moves groups from
   * Discord is judged on the second half: an import nobody joins is a copy of
   * a sidebar, not a group that moved.
   */
  imports: {
    discord: {
      total: number;
      last24h: number;
      last7d: number;
      /**
       * People (never the owner) who joined, in the last 7 days, a server that
       * began as a Discord import, by any door.
       */
      membersJoined7d: number;
      /** Of those, the ones whose invite link carried `?ref=discord`. */
      joinedViaImportInvite7d: number;
    };
  };

  /** Backs the "moderação" tab. */
  moderation: {
    reports: { open: number; actioned: number; dismissed: number; last24h: number };
    feedback: { open: number; confirmed: number; closed: number; last24h: number };
    bans: number;
    /** Timeouts that have not expired yet. */
    activeTimeouts: number;
    /** Newest first. Body truncated server side; no author, ever. */
    recentFeedback: { kind: string; status: string; createdAt: string; body: string }[];
  };
}

// ------------------------------------------------------------------- token

function configuredToken(): string | null {
  const token = process.env.ADMIN_METRICS_TOKEN?.trim() ?? "";
  return token.length >= ADMIN_METRICS_TOKEN_MIN_LENGTH ? token : null;
}

/** Whether the machine-token path is available at all. */
export function isAdminMetricsTokenConfigured(): boolean {
  return configuredToken() !== null;
}

/**
 * Constant-time check of an `Authorization` header against the configured
 * token. False, never a throw, for a missing header, a non-Bearer scheme, an
 * unset token or a mismatch: the caller falls through to the regular Clerk
 * resolution, which is what a moderator's JWT needs anyway.
 */
export function isAdminMetricsTokenValid(authorization: string | undefined): boolean {
  const expected = configuredToken();
  if (!expected || !authorization) {
    return false;
  }
  const [scheme, ...rest] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "bearer") {
    return false;
  }
  const presented = rest.join(" ").trim();
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Still burn a comparison so the length check alone does not time differently.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

// ----------------------------------------------------------------- queries

function toHourly(rows: { hours_ago: number; n: string }[]): number[] {
  const buckets = new Array<number>(24).fill(0);
  for (const row of rows) {
    const index = 23 - Number(row.hours_ago);
    // A row outside the window can only come from clock skew (a created_at
    // slightly in the future); it is dropped rather than thrown on.
    if (index >= 0 && index < 24) {
      buckets[index] = Number(row.n);
    }
  }
  return buckets;
}

/**
 * `hours_ago` is computed in SQL against the database clock, so the buckets do
 * not depend on the app and the database agreeing on what time it is.
 */
function hoursAgo(column: string): string {
  return `(EXTRACT(EPOCH FROM date_trunc('hour', now()) - date_trunc('hour', ${column})) / 3600)::int`;
}

/**
 * Everything the 30-second cache holds — which is everything except `runtime`.
 *
 * Expressed as a type rather than as a convention on purpose: it makes it
 * impossible to accidentally compute the live block inside the cached one.
 */
/**
 * Everything the 30-second cache holds. The live blocks are excluded because
 * they are sampled per request, and the three cluster fields join them: a
 * cached `instanceId` would name whichever machine happened to warm the cache
 * rather than the one answering, which is worse than not saying at all.
 */
type CachedMetrics = Omit<
  AdminMetrics,
  "runtime" | "ready" | "sfu" | "instanceId" | "instanceCount" | "cluster"
>;

async function computeAdminMetrics(): Promise<CachedMetrics> {
  const pool = getPool();
  const [
    users,
    usersByHour,
    servers,
    channels,
    messages,
    messagesByHour,
    topServers,
    acquisition,
    retention,
    activation,
    callRatings,
    connections,
  ] = await runWithConcurrencyLimit(
    [
    () => pool.query<{ total: string; last24h: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')::text AS last24h
         FROM users
        WHERE NOT is_webhook AND NOT is_character`,
    ),
    () => pool.query<{ hours_ago: number; n: string }>(
      `SELECT ${hoursAgo("created_at")} AS hours_ago, COUNT(*)::text AS n
         FROM users
        WHERE created_at >= date_trunc('hour', now()) - interval '23 hours'
          AND NOT is_webhook AND NOT is_character
        GROUP BY 1`,
    ),
    () => pool.query<{ total: string; last24h: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')::text AS last24h
         FROM servers`,
    ),
    () => pool.query<{ type: string; n: string }>(
      `SELECT type, COUNT(*)::text AS n
         FROM channels
        WHERE kind = 'server'
        GROUP BY type`,
    ),
    () => pool.query<{
      last24h: string;
      previous24h: string;
      last_hour: string;
      automated24h: string;
      dm_24h: string;
      group_24h: string;
      server_24h: string;
      senders: string;
      active_text_channels: string;
    }>(
      `SELECT COUNT(*) FILTER (WHERE f.human AND f.recent)::text AS last24h,
              COUNT(*) FILTER (WHERE f.human AND NOT f.recent)::text AS previous24h,
              COUNT(*) FILTER (WHERE f.human AND m.created_at >= now() - interval '1 hour')::text AS last_hour,
              COUNT(*) FILTER (WHERE NOT f.human AND f.recent)::text AS automated24h,
              COUNT(*) FILTER (WHERE f.human AND f.recent AND c.kind = 'dm')::text AS dm_24h,
              COUNT(*) FILTER (WHERE f.human AND f.recent AND c.kind = 'group')::text AS group_24h,
              COUNT(*) FILTER (WHERE f.human AND f.recent AND c.kind = 'server')::text AS server_24h,
              COUNT(DISTINCT m.author_id) FILTER (WHERE f.human AND f.recent)::text AS senders,
              COUNT(DISTINCT m.channel_id) FILTER (
                WHERE f.human AND f.recent AND c.kind = 'server' AND c.type = 'text'
              )::text AS active_text_channels
         FROM messages m
         JOIN users u ON u.id = m.author_id
         JOIN channels c ON c.id = m.channel_id
         CROSS JOIN LATERAL (
           SELECT NOT (u.is_webhook OR u.is_character) AS human,
                  m.created_at >= now() - interval '24 hours' AS recent
         ) f
        WHERE m.created_at >= now() - interval '48 hours'`,
    ),
    () => pool.query<{ hours_ago: number; n: string }>(
      `SELECT ${hoursAgo("m.created_at")} AS hours_ago,
              COUNT(*)::text AS n
         FROM messages m
         JOIN users u ON u.id = m.author_id
        WHERE m.created_at >= date_trunc('hour', now()) - interval '23 hours'
          AND NOT u.is_webhook AND NOT u.is_character
        GROUP BY 1`,
    ),
    () => pool.query<{
      name: string;
      tagline: string | null;
      channels: string;
      members: string;
      messages_24h: string;
    }>(
      `WITH active AS (
         SELECT c.server_id, COUNT(*) AS messages_24h
           FROM messages m
           JOIN channels c ON c.id = m.channel_id
           JOIN users u ON u.id = m.author_id
          WHERE m.created_at >= now() - interval '24 hours'
            AND c.server_id IS NOT NULL
            AND NOT u.is_webhook AND NOT u.is_character
          GROUP BY c.server_id
          ORDER BY COUNT(*) DESC
          LIMIT 5
       )
       SELECT s.name,
              s.community_tagline AS tagline,
              (SELECT COUNT(*) FROM channels c
                WHERE c.server_id = s.id AND c.type IN ('text', 'voice', 'watch_party'))::text AS channels,
              (SELECT COUNT(*) FROM server_members sm
                WHERE sm.server_id = s.id)::text AS members,
              a.messages_24h::text AS messages_24h
         FROM active a
         JOIN servers s ON s.id = a.server_id
        ORDER BY a.messages_24h DESC, s.name`,
    ),
    () => acquisitionReport(7),
    () => retentionBySource(30),
    () => activationFunnel(),
    () => callRatingSummary(7),
    () => connectionAdoption(),
    ],
    METRICS_QUERY_CONCURRENCY,
  );

  // One snapshot, used both to look up room names below and to build the
  // payload further down. Calling it twice would let a room open between the
  // two calls and render with no name at all.
  const voice = await getVoiceActivitySnapshot();

  // Live HLS. The flag, the ladder and the running transcodes are all
  // in-process reads; only `uncleaned` costs a query, and it is a COUNT over
  // an index-shaped predicate on a table with one row per rendition per
  // party. A failure here must not take the whole dashboard down: a null
  // would be indistinguishable from zero on the one number that matters, so
  // it falls back to -1, which reads as "could not ask" rather than "clean".
  const hlsFlag = liveHlsConfig();
  const hlsActivity = liveHlsActivity();
  const llActivity = llHlsActivity();
  const hlsUncleaned = await countDueSessions().catch(() => -1);

  // The tab detail, in a second round of parallel queries. It is separate from
  // the block above only for readability; both rounds are inside the same
  // 30-second cache entry, so a dashboard switching tabs never touches the API.
  const [
    channelShape,
    channelsPerServer,
    emptyTextChannels,
    topTextChannels,
    userAdoption,
    active7d,
    signupsByDay,
    returning7d,
    communityTotals,
    communityCategories,
    communityList,
    reportCounts,
    feedbackCounts,
    banCounts,
    recentFeedback,
    voiceRoomNames,
    productCounts,
    statusHistory,
    importCounts,
    joinRefs,
  ] = await runWithConcurrencyLimit(
    [
    () => pool.query<{ private_text: string; dm: string; grp: string }>(
      `SELECT COUNT(*) FILTER (
                WHERE kind = 'server' AND type = 'text' AND is_private
              )::text AS private_text,
              COUNT(*) FILTER (WHERE kind = 'dm')::text AS dm,
              COUNT(*) FILTER (WHERE kind = 'group')::text AS grp
         FROM channels`,
    ),
    () => pool.query<{ servers_with_channels: string; max_channels: string }>(
      `SELECT COUNT(*)::text AS servers_with_channels,
              COALESCE(MAX(n), 0)::text AS max_channels
         FROM (
           SELECT server_id, COUNT(*) AS n
             FROM channels
            WHERE kind = 'server'
            GROUP BY server_id
         ) t`,
    ),
    () => pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM channels c
        WHERE c.kind = 'server' AND c.type = 'text'
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.channel_id = c.id)`,
    ),
    () => pool.query<{ channel: string; server: string; messages_24h: string; senders_24h: string }>(
      `SELECT c.name AS channel,
              s.name AS server,
              COUNT(*)::text AS messages_24h,
              COUNT(DISTINCT m.author_id)::text AS senders_24h
         FROM messages m
         JOIN channels c ON c.id = m.channel_id
         JOIN servers s ON s.id = c.server_id
         JOIN users u ON u.id = m.author_id
        WHERE m.created_at >= now() - interval '24 hours'
          AND c.kind = 'server' AND c.type = 'text'
          AND NOT u.is_webhook AND NOT u.is_character
        GROUP BY c.id, c.name, s.name
        ORDER BY COUNT(*) DESC, c.name
        LIMIT 8`,
    ),
    () => pool.query<{
      with_handle: string;
      with_avatar: string;
      with_banner: string;
      age_checked: string;
      deletion_pending: string;
    }>(
      `SELECT COUNT(*) FILTER (WHERE handle IS NOT NULL)::text AS with_handle,
              COUNT(*) FILTER (
                WHERE avatar_url IS NOT NULL OR avatar_key IS NOT NULL
              )::text AS with_avatar,
              COUNT(*) FILTER (
                WHERE banner_url IS NOT NULL OR banner_key IS NOT NULL
              )::text AS with_banner,
              COUNT(*) FILTER (WHERE age_checked_at IS NOT NULL)::text AS age_checked,
              COUNT(*) FILTER (WHERE deletion_started_at IS NOT NULL)::text AS deletion_pending
         FROM users
        WHERE NOT is_webhook AND NOT is_character`,
    ),
    () => pool.query<{ n: string }>(
      `SELECT COUNT(DISTINCT m.author_id)::text AS n
         FROM messages m
         JOIN users u ON u.id = m.author_id
        WHERE m.created_at >= now() - interval '7 days'
          AND NOT u.is_webhook AND NOT u.is_character`,
    ),
    () => pool.query<{ day: string; n: string }>(
      `SELECT to_char(
                date_trunc('day', created_at AT TIME ZONE 'America/Sao_Paulo'),
                'YYYY-MM-DD'
              ) AS day,
              COUNT(*)::text AS n
         FROM users
        WHERE created_at >= now() - interval '14 days'
          AND NOT is_webhook AND NOT is_character
        GROUP BY 1
        ORDER BY 1`,
    ),
    () => pool.query<{ eligible: string; active: string }>(
      `SELECT COUNT(*)::text AS eligible,
              COUNT(*) FILTER (
                WHERE EXISTS (
                  SELECT 1 FROM messages m
                   WHERE m.author_id = u.id
                     AND m.created_at >= now() - interval '7 days'
                )
              )::text AS active
         FROM users u
        WHERE NOT u.is_webhook AND NOT u.is_character
          AND u.created_at < now() - interval '24 hours'`,
    ),
    () => pool.query<{ total: string; listed: string; suspended: string; with_slug: string }>(
      // `total` counts communities with a PUBLIC ADDRESS; `listed` counts the
      // subset that is also in the directory. The two stopped being the same
      // number when the switches were split, and the operator needs the second
      // one — the directory is the surface with the moderation duty on it.
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (
                WHERE is_community_listed AND NOT is_community_suspended
              )::text AS listed,
              COUNT(*) FILTER (WHERE is_community_suspended)::text AS suspended,
              COUNT(*) FILTER (WHERE community_slug IS NOT NULL)::text AS with_slug
         FROM servers
        WHERE is_community`,
    ),
    () => pool.query<{ category: string; n: string }>(
      `SELECT community_category AS category, COUNT(*)::text AS n
         FROM servers
        WHERE is_community
        GROUP BY 1
        ORDER BY COUNT(*) DESC, 1`,
    ),
    () => pool.query<{
      name: string;
      slug: string | null;
      category: string;
      members: string;
      channels: string;
      messages_24h: string;
      suspended: boolean;
    }>(
      `SELECT s.name,
              s.community_slug AS slug,
              s.community_category AS category,
              s.is_community_suspended AS suspended,
              s.member_count::text AS members,
              (SELECT COUNT(*) FROM channels c
                WHERE c.server_id = s.id AND c.kind = 'server')::text AS channels,
              (SELECT COUNT(*)
                 FROM messages m
                 JOIN channels c2 ON c2.id = m.channel_id
                 JOIN users u2 ON u2.id = m.author_id
                WHERE c2.server_id = s.id
                  AND m.created_at >= now() - interval '24 hours'
                  AND NOT u2.is_webhook AND NOT u2.is_character)::text AS messages_24h
         FROM servers s
        WHERE s.is_community
        ORDER BY s.member_count DESC, s.name
        LIMIT 20`,
    ),
    () => pool.query<{ open: string; actioned: string; dismissed: string; last24h: string }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'open')::text AS open,
              COUNT(*) FILTER (WHERE status = 'actioned')::text AS actioned,
              COUNT(*) FILTER (WHERE status = 'dismissed')::text AS dismissed,
              COUNT(*) FILTER (
                WHERE created_at >= now() - interval '24 hours'
              )::text AS last24h
         FROM reports`,
    ),
    () => pool.query<{ open: string; confirmed: string; closed: string; last24h: string }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'open')::text AS open,
              COUNT(*) FILTER (WHERE status = 'confirmed')::text AS confirmed,
              COUNT(*) FILTER (WHERE status = 'closed')::text AS closed,
              COUNT(*) FILTER (
                WHERE created_at >= now() - interval '24 hours'
              )::text AS last24h
         FROM feedback`,
    ),
    () => pool.query<{ bans: string; timeouts: string }>(
      `SELECT (SELECT COUNT(*) FROM server_bans)::text AS bans,
              (SELECT COUNT(*) FROM member_timeouts
                WHERE expires_at > now())::text AS timeouts`,
    ),
    () => pool.query<{ kind: string; status: string; created_at: Date; body: string }>(
      `SELECT kind, status, created_at, left(body, 160) AS body
         FROM feedback
        ORDER BY id DESC
        LIMIT 8`,
    ),
    // Names for the rooms that have somebody in them right now. The snapshot
    // holds channel ids only; an empty list skips the query entirely rather
    // than sending `IN ()` to Postgres.
    async () => {
      const ids = voice.rooms.map((room) => room.voiceChannelId);
      if (ids.length === 0) {
        return { rows: [] as { id: string; channel: string; server: string | null }[] };
      }
      return pool.query<{ id: string; channel: string; server: string | null }>(
        `SELECT c.id::text AS id, c.name AS channel, s.name AS server
           FROM channels c
           LEFT JOIN servers s ON s.id = c.server_id
          WHERE c.id = ANY($1::uuid[])`,
        [ids],
      );
    },
    () => pool.query<{
      friendships: string;
      friend_pending: string;
      attachments: string;
      attachments_24h: string;
      invites_24h: string;
      invite_uses: string;
      push_web: string;
      push_apns: string;
      push_fcm: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM friendships WHERE status = 'accepted')::text AS friendships,
         (SELECT COUNT(*) FROM friendships WHERE status = 'pending')::text AS friend_pending,
         (SELECT COUNT(*) FROM message_attachments)::text AS attachments,
         (SELECT COUNT(*) FROM message_attachments
           WHERE created_at >= now() - interval '24 hours')::text AS attachments_24h,
         (SELECT COUNT(*) FROM server_invites
           WHERE created_at >= now() - interval '24 hours')::text AS invites_24h,
         (SELECT COALESCE(SUM(uses), 0) FROM server_invites)::text AS invite_uses,
         (SELECT COUNT(*) FROM push_subscriptions WHERE platform = 'web')::text AS push_web,
         (SELECT COUNT(*) FROM push_subscriptions WHERE platform = 'apns')::text AS push_apns,
         (SELECT COUNT(*) FROM push_subscriptions WHERE platform = 'fcm')::text AS push_fcm`,
    ),
    // A history that failed to read must not cost the dashboard its counts:
    // the sparklines vanish, every number stays.
    () => readStatusHistory().catch(() => null),
    () => pool.query<{
      total: string;
      last24h: string;
      last7d: string;
      members_7d: string;
      via_ref_7d: string;
    }>(
      `WITH imported AS (
         SELECT server_id, created_at
           FROM audit_log
          WHERE action = 'server.discord_import'
       ),
       joined AS (
         SELECT sm.join_ref
           FROM server_members sm
           JOIN users u ON u.id = sm.user_id
          WHERE sm.server_id IN (SELECT server_id FROM imported)
            AND sm.role <> 'owner'
            AND sm.joined_at >= now() - interval '7 days'
            AND NOT u.is_webhook AND NOT u.is_character
       )
       SELECT (SELECT COUNT(*) FROM imported)::text AS total,
              (SELECT COUNT(*) FROM imported
                WHERE created_at >= now() - interval '24 hours')::text AS last24h,
              (SELECT COUNT(*) FROM imported
                WHERE created_at >= now() - interval '7 days')::text AS last7d,
              (SELECT COUNT(*) FROM joined)::text AS members_7d,
              (SELECT COUNT(*) FROM joined
                WHERE join_ref = 'discord')::text AS via_ref_7d`,
    ),
    () => pool.query<{ ref: string; n: string }>(
      `SELECT join_ref AS ref, COUNT(*)::text AS n
         FROM server_members
        WHERE join_ref IS NOT NULL
          AND joined_at >= now() - interval '7 days'
        GROUP BY join_ref
        ORDER BY COUNT(*) DESC, join_ref
        LIMIT 10`,
    ),
    ],
    METRICS_QUERY_CONCURRENCY,
  );

  const channelCounts = { text: 0, voice: 0, category: 0, thread: 0 };
  for (const row of channels.rows) {
    if (row.type in channelCounts) {
      channelCounts[row.type as keyof typeof channelCounts] = Number(row.n);
    }
  }

  const m = messages.rows[0];
  const roomNames = new Map(
    voiceRoomNames.rows.map((row) => [row.id, { channel: row.channel, server: row.server }]),
  );

  return {
    generatedAt: new Date().toISOString(),
    cacheTtlSeconds: CACHE_TTL_MS / 1000,
    version: process.env.APP_VERSION?.trim() || null,
    excludedAccounts: EXCLUDED_ACCOUNTS,
    statusHistory,
    users: {
      total: Number(users.rows[0]?.total ?? 0),
      last24h: Number(users.rows[0]?.last24h ?? 0),
      byHour: toHourly(usersByHour.rows),
    },
    servers: {
      total: Number(servers.rows[0]?.total ?? 0),
      last24h: Number(servers.rows[0]?.last24h ?? 0),
    },
    messages: {
      last24h: Number(m?.last24h ?? 0),
      previous24h: Number(m?.previous24h ?? 0),
      lastHour: Number(m?.last_hour ?? 0),
      automated24h: Number(m?.automated24h ?? 0),
      byHour: toHourly(messagesByHour.rows),
      byScope24h: {
        dm: Number(m?.dm_24h ?? 0),
        group: Number(m?.group_24h ?? 0),
        server: Number(m?.server_24h ?? 0),
      },
    },
    distinctSenders24h: Number(m?.senders ?? 0),
    activeTextChannels24h: Number(m?.active_text_channels ?? 0),
    channels: channelCounts,
    calls: callMetricsSnapshot(),
    streamQuality: streamQualityMetricsSnapshot(),
    dbTx: { byPath: dbTxByPath() },
    dbQueries: { total: dbQueryTotal(), byRoute: dbQueriesByRoute() },
    readCache: readCacheMetrics(),
    presence: getPresenceFanoutStats(),
    voice: {
      activeRooms: voice.activeRooms,
      participants: voice.participants,
      largestRoomNow: voice.largestRoomNow,
      peakRoomSizeToday: voice.peakRoomSizeToday,
      peakTrackedSince: voice.peakTrackedSince,
      backend: voice.backend,
      cluster: voice.cluster,
      registry: voice.registry,
      seats: voice.seats,
      roster: voice.roster,
      rooms: voice.rooms.map((room) => {
        const named = roomNames.get(room.voiceChannelId);
        return {
          channel: named?.channel ?? null,
          server: named?.server ?? null,
          participants: room.participants,
          sharingScreen: room.sharingScreen,
          transport: room.transport,
          openedAt: room.openedAt,
        };
      }),
    },
    watchParty: {
      ...watchPartySweepCounters(),
      draftTtlMinutes: watchPartyDraftTtlMinutes(),
      hostGoneMinutes: watchPartyHostGoneMinutes(),
    },
    liveHls: {
      enabled: hlsFlag.enabled,
      configured: isLiveHlsEnabled(),
      allowlisted: hlsFlag.allowlisted,
      stateFrames: watchPartyStateFrameCounters(),
      ladder: hlsFlag.ladder.map((rung) => rung.name),
      sessions: hlsActivity.sessions,
      maxSessions: hlsActivity.maxSessions,
      rungs: hlsActivity.rungs,
      oldestSessionMinutes: hlsActivity.oldestMinutes,
      silentSessions: hlsActivity.silentSessions,
      orphansStopped: hlsActivity.orphansStopped,
      // Zero on one machine. On two it is the proof that the cross-machine
      // owner guard runs at all: rows this process left alone because the
      // other one is still driving them.
      skippedOwnedElsewhere: hlsActivity.skippedOwnedElsewhere,
      deferredStops: hlsActivity.deferredStops,
      micArchive: hlsActivity.micArchives,
      // Each of these is a second, video-only 360p30 transcode of a
      // presenter's camera, on top of that party's ladder: roughly 0.2 to 0.3
      // of a core apiece. What turns "the box feels slow" into "three hosts
      // have their webcams on". Zero with `LIVE_HLS_CAMERA=false`.
      cameraSessions: hlsActivity.cameraSessions,
      uncleaned: hlsUncleaned,
      sweepsHere: runsColdJobs(processRole()),
      keepWarmLoops: hlsKeepWarmLoopsActive(),
      keepWarmRenders: hlsKeepWarmRenders(),
      latency: hlsTelemetryActivity(),
      llSessions: llActivity.sessions,
      llStartFailures: llActivity.startFailures,
      llStopFailures: llActivity.stopFailures,
      llDemoted: llActivity.demoted,
      startsTotal: hlsActivity.startsTotal,
      stopsTotal: hlsActivity.stopsTotal,
      restartsScheduled: hlsActivity.restartsScheduledTotal,
      restartsExhausted: hlsActivity.restartsExhaustedTotal,
      playlistRejectedByReason: hlsPlaylistRejectionsByReason(),
    },
    topServers24h: topServers.rows.map((row) => ({
      name: row.name,
      tagline: row.tagline,
      channels: Number(row.channels),
      members: Number(row.members),
      messages24h: Number(row.messages_24h),
    })),
    acquisition,
    activation,
    retention,
    callRatings,
    // The denominator travels with the numerators rather than leaving the
    // dashboard to pick one: it is the users total in this same payload.
    connections: { ...connections, ofUsers: Number(users.rows[0]?.total ?? 0) },

    channelDetail: {
      privateText: Number(channelShape.rows[0]?.private_text ?? 0),
      conversations: {
        dm: Number(channelShape.rows[0]?.dm ?? 0),
        group: Number(channelShape.rows[0]?.grp ?? 0),
      },
      serversWithChannels: Number(channelsPerServer.rows[0]?.servers_with_channels ?? 0),
      maxChannelsInServer: Number(channelsPerServer.rows[0]?.max_channels ?? 0),
      emptyText: Number(emptyTextChannels.rows[0]?.n ?? 0),
      topText24h: topTextChannels.rows.map((row) => ({
        channel: row.channel,
        server: row.server,
        messages24h: Number(row.messages_24h),
        senders24h: Number(row.senders_24h),
      })),
    },

    userDetail: {
      active7d: Number(active7d.rows[0]?.n ?? 0),
      withHandle: Number(userAdoption.rows[0]?.with_handle ?? 0),
      withAvatar: Number(userAdoption.rows[0]?.with_avatar ?? 0),
      withBanner: Number(userAdoption.rows[0]?.with_banner ?? 0),
      ageChecked: Number(userAdoption.rows[0]?.age_checked ?? 0),
      deletionPending: Number(userAdoption.rows[0]?.deletion_pending ?? 0),
      signupsByDay: signupsByDay.rows.map((row) => ({ day: row.day, n: Number(row.n) })),
      returning7d: {
        eligible: Number(returning7d.rows[0]?.eligible ?? 0),
        active: Number(returning7d.rows[0]?.active ?? 0),
      },
    },

    communities: {
      enabled: isCommunitiesEnabled(),
      total: Number(communityTotals.rows[0]?.total ?? 0),
      listed: Number(communityTotals.rows[0]?.listed ?? 0),
      suspended: Number(communityTotals.rows[0]?.suspended ?? 0),
      withSlug: Number(communityTotals.rows[0]?.with_slug ?? 0),
      byCategory: communityCategories.rows.map((row) => ({
        category: row.category,
        n: Number(row.n),
      })),
      list: communityList.rows.map((row) => ({
        name: row.name,
        slug: row.slug,
        category: row.category,
        members: Number(row.members),
        channels: Number(row.channels),
        messages24h: Number(row.messages_24h),
        suspended: row.suspended,
      })),
    },

    product: {
      friendships: Number(productCounts.rows[0]?.friendships ?? 0),
      pendingFriendRequests: Number(productCounts.rows[0]?.friend_pending ?? 0),
      attachments: {
        total: Number(productCounts.rows[0]?.attachments ?? 0),
        last24h: Number(productCounts.rows[0]?.attachments_24h ?? 0),
      },
      invites: {
        created24h: Number(productCounts.rows[0]?.invites_24h ?? 0),
        uses: Number(productCounts.rows[0]?.invite_uses ?? 0),
        joinsByRef7d: Object.fromEntries(
          joinRefs.rows.map((row) => [row.ref, Number(row.n)]),
        ),
      },
      push: {
        web: Number(productCounts.rows[0]?.push_web ?? 0),
        apns: Number(productCounts.rows[0]?.push_apns ?? 0),
        fcm: Number(productCounts.rows[0]?.push_fcm ?? 0),
      },
      pushDelivery: pushDeliverySnapshot(),
    },

    imports: {
      discord: {
        total: Number(importCounts.rows[0]?.total ?? 0),
        last24h: Number(importCounts.rows[0]?.last24h ?? 0),
        last7d: Number(importCounts.rows[0]?.last7d ?? 0),
        membersJoined7d: Number(importCounts.rows[0]?.members_7d ?? 0),
        joinedViaImportInvite7d: Number(importCounts.rows[0]?.via_ref_7d ?? 0),
      },
    },

    moderation: {
      reports: {
        open: Number(reportCounts.rows[0]?.open ?? 0),
        actioned: Number(reportCounts.rows[0]?.actioned ?? 0),
        dismissed: Number(reportCounts.rows[0]?.dismissed ?? 0),
        last24h: Number(reportCounts.rows[0]?.last24h ?? 0),
      },
      feedback: {
        open: Number(feedbackCounts.rows[0]?.open ?? 0),
        confirmed: Number(feedbackCounts.rows[0]?.confirmed ?? 0),
        closed: Number(feedbackCounts.rows[0]?.closed ?? 0),
        last24h: Number(feedbackCounts.rows[0]?.last24h ?? 0),
      },
      bans: Number(banCounts.rows[0]?.bans ?? 0),
      activeTimeouts: Number(banCounts.rows[0]?.timeouts ?? 0),
      recentFeedback: recentFeedback.rows.map((row) => ({
        kind: row.kind,
        status: row.status,
        createdAt: new Date(row.created_at).toISOString(),
        body: row.body,
      })),
    },
  };
}

// ------------------------------------------------------------------- cache

let cached: { at: number; payload: CachedMetrics } | null = null;
let inFlight: Promise<CachedMetrics> | null = null;

/**
 * The cached counts when they are younger than the TTL, otherwise a fresh set.
 * Concurrent callers during a refresh share the same computation rather than
 * each running the queries.
 */
async function getCachedMetrics(): Promise<CachedMetrics> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.payload;
  }
  if (!inFlight) {
    inFlight = computeAdminMetrics()
      .then((payload) => {
        cached = { at: Date.now(), payload };
        return payload;
      })
      .catch((error: unknown) => {
        // A3.1: the operator needs this dashboard MOST during the outage
        // it is reporting on. `computeAdminMetrics` is ~30 queries against
        // the pool the breaker watches, so an open breaker fails all of them
        // at once — serve the last good snapshot instead of taking the
        // whole endpoint down over it. `getAdminMetrics` layers fresh
        // `runtime` (which carries `db.breaker`), `ready` and `sfu` blocks
        // on top of whatever this returns, live, every request, so the
        // breaker's own state is never itself stale. Only when nothing has
        // ever been cached (a fresh boot with a dead database) does this
        // still propagate — there is no snapshot to fall back to.
        if (cached) {
          return cached.payload;
        }
        throw error;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * The payload: ~32 queries' worth of counts from the 30-second cache, plus a
 * `runtime` block taken **now**, on every single request.
 *
 * WHY THE SPLIT. The cache exists because the counts are expensive — a scan of
 * `messages` per dashboard refresh is a self-inflicted incident, and a signup
 * total that lags by half a minute is still a signup total. Neither half of
 * that reasoning applies to `runtime`. It costs nothing, so caching it saves
 * nothing; and a *stale* saturation reading is worse than no reading at all,
 * because the entire value of `waitingCount` is that it moves during the ten
 * seconds a stampede is actually happening. A dashboard that showed a queue of
 * zero because the queue formed and drained inside the cache window would be
 * confidently wrong at the exact moment it was being consulted.
 *
 * The high-water marks in the block cover the other half of the same problem:
 * a 30-second poll misses a spike even when the reading is live. See
 * lib/runtime.ts.
 *
 * The spread never mutates the cached object, so the cache cannot pick up a
 * `runtime` block and start serving a stale one.
 */
export async function getAdminMetrics(): Promise<AdminMetrics> {
  const [payload, ready, sfu] = await Promise.all([
    getCachedMetrics(),
    checkReady(),
    readSfuStats(),
  ]);
  const runtime = runtimeSnapshot();
  const cluster = await clusterMetrics(runtime);
  return {
    ...payload,
    runtime,
    instanceId: INSTANCE_ID,
    instanceCount: cluster.instances,
    cluster,
    ready,
    sfu,
  };
}

/**
 * The cluster block, with the single-machine case as the fallback rather than
 * as a special case.
 *
 * With `VOICE_REGISTRY` off there are no instance rows at all — a self-host,
 * local dev, and `pqp-api` before the multi-instance work. Reporting zeroes
 * there would be a lie of a different kind, so the answer is this process's
 * own numbers labelled as a cluster of one. A failed read gets the same
 * treatment: a metrics endpoint must never 500 over decoration (the same rule
 * lib/runtime.ts states about its getters).
 */
async function clusterMetrics(runtime: RuntimeMetrics): Promise<ClusterMetrics> {
  const alone = (): ClusterMetrics => ({
    instances: 1,
    reporting: 1,
    maxStalenessSeconds: 0,
    sockets: runtime.sockets,
    compressedSockets: runtime.compressedSockets,
    // The local map, not a zero. A single-instance deployment is a cluster of
    // one, and its voice peers are the cluster's voice peers; hard-coding 0
    // would make the common configuration read as an empty service.
    voiceParticipants: localVoicePeerCount(),
    hlsSessions: liveHlsActivity().sessions,
    poolBusy: runtime.pool.busy,
    poolMax: runtime.pool.max,
    versions: process.env.APP_VERSION?.trim()
      ? [process.env.APP_VERSION.trim()]
      : [],
  });
  try {
    // Rows left behind by a deployment that has since turned the registry off
    // are still inside the TTL for 45 seconds, and summing them would show
    // the operator the previous topology's numbers. The flag, not the rows,
    // says whether this process has siblings.
    if (!clusterTopologyTracked()) {
      return alone();
    }
    const snapshot = await readClusterSnapshot();
    if (snapshot.instances === 0) {
      return alone();
    }
    return {
      instances: snapshot.instances,
      reporting: snapshot.reporting,
      maxStalenessSeconds: snapshot.maxStalenessSeconds,
      sockets: snapshot.sockets,
      compressedSockets: snapshot.compressedSockets,
      voiceParticipants: snapshot.voiceParticipants,
      hlsSessions: snapshot.hlsSessions,
      poolBusy: snapshot.poolBusy,
      poolMax: snapshot.poolMax,
      versions: snapshot.versions,
    };
  } catch {
    return alone();
  }
}

/** Test hook: forget the cached payload. */
export function resetAdminMetricsCache(): void {
  cached = null;
}
