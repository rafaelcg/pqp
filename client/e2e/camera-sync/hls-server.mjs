#!/usr/bin/env node
/**
 * Serves `gen.mjs`'s film and camera as two LIVE playlists, the way the
 * playlist proxy serves the ladder and the camera rung beside it.
 *
 * THE TIMELINE. Content time t was "captured" at wall clock `epoch + t`, and
 * every segment's `#EXT-X-PROGRAM-DATE-TIME` says so, on both playlists: the
 * one shared anchor `docs/WATCH_PARTY.md` says the renditions have. A segment
 * becomes listed once it has finished plus its track's pipeline delay
 * (`--film-delay-ms`, `--cam-delay-ms`), which is how two egresses with
 * different start-up and upload times look from the viewer's side. The window
 * is the proxy's: the newest 15 segments.
 *
 * KNOBS FOR THE MEASUREMENT (`POST /control`, JSON):
 *  - `{ "stall": "cam" | "film", "ms": 8000 }`: every segment request of that
 *    track is held for `ms` from now, then answered. A real egress box or CDN
 *    hiccup, as the player sees it: its buffer runs dry and it stalls.
 *  - `{ "camPdtErrorMs": 1500 }`: the camera's PROGRAM-DATE-TIME is off by
 *    that much from the truth, which no player can see. Only for proving what
 *    the sync can and cannot correct.
 *  - `GET /control` answers the current state and the epoch.
 *
 * Usage: node hls-server.mjs --media <dir> [--port 8787] [--preroll-ms 70000]
 *        [--film-delay-ms 1000] [--cam-delay-ms 2500]
 * Local only: it binds 127.0.0.1.
 */
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const WINDOW = 15;

export function startHlsServer({
  media,
  port = 8787,
  prerollMs = 70_000,
  filmDelayMs = 1_000,
  camDelayMs = 2_500,
}) {
  const manifest = JSON.parse(readFileSync(path.join(media, "manifest.json"), "utf8"));
  const state = {
    epoch: Date.now() - prerollMs,
    filmDelayMs,
    camDelayMs,
    camPdtErrorMs: 0,
    stallUntil: { film: 0, cam: 0 },
    requests: { film: 0, cam: 0 },
  };

  /** Each segment's content start (s), from the cumulative EXTINF. */
  function starts(durations, offsetSeconds) {
    const out = [];
    let at = offsetSeconds;
    for (const duration of durations) {
      out.push(at);
      at += duration;
    }
    return out;
  }
  const tracks = {
    film: { durations: manifest.film, starts: starts(manifest.film, 0) },
    cam: {
      durations: manifest.camera,
      starts: starts(manifest.camera, manifest.camPhaseMs / 1000),
    },
  };

  function playlist(track, now) {
    const { durations, starts: begin } = tracks[track];
    const delay = track === "film" ? state.filmDelayMs : state.camDelayMs;
    const pdtError = track === "cam" ? state.camPdtErrorMs : 0;
    const listed = [];
    for (let i = 0; i < durations.length; i += 1) {
      const endWall = state.epoch + (begin[i] + durations[i]) * 1000;
      if (endWall + delay <= now) {
        listed.push(i);
      }
    }
    const window = listed.slice(-WINDOW);
    if (window.length === 0) {
      return null;
    }
    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durations))}`,
      `#EXT-X-MEDIA-SEQUENCE:${window[0]}`,
    ];
    for (const i of window) {
      const pdt = new Date(state.epoch + begin[i] * 1000 + pdtError).toISOString();
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${pdt}`);
      lines.push(`#EXTINF:${durations[i].toFixed(6)},`);
      lines.push(`/seg/${track === "film" ? "film" : "cam"}_${String(i).padStart(5, "0")}.ts`);
    }
    return `${lines.join("\n")}\n`;
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === "/control") {
      if (req.method === "POST") {
        // The knobs are for the spec (Node, no Origin header), never for a
        // page: a browser's cross-origin POST is refused outright, so no tab
        // that happens to be open on this machine can stall the rig.
        if (req.headers.origin) {
          res.writeHead(403).end();
          return;
        }
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          let input;
          try {
            input = body ? JSON.parse(body) : {};
          } catch {
            res.writeHead(400).end();
            return;
          }
          const finite = (value) => typeof value === "number" && Number.isFinite(value);
          if ((input.stall === "cam" || input.stall === "film") && finite(Number(input.ms ?? 0))) {
            state.stallUntil[input.stall] = Date.now() + Number(input.ms ?? 0);
          }
          if (finite(input.camPdtErrorMs)) {
            state.camPdtErrorMs = input.camPdtErrorMs;
          }
          if (finite(input.camDelayMs)) {
            state.camDelayMs = input.camDelayMs;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(state));
        });
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state));
      return;
    }
    const live = /^\/(film|cam)\.m3u8$/.exec(url.pathname);
    if (live) {
      const body = playlist(live[1], Date.now());
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(body);
      return;
    }
    const segment = /^\/seg\/((film|cam)_\d{5}\.ts)$/.exec(url.pathname);
    if (segment) {
      const track = segment[2];
      const file = path.join(media, segment[1]);
      let size;
      try {
        size = statSync(file).size;
      } catch {
        res.writeHead(404).end();
        return;
      }
      state.requests[track] += 1;
      const send = () => {
        if (res.destroyed) {
          // The player gave up on a held request; nothing to answer.
          return;
        }
        res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": size });
        const stream = createReadStream(file);
        // A read that fails ends this one response, never the rig.
        stream.on("error", () => res.destroy());
        stream.pipe(res);
      };
      const holdMs = state.stallUntil[track] - Date.now();
      if (holdMs > 0) {
        setTimeout(send, holdMs);
      } else {
        send();
      }
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, state, port }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const media = arg("media", null);
  if (!media) {
    console.error("usage: node hls-server.mjs --media <dir> [--port 8787]");
    process.exit(2);
  }
  const { port } = await startHlsServer({
    media,
    port: Number(arg("port", 8787)),
    prerollMs: Number(arg("preroll-ms", 70_000)),
    filmDelayMs: Number(arg("film-delay-ms", 1_000)),
    camDelayMs: Number(arg("cam-delay-ms", 2_500)),
  });
  console.log(`camera-sync HLS on http://127.0.0.1:${port} (film.m3u8, cam.m3u8, /control)`);
}
