import { isLiveKitConfigured } from "./backends.js";

/**
 * What the SFU is doing right now, for the operator dashboard.
 *
 * WHY. On 2026-09-05 production voice moved from LiveKit Cloud to a
 * self-hosted LiveKit (`wss://sfu.pqp.gg`, a Vultr box in São Paulo). The
 * process already knows which SFU it hands out tokens for and already holds a
 * `RoomServiceClient` for eviction, so the dashboard can say three things a
 * rollback or an outage would otherwise hide: **which host** the API is
 * configured with (a rollback to LiveKit Cloud is a one-line secret change
 * and invisible from the app), **whether it answers**, and **how many rooms
 * and people it holds** according to the SFU itself, which is the number to
 * compare against the API's own peer map when the two drift.
 *
 * WHAT IS NOT HERE. The API key and secret, ever. The room names, which are
 * channel ids. Error strings. This block only rides on `/api/admin/metrics`,
 * behind the machine token; `/ready` gets the hostname alone.
 *
 * COST. One `listRooms` per `SFU_STATS_CACHE_TTL_MS` (10 s), concurrent
 * callers share the in-flight probe, and a probe is abandoned after
 * `SFU_STATS_TIMEOUT_MS`. The dashboard polls every 30 s, so an eager reader
 * cannot make this process hammer the SFU: the ceiling is six calls a minute
 * whatever the request rate.
 */

export const SFU_STATS_CACHE_TTL_MS = 10_000;
export const SFU_STATS_TIMEOUT_MS = 3_000;

export interface SfuStats {
  /** LiveKit URL, key and secret are all set on this process. */
  configured: boolean;
  /** Hostname only (`sfu.pqp.gg`), never the scheme, port, path or key. */
  host: string | null;
  /**
   * The probe's verdict. `null` while not configured. `true` means
   * `listRooms` answered inside the timeout; the counts below are then real.
   */
  reachable: boolean | null;
  /** Round-trip of the probe in ms; `null` when not configured. */
  ms: number | null;
  /** Why `reachable` is false; `null` otherwise. Never an error string. */
  failure: "timeout" | "error" | null;
  /** Rooms the SFU holds, as the SFU counts them. `null` unless reachable. */
  rooms: number | null;
  /** Sum of `numParticipants` over those rooms. `null` unless reachable. */
  participants: number | null;
  /** Participants in the fullest room. `null` unless reachable, 0 when empty. */
  largestRoom: number | null;
  /** ISO time the numbers were read; the cache entry's age starts here. */
  checkedAt: string | null;
  /** How long the numbers above are served before the SFU is asked again. */
  cacheTtlSeconds: number;
}

/** The subset of a LiveKit `Room` this module reads. */
export interface SfuRoomLike {
  numParticipants: number;
}

export interface SfuStatsReaderOptions {
  /** Null when LiveKit is not configured. */
  host: () => string | null;
  /** Rejects when the SFU cannot be reached; hangs when it is silent. */
  listRooms: () => Promise<readonly SfuRoomLike[]>;
  now?: () => number;
  cacheTtlMs?: number;
  timeoutMs?: number;
}

/** The last reading this process took, and how long ago it took it. */
export interface SfuStatsPeek {
  stats: SfuStats;
  ageMs: number;
}

export interface SfuStatsReader {
  read(): Promise<SfuStats>;
  /**
   * The last reading, without ever taking a new one. `null` when this process
   * has never probed, or when the host changed under it and the reading
   * belongs to the SFU we are no longer pointed at.
   *
   * WHY. `/status.json` is public and unauthenticated. It must not be able to
   * make this process call a third party, and it must not be able to wait on
   * one, so the status page reads what the last probe found instead of asking
   * for a fresh one. The caller decides how old is too old.
   */
  peek(): SfuStatsPeek | null;
  /** Test hook: forget the cache. */
  reset(): void;
}

/**
 * `wss://sfu.pqp.gg:443/x` and `sfu.pqp.gg` both give `sfu.pqp.gg`. A value
 * that cannot be parsed gives null rather than leaking whatever it was.
 */
export function sfuHostFromUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `wss://${value}`;
  try {
    const host = new URL(candidate).hostname;
    return host ? host.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The SFU host this process is configured with, from `LIVEKIT_URL`. */
export function sfuHost(): string | null {
  return isLiveKitConfigured() ? sfuHostFromUrl(process.env.LIVEKIT_URL) : null;
}

function notConfigured(cacheTtlMs: number): SfuStats {
  return {
    configured: false,
    host: null,
    reachable: null,
    ms: null,
    failure: null,
    rooms: null,
    participants: null,
    largestRoom: null,
    checkedAt: null,
    cacheTtlSeconds: cacheTtlMs / 1000,
  };
}

/**
 * Injectable so the cache, the timeout and the arithmetic can be tested on a
 * fake clock against a fake SFU.
 */
export function createSfuStatsReader(options: SfuStatsReaderOptions): SfuStatsReader {
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? SFU_STATS_CACHE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? SFU_STATS_TIMEOUT_MS;

  let cached: { at: number; host: string; stats: SfuStats } | null = null;
  let inFlight: Promise<SfuStats> | null = null;

  async function probe(host: string): Promise<SfuStats> {
    const started = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      timer.unref?.();
    });
    // The loser of the race is abandoned and its rejection swallowed, so a
    // slow SFU never surfaces as an unhandled rejection after the response.
    const attempt: Promise<readonly SfuRoomLike[] | "error"> = Promise.resolve()
      .then(options.listRooms)
      .catch(() => "error" as const);
    let outcome: readonly SfuRoomLike[] | "error" | "timeout";
    try {
      outcome = await Promise.race([attempt, timeout]);
    } finally {
      clearTimeout(timer);
    }
    const ms = now() - started;
    const checkedAt = new Date(now()).toISOString();
    const base = {
      configured: true,
      host,
      ms,
      checkedAt,
      cacheTtlSeconds: cacheTtlMs / 1000,
    };
    if (outcome === "timeout" || outcome === "error") {
      return {
        ...base,
        reachable: false,
        failure: outcome,
        rooms: null,
        participants: null,
        largestRoom: null,
      };
    }
    let participants = 0;
    let largestRoom = 0;
    for (const room of outcome) {
      const n = Math.max(0, Number(room.numParticipants) || 0);
      participants += n;
      largestRoom = Math.max(largestRoom, n);
    }
    return {
      ...base,
      reachable: true,
      failure: null,
      rooms: outcome.length,
      participants,
      largestRoom,
    };
  }

  return {
    async read(): Promise<SfuStats> {
      const host = options.host();
      if (!host) {
        cached = null;
        return notConfigured(cacheTtlMs);
      }
      const at = now();
      // A host change mid-run (a rollback) must not serve the old host's
      // numbers under the new name for up to ten seconds.
      if (cached && cached.host === host && at - cached.at < cacheTtlMs) {
        return cached.stats;
      }
      if (inFlight) {
        return inFlight;
      }
      inFlight = probe(host)
        .then((stats) => {
          cached = { at: now(), host, stats };
          return stats;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    peek(): SfuStatsPeek | null {
      if (!cached) {
        return null;
      }
      // A rollback changes the host mid-run; the old host's numbers must not
      // be served under the new one's name, at any age.
      if (cached.host !== options.host()) {
        return null;
      }
      return { stats: cached.stats, ageMs: Math.max(0, now() - cached.at) };
    },
    reset(): void {
      cached = null;
      inFlight = null;
    },
  };
}

/**
 * The process-wide reader. Env is read per call (`sfuHost`), so a test that
 * sets LiveKit mid-run and a deploy that gains it both work without a
 * restart of anything here.
 */
const reader = createSfuStatsReader({
  host: sfuHost,
  // Imported at call time, not at module load. `admin.js` reaches for the
  // LiveKit SDK and a `RoomServiceClient`, and this module is now on the
  // voice-room path (the promotion guard in `ws/voice.ts` asks whether the
  // SFU is answering before it moves a call onto it), so a static import
  // would drag that whole graph into every process and every test that only
  // wants the peer bookkeeping. A probe is at most six a minute; one dynamic
  // import, cached by the loader after the first, is not the cost here.
  listRooms: async () => (await import("./admin.js")).listSfuRooms(),
});

export function readSfuStats(): Promise<SfuStats> {
  return reader.read();
}

/** The last reading, never a new one. See `SfuStatsReader.peek`. */
export function peekSfuStats(): SfuStatsPeek | null {
  return reader.peek();
}

/** Test hook. */
export function resetSfuStats(): void {
  reader.reset();
}
