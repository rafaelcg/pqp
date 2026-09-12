// Music fan-out under load: N sockets seated in one voice room, one writer
// sending set-music at a fixed rate, every socket timing the echo.
import WebSocket from "ws";
import { execSync } from "node:child_process";

const WS = process.env.WS ?? "ws://localhost:3001/ws";
const CHANNEL = process.env.CHANNEL;
const N = Number(process.env.N ?? 50);
const QUEUE = Number(process.env.QUEUE ?? 50);
if (!CHANNEL) throw new Error("CHANNEL=<voice channel uuid>");

function track(i) {
  return { id: `t${i}`, provider: "youtube", videoId: "dQw4w9WgXcQ", title: `Track ${i} - A reasonably long title like YouTube gives (Official Video)`, sourceUrl: null, thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", durationMs: 213000, addedByUserId: WRITER_USER_ID, addedByName: "Load User 1" };
}

const peers = [];
function connect(i) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    const peer = { i, ws, peerId: null, echoes: [], bytes: 0 };
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: `dev-local-token:ws${i}`, caps: ["voice-roster-delta", "presence-delta", "voice-transport-changed"] })));
    ws.on("message", (raw) => {
      const text = raw.toString(); peer.bytes += text.length;
      let m; try { m = JSON.parse(text); } catch { return; }
      if (m.type === "auth-ok" || m.type === "ready" || m.type === "hello") {
        ws.send(JSON.stringify({ type: "join-voice-room", voiceChannelId: CHANNEL, transports: ["livekit", "mesh"] }));
      }
      if (m.type === "welcome") { peer.peerId = m.peerId; resolve(peer); }
      if (m.type === "voice-join-refused" || m.type === "voice-room-full") reject(new Error(`${i}: ${m.type} ${m.reason ?? ""}`));
      if (m.type === "music") {
        if (m.forced) peer.refused = (peer.refused ?? 0) + 1;
        else if (m.state?.atMs) peer.echoes.push(performance.timeOrigin + performance.now() - m.state.atMs);
      }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error(`${i}: no welcome`)), 15000);
  });
}

function serverCpu() {
  try {
    const pid = execSync("lsof -nP -iTCP:3001 -sTCP:LISTEN -t").toString().trim().split("\n")[0];
    const out = execSync(`ps -o %cpu=,rss= -p ${pid}`).toString().trim().split(/\s+/);
    return { cpu: Number(out[0]), rssMb: Math.round(Number(out[1]) / 1024) };
  } catch { return { cpu: NaN, rssMb: NaN }; }
}

const API = process.env.API ?? "http://localhost:3001";
for (let i = 1; i <= N; i++) {
  const token = `dev-local-token:ws${i}`;
  await fetch(`${API}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  await fetch(`${API}/api/me/age-check`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ dateOfBirth: "1990-01-01" }) });
  await new Promise((r) => setTimeout(r, 30));
}
// Dev identities are not members of the Sandbox by themselves; seat them.
execSync(`psql postgresql://pqp:pqp@localhost:5432/pqp -q -c "insert into server_members (server_id, user_id, role) select c.server_id, u.id, 'member' from users u, channels c where c.id='${CHANNEL}' and u.clerk_id like 'dev_local_user_ws%' on conflict do nothing"`);
// The writer manages the music (admin rank resolves to every bit); everyone else is a member.
execSync(`psql postgresql://pqp:pqp@localhost:5432/pqp -q -c "update server_members set role='admin' where user_id=(select id from users where clerk_id='dev_local_user_ws1')"`);
const me = await (await fetch(`${API}/api/me`, { headers: { Authorization: "Bearer dev-local-token:ws1" } })).json();
const WRITER_USER_ID = me.id;
const queue = Array.from({ length: QUEUE }, (_, i) => track(i + 1));
console.log(`connecting ${N} sockets into ${CHANNEL} ...`);
const t0 = performance.now();
const settled = await Promise.allSettled(Array.from({ length: N }, (_, i) => connect(i + 1)));
for (const s of settled) if (s.status === "fulfilled") peers.push(s.value); else console.log("  join failed:", s.reason.message);
console.log(`  ${peers.length}/${N} seated in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
if (peers.length === 0) process.exit(1);

const writer = peers[0];
let rev = 0;
function write() {
  rev += 1;
  const state = { current: track(0), queue, status: "playing", positionMs: rev * 1000, atMs: Date.now(), rev, actorId: writer.peerId };
  writer.ws.send(JSON.stringify({ type: "set-music", state }));
  return JSON.stringify(state).length;
}

function pct(arr, p) { const s = [...arr].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) : NaN; }

for (const rate of [1, 5, 10]) {
  for (const p of peers) { p.echoes = []; p.bytes = 0; }
  const cpuBefore = serverCpu();
  const seconds = 10; let sentBytes = 0; let sent = 0;
  const start = performance.now();
  for (let i = 0; i < rate * seconds; i++) {
    const at = start + i * (1000 / rate); const wait = at - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    // Alternate structural (queue changes) and position-only writes: the
    // server coalesces position-only ones past its budget.
    if (i % 2 === 0) queue.push(queue.shift());
    sentBytes += write(); sent += 1;
  }
  await new Promise((r) => setTimeout(r, 1500));
  const cpuAfter = serverCpu();
  const all = peers.flatMap((p) => p.echoes);
  const received = peers.map((p) => p.echoes.length);
  const bytes = peers.reduce((a, p) => a + p.bytes, 0);
  console.log(`\n== ${rate} writes/s for ${seconds}s, ${peers.length} sockets, queue ${QUEUE}`);
  const refused = peers.reduce((a, p) => a + (p.refused ?? 0), 0);
  if (refused) console.log(`   REFUSED writes seen: ${refused}`);
  console.log(`   sent ${sent} writes (${Math.round(sentBytes / sent)} bytes each); echoes per socket min=${Math.min(...received)} max=${Math.max(...received)} (coalesced position-only writes are not echoed)`);
  console.log(`   fan-out latency ms (write stamped -> echo seen): p50=${pct(all, 0.5)} p95=${pct(all, 0.95)} p99=${pct(all, 0.99)} max=${Math.round(Math.max(...all))}`);
  console.log(`   bytes to all sockets: ${(bytes / 1024).toFixed(0)} KB total, ${(bytes / peers.length / seconds / 1024).toFixed(1)} KB/s per socket`);
  console.log(`   server: cpu ${cpuBefore.cpu}% -> ${cpuAfter.cpu}%, rss ${cpuAfter.rssMb} MB`);
}
for (const p of peers) p.ws.close();
process.exit(0);
