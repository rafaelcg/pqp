/**
 * LOCAL ONLY: a fake live watch party for trying the signed-out live preview
 * (`docs/WATCH_PARTY.md` §"Watching without an account") on a laptop, with no
 * LiveKit and no egress.
 *
 * What it does, against the LOCAL database in DATABASE_URL:
 *
 *  1. Finds the community with slug `sandbox` (the dev seed's hall; another
 *     slug with `--slug=<slug>`), and makes sure it has a public watch party
 *     channel named `cinema` that @everyone can see.
 *  2. Writes an open `hls_sessions` row for it, the way the egress writer
 *     records a live ladder with one rung, and a live watch party row
 *     (`channel_sessions`) with its host's "Prévia pública" opt-in turned on
 *     (`options.publicPreview`, which the preview needs) and a title to show
 *     (`--title=...`). A party already open on the channel is only opted in.
 *  3. Runs ffmpeg (test pattern and a tone) writing a live HLS rendition
 *     into a temporary directory, and serves that directory as a tiny
 *     path-style S3 bucket (`../db-blip-harness/fake-s3.mjs`).
 *
 * Ctrl+C ends the session row and stops both.
 *
 * The API must read the same bucket, so start it with the four
 * `LIVE_HLS_S3_*` lines this prints (they point at 127.0.0.1). Refuses any
 * DATABASE_URL that is not on this machine.
 *
 * Usage, from the repo root:
 *   set -a; source .env; set +a
 *   node tools/live-preview-dev/fake-live.mjs [--slug=sandbox] [--port=9611] [--title=...]
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeS3 } from "../db-blip-harness/fake-s3.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const pg = createRequire(join(REPO, "server", "package.json"))("pg");

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "true"];
  }),
);
const SLUG = args.slug ?? "sandbox";
const TITLE = args.title ?? "Sessão de teste: barras de cor";
const PORT = Number(args.port ?? 9611);
const BUCKET = "pqp-live-preview-dev";
const RUNG = "720p30";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required (source the repo's .env first)");
}
const host = new URL(databaseUrl).hostname;
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
  throw new Error(`refusing a non-local database (${host}): this script writes rows`);
}

const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();

const server = await db.query(
  `SELECT id, name, owner_id FROM servers WHERE community_slug = $1 AND is_community`,
  [SLUG],
);
if (server.rows.length === 0) {
  throw new Error(
    `no community with slug "${SLUG}". The dev seed makes "sandbox" when DEV_AUTH_BYPASS is on.`,
  );
}
const serverId = server.rows[0].id;

let channel = await db.query(
  `SELECT id FROM channels WHERE server_id = $1 AND name = 'cinema' AND type = 'watch_party'`,
  [serverId],
);
if (channel.rows.length === 0) {
  channel = await db.query(
    `INSERT INTO channels (server_id, name, type, position)
     VALUES ($1, 'cinema', 'watch_party', 900) RETURNING id`,
    [serverId],
  );
}
const channelId = channel.rows[0].id;

// End anything a previous run left open on this channel, then open a new one.
await db.query(
  `UPDATE hls_sessions SET ended_at = now() WHERE channel_id = $1 AND ended_at IS NULL`,
  [channelId],
);
const startedAt = Date.now();
await db.query(
  `INSERT INTO hls_sessions (channel_id, object_prefix, started_at, rung, presenter_peer_id)
   VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, 'fake-presenter')`,
  [channelId, `live/${channelId}/${startedAt}-${RUNG}`, startedAt, RUNG],
);

// The party's title, as a host going live would leave it. Only when nothing
// is open on the channel (one active party per channel is a unique index);
// only the row made here is ended on the way out.
const party = await db.query(
  `INSERT INTO channel_sessions
     (channel_id, server_id, title, starts_at, status, created_by, host_user_id, went_live_at, options)
   SELECT $1, $2, $3, now(), 'live', $4, $4, now(), '{"publicPreview": true}'::jsonb
    WHERE NOT EXISTS (
      SELECT 1 FROM channel_sessions
       WHERE channel_id = $1 AND status IN ('draft', 'scheduled', 'live')
    )
   RETURNING id`,
  [channelId, serverId, TITLE, server.rows[0].owner_id],
);
const partyId = party.rows[0]?.id ?? null;
// A party somebody already opened on the channel: opted in, so the preview
// can show it. Without the opt-in the preview refuses it (not-public).
await db.query(
  `UPDATE channel_sessions SET options = options || '{"publicPreview": true}'::jsonb
    WHERE channel_id = $1 AND status = 'live'`,
  [channelId],
);

const root = mkdtempSync(join(tmpdir(), "pqp-live-preview-"));
const dir = join(root, "live", channelId);
mkdirSync(dir, { recursive: true });
const s3 = await startFakeS3({ port: PORT, root, bucket: BUCKET });
const base = `${startedAt}-${RUNG}`;
const ffmpeg = spawn(
  "ffmpeg",
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-re",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-g",
    "60",
    "-keyint_min",
    "60",
    "-sc_threshold",
    "0",
    "-c:a",
    "aac",
    "-f",
    "hls",
    "-hls_time",
    "2",
    // A long window, and segments kept a while after they leave it: the
    // playlist proxy serves a window a few segments behind the live edge,
    // and a segment it lists must still exist when a player asks for it.
    "-hls_list_size",
    "30",
    "-hls_delete_threshold",
    "30",
    "-hls_flags",
    "delete_segments+program_date_time+temp_file",
    "-hls_segment_filename",
    join(dir, `${base}_%05d.ts`),
    join(dir, `${base}.m3u8`),
  ],
  { stdio: ["ignore", "inherit", "inherit"] },
);

console.log(`
Live on #cinema in "${server.rows[0].name}" (channel ${channelId}).

Start the API with these, beside DEV_AUTH_BYPASS, COMMUNITIES_ENABLED=true and
LIVE_PREVIEW=true (or the flag turned on for this server):

  LIVE_HLS_S3_BUCKET=${BUCKET}
  LIVE_HLS_S3_ACCESS_KEY_ID=dev
  LIVE_HLS_S3_SECRET_ACCESS_KEY=dev
  LIVE_HLS_S3_ENDPOINT=http://127.0.0.1:${PORT}
  LIVE_HLS_S3_FORCE_PATH_STYLE=true
  LIVE_HLS_S3_REGION=auto

Then open /c/${SLUG} signed out. Ctrl+C ends the session.
`);

let stopping = false;
async function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  ffmpeg.kill("SIGINT");
  await db
    .query(`UPDATE hls_sessions SET ended_at = now() WHERE channel_id = $1 AND ended_at IS NULL`, [
      channelId,
    ])
    .catch(() => {});
  if (partyId) {
    await db
      .query(
        `UPDATE channel_sessions SET status = 'ended', ended_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'live'`,
        [partyId],
      )
      .catch(() => {});
  }
  await db.end().catch(() => {});
  await s3.stop();
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
ffmpeg.on("exit", () => void stop());
