/**
 * The share fast-start rig's moving parts, shared by the Playwright spec and
 * by `node rig.mjs <scenario>` for a one-off run.
 *
 *   - the source clip (`ensureMedia`): 1080p30 ffmpeg `testsrc2` (it burns a
 *     running clock and frame count into every frame) with light temporal
 *     grain, so the encoder spends bits the way it does on a film;
 *   - the media server (`startSfu`): LiveKit 1.13.6, the version production
 *     runs, in Docker, with `livekit.yaml` from this directory;
 *   - the shaper (`shape`): `tc` in a sidecar sharing the server's network
 *     namespace, on the loopback hop between the TURN relay and the server,
 *     which only relayed pages use: a viewer opened with `relay=1` has its
 *     downlink shaped and nobody else's, a presenter with `relay=1` its uplink;
 *   - tokens (`token`): HS256 by hand, no SDK, with the local key in
 *     `livekit.yaml`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MEDIA = path.join(HERE, "media-cache");
export const CONTAINER = "sfs-lk";
const SHAPER = "sfs-shaper";
const KEY = "sfsdevkey";
const SECRET = "sfs-local-secret-not-a-real-key-0123456789";
export const SFU_URL = "ws://127.0.0.1:7880";

export function hasTools() {
  const ok = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
  return ok("ffmpeg", ["-version"]) && ok("docker", ["info"]) && ok("lk", ["--version"]);
}

export function ensureMedia() {
  const out = path.join(MEDIA, "src.mp4");
  if (existsSync(out)) return out;
  mkdirSync(MEDIA, { recursive: true });
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30,noise=alls=4:allf=t",
    "-t", "60", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-pix_fmt", "yuv420p", "-g", "60", out,
  ]);
  return out;
}

export function startSfu() {
  spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  execFileSync("docker", [
    "run", "-d", "--name", CONTAINER,
    "-p", "127.0.0.1:7880:7880", "-p", "127.0.0.1:7881:7881",
    "-p", "127.0.0.1:7882:7882/udp", "-p", "127.0.0.1:3478:3478/udp",
    // The TURN relay's allocations (`relay_range_*` in livekit.yaml): a
    // shaped run that forces the browser through the relay reaches them here.
    "-p", "127.0.0.1:30000-30100:30000-30100/udp",
    "-v", `${path.join(HERE, "livekit.yaml")}:/etc/livekit.yaml:ro`,
    "livekit/livekit-server:v1.13.6",
    "--config", "/etc/livekit.yaml", "--node-ip", "127.0.0.1", "--bind", "0.0.0.0",
  ]);
}

export function stopSfu() {
  spawnSync("docker", ["rm", "-f", SHAPER], { stdio: "ignore" });
  spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
}

/** Docker logs since `since` (unix seconds), parsed. */
export function sfuLogs(since) {
  const res = spawnSync("docker", ["logs", "--since", String(since), CONTAINER], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  const lines = `${res.stdout}\n${res.stderr}`.split("\n");
  const out = [];
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partial line
    }
  }
  return out;
}

/** A queue of about `ms` at `rate`, in 1200-byte packets (netem counts packets). */
function queuePackets(rate, ms) {
  const m = /^([\d.]+)\s*(k|m)bit$/i.exec(rate);
  const bps = m ? Number(m[1]) * (m[2].toLowerCase() === "m" ? 1e6 : 1e3) : 5e6;
  return Math.max(8, Math.round((bps * ms) / 1000 / (1200 * 8)));
}

/**
 * Shape the relayed legs. A page opened with `relay=1` reaches the media
 * server only through the TURN relay, and the relay and the server talk over
 * the container's loopback, so on `lo`:
 *
 *   - server (7882) to relay is the relayed VIEWER's downlink,
 *   - relay to server (7882) is the relayed PRESENTER's uplink.
 *
 * Nothing else crosses `lo`, and TURN's own control traffic (port 3478 on
 * eth0) is never touched, which is what made shaping eth0 fail one ICE setup
 * in three. netem's own rate limiter with a queue of `queueMs`, not tbf with a
 * netem child (tbf peeking a delaying netem stalls).
 *
 * `viewer` / `presenter`: `{ rate: "5mbit", impair: "delay 20ms", queueMs }`.
 */
export function shape({ viewer, presenter } = {}) {
  const leg = (band, cfg, match) => [
    `tc qdisc add dev lo parent 1:${band} handle ${band}0: netem ${cfg.impair ?? "delay 20ms"} rate ${cfg.rate} limit ${queuePackets(cfg.rate, cfg.queueMs ?? 150)}`,
    `tc filter add dev lo parent 1: protocol ip prio ${band} u32 match ip protocol 17 0xff match ${match} flowid 1:${band}`,
  ];
  const script = [
    "apk add -q iproute2 >/dev/null 2>&1 || true",
    "tc qdisc del dev lo root 2>/dev/null || true",
    "tc qdisc add dev lo root handle 1: prio bands 3 priomap 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1",
    ...(viewer ? leg(1, viewer, "ip sport 7882 0xffff") : []),
    ...(presenter ? leg(3, presenter, "ip dport 7882 0xffff") : []),
    "tc -s qdisc show dev lo",
  ].join(" && ");
  return execFileSync(
    "docker",
    ["run", "--rm", "--name", SHAPER, "--net", `container:${CONTAINER}`, "--cap-add", "NET_ADMIN", "alpine:3.20", "sh", "-c", script],
    { encoding: "utf8" },
  );
}

/** What left each shaped leg, for the record. */
export function shapeStats() {
  return spawnSync(
    "docker",
    ["run", "--rm", "--net", `container:${CONTAINER}`, "--cap-add", "NET_ADMIN", "alpine:3.20", "sh", "-c",
      "apk add -q iproute2 >/dev/null 2>&1; tc -s qdisc show dev lo"],
    { encoding: "utf8" },
  ).stdout;
}

function b64url(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value))
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function token(room, identity, video) {
  const nowS = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: "HS256", typ: "JWT" });
  const body = b64url({
    iss: KEY,
    sub: identity,
    name: identity,
    nbf: nowS - 10,
    exp: nowS + 6 * 3600,
    video: video ?? { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
  });
  const sig = createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64")
    .replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${head}.${body}.${sig}`;
}

/** Who the media server says is in `room` right now (its RoomService API). */
export async function participantCount(room) {
  const res = await fetch(`http://127.0.0.1:7880/twirp/livekit.RoomService/ListParticipants`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token(room, "rig-admin", { room, roomAdmin: true })}`,
    },
    body: JSON.stringify({ room }),
  });
  if (!res.ok) return null;
  const body = await res.json();
  return Array.isArray(body.participants) ? body.participants.length : 0;
}

/** Wait until the room holds at least `want` participants, or throw. */
export async function waitForParticipants(room, want, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  let seen = null;
  while (Date.now() < until) {
    seen = await participantCount(room).catch(() => null);
    if (seen !== null && seen >= want) return seen;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`room ${room} reached ${seen ?? "no answer"} of ${want} participants`);
}

export function harnessUrl(base, query) {
  const q = new URLSearchParams({ url: SFU_URL, ...query });
  return `${base}/e2e/share-fast-start/harness.html?${q}`;
}

/**
 * From a viewer's samples: when the first frame was decoded, and when the
 * received picture reached `target` lines and STAYED there (every later
 * sample at or above it), in ms from the moment the page started joining.
 */
export function summarise(sfs, target) {
  const viewer = sfs.samples;
  const first = viewer.find((s) => s.framesDecoded > 0);
  let reached = null;
  for (const s of viewer) {
    if (s.h === null || s.framesDecoded === 0) continue;
    if (s.h >= target) {
      reached ??= s.t;
    } else {
      reached = null;
    }
  }
  const heights = [];
  for (const s of viewer) {
    if (s.h === null || s.framesDecoded === 0) continue;
    const last = heights.at(-1);
    if (!last || last.h !== s.h) heights.push({ t: s.t, h: s.h });
  }
  const tail = viewer.slice(-20).filter((s) => s.kbps !== null);
  const steadyKbps = tail.length
    ? Math.round(tail.reduce((a, s) => a + s.kbps, 0) / tail.length)
    : null;
  const ev = (name) => sfs.events.find((e) => e.name === name)?.t ?? null;
  return {
    connected: ev("connected"),
    subscribed: ev("screenStream"),
    firstFrame: first?.t ?? null,
    target,
    reachedTarget: reached,
    heights,
    steadyKbps,
    settings: sfs.settings,
  };
}
