import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const {
  ARM_TTL_MS,
  CLAIM_TIMEOUT_MS,
  MAX_HOST_CRASHES,
  createShareAudioController,
} = require("./win-share-audio-session.js");

/** A utility process that answers the way `win-share-audio-host.js` does. */
function fakeHost({ selftest = { ok: true, stage: null, hr: 0 }, onStart } = {}) {
  const child = new EventEmitter();
  child.sent = [];
  child.killed = false;
  child.postMessage = (message, ports) => {
    child.sent.push({ message, ports });
    if (message.type === "selftest") {
      queueMicrotask(() => child.emit("message", { type: "selftest", ...selftest }));
    }
    if (message.type === "start") {
      onStart?.(message, (reply) => child.emit("message", { sessionId: message.sessionId, ...reply }));
    }
  };
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

function fakeChannel() {
  const make = (name) => ({ name, closed: false, close() { this.closed = true; } });
  return { port1: make("port1"), port2: make("port2") };
}

function controller(options = {}) {
  const hosts = [];
  const clock = { now: 1_000 };
  const api = createShareAudioController({
    platform: "win32",
    ownPid: 4000,
    now: () => clock.now,
    createChannel: fakeChannel,
    fork: () => {
      const host = fakeHost(options.host);
      hosts.push(host);
      return host;
    },
    ...options.overrides,
  });
  return { api, hosts, clock };
}

const started = (reply) => reply({ type: "session", state: "started", target: { mode: "exclude", reason: "screen" }, autoConvert: true });

describe("status", () => {
  it("is unavailable off Windows without starting anything", async () => {
    let forked = false;
    const api = createShareAudioController({
      platform: "darwin",
      ownPid: 1,
      createChannel: fakeChannel,
      fork: () => {
        forked = true;
      },
    });
    assert.equal((await api.status()).available, false);
    assert.equal(forked, false);
  });

  it("self-tests once in the audio process and caches the answer", async () => {
    const { api, hosts } = controller();
    assert.deepEqual(await api.status(), { available: true, reason: null, stage: null, hr: 0 });
    await api.status();
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].sent.filter((s) => s.message.type === "selftest").length, 1);
    assert.equal(hosts[0].sent[0].message.ownPid, 4000);
  });

  it("reports the failing stage and HRESULT on a build that cannot", async () => {
    const { api } = controller({ host: { selftest: { ok: false, stage: "activate", hr: 0x80070057 } } });
    assert.deepEqual(await api.status(), {
      available: false,
      reason: "activate",
      stage: "activate",
      hr: 0x80070057,
    });
  });
});

describe("arming", () => {
  it("is good for exactly one request", () => {
    const { api } = controller();
    assert.equal(api.consumeArm(), false);
    assert.equal(api.arm(), true);
    assert.equal(api.consumeArm(), true);
    assert.equal(api.consumeArm(), false);
  });

  it("expires, so an old arm cannot turn the box on for a later share", () => {
    const { api, clock } = controller();
    api.arm();
    clock.now += ARM_TTL_MS + 1;
    assert.equal(api.consumeArm(), false);
  });
});

describe("a share's capture", () => {
  it("hands the host one end of the channel and the page the other", async () => {
    const { api, hosts } = controller({ host: { onStart: (_message, reply) => started(reply) } });
    api.start({ sourceId: "screen:0:0" });
    const claim = await api.claim();
    assert.equal(claim.active, true);
    assert.equal(claim.autoConvert, true);
    assert.equal(claim.port.name, "port2");
    const start = hosts[0].sent.find((s) => s.message.type === "start");
    assert.equal(start.message.sourceId, "screen:0:0");
    assert.equal(start.message.ownPid, 4000);
    assert.equal(start.ports[0].name, "port1");
  });

  it("gives the port out once", async () => {
    const { api } = controller({ host: { onStart: (_message, reply) => started(reply) } });
    api.start({ sourceId: "screen:0:0" });
    assert.equal((await api.claim()).active, true);
    assert.deepEqual(await api.claim(), { active: false, reason: "claimed", stage: null, hr: null });
  });

  it("passes a failed activation through with its stage and HRESULT", async () => {
    const { api } = controller({
      host: {
        onStart: (_message, reply) =>
          reply({ type: "session", state: "failed", stage: "activate", hr: 0x88890010 }),
      },
    });
    api.start({ sourceId: "window:1:0" });
    assert.deepEqual(await api.claim(), {
      active: false,
      reason: "failed",
      stage: "activate",
      hr: 0x88890010,
    });
  });

  it("answers none when nothing was started (the box was not ticked)", async () => {
    const { api } = controller();
    assert.equal((await api.claim()).reason, "none");
  });

  it("stops the previous capture when a new share starts", async () => {
    const { api, hosts } = controller({ host: { onStart: () => {} } });
    api.start({ sourceId: "screen:0:0" });
    api.start({ sourceId: "screen:1:0" });
    const types = hosts[0].sent.map((s) => s.message.type);
    assert.deepEqual(types, ["start", "stop", "start"]);
    api.stop();
  });

  it("settles a claim when the audio process dies instead of hanging the share", async () => {
    const { api, hosts } = controller({ host: { onStart: () => {} } });
    api.start({ sourceId: "screen:0:0" });
    const pending = api.claim();
    hosts[0].emit("exit", 3);
    assert.equal((await pending).reason, "host-exit");
  });

  it("stops trying after the audio process has crashed twice", async () => {
    const { api, hosts } = controller({ host: { onStart: () => {} } });
    for (let i = 0; i < MAX_HOST_CRASHES; i += 1) {
      api.start({ sourceId: "screen:0:0" });
      hosts.at(-1).emit("exit", 1);
    }
    api.start({ sourceId: "screen:0:0" });
    assert.equal((await api.claim()).reason, "host-unavailable");
    assert.equal((await api.status()).available, false);
    assert.equal(hosts.length, MAX_HOST_CRASHES);
  });

  it("stops a capture whose claim timed out, and one that starts after that", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { api, hosts } = controller({ host: { onStart: () => {} } });
    api.start({ sourceId: "screen:0:0" });
    const pending = api.claim();
    t.mock.timers.tick(CLAIM_TIMEOUT_MS);
    assert.equal((await pending).reason, "timeout");
    const start = hosts[0].sent.find((s) => s.message.type === "start");
    const stops = () => hosts[0].sent.filter((s) => s.message.type === "stop");
    assert.equal(stops().length, 1);
    assert.equal(start.ports[0].closed, false, "the host's end is the host's to close");
    // The late start is told to stop rather than capture into a dead port.
    hosts[0].emit("message", { type: "session", sessionId: start.message.sessionId, state: "started" });
    assert.equal(stops().length, 2);
    assert.equal(stops()[1].message.sessionId, start.message.sessionId);
  });

  it("clears a capture that ended on its own", async () => {
    let reply;
    const { api } = controller({
      host: {
        onStart: (_message, send) => {
          reply = send;
          started(send);
        },
      },
    });
    api.start({ sourceId: "screen:0:0" });
    assert.equal((await api.claim()).active, true);
    reply({ type: "session", state: "ended", stats: {} });
    assert.equal((await api.claim()).reason, "none");
  });

  it("stops the host's session when the capture failed", async () => {
    const { api, hosts } = controller({
      host: {
        onStart: (_message, reply) =>
          reply({ type: "session", state: "failed", stage: "initialize", hr: 1 }),
      },
    });
    api.start({ sourceId: "screen:0:0" });
    await api.claim();
    assert.ok(hosts[0].sent.some((s) => s.message.type === "stop"));
  });

  it("dispose stops the capture and the process", () => {
    const { api, hosts } = controller({ host: { onStart: () => {} } });
    api.start({ sourceId: "screen:0:0" });
    api.dispose();
    assert.equal(hosts[0].killed, true);
  });
});
