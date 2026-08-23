/**
 * The socket that comes back, under the conditions that made it necessary.
 *
 * These drive a fake WebSocket rather than a server, because the interesting
 * events are the ones a real server will not produce on request: a TCP reset
 * with no close frame, an `error` that is never followed by a `close`, and a
 * half-open socket that still reports OPEN while nothing crosses it. Each of
 * those is a real shape — the third is what a proxy reap looks like from inside
 * the process — and each one used to end with the bot alive and deaf.
 *
 * The end-to-end version of this (the real `src/bot.js` binary against a real
 * socket over real TCP) is a manual harness, because it needs a server; see the
 * reproduction notes in `README.md`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ResilientSocket } from "../src/socket.js";
import { PqpSocket } from "../../ambient/src/pqp-client.js";

/** Every socket the code under test has opened, newest last. */
let opened = [];
/** When true, the next socket refuses the connection instead of opening. */
let refuseNext = false;

/**
 * A WebSocket that answers `auth` with `ready` and `ping` with `pong`, and
 * exposes the failures a real one cannot be asked for.
 */
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.answerPings = true;
    this.refuse = refuseNext;
    opened.push(this);
    setTimeout(() => {
      if (this.refuse) {
        this.readyState = 3;
        this.onclose?.({ code: 1006, reason: "refused" });
        return;
      }
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }

  send(raw) {
    const frame = JSON.parse(raw);
    this.sent.push(frame);
    if (frame.type === "auth") {
      this.deliver({ type: "ready" });
    }
    if (frame.type === "ping" && this.answerPings) {
      this.deliver({ type: "pong" });
    }
  }

  deliver(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  /** A reap: the connection is gone, a close event is all anybody gets. */
  kill(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }

  /** An error with NO close behind it — the shape `onerror = () => {}` hid. */
  failSilently() {
    this.onerror?.({ message: "ECONNRESET" });
  }

  close() {
    this.readyState = 3;
  }
}

function makeSocket(overrides = {}) {
  const lines = [];
  const socket = new ResilientSocket({
    wsUrl: "ws://test/ws",
    label: "#ajuda",
    channelId: "c1",
    tokenProvider: () => "character:tok",
    log: (event, fields) => lines.push({ event, ...fields }),
    WebSocketImpl: FakeSocket,
    pingIntervalMs: 20,
    baseDelayMs: 10,
    maxDelayMs: 40,
    jitter: () => 0,
    ...overrides,
  });
  return { socket, lines };
}

async function waitFor(predicate, what, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

test.beforeEach(() => {
  opened = [];
  refuseNext = false;
});

test("a dropped socket is reported, reconnected, and re-joined", async () => {
  const { socket, lines } = makeSocket();
  const seen = [];
  socket.onFrame((f) => seen.push(f));
  await socket.start();

  opened[0].deliver({ type: "message-broadcast", message: { body: "before" } });
  assert.equal(seen.length, 1);

  opened[0].kill();
  await waitFor(() => socket.isOpen(), "the socket to come back");

  // The subscription survived: the caller never re-registered anything.
  opened[1].deliver({ type: "message-broadcast", message: { body: "after" } });
  assert.deepEqual(
    seen.map((f) => f.message.body),
    ["before", "after"],
  );

  // And it is in the right room again. A reconnect that forgets to re-join is
  // a socket that is open and still receives nothing.
  assert.deepEqual(
    opened[1].sent.map((f) => f.type),
    ["auth", "join-channel"],
  );
  assert.equal(opened[1].sent[1].channelId, "c1");

  const events = lines.map((l) => l.event);
  assert.ok(events.includes("socket.closed"), events.join(","));
  assert.ok(events.includes("socket.reconnect"), events.join(","));
  assert.ok(events.includes("socket.reconnected"), events.join(","));
  assert.equal(socket.state().reconnects, 1);
  socket.close();
});

test("an error with no close behind it still counts as a loss", async () => {
  // The exact shape `socket.onerror = () => {}` used to swallow: the process
  // keeps a dead socket, believes it is connected, and never speaks again.
  const { socket } = makeSocket();
  await socket.start();
  opened[0].failSilently();
  await waitFor(() => opened.length === 2 && socket.isOpen(), "recovery from a bare error");
  socket.close();
});

test("a half-open socket is detected by missed pongs", async () => {
  const { socket, lines } = makeSocket();
  await socket.start();
  // Still OPEN as far as the runtime is concerned; simply nothing comes back.
  opened[0].answerPings = false;
  await waitFor(
    () => lines.some((l) => l.event === "socket.stale"),
    "the keepalive to give up on a silent socket",
  );
  await waitFor(() => socket.isOpen() && opened.length === 2, "a replacement socket");
  socket.close();
});

test("failed attempts back off, are logged, and eventually succeed", async () => {
  const { socket, lines } = makeSocket();
  await socket.start();

  refuseNext = true;
  opened[0].kill();
  await waitFor(
    () => lines.filter((l) => l.event === "socket.reconnect.failed").length >= 3,
    "three failed attempts",
  );

  const delays = lines.filter((l) => l.event === "socket.reconnect").map((l) => l.inMs);
  assert.deepEqual(delays.slice(0, 3), [10, 20, 40], "backoff doubles and caps");

  refuseNext = false;
  await waitFor(() => socket.isOpen(), "recovery once the server answers again");
  assert.equal(socket.state().reconnects, 1);
  socket.close();
});

test("close() stops the reconnect loop for good", async () => {
  const { socket, lines } = makeSocket();
  await socket.start();
  socket.close();
  opened[0].kill();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(opened.length, 1, "no replacement socket after a deliberate close");
  assert.equal(
    lines.filter((l) => l.event === "socket.reconnect").length,
    0,
    "a deliberate close must not look like an outage",
  );
});

test("the first connect fails loudly instead of retrying", async () => {
  // A bad token, a renamed channel or a wrong URL does not heal on its own, and
  // a bot that retries one forever is a machine that looks alive while never
  // having worked. Fly restarts a crash; nothing rescues a patient loop.
  refuseNext = true;
  const { socket, lines } = makeSocket();
  await assert.rejects(() => socket.start(), /closed before ready/);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(opened.length, 1, "a failed FIRST connect is not retried");
  assert.equal(lines.filter((l) => l.event === "socket.reconnect").length, 0);
  socket.close();
});

test("a fresh token is resolved for every attempt", async () => {
  let issued = 0;
  const { socket } = makeSocket({ tokenProvider: () => `character:tok${++issued}` });
  await socket.start();
  opened[0].kill();
  await waitFor(() => socket.isOpen(), "reconnect");
  assert.equal(opened[0].sent[0].token, "character:tok1");
  assert.equal(opened[1].sent[0].token, "character:tok2");
  socket.close();
});

test("PqpSocket without a close handler stays dead — the ambient cast's contract", async () => {
  // The regression guard for tools/ambient: a persona whose socket drops goes
  // quiet and is re-cast on the next scene. Nothing added for the support bot
  // may turn that into a reconnect behind the cast's back.
  const bare = new PqpSocket({
    wsUrl: "ws://test/ws",
    token: "t",
    label: "#papo",
    WebSocketImpl: FakeSocket,
  });
  await bare.connect();
  assert.equal(opened.length, 1);
  opened[0].kill();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(opened.length, 1, "the cast must not reconnect");
  assert.equal(bare.isOpen(), false);
});
