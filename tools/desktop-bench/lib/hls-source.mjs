// A live HLS source for the watch party scene: ffmpeg writes a 720p30 test
// picture and a tone into the directory the fake S3 serves, and one
// `hls_sessions` row says that session is live (the way the egress writer
// records it). The API's playlist proxy then renders it and the client's own
// watch party player plays it. Same recipe as `tools/db-blip-harness/`
// (`startFfmpeg` and the row in its `main`), at 720p instead of 360p and kept
// for the whole run.
//
// No LiveKit egress is involved, so the API has no in-process room for this
// session; it answers `GET /api/channels/:id/live` from the table, which is the
// path the machine that is not running the egress takes in production
// (`liveHlsStreamFromDb`). The playlist, the segments, the token and the player
// are the real ones.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pg = createRequire(path.join(here, "../../../server/package.json"))("pg");
const RUNG = "720p30";

export async function startHlsSource({ s3Root, databaseUrl, channelId, log }) {
  const startedAt = Date.now();
  const dir = path.join(s3Root, "live", channelId);
  mkdirSync(dir, { recursive: true });
  const base = `${startedAt}-${RUNG}`;

  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  await db.query(
    `INSERT INTO hls_sessions (channel_id, object_prefix, started_at, rung, presenter_peer_id)
     VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, 'desktop-bench-presenter')`,
    [channelId, `live/${channelId}/${base}`, startedAt, RUNG],
  );
  await db.end();

  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-re",
      "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440",
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
      "-b:v", "2500k", "-maxrate", "2500k", "-bufsize", "5000k",
      "-g", "120", "-keyint_min", "120", "-sc_threshold", "0",
      "-c:a", "aac", "-b:a", "96k",
      "-f", "hls", "-hls_time", "4", "-hls_list_size", "6",
      "-hls_flags", "delete_segments+program_date_time+temp_file",
      "-hls_segment_filename", path.join(dir, `${base}_%05d.ts`),
      path.join(dir, `${base}.m3u8`),
    ],
    { detached: true, stdio: ["ignore", "ignore", "inherit"] },
  );
  log(`ffmpeg live HLS source up (pid ${ffmpeg.pid}), session ${startedAt}`);

  return {
    pid: ffmpeg.pid,
    startedAt,
    stop: () =>
      new Promise((done) => {
        if (ffmpeg.exitCode !== null || ffmpeg.signalCode !== null) return done();
        ffmpeg.once("exit", () => done());
        try {
          process.kill(-ffmpeg.pid, "SIGTERM");
        } catch {
          ffmpeg.kill("SIGTERM");
        }
        setTimeout(() => ffmpeg.kill("SIGKILL"), 4_000).unref();
      }),
  };
}
