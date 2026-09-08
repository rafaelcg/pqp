import { getPool } from "../db.js";
import { isStorageConfigured, headObject } from "../lib/s3.js";
import { isGifSearchConfigured, trendingGifs } from "./gifs.js";
import { getServerVoiceBackend, isLiveKitConfigured } from "../voice/backends.js";
import { peekSfuStats, readSfuStats } from "../voice/sfu-stats.js";

/**
 * The public status page.
 *
 * THIS IS THE ONLY DATA THE APP SERVES WITHOUT AUTHENTICATION, so everything
 * here is written to the standard of "a stranger is reading it". A status page
 * is a reconnaissance surface as much as an operational one: it must say
 * whether a dependency is healthy without saying what or where that dependency
 * is. No hostnames, no bucket names, no provider names, no error strings, no
 * counts of users or servers — only a component label, a state, and a latency.
 */

export type ComponentState = "operational" | "degraded" | "down" | "disabled";

export interface ComponentStatus {
  /** Stable machine key, also used as the samples row's `component`. */
  key: string;
  label: string;
  state: ComponentState;
  /**
   * Round-trip of this probe, **absent when the component is not probed**.
   *
   * Absent is not zero. A component whose health is inferred rather than
   * measured (the API cannot time itself; mesh voice has no server-side media
   * to time) omits the field entirely, because a `0` here renders as "0 ms"
   * and reads as an impossibly fast probe rather than as no probe at all.
   * Every consumer must therefore treat a missing field as "not measured" and
   * say so in words.
   */
  latencyMs?: number;
  /** Fraction of successful samples in the window, null when never sampled. */
  uptime24h: number | null;
  uptime7d: number | null;
}

export interface StatusSummary {
  state: ComponentState;
  components: ComponentStatus[];
  checkedAt: string;
}

interface Probe {
  key: string;
  label: string;
  /**
   * Three outcomes, deliberately distinct:
   *
   *  - `null` — **not configured**, reported as `disabled`. Explicitly not a
   *    failure: an instance with no object storage is healthy, it simply has
   *    attachments turned off.
   *  - `{ ok: true | false }` — a verdict. Up or down.
   *  - `{ ok: "unknown" }` — **asked, no answer in the time allowed**,
   *    reported as `degraded`. Not up, and not claimed to be down either. It
   *    is never written to `status_samples`, so an unknown minute neither
   *    inflates nor deflates uptime.
   *
   * A result with no `latencyMs` means "nothing was timed". See the field's
   * comment on `ComponentStatus`: absent is not zero.
   */
  run: () => Promise<{ ok: boolean | "unknown"; latencyMs?: number } | null>;
}

async function timed(
  fn: () => Promise<unknown>,
): Promise<{ ok: boolean; latencyMs: number }> {
  const started = Date.now();
  try {
    await fn();
    return { ok: true, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: Date.now() - started };
  }
}

/**
 * A key that cannot exist, so the probe measures "can we reach the bucket and
 * get an authorised answer" without depending on any particular object being
 * there. `headObject` returns null for a missing key and throws only when the
 * request itself failed, which is exactly the distinction wanted.
 */
const STORAGE_PROBE_KEY = "__status_probe__/does-not-exist";

const PROBES: Probe[] = [
  {
    key: "api",
    label: "API",
    // Reached only by serving this request, so it is operational by
    // construction. Listed anyway: a status page that omits the thing the
    // reader is currently talking to reads as an oversight.
    //
    // No latency, deliberately. A process cannot time its own round trip:
    // any number here would be the cost of this function, not of the request
    // the reader made, and the one thing that would make it meaningful (the
    // network between them) is the part that is not measurable from inside.
    run: async () => ({ ok: true }),
  },
  {
    key: "database",
    label: "Database",
    run: () => timed(() => getPool().query("SELECT 1")),
  },
  {
    key: "storage",
    label: "File attachments",
    run: async () =>
      isStorageConfigured() ? timed(() => headObject(STORAGE_PROBE_KEY)) : null,
  },
  {
    key: "voice",
    label: "Voice",
    run: async () => {
      // Mesh voice has no server-side dependency to probe — media is
      // peer-to-peer, so the only thing that could be down is signalling,
      // which rides the same process as the API. Nothing to time.
      if (getServerVoiceBackend() !== "livekit") {
        return { ok: true };
      }
      if (!isLiveKitConfigured()) {
        return { ok: false };
      }
      // The SFU's *last* answer, never a new one. `/status.json` is public
      // and unauthenticated, so it must not be able to make this process call
      // a third party nor wait on one; `refreshSlowProbes` below pays that
      // cost once a minute from the sampler, where it belongs. A reading
      // older than the window is treated as no reading rather than as a
      // verdict, so a stopped sampler cannot leave a stale green here.
      const last = peekSfuStats();
      if (!last || last.ageMs > SFU_READING_MAX_AGE_MS || !last.stats.configured) {
        return { ok: true };
      }
      if (last.stats.reachable !== true) {
        return { ok: false };
      }
      return {
        ok: true,
        ...(last.stats.ms === null ? {} : { latencyMs: last.stats.ms }),
      };
    },
  },
  {
    key: "gifs",
    label: "GIF search",
    run: async () => {
      if (!isGifSearchConfigured()) {
        return null;
      }
      // Same rule as voice: the reading is taken on a schedule, not on the
      // read. Until the first one lands, the key being present is all this
      // knows, and it says so by reporting no latency.
      if (!gifReading || Date.now() - gifReading.at > GIF_READING_MAX_AGE_MS) {
        return { ok: true };
      }
      // A probe that ran out of time is `unknown`, never `operational`. We
      // asked and got nothing back; saying "up" would be inventing the half
      // of the answer that never arrived.
      if (gifReading.ok === "unknown") {
        return { ok: "unknown" };
      }
      return {
        ok: gifReading.ok,
        ...(gifReading.latencyMs === undefined ? {} : { latencyMs: gifReading.latencyMs }),
      };
    },
  },
];

/**
 * How long a reading taken elsewhere is still worth reporting.
 *
 * Both are several times their refresh interval, so an ordinary missed tick
 * does not blank the field; both are finite, so a sampler that has actually
 * stopped degrades to "not measured" instead of to a number from an hour ago.
 */
const SFU_READING_MAX_AGE_MS = 5 * 60_000;
const GIF_READING_MAX_AGE_MS = 45 * 60_000;

/**
 * How often the GIF provider is actually asked.
 *
 * Fifteen minutes while it is answering; **one sampler tick** after a probe
 * that failed or timed out, so a recovery is confirmed in a minute rather
 * than a quarter of an hour, and so a single bad probe cannot hold the
 * component in a bad state for long enough for anybody to be paged over it.
 */
const GIF_PROBE_INTERVAL_MS = 15 * 60_000;
const GIF_RETRY_INTERVAL_MS = 60_000;

/**
 * The hard ceiling on one GIF probe.
 *
 * `gifs.ts` already puts an `AbortSignal.timeout(5s)` on its own `fetch`, so
 * in practice that one fires first and this never does — which is the point:
 * this is the guard for everything the inner timeout does not cover. The
 * sampler `await`s this call, and a promise that neither resolves nor rejects
 * would stop `recordStatusSamples` before it ever reached the write. Uptime,
 * the history and every status sample would silently stop moving while the
 * dashboard kept showing the last good numbers, which is the worst shape a
 * monitoring failure can take. Eight seconds is comfortably above the inner
 * five and comfortably below the sampler's sixty, so the two never race and
 * a skipped tick is impossible.
 */
const GIF_PROBE_TIMEOUT_MS = 8_000;

/**
 * `ok: "unknown"` means the probe ran out of time. Distinct from `false`,
 * which means the provider answered and the answer was a refusal.
 */
let gifReading: { ok: boolean | "unknown"; latencyMs?: number; at: number } | null =
  null;
let gifProbeStartedAt = 0;
/**
 * The probe in flight, if any. Without it a slow provider gets a fresh probe
 * every sampler tick and the sockets pile up for as long as the incident
 * lasts; with it, a tick that finds one running simply skips.
 */
let gifProbeInFlight: Promise<void> | null = null;

/**
 * One GIF probe, bounded.
 *
 * The loser of the race is abandoned rather than awaited, and its rejection
 * is swallowed, so a provider that answers at the ninth second cannot surface
 * as an unhandled rejection long after the sampler moved on. The socket
 * itself is closed by the `AbortSignal` inside `gifs.ts`, not left dangling.
 */
async function probeGifs(): Promise<void> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), GIF_PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
  const attempt: Promise<"ok" | "error"> = Promise.resolve()
    .then(() => trendingGifs(1))
    .then(
      () => "ok" as const,
      () => "error" as const,
    );
  let outcome: "ok" | "error" | "timeout";
  try {
    outcome = await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
  const at = Date.now();
  gifReading =
    outcome === "timeout"
      ? { ok: "unknown", at }
      : { ok: outcome === "ok", latencyMs: at - started, at };
}

/**
 * The probes that cost somebody else something.
 *
 * Called from the sampler, once a minute, and never from serving
 * `/status.json`. Two components are measured here rather than inline:
 *
 *  - **The SFU.** `readSfuStats` has its own 10-second cache and shares an
 *    in-flight probe, so this is one `listRooms` a minute against our own box
 *    in our own region. It is what turns "LiveKit is configured" into "the
 *    media server answered", which is the difference between a green tile and
 *    a true one the night the box stops answering.
 *  - **GIF search.** A real search against the provider every
 *    `GIF_PROBE_INTERVAL_MS`, which is the only thing that can see a revoked
 *    key or a 5xx upstream; a configuration check cannot. Ninety-six requests
 *    a day is a rounding error against the quota and it is a fixed cost, not
 *    one that scales with how many people load the status page.
 *
 * Failures are swallowed on purpose: this refreshes readings, and a reading
 * that could not be taken simply is not taken.
 */
export async function refreshSlowProbes(): Promise<void> {
  const started = Date.now();
  const sfu = readSfuStats().catch(() => undefined);

  const due =
    gifReading === null || gifReading.ok === true
      ? GIF_PROBE_INTERVAL_MS
      : GIF_RETRY_INTERVAL_MS;
  if (
    isGifSearchConfigured() &&
    // A probe already running is never joined and never duplicated: this tick
    // has nothing to add and the sampler must not wait on it.
    gifProbeInFlight === null &&
    started - gifProbeStartedAt >= due
  ) {
    gifProbeStartedAt = started;
    gifProbeInFlight = probeGifs().finally(() => {
      gifProbeInFlight = null;
    });
  }

  // Only the SFU read is awaited. The GIF probe is bounded, but it is also
  // simply not this tick's business: the sample must be written on time
  // whatever the provider is doing, and the reading lands for the next tick.
  await sfu;
}

/**
 * Test hook: wait for the probe `refreshSlowProbes` deliberately does not
 * wait for. Production never calls this — the whole point of the fire-and-
 * forget above is that nothing on the sampler's path joins it.
 */
export function settleSlowProbes(): Promise<void> {
  return gifProbeInFlight ?? Promise.resolve();
}

/** Test hook: forget the scheduled readings. */
export function resetSlowProbes(): void {
  gifReading = null;
  gifProbeStartedAt = 0;
  gifProbeInFlight = null;
}

/** Run every probe once. Used by the sampler and by the live endpoint alike. */
export async function probeComponents(): Promise<
  { key: string; label: string; ok: boolean | null | "unknown"; latencyMs?: number }[]
> {
  return Promise.all(
    PROBES.map(async (probe) => {
      // A probe that threw outside its own timing measured nothing, so it
      // reports no latency rather than a zero.
      const result: { ok: boolean | "unknown"; latencyMs?: number } | null =
        await probe.run().catch(() => ({ ok: false }));
      if (result === null) {
        return { key: probe.key, label: probe.label, ok: null };
      }
      return {
        key: probe.key,
        label: probe.label,
        ok: result.ok,
        ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
      };
    }),
  );
}

/**
 * Probe and persist. Disabled components are not written: a row per minute
 * saying "attachments are still turned off" is noise, and its absence is what
 * lets uptime be computed over only the windows a component was actually meant
 * to be running.
 */
export async function recordStatusSamples(): Promise<void> {
  // Refresh the readings that cost an upstream something *before* probing,
  // so this tick's sample carries this tick's SFU answer rather than the
  // previous minute's. A failure here is not a failure of the sample.
  await refreshSlowProbes().catch(() => undefined);
  const results = await probeComponents();
  // Only a real verdict is written. `null` is "turned off" and `"unknown"` is
  // "we asked and got nothing"; recording either would let a component that
  // was never running, or never answered, move an uptime figure.
  const measured = results.filter(
    (r): r is { key: string; label: string; ok: boolean; latencyMs?: number } =>
      typeof r.ok === "boolean",
  );
  if (measured.length === 0) {
    return;
  }
  await getPool().query(
    `INSERT INTO status_samples (component, ok, latency_ms)
     SELECT * FROM UNNEST($1::text[], $2::boolean[], $3::int[])`,
    [
      measured.map((r) => r.key),
      measured.map((r) => r.ok),
      measured.map((r) => r.latencyMs ?? null),
    ],
  );
}

/** Samples older than this are dropped — the page never looks back further. */
const SAMPLE_RETENTION_DAYS = 30;

export async function pruneStatusSamples(): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM status_samples
     WHERE checked_at < NOW() - ($1 || ' days')::interval`,
    [SAMPLE_RETENTION_DAYS],
  );
  return result.rowCount ?? 0;
}

interface UptimeRow {
  component: string;
  uptime_24h: string | null;
  uptime_7d: string | null;
}

async function readUptime(): Promise<Map<string, { d1: number | null; d7: number | null }>> {
  const result = await getPool().query<UptimeRow>(
    `SELECT component,
            AVG(CASE WHEN checked_at > NOW() - INTERVAL '24 hours'
                     THEN (ok)::int END)::text AS uptime_24h,
            AVG((ok)::int)::text AS uptime_7d
     FROM status_samples
     WHERE checked_at > NOW() - INTERVAL '7 days'
     GROUP BY component`,
  );
  const byComponent = new Map<string, { d1: number | null; d7: number | null }>();
  for (const row of result.rows) {
    byComponent.set(row.component, {
      // AVG comes back as a numeric, which pg hands over as a string to avoid
      // precision loss — the same reason BIGINT columns arrive as strings.
      d1: row.uptime_24h === null ? null : Number(row.uptime_24h),
      d7: row.uptime_7d === null ? null : Number(row.uptime_7d),
    });
  }
  return byComponent;
}

function worst(states: ComponentState[]): ComponentState {
  if (states.includes("down")) {
    return "down";
  }
  if (states.includes("degraded")) {
    return "degraded";
  }
  return "operational";
}

export async function getStatusSummary(): Promise<StatusSummary> {
  const [results, uptime] = await Promise.all([
    probeComponents(),
    // Uptime is a nicety; a status page that 500s because its own history
    // query failed is worse than one that reports only the live state.
    readUptime().catch(() => new Map<string, { d1: number | null; d7: number | null }>()),
  ]);

  const components: ComponentStatus[] = results.map((result) => {
    const history = uptime.get(result.key);
    return {
      key: result.key,
      label: result.label,
      state:
        result.ok === null
          ? "disabled"
          : result.ok === "unknown"
            ? "degraded"
            : result.ok
              ? "operational"
              : "down",
      ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
      uptime24h: history?.d1 ?? null,
      uptime7d: history?.d7 ?? null,
    };
  });

  return {
    // A disabled component must not drag the headline down — it is off on
    // purpose, not broken.
    state: worst(
      components.filter((c) => c.state !== "disabled").map((c) => c.state),
    ),
    components,
    checkedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * History
 *
 * `status_samples` already holds one row per component per minute for 30
 * days, and until now nothing read the `latency_ms` column back: the status
 * page showed the instant value and an uptime percentage, so a component
 * whose latency had been climbing all afternoon looked exactly like one that
 * had been flat. The shape over time is the interesting part; the current
 * value on its own is not.
 *
 * This is read by the **operator dashboard**, through `/api/admin/metrics`
 * and its machine token. It stays off `/status.json`, which is public: a
 * latency curve is a load curve, and the public page is deliberately allowed
 * to say only "up" and "how often".
 * ------------------------------------------------------------------ */

export const HISTORY_WINDOW_HOURS = 24;
export const HISTORY_BUCKET_MINUTES = 30;

export interface StatusHistoryPoint {
  /** Mean round trip in the bucket; null when nothing in it was timed. */
  ms: number | null;
  /** Failed probes in the bucket. Non-zero is a dip worth drawing. */
  fails: number;
  /** Probes in the bucket at all; 0 means the sampler was not running. */
  samples: number;
}

export interface StatusHistoryComponent {
  key: string;
  /** Oldest first, one per `bucketMinutes`, gaps filled with empty buckets. */
  points: StatusHistoryPoint[];
  /**
   * What this component's latency normally is, over the same window.
   *
   * The point of the pair: 235 ms means nothing next to a database at 2 ms,
   * and everything next to its own p50 of 230 ms (fine) or of 40 ms (not).
   * Null when the component was never timed.
   */
  p50: number | null;
  p95: number | null;
}

export interface StatusHistory {
  windowHours: number;
  bucketMinutes: number;
  components: StatusHistoryComponent[];
}

interface BucketRow {
  component: string;
  bucket: number;
  ms: string | null;
  fails: string;
  samples: string;
}

interface SpreadRow {
  component: string;
  p50: string | null;
  p95: string | null;
}

/**
 * Latency and failures per bucket over the window, plus each component's own
 * p50 and p95.
 *
 * `date_bin` would be tidier and is PostgreSQL 14+; the arithmetic below is
 * the same thing on any version a self-host might be running. Both queries
 * ride the `(component, checked_at DESC)` index and read at most one day of
 * rows, which is ~1440 per component.
 */
export async function readStatusHistory(): Promise<StatusHistory> {
  const bucketSeconds = HISTORY_BUCKET_MINUTES * 60;
  const buckets = (HISTORY_WINDOW_HOURS * 60) / HISTORY_BUCKET_MINUTES;
  const pool = getPool();
  const [bucketed, spread] = await Promise.all([
    pool.query<BucketRow>(
      `SELECT component,
              FLOOR(EXTRACT(EPOCH FROM (NOW() - checked_at)) / $1)::int AS bucket,
              ROUND(AVG(latency_ms))::text AS ms,
              COUNT(*) FILTER (WHERE NOT ok)::text AS fails,
              COUNT(*)::text AS samples
         FROM status_samples
        WHERE checked_at > NOW() - ($2 || ' hours')::interval
        GROUP BY 1, 2`,
      [bucketSeconds, HISTORY_WINDOW_HOURS],
    ),
    pool.query<SpreadRow>(
      `SELECT component,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms)::int::text AS p50,
              PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)::int::text AS p95
         FROM status_samples
        WHERE checked_at > NOW() - ($1 || ' hours')::interval
          AND latency_ms IS NOT NULL
        GROUP BY 1`,
      [HISTORY_WINDOW_HOURS],
    ),
  ]);

  const byComponent = new Map<string, StatusHistoryComponent>();
  const componentOf = (key: string): StatusHistoryComponent => {
    let entry = byComponent.get(key);
    if (!entry) {
      entry = {
        key,
        // Pre-filled so a gap in the samples is drawn as a gap rather than
        // silently closed up into a shorter, smoother line.
        points: Array.from({ length: buckets }, () => ({
          ms: null,
          fails: 0,
          samples: 0,
        })),
        p50: null,
        p95: null,
      };
      byComponent.set(key, entry);
    }
    return entry;
  };

  for (const row of bucketed.rows) {
    // `bucket` counts backwards from now; the series reads oldest first.
    const index = buckets - 1 - row.bucket;
    if (index < 0 || index >= buckets) {
      continue;
    }
    const point = componentOf(row.component).points[index];
    if (!point) {
      continue;
    }
    point.ms = row.ms === null ? null : Number(row.ms);
    point.fails = Number(row.fails);
    point.samples = Number(row.samples);
  }
  for (const row of spread.rows) {
    const entry = componentOf(row.component);
    entry.p50 = row.p50 === null ? null : Number(row.p50);
    entry.p95 = row.p95 === null ? null : Number(row.p95);
  }

  return {
    windowHours: HISTORY_WINDOW_HOURS,
    bucketMinutes: HISTORY_BUCKET_MINUTES,
    components: [...byComponent.values()],
  };
}
