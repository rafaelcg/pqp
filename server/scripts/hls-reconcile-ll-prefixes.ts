/**
 * Repoint `mode = 'll'` rows at the prefix pqp-remux actually wrote.
 *
 * Every LL session before 2026-09-22 was recorded under the box's own clock,
 * a few milliseconds off the row's `started_at`, so its row names an empty
 * prefix: retention cleans nothing, `keep_replay` protects nothing, and the
 * past-broadcasts dialog cannot find the show. This lists `live/<channel>/`
 * in the `LIVE_HLS_S3_*` bucket for a `<startedAt>-ll` directory within
 * `--window-ms` of each row's `started_at`, and rewrites `object_prefix` to
 * it, with `keep_replay = TRUE` (see `hls-ll-prefix-reconcile.ts` for why the
 * two go together).
 *
 * DRY RUN BY DEFAULT. Nothing is written without `--apply`, and the dry run
 * prints exactly what `--apply` would do. The bucket is only ever listed and
 * read, never written.
 *
 *   DATABASE_URL=... LIVE_HLS_S3_ENDPOINT=... LIVE_HLS_S3_BUCKET=... \
 *   LIVE_HLS_S3_ACCESS_KEY_ID=... LIVE_HLS_S3_SECRET_ACCESS_KEY=... \
 *     pnpm --filter @pqp/server exec tsx scripts/hls-reconcile-ll-prefixes.ts \
 *       [--prefix <object_prefix>] [--include-cleaned] [--check-playlists] [--apply]
 *
 *   --prefix <p>         only the row whose object_prefix is exactly p
 *   --include-cleaned    also rows a sweep already marked cleaned (it deleted
 *                        nothing, since their prefix was empty); those are
 *                        revived, cleaned_at back to NULL
 *   --window-ms <n>      how far from started_at a directory may be (5000)
 *   --check-playlists    HEAD each repointed prefix's master.m3u8 and say
 *                        whether the recording will play or only list (one
 *                        request per row, so off for a big backlog)
 *   --replay-hours <n>   the LIVE_HLS_REPLAY_HOURS the sweep runs with (720);
 *                        a row that ended longer ago than this is refused,
 *                        because the next sweep would delete it at once
 *   --apply              write
 *
 * RUN IT ONLY AFTER THE API THAT DEFAULTS TO 720 HOURS IS DEPLOYED, or with
 * `--replay-hours` set to what the deployed sweep actually uses. A repointed
 * row outside the sweep's window is deleted on the next tick.
 */
/* eslint-disable no-console -- a CLI report is its stdout */
import pg from "pg";
import { buildStorageConfig, signRequest, type StorageConfig } from "../src/lib/s3.js";
import {
  planLlPrefixRepair,
  type LlPrefixPlan,
  type LlPrefixRow,
} from "../src/voice/hls-ll-prefix-reconcile.js";

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function storage(): StorageConfig {
  const config = buildStorageConfig({
    bucket: process.env.LIVE_HLS_S3_BUCKET,
    accessKeyId: process.env.LIVE_HLS_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY,
    endpoint: process.env.LIVE_HLS_S3_ENDPOINT,
    region: process.env.LIVE_HLS_S3_REGION,
    forcePathStyle: process.env.LIVE_HLS_S3_FORCE_PATH_STYLE === "true",
  });
  if (!config) {
    throw new Error("LIVE_HLS_S3_* is not configured");
  }
  return config;
}

/** Every `live/<channel>/<x>/` directory, as `live/<channel>/<x>`. One
 * delimited listing rather than every object: a busy channel holds thousands. */
async function llDirectories(config: StorageConfig, channelId: string): Promise<string[]> {
  const prefixes: string[] = [];
  let token: string | undefined;
  for (;;) {
    const query: Record<string, string> = {
      "list-type": "2",
      prefix: `live/${channelId}/`,
      delimiter: "/",
    };
    if (token) {
      query["continuation-token"] = token;
    }
    const url = signRequest({ method: "GET", key: "", ttlSeconds: 300, query, config }).url;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`ListObjectsV2 for ${channelId}: HTTP ${response.status}`);
    }
    const body = await response.text();
    for (const match of body.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>/g)) {
      prefixes.push(match[1]!.replace(/\/$/, ""));
    }
    if (!/<IsTruncated>true<\/IsTruncated>/.test(body)) {
      return prefixes;
    }
    token = body.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)?.[1];
    if (!token) {
      throw new Error("truncated ListObjectsV2 with no continuation token");
    }
  }
}

/** Whether the box wrote replay playlists there (it did from 2026-09-22). */
async function hasMaster(config: StorageConfig, prefix: string): Promise<boolean> {
  const url = signRequest({
    method: "HEAD",
    key: `${prefix}/master.m3u8`,
    ttlSeconds: 300,
    config,
  }).url;
  const response = await fetch(url, { method: "HEAD" });
  return response.ok;
}

function describePlan(plan: LlPrefixPlan): string {
  const head = `${plan.row.id} ${plan.row.objectPrefix}`;
  switch (plan.kind) {
    case "ok":
      return `ok        ${head} (objects are under its own prefix)`;
    case "missing":
      return `missing   ${head} (no -ll directory within the window)`;
    case "ambiguous":
      return `ambiguous ${head} -> ${plan.candidates.join(", ")} (left alone)`;
    case "taken":
      return `taken     ${head} -> ${plan.prefix} (another row already names it)`;
    case "expired":
      return `expired   ${head} -> ${plan.prefix} (ended past the replay window; the next sweep would delete it)`;
    case "repoint":
      return `repoint   ${head} -> ${plan.prefix}${plan.revive ? " (revive: cleaned_at -> NULL)" : ""}, keep_replay -> TRUE`;
  }
}

async function main(): Promise<void> {
  const apply = flag("--apply");
  const includeCleaned = flag("--include-cleaned");
  const checkPlaylists = flag("--check-playlists");
  const onlyPrefix = option("--prefix");
  const windowMs = Number(option("--window-ms") ?? 5_000);
  const replayHours = Number(option("--replay-hours") ?? 720);
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  const config = storage();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const rows = await pool.query<{
      id: string;
      channel_id: string;
      object_prefix: string;
      started_at_ms: string;
      ended_at_ms: string | null;
      cleaned: boolean;
      keep_replay: boolean;
    }>(
      `SELECT id, channel_id, object_prefix,
              (EXTRACT(EPOCH FROM started_at) * 1000)::bigint AS started_at_ms,
              (EXTRACT(EPOCH FROM ended_at) * 1000)::bigint AS ended_at_ms,
              cleaned_at IS NOT NULL AS cleaned, keep_replay
       FROM hls_sessions
       WHERE mode = 'll'
         AND ($1::boolean OR cleaned_at IS NULL)
         AND ($2::text IS NULL OR object_prefix = $2)
       ORDER BY started_at`,
      [includeCleaned, onlyPrefix ?? null],
    );
    const claimed = new Set(
      (await pool.query<{ object_prefix: string }>(`SELECT object_prefix FROM hls_sessions`)).rows.map(
        (r) => r.object_prefix,
      ),
    );
    const directories = new Map<string, string[]>();
    const counts: Record<string, number> = {};
    console.log(
      `${rows.rows.length} LL row(s); window ${windowMs} ms; replay window ${replayHours} h; ${apply ? "APPLYING" : "dry run"}`,
    );
    for (const raw of rows.rows) {
      const row: LlPrefixRow = {
        id: raw.id,
        channelId: raw.channel_id,
        objectPrefix: raw.object_prefix,
        startedAtMs: Number(raw.started_at_ms),
        endedAtMs: raw.ended_at_ms === null ? null : Number(raw.ended_at_ms),
        cleaned: raw.cleaned,
        keepReplay: raw.keep_replay,
      };
      if (!directories.has(row.channelId)) {
        directories.set(row.channelId, await llDirectories(config, row.channelId));
      }
      // The row's own prefix is in `claimed` too, and harmless there: a
      // candidate equal to it is the "ok" answer, decided before this set is
      // ever consulted.
      const plan = planLlPrefixRepair({
        row,
        bucketPrefixes: directories.get(row.channelId)!,
        claimedPrefixes: claimed,
        windowMs,
        replayHours,
        now: Date.now(),
      });
      counts[plan.kind] = (counts[plan.kind] ?? 0) + 1;
      let line = describePlan(plan);
      if (
        plan.kind === "repoint" &&
        checkPlaylists &&
        !(await hasMaster(config, plan.prefix))
      ) {
        // Kept and accounted for (retention will collect it), but it
        // predates the box writing replay playlists: it lists in the
        // history and answers 404 on Watch.
        line += " [no master.m3u8: will list, will not play]";
      }
      console.log(line);
      if (plan.kind !== "repoint" || !apply) {
        continue;
      }
      const updated = await pool.query(
        `UPDATE hls_sessions
         SET object_prefix = $2,
             keep_replay = TRUE,
             cleaned_at = CASE WHEN $3::boolean THEN NULL ELSE cleaned_at END
         WHERE id = $1 AND object_prefix = $4`,
        [row.id, plan.prefix, plan.revive, row.objectPrefix],
      );
      if (updated.rowCount !== 1) {
        console.log(`          ${row.id}: row changed underneath, not written`);
        continue;
      }
      claimed.delete(row.objectPrefix);
      claimed.add(plan.prefix);
    }
    console.log(
      Object.entries(counts)
        .map(([kind, n]) => `${kind}=${n}`)
        .join(" ") || "nothing to do",
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
