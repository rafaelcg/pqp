/**
 * THE MP4 COPY OF A JAM CAMERA VIDEO, THROUGH THE REAL API, THE REAL WORKER
 * CODE AND A REAL OBJECT STORE.
 *
 * Chrome records WebM, which iOS and Safari cannot play. The worker makes an
 * H.264 + AAC copy (`server/src/services/jam-video-transcode.ts`); this spec
 * proves the path around the conversion with MinIO under it: a track is added
 * with a real WebM through a presigned PUT, the job is queued by the claim, the
 * API process (which runs the batch jobs itself in this setup) converts it with
 * ffmpeg and PUTs the copy, and a read then offers it: `videoUrl` is the MP4,
 * `videoSources` lists the copy first and the original second, both URLs fetch,
 * the copy is a `moov`-first MP4 and its size is what the read says.
 *
 * The frame-and-sample accuracy of the conversion is pinned where it can be
 * measured (`server/src/speech/video-transcode.test.ts`, real ffmpeg); the
 * time zero of a take recorded by the browser is `e2e/jam/`.
 *
 * Needs object storage (`S3_*` exported, `docker compose --profile storage up
 * -d`) and an ffmpeg with libx264 on the machine running the API; without
 * either the spec skips, saying which.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const RUN = Date.now().toString(36);
const CLIP = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "jam-clip.webm"));

const FFMPEG = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const encoders = spawnSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" });
const haveX264 = encoders.status === 0 && /\blibx264\b/.test(encoders.stdout) && /\baac\b/.test(encoders.stdout);

test.setTimeout(120_000);

const headersFor = (suffix: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
});

async function call<T>(suffix: string, method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: headersFor(suffix),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${method} ${route} -> ${response.status} ${await response.text()}`);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

async function materialise(suffix: string): Promise<void> {
  const headers = headersFor(suffix);
  const me = await fetch(`${API}/api/me`, { headers });
  const body = (await me.json()) as { ageGate?: string };
  if (body.ageGate && body.ageGate !== "passed") {
    await fetch(`${API}/api/me/age-check`, { method: "POST", headers, body: JSON.stringify({ dateOfBirth: "1990-01-01" }) });
  }
}

/** A short plucked note as a WAV declared as FLAC: the server never decodes audio. */
function wav(): Buffer {
  const rate = 8000;
  const samples = rate * 2;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 196 * i) / rate) * 6000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function upload(who: string, songId: string, kind: "audio" | "video", bytes: Buffer): Promise<string> {
  const contentType = kind === "audio" ? "audio/flac" : "video/webm";
  const ticket = await call<{ uploadId: string; uploadUrl: string }>(who, "POST", `/api/jam-songs/${songId}/uploads`, {
    kind,
    contentType,
    byteSize: bytes.length,
  });
  const put = await fetch(ticket.uploadUrl, { method: "PUT", headers: { "Content-Type": contentType, "Content-Length": String(bytes.length) }, body: bytes });
  expect(put.ok).toBe(true);
  return ticket.uploadId;
}

interface TrackRead {
  id: string;
  videoUrl: string | null;
  videoContentType: string | null;
  videoBytes: number | null;
  videoSources?: { url: string; contentType: string; bytes: number }[];
}

test("a camera video recorded as WebM gets an MP4 copy, which a read offers first and which is a faststart MP4 in the bucket", async () => {
  test.skip(!haveX264, "needs ffmpeg with libx264 and AAC on this machine (the API process converts)");
  const host = `copyhost${RUN}`;
  await materialise(host);
  const { server } = await call<{ server: { id: string } }>(host, "POST", "/api/servers", { name: `Copia ${Date.now()}` });
  const flip = await fetch(`${API}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${E2E_ADMIN_TOKEN}` },
    body: JSON.stringify({ key: "jam_channels", serverId: server.id, enabled: true }),
  });
  expect(flip.status).toBe(200);
  const { channel } = await call<{ channel: { id: string } }>(host, "POST", `/api/servers/${server.id}/channels`, { name: "jam", type: "jam" });
  const config = await call<{ uploads: boolean }>(host, "GET", `/api/jam/config?serverId=${server.id}`);
  test.skip(!config.uploads, "needs object storage: export S3_* and start MinIO (docker compose --profile storage up -d)");

  const { song } = await call<{ song: { id: string } }>(host, "POST", `/api/channels/${channel.id}/jam-songs`, { title: "Com cópia" });
  const audioUploadId = await upload(host, song.id, "audio", wav());
  const videoUploadId = await upload(host, song.id, "video", CLIP);
  const added = await call<{ track: TrackRead }>(host, "POST", `/api/jam-songs/${song.id}/tracks`, {
    instrument: "guitar",
    audioUploadId,
    videoUploadId,
    durationMs: 2_000,
  });
  // What an old client sees the instant the track exists: the recorded file.
  expect(added.track.videoContentType).toBe("video/webm");
  expect(added.track.videoSources).toHaveLength(1);

  // The conversion runs in the background: poll the read until the copy is offered.
  let read: TrackRead | undefined;
  await expect
    .poll(
      async () => {
        const detail = await call<{ tracks: TrackRead[] }>(host, "GET", `/api/jam-songs/${song.id}`);
        read = detail.tracks[0];
        return read?.videoSources?.length ?? 0;
      },
      { timeout: 90_000, intervals: [1_000] },
    )
    .toBe(2);

  expect(read!.videoContentType).toBe("video/mp4");
  expect(read!.videoUrl).toBe(read!.videoSources![0]!.url);
  expect(read!.videoSources!.map((source) => source.contentType)).toEqual(["video/mp4", "video/webm"]);
  expect(read!.videoSources![1]!.bytes).toBe(CLIP.length);

  const copy = await fetch(read!.videoSources![0]!.url);
  expect(copy.status).toBe(200);
  expect(copy.headers.get("content-type")).toBe("video/mp4");
  const bytes = Buffer.from(await copy.arrayBuffer());
  expect(bytes.length).toBe(read!.videoBytes);
  expect(bytes.toString("latin1", 4, 8)).toBe("ftyp");
  // faststart: the moov box comes before the mdat, so a phone can start before the last byte
  const moov = bytes.indexOf("moov", 0, "latin1");
  const mdat = bytes.indexOf("mdat", 0, "latin1");
  expect(moov).toBeGreaterThan(0);
  expect(moov).toBeLessThan(mdat);
  expect(bytes.includes("avc1", 0, "latin1")).toBe(true);
  // (The fixture is a picture with no sound; the AAC half is pinned in video-transcode.test.ts.)

  // The original is still there, untouched, for every browser that plays it.
  const original = await fetch(read!.videoSources![1]!.url);
  expect(original.status).toBe(200);
  expect(Buffer.from(await original.arrayBuffer()).equals(CLIP)).toBe(true);
});
