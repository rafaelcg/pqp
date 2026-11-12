#!/usr/bin/env node
/**
 * Seeds a LOCAL database with public jams for the jam.pqp.gg website
 * (`docs/JAM_SITE.md`): fifteen published songs across a dozen made-up
 * accounts, with real audio and video that ffmpeg synthesises (tones and
 * moving gradients: no people, no recordings), and the states the contract
 * hides, so a developer can see that they do not show.
 *
 * It drives the REAL API (the dev auth bypass, the three-step upload, the
 * public routes), so the data is what production code would write. The only
 * things done with SQL are what a worker or an operator does in production:
 * marking a cover or a video as scanned, setting plays and likes, and moving a
 * standalone song under a server so it has an origin.
 *
 *   JAM_PUBLIC=true JAM_CHANNELS=true DEV_AUTH_BYPASS=true  (server env)
 *   node tools/jam-site-seed/seed.mjs --api http://localhost:3411 \
 *        --db postgresql://pqp:pqp@localhost:5432/pqp_local --out /tmp/jam-seed
 *
 * Needs: ffmpeg, psql, and S3 (MinIO) configured on the server. Refuses any
 * API that is not on localhost.
 *
 * With `--media <dir>` (the directory `fetch-media.mjs` filled) the same songs
 * are seeded with public-domain media instead: painted and photographed covers,
 * real clips of people playing for the video parts, historical portraits as
 * avatars, and one more song (eleven parts). Audio-only parts keep the
 * synthetic audio on purpose. `ATTRIBUTION.md` lists every file and its licence.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, value, index, all) => {
    if (value.startsWith("--")) acc.push([value.slice(2), all[index + 1]]);
    return acc;
  }, []),
);
const API = (args.api ?? "http://localhost:3001").replace(/\/+$/, "");
const DB = args.db ?? "postgresql://pqp:pqp@localhost:5432/pqp";
const OUT = args.out ?? "/tmp/jam-seed";
/** `--media <dir>`: seed with the public-domain media `fetch-media.mjs` downloaded. */
const MEDIA = args.media ? JSON.parse(readFileSync(join(args.media, "media.json"), "utf8")) : null;
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(API)) {
  console.error("refusing: --api must be a localhost address");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const sql = (text) =>
  execFileSync("psql", [DB, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", text], { encoding: "utf8" }).trim();

async function call(suffix, method, path, body, expect = [200, 201, 204]) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer dev-local-token:${suffix}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!expect.includes(response.status)) {
    throw new Error(`${method} ${path} as ${suffix}: ${response.status} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

// ------------------------------------------------------------------ people

const PEOPLE = {
  leco: "Leco", tchelo: "Tchelo", juju: "Juju", gui: "Gui", nanda: "Nanda", zeca: "Zeca",
  bia: "Bia", cris: "Cris", tati: "Tati", lia: "Lia", duda: "Duda", mari: "Mari",
};

async function ensurePeople() {
  for (const [suffix, name] of Object.entries(PEOPLE)) {
    await call(suffix, "GET", "/api/me", null, [200, 201]);
    sql(
      `UPDATE users SET age_checked_at = NOW(), age_check_passed = TRUE, created_at = NOW() - INTERVAL '30 days' WHERE clerk_id = 'dev_local_user_${suffix}'`,
    );
    await call(suffix, "PATCH", "/api/me", { displayName: name, handle: suffix }, [200, 409]);
  }
  if (MEDIA) {
    // Eight of the twelve have a photograph; the rest keep the monogram, as real people do.
    for (const [index, suffix] of Object.keys(PEOPLE).slice(0, MEDIA.portraits.length).entries()) {
      const bytes = readFileSync(MEDIA.portraits[index]);
      const ticket = await call(suffix, "POST", "/api/me/avatar", { contentType: "image/jpeg", byteSize: bytes.length });
      const put = await fetch(ticket.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "image/jpeg", "content-length": String(bytes.length) },
        body: bytes,
      });
      if (!put.ok) throw new Error(`PUT avatar ${suffix}: ${put.status}`);
      await call(suffix, "POST", "/api/me/avatar/claim", { key: ticket.key });
    }
  }
}

const userId = (suffix) => sql(`SELECT id FROM users WHERE clerk_id = 'dev_local_user_${suffix}'`);

// ------------------------------------------------------------------- media

const SECONDS = MEDIA ? MEDIA.seconds : 28;
const esc = (expr) => expr.replace(/,/g, "\\,");

/** One instrument's synthetic line. `p` shifts the pitch a little so two guitars differ. */
function expression(instrument, p) {
  const step = (n, map) =>
    map.map(([k, semis]) => `eq(${n},${k})*${semis}`).join("+") || "0";
  switch (instrument) {
    case "drums":
      return `0.85*sin(2*PI*(55+90*exp(-30*mod(t,0.5)))*t)*exp(-9*mod(t,0.5))+0.2*(random(0)*2-1)*exp(-40*mod(t+0.25,0.5))`;
    case "bass": {
      const n = "mod(floor(t/2),4)";
      return `0.7*sin(2*PI*${(55 * p).toFixed(2)}*pow(2,(${step(n, [[2, 5], [3, 3]])})/12)*t)*(0.55+0.45*exp(-5*mod(t,0.5)))`;
    }
    case "guitar": {
      const n = "mod(floor(t/0.25),4)";
      const f = `${(196 * p).toFixed(2)}*pow(2,(${step(n, [[1, 4], [2, 7], [3, 12]])})/12)`;
      return `0.5*sin(2*PI*${f}*t)*exp(-6*mod(t,0.25))+0.2*sin(4*PI*${f}*t)*exp(-8*mod(t,0.25))`;
    }
    case "vocals": {
      const n = "mod(floor(t/1),4)";
      const f = `${(262 * p).toFixed(2)}*pow(2,(${step(n, [[1, 2], [2, 4], [3, 7]])})/12)`;
      return `0.45*sin(2*PI*${f}*t+4*sin(2*PI*5.5*t))*(0.35+0.65*pow(sin(PI*mod(t,1)),2))`;
    }
    case "keys": {
      const n = "mod(floor(t/2),4)";
      const f = `${(130.8 * p).toFixed(2)}*pow(2,(${step(n, [[1, 5], [2, 7], [3, 3]])})/12)`;
      return `0.22*(sin(2*PI*${f}*t)+sin(2*PI*${f}*1.26*t)+sin(2*PI*${f}*1.5*t))*(0.7+0.3*sin(2*PI*0.25*t))`;
    }
    default:
      return `0.3*(random(0)*2-1)*exp(-18*mod(t,0.25))*(0.5+0.5*sin(2*PI*0.5*t))`;
  }
}

const HUE = { drums: "0xc8621a", guitar: "0xc9b41c", vocals: "0xb6558c", keys: "0x2e9aa0", bass: "0x2d52b8", other: "0x7a6aa3" };

function ffmpeg(argv) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...argv], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ffmpeg ${argv.join(" ")}: ${result.stderr}`);
}

function peaksOf(file) {
  const raw = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "f32le", "-ac", "1", "-ar", "8000", "pipe:1"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const samples = new Float32Array(raw.stdout.buffer, raw.stdout.byteOffset, Math.floor(raw.stdout.length / 4));
  const buckets = 400;
  const out = [];
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * samples.length) / buckets);
    const to = Math.floor(((b + 1) * samples.length) / buckets);
    let peak = 0;
    for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(samples[i]));
    out.push(Math.round(Math.min(1, peak) * 1000) / 1000);
  }
  return out;
}

const mediaCache = new Map();
function audioFor(instrument, p) {
  const key = `${instrument}-${p}`;
  if (!mediaCache.has(key)) {
    const file = join(OUT, `a-${key}.flac`);
    if (!existsSync(file) || statSync(file).size === 0) {
      ffmpeg(["-f", "lavfi", "-i", `aevalsrc=${esc(expression(instrument, p))}:s=44100:d=${SECONDS}`, "-af", "volume=0.9", "-ac", "1", "-c:a", "flac", file]);
    }
    mediaCache.set(key, { file, bytes: statSync(file).size, peaks: peaksOf(file) });
  }
  return mediaCache.get(key);
}

/** The clip a video part of this instrument shows: a different one each time, so a band is not four copies of one drummer. */
const clipUse = new Map();
function clipFor(instrument) {
  const pool = MEDIA.clips.filter((c) => c.role === instrument);
  const from = pool.length ? pool : MEDIA.clips.filter((c) => c.role === "other");
  const n = clipUse.get(instrument) ?? 0;
  clipUse.set(instrument, n + 1);
  return from[n % from.length];
}

/** A clip's own sound, for the part that carries its picture. */
function clipAudio(clip) {
  const key = `clip-${clip.id}`;
  if (!mediaCache.has(key)) {
    const file = join(OUT, `a-${key}.flac`);
    if (!existsSync(file) || statSync(file).size === 0) {
      ffmpeg(["-i", clip.file, "-vn", "-ac", "1", "-ar", "44100", "-c:a", "flac", file]);
    }
    mediaCache.set(key, { file, bytes: statSync(file).size, peaks: peaksOf(file) });
  }
  return mediaCache.get(key);
}

const VIDEO_TYPE = MEDIA?.format === "mp4" ? "video/mp4" : "video/webm";

function videoFor(instrument, variant) {
  const key = `${instrument}-${variant}`;
  if (!mediaCache.has(key)) {
    const file = join(OUT, `v-${key}.webm`);
    if (!existsSync(file) || statSync(file).size === 0) {
      const hue = HUE[instrument] ?? HUE.other;
      // A thin progress line tied to the clock, so a viewer can SEE the picture is on the song's time.
      ffmpeg([
        "-f", "lavfi", "-i",
        `gradients=s=640x360:d=${SECONDS}:r=15:speed=${0.01 + variant * 0.006}:c0=${hue}:c1=0x10161c:c2=${hue}:nb_colors=3:type=${variant % 2 ? "radial" : "linear"}`,
        "-f", "lavfi", "-i", `color=c=white@0.5:s=640x3:r=15:d=${SECONDS}`,
        "-filter_complex", `[0][1]overlay=x='-w+t*w/${SECONDS}':y=0,format=yuv420p`,
        "-c:v", "libvpx", "-b:v", "600k", "-crf", "32", "-deadline", "realtime", "-cpu-used", "8", "-an", "-t", String(SECONDS), file,
      ]);
    }
    mediaCache.set(key, { file, bytes: statSync(file).size });
  }
  return mediaCache.get(key);
}

function coverFor(n) {
  if (MEDIA) {
    const picked = MEDIA.covers[n % MEDIA.covers.length];
    return { file: picked, bytes: statSync(picked).size };
  }
  const file = join(OUT, `c-${n}.jpg`);
  if (!existsSync(file) || statSync(file).size === 0) {
    const hues = ["0x2d52b8", "0xc8621a", "0xb6558c", "0x2e9aa0", "0xc9b41c", "0x7a6aa3"];
    ffmpeg([
      "-f", "lavfi", "-i",
      `gradients=s=640x640:d=1:r=1:speed=0.03:c0=${hues[n % 6]}:c1=0x10161c:c2=${hues[(n + 2) % 6]}:nb_colors=3:type=${n % 2 ? "spiral" : "linear"}`,
      "-frames:v", "1", "-q:v", "4", file,
    ]);
  }
  return { file, bytes: statSync(file).size };
}

async function upload(suffix, songId, kind, contentType, media) {
  const ticket = await call(suffix, "POST", `/api/jam-songs/${songId}/uploads`, { kind, contentType, byteSize: media.bytes });
  const put = await fetch(ticket.uploadUrl, {
    method: "PUT",
    headers: { "content-type": contentType, "content-length": String(media.bytes) },
    body: readFileSync(media.file),
  });
  if (!put.ok) throw new Error(`PUT ${kind}: ${put.status} ${await put.text()}`);
  return ticket.uploadId;
}

// ------------------------------------------------------------------- songs

/** [instrument, person, options] */
const T = (instrument, person, o = {}) => ({ instrument, person, ...o });

const SONGS = [
  {
    key: "minuano", title: "Minuano", artist: null, starter: "leco", hoursAgo: 3, plays: 1240, likes: 48,
    mode: ["wanted", ["bass"]], origin: { name: "Garagem do Tchê", slug: "garagem-do-tche", show: true },
    tracks: [T("drums", "leco", { video: true }), T("guitar", "tchelo", { label: "cavaquinho" }), T("vocals", "juju", { video: true }), T("keys", "gui", { video: true }),
      // The consent a person withdrew: this part is not public.
      T("other", "duda", { consent: "no", note: "hidden: consent no" })],
    cover: 0,
  },
  {
    key: "sinaleira", title: "Sinaleira aberta", starter: "nanda", hoursAgo: 9, plays: 2600, likes: 130,
    mode: ["wanted", ["vocals"]], origin: { name: "Rádio Porão", slug: null, show: true },
    tracks: [T("drums", "nanda"), T("bass", "zeca", { offset: 1200 }), T("guitar", "bia", { video: true, offset: 2400 }), T("keys", "cris", { offset: 400 })],
  },
  {
    key: "onibus", title: "Ônibus T4 atrasado", starter: "bia", hoursAgo: 20, plays: 88, likes: 1,
    mode: ["open", []], origin: null,
    tracks: [T("guitar", "bia", { video: true }), T("vocals", "lia", { outsideOnly: true, note: "hidden: take not put in the mix" })],
    cover: 1,
  },
  {
    key: "ruadapraia", title: "Rua da Praia, 3h", artist: "Trio Meia-Lua", starter: "tchelo", hoursAgo: 30, plays: 5800, likes: 540,
    mode: ["closed", []], origin: { name: "Rádio Porão", slug: null, show: true },
    tracks: [T("drums", "tchelo", { video: true }), T("bass", "nanda", { video: true }), T("guitar", "bia", { video: true, offset: 2000 }), T("vocals", "juju", { video: true }), T("keys", "gui"), T("other", "zeca", { label: "pandeiro", video: true })],
    cover: 2,
  },
  {
    key: "chimarrao", title: "Chimarrão das seis", starter: "gui", hoursAgo: 40, plays: 312, likes: 0,
    mode: ["wanted", ["drums", "vocals"]], origin: { name: "Estúdio Sul", slug: null, show: true },
    tracks: [T("guitar", "gui", { video: true }), T("keys", "cris", { video: true }), T("bass", "nanda")],
  },
  {
    key: "vento", title: "Vento Norte", starter: "mari", hoursAgo: 50, plays: 41, likes: 0,
    mode: ["wanted", ["bass", "guitar"]], origin: null,
    tracks: [T("drums", "mari")],
  },
  {
    key: "cafe", title: "Café sem açúcar", starter: "cris", hoursAgo: 60, plays: 2100, likes: 96,
    mode: ["wanted", ["guitar"]], origin: null,
    tracks: [T("keys", "cris", { video: true }), T("drums", "leco", { video: true })],
    cover: 3,
  },
  {
    key: "garoa", title: "Garoa em Pelotas", starter: "lia", hoursAgo: 75, plays: 940, likes: 23,
    mode: ["wanted", ["keys"]], origin: null,
    tracks: [T("guitar", "lia", { offset: 0 }), T("vocals", "mari", { offset: 3000 })],
  },
  {
    key: "ladeira", title: "Ladeira da Borges", starter: "zeca", hoursAgo: 90, plays: 3400, likes: 212,
    mode: ["closed", []], origin: { name: "Os da Quinta", slug: null, show: true },
    tracks: [T("drums", "zeca", { video: true }), T("bass", "nanda", { video: true }), T("guitar", "bia"), T("guitar", "tchelo", { video: true, label: "solo" }), T("vocals", "juju", { video: true }), T("vocals", "lia", { label: "coro" }), T("keys", "gui", { video: true }), T("other", "tati", { label: "sax", video: true }), T("other", "duda", { label: "pandeiro" })],
    cover: 4,
  },
  {
    key: "canoas", title: "Último trem pra Canoas", starter: "tati", hoursAgo: 110, plays: 420, likes: 3,
    mode: ["wanted", ["drums"]], origin: { name: "Clube do Violão", slug: null, show: false },
    tracks: [T("guitar", "tati", { video: true }), T("vocals", "duda", { video: true }), T("keys", "mari")],
  },
  {
    key: "ana302", title: "Ana do 302", starter: "juju", hoursAgo: 130, plays: 1700, likes: 61,
    mode: ["open", []], origin: { name: "Ensaio Aberto", slug: null, show: true },
    tracks: [T("vocals", "juju", { video: true }), T("guitar", "tchelo", { video: true })],
    cover: 5,
  },
  {
    key: "brique", title: "Domingo no Brique", starter: "zeca", hoursAgo: 150, plays: 9300, likes: 880,
    mode: ["wanted", ["bass"]], origin: { name: "Garagem do Tchê", slug: "garagem-do-tche", show: true },
    tracks: [T("drums", "leco", { video: true }), T("guitar", "tchelo", { video: true, label: "cavaquinho" }), T("vocals", "juju", { video: true }), T("keys", "gui"),
      T("other", "zeca", { label: "pandeiro", video: true }),
      // A video that never passed the frame scan: its part shows as audio only.
      T("other", "tati", { label: "sax", video: true, scan: "pending", note: "hidden: video not scanned" })],
  },
  {
    key: "riff", title: "Riff solto", starter: "duda", hoursAgo: 170, plays: 12, likes: 0,
    mode: ["wanted", ["vocals"]], origin: null,
    tracks: [T("guitar", "duda")],
  },
  {
    key: "duo", title: "Duo de domingo", starter: "nanda", hoursAgo: 190, plays: 270, likes: 7,
    mode: ["closed", []], origin: null,
    tracks: [T("bass", "nanda", { video: true }), T("keys", "cris", { video: true })],
    cover: 1,
  },
  {
    key: "trio", title: "Trio da esquina", starter: "tchelo", hoursAgo: 210, plays: 58, likes: 2,
    mode: ["open", []], origin: null,
    tracks: [T("guitar", "tchelo", { video: true }), T("bass", "gui", { video: true }), T("drums", "leco")],
  },
  // Eleven parts, only in the real-media seed: the largest mosaic, half of it audio only.
  ...(MEDIA
    ? [{
        key: "roda", title: "Roda de sábado", artist: "A Turma do Bar do Zé", starter: "bia", hoursAgo: 8, plays: 4200, likes: 305,
        mode: ["wanted", ["bass"]], origin: { name: "Garagem do Tchê", slug: "garagem-do-tche", show: true },
        tracks: [T("guitar", "bia", { video: true }), T("vocals", "juju", { video: true }), T("drums", "leco"), T("keys", "gui", { video: true }), T("guitar", "tchelo", { label: "violão 7 cordas" }),
          T("vocals", "lia", { label: "coro" }), T("vocals", "mari", { label: "coro" }), T("other", "tati", { label: "sax", video: true }), T("other", "duda", { label: "pandeiro" }),
          T("other", "zeca", { label: "acordeão", video: true }), T("other", "cris", { label: "violoncelo" })],
        cover: 12,
      }]
    : []),
  // Never public: unpublished by its starter.
  { key: "despublicada", title: "Despublicada (não aparece)", starter: "leco", hoursAgo: 5, plays: 5, likes: 0, mode: ["open", []], origin: null, tracks: [T("guitar", "leco")], unpublish: true },
];

const ids = {};
const NO_COVER = new Set(["riff", "vento", "garoa"]);
let nextCover = 0;
const channelsByServer = new Map();

async function ensureOrigin(starter, origin) {
  const key = `${starter}:${origin.name}`;
  if (channelsByServer.has(origin.name)) return channelsByServer.get(origin.name);
  const server = (await call(starter, "POST", "/api/servers", { name: origin.name })).server;
  const channel = (await call(starter, "POST", `/api/servers/${server.id}/channels`, { name: "jam", type: "jam" }).catch(() => null))?.channel ?? null;
  let channelId = channel?.id ?? null;
  if (!channelId) {
    channelId = sql(`SELECT id FROM channels WHERE server_id = '${server.id}' ORDER BY created_at LIMIT 1`);
  }
  const value = { serverId: server.id, channelId };
  channelsByServer.set(origin.name, value);
  if (origin.slug) {
    sql(`UPDATE servers SET is_community = TRUE, community_slug = '${origin.slug}' WHERE id = '${server.id}'`);
  }
  void key;
  return value;
}

async function seedSong(song, order) {
  const created = await call(song.starter, "POST", "/api/jam-public/songs", {
    title: song.title,
    ...(song.artist ? { artist: song.artist } : {}),
    joinMode: "open",
    nonce: `seed-${song.key}`,
  });
  const songId = created.song.id;
  ids[song.key] = { id: songId, title: song.title, notes: [] };

  const trackIds = [];
  // The starter's own part first: a song is not listed (so nobody else may add to it) until one part is public.
  const ordered = [...song.tracks].sort((a, b) => Number(b.person === song.starter) - Number(a.person === song.starter));
  for (const [index, track] of ordered.entries()) {
    const clip = MEDIA && track.video ? clipFor(track.instrument) : null;
    const audio = clip ? clipAudio(clip) : audioFor(track.instrument, 1 + ((order + index) % 4) * 0.06);
    const audioUploadId = await upload(track.person, songId, "audio", "audio/flac", audio);
    let videoUploadId = null;
    if (track.video) {
      videoUploadId = clip
        ? await upload(track.person, songId, "video", VIDEO_TYPE, { file: clip.file, bytes: statSync(clip.file).size })
        : await upload(track.person, songId, "video", "video/webm", videoFor(track.instrument, (order + index) % 3));
    }
    const added = await call(track.person, "POST", `/api/jam-songs/${songId}/tracks`, {
      instrument: track.instrument,
      ...(track.label ? { label: track.label } : {}),
      audioUploadId,
      videoUploadId,
      durationMs: SECONDS * 1000,
      offsetMs: track.offset ?? 0,
      trimStartMs: 0,
      trimEndMs: track.trimEnd ?? 0,
      gain: 1,
      peaks: audio.peaks,
      publicConsent: track.video ? "yes" : "audio_only",
    });
    const trackId = added.track.id;
    trackIds.push(trackId);
    if (track.note) ids[song.key].notes.push({ track: trackId, note: track.note });
    // A take from somebody else arrives out of the mix: the starter puts it in.
    if (track.person !== song.starter && !track.outsideOnly) {
      await call(song.starter, "PATCH", `/api/jam-tracks/${trackId}`, { inMix: true });
    }
    if (track.video) {
      const state = track.scan ?? "passed";
      sql(
        `UPDATE jam_public_tracks pt SET video_scan_status = '${state}', video_scan_key = t.video_key FROM jam_tracks t WHERE t.id = pt.track_id AND pt.track_id = '${trackId}' AND t.video_key IS NOT NULL`,
      );
    }
    if (track.consent) {
      sql(
        `INSERT INTO jam_public_consents (song_id, user_id, choice) VALUES ('${songId}', '${userId(track.person)}', '${track.consent}') ON CONFLICT (song_id, user_id) DO UPDATE SET choice = EXCLUDED.choice`,
      );
    }
  }

  const [joinMode, wanted] = song.mode;
  await call(song.starter, "PATCH", `/api/jam-songs/${songId}`, {
    joinMode,
    ...(joinMode === "wanted" ? { wantedInstruments: wanted } : {}),
  });

  // With real media nearly every song has a picture (a few keep the fallback tile), each a different one.
  const coverIndex = MEDIA ? (NO_COVER.has(song.key) ? undefined : nextCover++) : song.cover;
  if (coverIndex !== undefined) {
    const media = coverFor(coverIndex);
    const uploadId = await upload(song.starter, songId, "cover", "image/jpeg", media);
    await call(song.starter, "PUT", `/api/jam-songs/${songId}/cover`, { uploadId });
    sql(
      `INSERT INTO jam_public_cover_scans (upload_id, song_id, status, provider, scanned_at) VALUES ('${uploadId}', '${songId}', 'passed', 'seed', NOW()) ON CONFLICT (upload_id) DO UPDATE SET status = 'passed'`,
    );
  }

  if (song.origin) {
    const { serverId, channelId } = await ensureOrigin(song.starter, song.origin);
    sql(`UPDATE jam_songs SET channel_id = '${channelId}', server_id = '${serverId}' WHERE id = '${songId}'`);
    sql(`UPDATE jam_public_songs SET show_origin = ${song.origin.show ? "TRUE" : "FALSE"} WHERE song_id = '${songId}'`);
  }

  sql(
    `UPDATE jam_public_songs SET plays_count = ${song.plays}, likes_count = ${song.likes}, published_at = NOW() - interval '${song.hoursAgo} hours' WHERE song_id = '${songId}'`,
  );
  if (song.unpublish) {
    await call(song.starter, "DELETE", `/api/jam-songs/${songId}/public`);
  }
}

await ensurePeople();
for (const [order, song] of SONGS.entries()) {
  await seedSong(song, order);
  console.log(`seeded ${song.key}`);
}
writeFileSync(join(OUT, "seed-ids.json"), JSON.stringify(ids, null, 2));
console.log(`done: ${Object.keys(ids).length} songs, ids in ${join(OUT, "seed-ids.json")}`);
