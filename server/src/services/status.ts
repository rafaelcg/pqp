import { getPool } from "../db.js";
import { isStorageConfigured, headObject } from "../lib/s3.js";
import { isGifSearchConfigured } from "./gifs.js";
import { getServerVoiceBackend, isLiveKitConfigured } from "../voice/backends.js";

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
  /** Round-trip of this probe, absent when the component is not probed. */
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
   * `null` means "not configured", which is reported as `disabled` and is
   * explicitly not a failure — an instance with no object storage is healthy,
   * it simply has attachments turned off.
   */
  run: () => Promise<{ ok: boolean; latencyMs: number } | null>;
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
    run: async () => ({ ok: true, latencyMs: 0 }),
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
      // which rides the same process as the API.
      if (getServerVoiceBackend() !== "livekit") {
        return { ok: true, latencyMs: 0 };
      }
      // Config presence only. Reaching out to the SFU on every probe would put
      // a third-party network call on a public, unauthenticated endpoint.
      return { ok: isLiveKitConfigured(), latencyMs: 0 };
    },
  },
  {
    key: "gifs",
    label: "GIF search",
    run: async () => (isGifSearchConfigured() ? { ok: true, latencyMs: 0 } : null),
  },
];

/** Run every probe once. Used by the sampler and by the live endpoint alike. */
export async function probeComponents(): Promise<
  { key: string; label: string; ok: boolean | null; latencyMs?: number }[]
> {
  return Promise.all(
    PROBES.map(async (probe) => {
      const result = await probe.run().catch(() => ({
        ok: false,
        latencyMs: 0,
      }));
      if (result === null) {
        return { key: probe.key, label: probe.label, ok: null };
      }
      return {
        key: probe.key,
        label: probe.label,
        ok: result.ok,
        latencyMs: result.latencyMs,
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
  const results = await probeComponents();
  const measured = results.filter(
    (r): r is { key: string; label: string; ok: boolean; latencyMs?: number } =>
      r.ok !== null,
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
        result.ok === null ? "disabled" : result.ok ? "operational" : "down",
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
