/**
 * DO REAL BROWSERS DECODE THE SHARED FRAME? Chromium, Firefox and WebKit, each
 * through Playwright, against a real `ws` server built with the shipped
 * `WS_PER_MESSAGE_DEFLATE` and `ws_shared_deflate` on.
 *
 * The page opens SOCKETS WebSockets (enough for the shared path to engage).
 * Once all are open the server sends a fixed script: shared broadcasts of
 * roster-sized frames through `broadcastEncoded`, small ones (never
 * compressed), and ordinary per-socket compressed sends, interleaved in both
 * orders, including an ordinary send immediately before a broadcast (so that
 * socket's sender is busy and must fall back). Every socket in the page
 * records every text it receives; the script then compares, per socket, the
 * exact list against what the server sent, and reports the shared path's
 * counters so a run where nothing was actually shared cannot pass.
 *
 * Browsers decide for themselves what to offer: Chromium offers
 * `client_max_window_bits`, Firefox and WebKit a bare `permessage-deflate`.
 * Whether a browser keeps its inflate window across messages is its own
 * business, and a fresh-context frame decodes either way; this is the check
 * that the theory survives the real inflaters.
 *
 *   pnpm --filter @pqp/server exec tsx ../tools/ws-shared-deflate-bench/browser-decode.mts
 *
 * Uses the client package's Playwright and whatever browsers it has
 * installed; a browser that is missing is reported as skipped, not passed.
 */
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

process.env.WS_SHARED_DEFLATE = "true";

const SOCKETS = 12;
const ws = createRequire(new URL("../../server/package.json", import.meta.url))(
  "ws",
) as typeof import("ws");
const playwright = createRequire(new URL("../../client/package.json", import.meta.url))(
  "@playwright/test",
) as typeof import("@playwright/test");

const { WS_PER_MESSAGE_DEFLATE } = await import("../../server/src/lib/ws-compression.ts");
const { broadcastEncoded } = await import("../../server/src/ws/fanout.ts");
const { resetSharedDeflateStats, sharedDeflateStats } = await import(
  "../../server/src/lib/ws-shared-deflate.ts"
);

function roster(seq: number, people: number): string {
  const participants = [];
  for (let i = 0; i < people; i += 1) {
    participants.push({
      peerId: randomUUID(),
      userId: randomUUID(),
      displayName: `player_${randomBytes(4).toString("hex")}`,
      avatarUrl: `https://img.example/${randomBytes(13).toString("hex")}`,
      muted: i % 3 === 0,
      handRaisedAt: i % 4 === 0 ? 1_700_000_000_000 + i : null,
    });
  }
  return JSON.stringify({ type: "voice-roster", seq, participants });
}

const page = `<!doctype html><meta charset="utf-8"><script>
window.received = [];
window.ready = new Promise((resolve, reject) => {
  let open = 0;
  for (let i = 0; i < ${SOCKETS}; i += 1) {
    const list = [];
    window.received.push(list);
    const socket = new WebSocket("ws://" + location.host + "/ws?i=" + i);
    socket.onmessage = (event) => list.push(event.data);
    socket.onerror = () => { list.push("<error>"); reject(new Error("socket " + i + " failed")); };
    socket.onclose = (event) => list.push("<close " + event.code + ">");
    socket.onopen = () => { if (++open === ${SOCKETS}) resolve(); };
  }
});
</script>`;

const http = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(page);
});
const wss = new ws.WebSocketServer({ server: http, perMessageDeflate: WS_PER_MESSAGE_DEFLATE });
await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", () => resolve()));
const port = (http.address() as AddressInfo).port;

async function runBrowser(name: "chromium" | "firefox" | "webkit") {
  let browser;
  try {
    browser = await playwright[name].launch();
  } catch (error) {
    return { browser: name, skipped: String(error).split("\n")[0] };
  }
  const sockets: Array<{ index: number; socket: import("ws").WebSocket; extensions: string }> = [];
  const onConnection = (socket: import("ws").WebSocket, req: import("node:http").IncomingMessage) => {
    const index = Number(new URL(req.url ?? "/", "http://x").searchParams.get("i"));
    sockets.push({ index, socket, extensions: socket.extensions });
  };
  wss.on("connection", onConnection);
  try {
    const tab = await browser.newPage();
    await tab.goto(`http://127.0.0.1:${port}/`);
    await tab.evaluate("window.ready");
    while (sockets.length < SOCKETS) await new Promise((r) => setTimeout(r, 10));
    sockets.sort((a, b) => a.index - b.index);
    const targets = sockets.map((s) => s.socket);
    const expected: string[][] = sockets.map(() => []);
    const broadcast = (text: string) => {
      broadcastEncoded(targets, Buffer.from(text));
      for (const list of expected) list.push(text);
    };
    const ordinary = (i: number, text: string) => {
      targets[i]!.send(text);
      expected[i]!.push(text);
    };
    resetSharedDeflateStats();
    let seq = 0;
    for (let round = 0; round < 6; round += 1) {
      broadcast(roster(seq++, 60 + round * 40));
      // Ordinary compressed sends, then a broadcast right behind them: those
      // sockets' senders are busy and must queue the broadcast, not race it.
      for (let i = 0; i < SOCKETS; i += 3) ordinary(i, roster(seq++, 10));
      broadcast(roster(seq++, 120));
      broadcast(JSON.stringify({ type: "typing", seq: seq++ }));
      for (let i = 1; i < SOCKETS; i += 2) ordinary(i, JSON.stringify({ type: "small", seq: seq++ }));
      broadcast(roster(seq++, 250));
      await new Promise((r) => setTimeout(r, 20));
    }
    const want = expected.map((list) => list.length);
    await tab.waitForFunction(
      `window.received.every((list, i) => list.length >= ${JSON.stringify(want)}[i])`,
      undefined,
      { timeout: 20_000 },
    );
    const received = (await tab.evaluate("window.received")) as string[][];
    const mismatches = received.filter(
      (list, i) => JSON.stringify(list) !== JSON.stringify(expected[i]),
    ).length;
    const stats = sharedDeflateStats();
    return {
      browser: name,
      version: browser.version(),
      negotiated: sockets[0]!.extensions,
      frames: expected.reduce((n, list) => n + list.length, 0),
      socketsMismatched: mismatches,
      sharedSockets: stats.sockets,
      compressions: stats.compressions,
      senderBusyFallbacks: stats.fallbacks.senderBusy,
      ok: mismatches === 0 && stats.sockets > 0 && stats.fallbacks.verifyFailed === 0,
    };
  } finally {
    wss.off("connection", onConnection);
    for (const s of sockets) s.socket.terminate();
    await browser.close();
  }
}

const results = [];
for (const name of ["chromium", "firefox", "webkit"] as const) {
  results.push(await runBrowser(name));
}
console.log(JSON.stringify(results, null, 2));
wss.close();
http.close();
process.exit(results.every((r) => "skipped" in r || r.ok) ? 0 : 1);
