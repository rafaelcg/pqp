/**
 * A stand-in for `pqp-api`, real enough to run the actual `src/bot.js` binary
 * against: real HTTP, a real WebSocket over real TCP, real frames.
 *
 * ── WHY THIS EXISTS AND WHY IT IS NOT A TEST ────────────────────────────────
 *
 * The bug this bot had on 2026-08-23 was a DROPPED SOCKET, and there is no way
 * to ask a real server to drop one on demand — you can restart the API, which
 * is not the same event and is not something to do to production to check a
 * client. A local dev stack is closer but still cannot produce a TCP reset with
 * no close frame, which is what a proxy reap actually looks like from inside
 * the process.
 *
 * So: forty lines of WebSocket framing and a control plane that can. It speaks
 * only the handful of routes and frames the bot uses (`/api/me`, `/api/servers`,
 * `auth` → `ready`, `ping` → `pong`, `message-create` → `message-broadcast`),
 * which is the point — it is a fixture, not a second implementation of pqp, and
 * it must never grow into one. The unit tests in `test/socket.test.js` cover
 * the same failures with a fake WebSocket; this covers the whole binary,
 * including the parts (identity, channel resolution, the answer loop, the
 * heartbeat) that a fake socket cannot reach.
 *
 * ── THE REPRODUCTION ────────────────────────────────────────────────────────
 *
 *   node tools/support-bot/scripts/fake-pqp.mjs &
 *
 *   cd tools/support-bot
 *   PQP_API_URL=http://127.0.0.1:4599 SUPPORT_STATE_DIR=/tmp/support-repro \
 *     SUPPORT_COOLDOWN_MS=0 SUPPORT_HEARTBEAT_MS=4000 \
 *     node src/bot.js --watch --canned
 *
 *   curl -s 'http://127.0.0.1:4599/control/say?body=@manual_bot+da+pra+aumentar+a+qualidade+da+tela%3F'
 *   curl -sX POST http://127.0.0.1:4599/control/drop     # the reap
 *   curl -s 'http://127.0.0.1:4599/control/say?body=@manual_bot+e+no+iphone%3F'
 *
 * Before the reconnect landed, the second question produced NOTHING: no answer,
 * no log line, no exit, no restart. That silence is the whole bug.
 *
 * Control plane:
 *   GET/POST /control/say?body=...  broadcast an inbound message from "ana"
 *   POST     /control/drop          destroy every live socket, no close frame
 *   GET      /control/state         { sockets, drops }
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PORT = Number(process.env.PORT ?? 4599);

const live = new Set();
let drops = 0;
let msgSeq = 0;

function frame(payload) {
  const data = Buffer.from(payload, "utf8");
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  }
  return Buffer.concat([header, data]);
}

function send(sock, obj) {
  if (!sock.destroyed) sock.write(frame(JSON.stringify(obj)));
}

function broadcast(obj) {
  for (const s of live) send(s, obj);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (obj) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (url.pathname === "/api/me") {
    return json({
      id: "bot-user",
      username: "manual_bot",
      displayName: "manual [bot]",
      ageGate: "passed",
    });
  }
  if (url.pathname === "/api/me/age-check") return json({});
  if (url.pathname === "/api/servers") {
    return json({ servers: [{ id: "s1", name: "QG do pqp" }] });
  }
  if (url.pathname === "/api/servers/s1/channels") {
    return json({ channels: [{ id: "c1", name: "ajuda", type: "text" }] });
  }
  if (url.pathname === "/control/say") {
    msgSeq += 1;
    broadcast({
      type: "message-broadcast",
      message: {
        id: `m${msgSeq}`,
        channelId: "c1",
        authorId: "ana",
        authorName: "ana",
        body: url.searchParams.get("body") ?? "@manual_bot oi",
      },
    });
    return json({ ok: true, sockets: live.size });
  }
  if (url.pathname === "/control/drop") {
    drops += 1;
    const n = live.size;
    for (const s of live) s.destroy(); // no close frame: exactly what a reap looks like
    live.clear();
    return json({ dropped: n });
  }
  if (url.pathname === "/control/state") {
    return json({ sockets: live.size, drops });
  }
  res.writeHead(404).end("{}");
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  live.add(socket);
  socket.on("close", () => live.delete(socket));
  socket.on("error", () => live.delete(socket));

  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      }
      const maskStart = offset;
      if (masked) offset += 4;
      if (buf.length < offset + len) return;
      const payload = Buffer.from(buf.subarray(offset, offset + len));
      if (masked) {
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] ^= buf[maskStart + (i % 4)];
        }
      }
      buf = buf.subarray(offset + len);
      if (opcode === 8) {
        socket.destroy();
        return;
      }
      if (opcode !== 1) continue;
      let f;
      try {
        f = JSON.parse(payload.toString("utf8"));
      } catch {
        continue;
      }
      if (f.type === "auth") send(socket, { type: "ready" });
      else if (f.type === "ping") send(socket, { type: "pong" });
      else if (f.type === "message-create") {
        msgSeq += 1;
        broadcast({
          type: "message-broadcast",
          message: {
            id: `m${msgSeq}`,
            channelId: f.channelId,
            authorId: "bot-user",
            authorName: "manual [bot]",
            body: f.body,
          },
        });
        console.log(`[fake-pqp] BOT POSTED: ${f.body}`);
      }
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[fake-pqp] listening on ${PORT} (run ${randomUUID().slice(0, 8)})`);
});
