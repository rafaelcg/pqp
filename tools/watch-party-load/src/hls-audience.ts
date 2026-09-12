/* eslint-disable no-console -- this is a command-line load harness. */
import { readFileSync, writeFileSync } from "node:fs";

/**
 * A load harness for the OTHER half of a watch party: not the presenter's
 * WebRTC publish (that's `index.ts`), but the audience polling the HLS
 * playlist proxy (`server/src/voice/hls-playlist-proxy.ts`) the way hls.js
 * 1.7 actually does it. It exists to answer one question before a real
 * party: does the proxy (Postgres lookup + render cache + presigned segment
 * URLs) hold up with hundreds of viewers polling every ~2 s, independent of
 * LiveKit or the mesh path entirely.
 *
 * SAFETY, NOT CONFIGURATION: this generates hundreds of real HTTP viewers
 * against a real deployment. `assertSafeUrl` refuses `pqp.gg` / `api.pqp.gg`
 * (and any `*.pqp.gg` host) unless `--allow-production` is passed. This is
 * the only lock in this file; do not relax it "just to check something
 * quickly".
 */

// ------------------------------------------------------------------ options

type Options = {
  masterUrl: URL;
  tokensFile: string;
  viewers: number;
  seconds: number;
  rampSeconds: number;
  fetchSegments: boolean;
  out: string;
  allowProduction: boolean;
};

function arg(name: string, fallback = ""): string {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : (process.argv[at + 1] ?? "");
}
function has(name: string): boolean {
  return process.argv.includes(name);
}
function requiredArg(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function numberArg(name: string, fallback: number): number {
  const value = Number(arg(name, String(fallback)));
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}
function boolArg(name: string, fallback: boolean): boolean {
  const value = arg(name, fallback ? "true" : "false");
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
  return value === "true";
}

const PROD_SUFFIX = ".pqp.gg";
const STAGING_HOST = "pqp-api-staging.fly.dev";
function assertSafeUrl(url: URL, allowProduction: boolean): void {
  const host = url.hostname.toLowerCase();
  const isProd = host === "pqp.gg" || host === "api.pqp.gg" || host.endsWith(PROD_SUFFIX);
  if (isProd && host !== STAGING_HOST && !allowProduction) {
    throw new Error(`refusing to target production host "${host}" (pass --allow-production to override)`);
  }
}

function readOptions(): Options {
  const masterUrl = new URL(requiredArg("--url"));
  if (masterUrl.searchParams.has("t")) throw new Error("--url must not already carry a ?t= token; each viewer gets its own");
  const allowProduction = has("--allow-production");
  assertSafeUrl(masterUrl, allowProduction);
  const tokensFile = requiredArg("--tokens");
  const viewers = numberArg("--viewers", 50);
  const seconds = numberArg("--seconds", 120);
  const rampSeconds = numberArg("--ramp-seconds", 20);
  const fetchSegments = boolArg("--segments", true);
  const out = arg("--out", `./hls-audience-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  return { masterUrl, tokensFile, viewers, seconds, rampSeconds, fetchSegments, out, allowProduction };
}

function readTokens(path: string): string[] {
  const lines = readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error(`${path} contains no tokens`);
  return lines;
}

// ---------------------------------------------------------------- semaphore

/** Bounds global in-flight segment fetches so the harness box, not the
 * proxy, sets the ceiling. Playlist polls are never gated by this. */
function createSemaphore(max: number): () => Promise<() => void> {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = (): void => {
    active--;
    const next = queue.shift();
    if (next) next();
  };
  return () =>
    new Promise<() => void>((resolve) => {
      const tryAcquire = (): void => {
        if (active < max) {
          active++;
          resolve(release);
        } else {
          queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// --------------------------------------------------------------- m3u8 parse

/**
 * Picks the LAST `#EXT-X-STREAM-INF` variant, matching hls.js's default ABR
 * behaviour and `buildMasterPlaylist`'s "highest bitrate last" ordering.
 * Root-relative URIs resolve against the master's origin; absolute ones
 * (or ones that already carry their own `?t=`) resolve unchanged.
 */
function parseMasterVariant(text: string, baseUrl: URL): URL | null {
  const lines = text.split("\n").map((line) => line.trim());
  let lastUri: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith("#EXT-X-STREAM-INF")) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j]!;
      if (candidate.length === 0) continue;
      if (candidate.startsWith("#")) break;
      lastUri = candidate;
      break;
    }
  }
  return lastUri ? new URL(lastUri, baseUrl) : null;
}

type MediaSegment = { seq: number; url: URL };
type MediaPlaylist = { mediaSequence: number; targetDuration: number | null; segments: MediaSegment[] };

function parseMediaPlaylist(text: string, baseUrl: URL): MediaPlaylist {
  const lines = text.split("\n").map((line) => line.trim());
  let mediaSequence = 0;
  let targetDuration: number | null = null;
  const uris: string[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const value = Number(line.slice("#EXT-X-MEDIA-SEQUENCE:".length));
      if (Number.isFinite(value)) mediaSequence = value;
    } else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      const value = Number(line.slice("#EXT-X-TARGETDURATION:".length));
      if (Number.isFinite(value) && value > 0) targetDuration = value;
    } else if (!line.startsWith("#")) {
      uris.push(line);
    }
  }
  const segments = uris.map((uri, index) => ({ seq: mediaSequence + index, url: new URL(uri, baseUrl) }));
  return { mediaSequence, targetDuration, segments };
}

// ------------------------------------------------------------------ metrics

type Kind = "master" | "media" | "segment";
const KINDS: Kind[] = ["master", "media", "segment"];

class Metrics {
  totalByKind: Record<Kind, number> = { master: 0, media: 0, segment: 0 };
  statusByKind: Record<Kind, Record<string, number>> = { master: {}, media: {}, segment: {} };
  latenciesByKind: Record<Kind, number[]> = { master: [], media: [], segment: [] };
  bytesByKind: Record<Kind, number> = { master: 0, media: 0, segment: 0 };
  errorsByKind: Record<Kind, number> = { master: 0, media: 0, segment: 0 };
  sinceLastPrint: { countByKind: Record<Kind, number>; segmentBytes: number } = {
    countByKind: { master: 0, media: 0, segment: 0 },
    segmentBytes: 0,
  };

  record(kind: Kind, status: number, ms: number, bytes: number): void {
    this.totalByKind[kind]++;
    const key = String(status);
    this.statusByKind[kind][key] = (this.statusByKind[kind][key] ?? 0) + 1;
    this.latenciesByKind[kind].push(ms);
    this.bytesByKind[kind] += bytes;
    if (status < 200 || status >= 300) this.errorsByKind[kind]++;
    this.sinceLastPrint.countByKind[kind]++;
    if (kind === "segment") this.sinceLastPrint.segmentBytes += bytes;
  }

  resetPrintWindow(): void {
    this.sinceLastPrint = { countByKind: { master: 0, media: 0, segment: 0 }, segmentBytes: 0 };
  }
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}

// ----------------------------------------------------------------- fetching

const FETCH_TIMEOUT_MS = 15_000;

async function timedGet(url: string): Promise<{ status: number; ms: number; bytes: number; text: string }> {
  const start = Date.now();
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const buf = await res.arrayBuffer();
    return { status: res.status, ms: Date.now() - start, bytes: buf.byteLength, text: new TextDecoder().decode(buf) };
  } catch {
    return { status: 0, ms: Date.now() - start, bytes: 0, text: "" };
  }
}

async function timedGetDrain(url: string): Promise<{ status: number; ms: number; bytes: number }> {
  const start = Date.now();
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const buf = await res.arrayBuffer();
    return { status: res.status, ms: Date.now() - start, bytes: buf.byteLength };
  } catch {
    return { status: 0, ms: Date.now() - start, bytes: 0 };
  }
}

function withToken(url: URL, token: string): URL {
  const withT = new URL(url.toString());
  withT.searchParams.set("t", token);
  return withT;
}

// ------------------------------------------------------------------ viewer

type ViewerResult = {
  index: number;
  started: boolean;
  finished: boolean;
  fatal?: string;
  windowMisses: number;
  stuckEvents: number;
  maxStuckGapMs: number;
  playlistErrors: number;
  segmentErrors: number;
  segmentsFetched: number;
  segmentBytes: number;
  mediaPolls: number;
};

type RunnerCtx = {
  metrics: Metrics;
  endAt: number;
  fetchSegments: boolean;
  acquireSegmentSlot: () => Promise<() => void>;
};

const DEFAULT_POLL_MS = 2000;
const STUCK_THRESHOLD_MS = 6000;

async function runViewer(ctx: RunnerCtx, index: number, token: string, masterUrl: URL, startDelayMs: number): Promise<ViewerResult> {
  const result: ViewerResult = {
    index,
    started: false,
    finished: false,
    windowMisses: 0,
    stuckEvents: 0,
    maxStuckGapMs: 0,
    playlistErrors: 0,
    segmentErrors: 0,
    segmentsFetched: 0,
    segmentBytes: 0,
    mediaPolls: 0,
  };

  await sleep(startDelayMs);
  if (Date.now() >= ctx.endAt) {
    result.finished = true;
    return result;
  }
  result.started = true;

  // 1. Master playlist, once, with this viewer's own token.
  const taggedMasterUrl = withToken(masterUrl, token);
  const masterRes = await timedGet(taggedMasterUrl.toString());
  ctx.metrics.record("master", masterRes.status, masterRes.ms, masterRes.bytes);
  if (masterRes.status !== 200) {
    result.playlistErrors++;
    result.fatal = `master playlist ${masterRes.status || "network error"}`;
    result.finished = true;
    return result;
  }
  const mediaUrl = parseMasterVariant(masterRes.text, taggedMasterUrl);
  if (!mediaUrl) {
    result.playlistErrors++;
    result.fatal = "master playlist had no #EXT-X-STREAM-INF variant";
    result.finished = true;
    return result;
  }

  // 2. Media playlist, polled roughly every target-duration seconds
  // (default 2 s until the first playlist says otherwise), timed from the
  // end of the previous load so a slow proxy does not stack requests.
  let pollMs = DEFAULT_POLL_MS;
  let nextSeq: number | null = null;
  let lastMediaSeq: number | null = null;
  let lastSeqChangeAt = Date.now();
  let currentlyStuck = false;

  while (Date.now() < ctx.endAt) {
    const loadStart = Date.now();
    const mediaRes = await timedGet(mediaUrl.toString());
    ctx.metrics.record("media", mediaRes.status, mediaRes.ms, mediaRes.bytes);
    result.mediaPolls++;
    if (mediaRes.status !== 200) {
      result.playlistErrors++;
    } else {
      const parsed = parseMediaPlaylist(mediaRes.text, mediaUrl);
      if (parsed.targetDuration !== null) pollMs = parsed.targetDuration * 1000;

      if (parsed.mediaSequence === lastMediaSeq) {
        const gap = loadStart - lastSeqChangeAt;
        if (gap > STUCK_THRESHOLD_MS) {
          result.maxStuckGapMs = Math.max(result.maxStuckGapMs, gap);
          if (!currentlyStuck) {
            result.stuckEvents++;
            currentlyStuck = true;
          }
        }
      } else {
        lastMediaSeq = parsed.mediaSequence;
        lastSeqChangeAt = loadStart;
        currentlyStuck = false;
      }

      if (parsed.segments.length > 0) {
        const firstSeq = parsed.segments[0]!.seq;
        const lastSeq = parsed.segments[parsed.segments.length - 1]!.seq;
        const thirdFromLast = parsed.segments[Math.max(0, parsed.segments.length - 3)]!.seq;

        if (nextSeq === null) {
          nextSeq = thirdFromLast;
        } else if (nextSeq < firstSeq) {
          result.windowMisses++;
          nextSeq = thirdFromLast;
        }

        if (ctx.fetchSegments) {
          const toFetch = parsed.segments.filter((segment) => segment.seq >= nextSeq!);
          for (const segment of toFetch) {
            const release = await ctx.acquireSegmentSlot();
            try {
              const segRes = await timedGetDrain(segment.url.toString());
              ctx.metrics.record("segment", segRes.status, segRes.ms, segRes.bytes);
              if (segRes.status === 200) {
                result.segmentsFetched++;
                result.segmentBytes += segRes.bytes;
              } else {
                result.segmentErrors++;
              }
            } finally {
              release();
            }
          }
        }
        nextSeq = lastSeq + 1;
      }
    }

    const elapsed = Date.now() - loadStart;
    const wait = Math.min(Math.max(0, pollMs - elapsed), Math.max(0, ctx.endAt - Date.now()));
    await sleep(wait);
  }

  result.finished = true;
  return result;
}

// ------------------------------------------------------------------- print

function fmtPercentiles(values: number[]): { p50: number | null; p95: number | null; p99: number | null } {
  return { p50: percentile(values, 50), p95: percentile(values, 95), p99: percentile(values, 99) };
}

function printProgress(metrics: Metrics, activeViewers: number, windowMissesTotal: number, intervalSeconds: number): void {
  const reqPerSec: Record<Kind, string> = { master: "0", media: "0", segment: "0" };
  for (const kind of KINDS) reqPerSec[kind] = (metrics.sinceLastPrint.countByKind[kind] / intervalSeconds).toFixed(1);
  const mbit = ((metrics.sinceLastPrint.segmentBytes * 8) / 1_000_000 / intervalSeconds).toFixed(2);
  const mediaLatency = fmtPercentiles(metrics.latenciesByKind.media);
  const segmentLatency = fmtPercentiles(metrics.latenciesByKind.segment);
  console.error(
    JSON.stringify({
      at: new Date().toISOString(),
      activeViewers,
      reqPerSec,
      errors: metrics.errorsByKind,
      mediaLatencyMs: mediaLatency,
      segmentLatencyMs: segmentLatency,
      windowMissesTotal,
      segmentMbps: mbit,
    }),
  );
  metrics.resetPrintWindow();
}

// --------------------------------------------------------------------- run

async function run(): Promise<void> {
  const options = readOptions();
  const allTokens = readTokens(options.tokensFile);
  const viewerCount = Math.min(options.viewers, allTokens.length);
  if (viewerCount < allTokens.length) {
    console.error(`note: --viewers ${options.viewers} exceeds ${allTokens.length} tokens in ${options.tokensFile}; using ${viewerCount}`);
  }
  const tokens = allTokens.slice(0, viewerCount);

  const metrics = new Metrics();
  const acquireSegmentSlot = createSemaphore(64);
  const startedAt = Date.now();
  const endAt = startedAt + options.seconds * 1000;
  const ctx: RunnerCtx = { metrics, endAt, fetchSegments: options.fetchSegments, acquireSegmentSlot };

  console.error(
    JSON.stringify({
      event: "start",
      url: options.masterUrl.toString(),
      viewers: viewerCount,
      seconds: options.seconds,
      rampSeconds: options.rampSeconds,
      fetchSegments: options.fetchSegments,
    }),
  );

  const startTimes: number[] = tokens.map((_, index) => Math.round((index / Math.max(1, viewerCount)) * options.rampSeconds * 1000));
  let windowMissesTotal = 0;
  const activeAt = () => startTimes.filter((delay, i) => startedAt + delay <= Date.now() && !viewerResults[i]?.finished).length;
  const viewerResults: (ViewerResult | undefined)[] = new Array(viewerCount);

  const printTimer = setInterval(() => {
    windowMissesTotal = viewerResults.reduce((sum, r) => sum + (r?.windowMisses ?? 0), 0);
    printProgress(metrics, activeAt(), windowMissesTotal, 10);
  }, 10_000);

  const viewerPromises = tokens.map(async (token, index) => {
    const result = await runViewer(ctx, index, token, options.masterUrl, startTimes[index]!);
    viewerResults[index] = result;
    return result;
  });

  await Promise.all(viewerPromises);
  clearInterval(printTimer);

  const finalWindowMisses = viewerResults.reduce((sum, r) => sum + (r?.windowMisses ?? 0), 0);
  const finalStuckEvents = viewerResults.reduce((sum, r) => sum + (r?.stuckEvents ?? 0), 0);
  const missHistogram: Record<string, number> = {};
  for (const r of viewerResults) {
    if (!r) continue;
    const key = String(r.windowMisses);
    missHistogram[key] = (missHistogram[key] ?? 0) + 1;
  }
  const endedAt = Date.now();

  const summary = {
    config: {
      url: options.masterUrl.toString(),
      tokensFile: options.tokensFile,
      viewers: viewerCount,
      requestedViewers: options.viewers,
      tokensAvailable: allTokens.length,
      seconds: options.seconds,
      rampSeconds: options.rampSeconds,
      fetchSegments: options.fetchSegments,
      allowProduction: options.allowProduction,
    },
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - startedAt,
    totals: {
      requestsByKind: metrics.totalByKind,
      bytesByKind: metrics.bytesByKind,
      errorsByKind: metrics.errorsByKind,
    },
    percentilesMs: {
      master: fmtPercentiles(metrics.latenciesByKind.master),
      media: fmtPercentiles(metrics.latenciesByKind.media),
      segment: fmtPercentiles(metrics.latenciesByKind.segment),
    },
    statusCounts: metrics.statusByKind,
    windowMisses: { total: finalWindowMisses, byViewerHistogram: missHistogram },
    stuckEvents: { total: finalStuckEvents },
    viewers: viewerResults,
  };

  writeFileSync(options.out, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
  console.error(`wrote ${options.out}`);
}

const USAGE = [
  "usage: pnpm exec tsx src/hls-audience.ts --url <master playlist URL, no ?t=> --tokens <file>",
  "         [--viewers N=50] [--seconds S=120] [--ramp-seconds R=20]",
  "         [--segments true|false=true] [--out <file>] [--allow-production]",
].join("\n");

if (has("--help") || has("-h")) {
  console.log(USAGE);
} else {
  try {
    await run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exitCode = 1;
  }
}
