import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const {
  SHARE_SINK,
  SHARE_SOURCE,
  SHARE_SOURCE_LABEL,
  IDLE_BEFORE_FIRST_READ_MS,
  IDLE_AFTER_READ_MS,
  ARM_TTL_MS,
  LINK_ATTEMPTS,
  parseInfo,
  parseModules,
  parseStreams,
  parseClients,
  parsePwDump,
  streamPids,
  isOwnStream,
  isAppStream,
  planSinkInputMoves,
  planLinks,
  busChannelsFor,
  graphCaptureInUse,
  linksIntoBus,
  errorText,
  loopbackInput,
  captureInUse,
  idleExpired,
  leftoverModules,
  loopbackArgs,
  createLinuxShareAudio,
} = require("./linux-share-audio.js");

// Trimmed from real `LC_ALL=C pactl` output, captured on 2026-09-27 from
// Electron 44's test rig (Ubuntu 24.04: PulseAudio 16.1 and PipeWire 1.0.5).
const PIPEWIRE_INFO = `Server String: /tmp/xdg-1000/pulse/native
Library Protocol Version: 35
Server Protocol Version: 35
Server Name: PulseAudio (on PipeWire 1.0.5)
Server Version: 15.0.0
Default Sink: hw
Default Source: hw.monitor`;

const PULSE_INFO = `Server Name: pulseaudio
Server Version: 16.1
Default Sink: hw
Default Source: hw.monitor`;

const PULSE_SINK_INPUTS = `Sink Input #0
	Driver: module-loopback.c
	Owner Module: 21
	Client: n/a
	Sink: 1
	Properties:
		media.role = "abstract"
		media.name = "Loopback from Monitor of pqp-share-audio-mix"

Sink Input #1
	Driver: protocol-native.c
	Owner Module: 7
	Client: 4
	Sink: 1
	Volume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB
	        balance 0.00
	Properties:
		media.format = "WAV (Microsoft)"
		application.name = "paplay"
		media.name = "/tmp/440.wav"
		application.process.id = "29"
		application.process.binary = "pacat"
`;

const PIPEWIRE_MODULES = `2	libpipewire-module-protocol-native	{
            # List of server Unix sockets, and optionally permissions
        }
17	libpipewire-module-adapter
536870913	module-null-sink	sink_name=hw sink_properties=device.description=HW
536870914	module-null-sink	sink_name=pqp_share_audio sink_properties=device.description=pqp-share-audio-mix
536870915	module-loopback	source=pqp_share_audio.monitor sink=hw latency_msec=30 source_dont_move=true
536870916	module-remap-source	master=pqp_share_audio.monitor source_name=pqp_share_audio_capture source_properties=device.description=pqp-share-audio
`;

describe("parsing pactl", () => {
  it("reads the server and the default output on both servers", () => {
    assert.deepEqual(parseInfo(PIPEWIRE_INFO), {
      serverName: "PulseAudio (on PipeWire 1.0.5)",
      defaultSink: "hw",
      pipewire: true,
    });
    assert.deepEqual(parseInfo(PULSE_INFO), {
      serverName: "pulseaudio",
      defaultSink: "hw",
      pipewire: false,
    });
    assert.equal(parseInfo("").serverName, null);
  });

  it("reads streams, their sink, owner module and properties", () => {
    const streams = parseStreams(PULSE_SINK_INPUTS, "sink-inputs");
    assert.equal(streams.length, 2);
    assert.deepEqual(
      streams.map((s) => [s.index, s.target, s.ownerModule]),
      [
        [0, 1, 21],
        [1, 1, 7],
      ],
    );
    assert.equal(streams[1].props["application.process.id"], "29");
    assert.equal(streams[0].props["application.process.id"], undefined);
  });

  it("survives PipeWire's multi-line module arguments", () => {
    const modules = parseModules(PIPEWIRE_MODULES);
    assert.deepEqual(
      modules.map((m) => m.index),
      [2, 17, 536870913, 536870914, 536870915, 536870916],
    );
  });
});

describe("planSinkInputMoves", () => {
  const ownPids = new Set(["500"]);
  const base = { ownPids, outputIndex: 1, shareIndex: 9, outputName: "hw" };
  const app = (index, target, pid) => ({
    index,
    target,
    ownerModule: null,
    props: { "application.process.id": pid },
  });

  it("moves other apps on the output into the bus and leaves ours alone", () => {
    const moves = planSinkInputMoves({
      ...base,
      inputs: [app(1, 1, "29"), app(2, 1, "500")],
    });
    assert.deepEqual(moves, [{ index: 1, to: SHARE_SINK }]);
  });

  it("takes our own stream OUT of the bus, first", () => {
    const moves = planSinkInputMoves({
      ...base,
      inputs: [app(1, 1, "29"), app(2, 9, "500")],
    });
    assert.deepEqual(moves, [
      { index: 2, to: "hw" },
      { index: 1, to: SHARE_SINK },
    ]);
  });

  it("never touches module streams or apps sent to another device", () => {
    const loop = { index: 3, target: 1, ownerModule: 21, props: {} };
    const moves = planSinkInputMoves({
      ...base,
      inputs: [loop, app(4, 5, "31")],
    });
    assert.deepEqual(moves, []);
  });
});

describe("small decisions", () => {
  it("finds the loopback by its module", () => {
    const streams = parseStreams(PULSE_SINK_INPUTS, "sink-inputs");
    assert.equal(loopbackInput(streams, 21)?.index, 0);
    assert.equal(loopbackInput(streams, null), null);
  });

  it("knows when the capture is being read", () => {
    assert.equal(captureInUse([{ index: 1, target: 4 }], 4), true);
    assert.equal(captureInUse([{ index: 1, target: 2 }], 4), false);
    assert.equal(captureInUse([], null), false);
  });

  it("waits longer for a first read than after the last one", () => {
    assert.equal(idleExpired({ now: IDLE_BEFORE_FIRST_READ_MS, startedAt: 0, lastReadAt: null }), false);
    assert.equal(idleExpired({ now: IDLE_BEFORE_FIRST_READ_MS + 1, startedAt: 0, lastReadAt: null }), true);
    assert.equal(idleExpired({ now: 1000 + IDLE_AFTER_READ_MS + 1, startedAt: 0, lastReadAt: 1000 }), true);
    assert.equal(idleExpired({ now: 1000 + IDLE_AFTER_READ_MS, startedAt: 0, lastReadAt: 1000 }), false);
  });

  it("finds only our leftovers, and unloads the sink last", () => {
    assert.deepEqual(leftoverModules(parseModules(PIPEWIRE_MODULES)), [
      536870915, 536870916, 536870914,
    ]);
  });

  it("does not pin the loopback to a device that can be unplugged", () => {
    const args = loopbackArgs("hw");
    assert.ok(args.includes("sink=hw"));
    assert.ok(!args.some((a) => a.startsWith("sink_dont_move")));
  });
});

/**
 * A sound server small enough to reason about, answering the handful of pactl
 * commands the orchestrator sends, in the same text shapes the real one does.
 */
function fakeServer({ defaultSink = "hw", pactl = true } = {}) {
  const state = {
    defaultSink,
    nextModule: 100,
    nextSink: 10,
    nextSource: 50,
    sinks: [{ index: 1, name: "hw", module: null }],
    sources: [{ index: 2, name: "hw.monitor", module: null }],
    modules: [],
    inputs: [],
    outputs: [],
    clients: new Map(),
    refuse: new Map(),
    moveCalls: [],
    log: [],
  };
  const sinkByName = (name) => state.sinks.find((s) => s.name === name);
  const run = async (args) => {
    state.log.push(args.join(" "));
    if (!pactl) {
      throw new Error("spawn pactl ENOENT");
    }
    const [cmd, a1, a2] = args;
    if (cmd === "info") {
      return `Server Name: PulseAudio (on PipeWire 1.0.5)\nDefault Sink: ${state.defaultSink}\n`;
    }
    if (cmd === "list" && a1 === "short") {
      if (a2 === "sinks") return state.sinks.map((s) => `${s.index}\t${s.name}\tPipeWire`).join("\n");
      if (a2 === "sources") return state.sources.map((s) => `${s.index}\t${s.name}\tPipeWire`).join("\n");
      if (a2 === "modules") return state.modules.map((m) => `${m.index}\t${m.name}\t${m.args}\t`).join("\n");
      if (a2 === "source-outputs") return state.outputs.map((o) => `${o.index}\t${o.target}\t-\tPipeWire`).join("\n");
    }
    if (cmd === "list" && a1 === "sink-inputs") {
      return state.inputs
        .map((i) =>
          [
            `Sink Input #${i.index}`,
            `\tOwner Module: ${i.ownerModule ?? "n/a"}`,
            `\tClient: ${i.client ?? "n/a"}`,
            `\tSink: ${i.target}`,
            "\tProperties:",
            ...Object.entries(i.props).map(([k, v]) => `\t\t${k} = "${v}"`),
          ].join("\n"),
        )
        .join("\n\n");
    }
    if (cmd === "load-module") {
      const index = state.nextModule++;
      const rest = args.slice(2).join(" ");
      state.modules.push({ index, name: a1, args: rest });
      if (a1 === "module-null-sink") {
        state.sinks.push({ index: state.nextSink++, name: SHARE_SINK, module: index });
      } else if (a1 === "module-loopback") {
        const sink = /sink=(\S+)/.exec(rest)[1];
        state.inputs.push({ index: 900 + index, target: sinkByName(sink).index, ownerModule: index, props: {} });
      } else if (a1 === "module-remap-source") {
        state.sources.push({ index: state.nextSource++, name: SHARE_SOURCE, module: index });
      }
      return `${index}\n`;
    }
    if (cmd === "unload-module") {
      const index = Number(a1);
      state.modules = state.modules.filter((m) => m.index !== index);
      const gone = state.sinks.filter((s) => s.module === index);
      state.sinks = state.sinks.filter((s) => s.module !== index);
      state.sources = state.sources.filter((s) => s.module !== index);
      state.inputs = state.inputs.filter((i) => i.ownerModule !== index);
      for (const sink of gone) {
        for (const input of state.inputs) {
          if (input.target === sink.index) input.target = sinkByName(state.defaultSink)?.index ?? 1;
        }
      }
      return "";
    }
    if (cmd === "list" && a1 === "clients") {
      return [...state.clients.entries()]
        .map(([index, props]) =>
          [`Client #${index}`, "\tDriver: PipeWire", "\tProperties:", ...Object.entries(props).map(([k, v]) => `\t\t${k} = "${v}"`)].join("\n"),
        )
        .join("\n\n");
    }
    if (cmd === "move-sink-input") {
      const input = state.inputs.find((i) => i.index === Number(a1));
      if (a2 === SHARE_SINK && state.refuse.has(input.index)) {
        // What `pactl` prints for a PA_STREAM_DONT_MOVE stream, on PulseAudio
        // 17 and PipeWire 1.4.2 alike (reproduced in the rig).
        throw Object.assign(new Error(`Command failed: pactl move-sink-input ${a1} ${a2}`), {
          stderr: state.refuse.get(input.index),
        });
      }
      state.moveCalls.push(input.index);
      input.target = sinkByName(a2).index;
      return "";
    }
    if (cmd === "set-default-sink") {
      state.defaultSink = a1;
      return "";
    }
    throw new Error(`fake pactl does not know: ${args.join(" ")}`);
  };
  const addApp = (index, pid, sink = "hw", { props = {}, client = null, clientProps = null } = {}) => {
    if (client !== null && clientProps) {
      state.clients.set(client, clientProps);
    }
    state.inputs.push({
      index,
      target: sinkByName(sink).index,
      ownerModule: null,
      client,
      props: pid === null ? { ...props } : { "application.process.id": pid, ...props },
    });
  };
  const where = (index) => state.sinks.find((s) => s.index === state.inputs.find((i) => i.index === index)?.target)?.name;
  return { state, run, addApp, where, sinkByName };
}

function harness(server, { pids = ["500"], onActive } = {}) {
  let clock = 0;
  const shareAudio = createLinuxShareAudio({
    run: server.run,
    ...(onActive ? { onActive } : {}),
    ownPids: () => new Set(pids),
    now: () => clock,
    setTimer: () => 0,
    clearTimer: () => {},
    setTick: () => 0,
    clearTick: () => {},
  });
  return { shareAudio, advance: (ms) => (clock += ms) };
}

describe("createLinuxShareAudio", () => {
  it("builds the bus: other apps in, the call out, the capture listable", async () => {
    const server = fakeServer();
    server.addApp(1, "29"); // a film in another app
    server.addApp(2, "500"); // the call
    const { shareAudio } = harness(server);

    const started = await shareAudio.start();

    assert.deepEqual(started, { ok: true, label: SHARE_SOURCE_LABEL });
    assert.equal(server.where(1), SHARE_SINK);
    assert.equal(server.where(2), "hw");
    assert.equal(server.state.defaultSink, "hw", "the user's default output is never changed");
    assert.deepEqual(
      server.state.modules.map((m) => m.name),
      ["module-null-sink", "module-loopback", "module-remap-source"],
    );
    assert.ok(server.state.sources.some((s) => s.name === SHARE_SOURCE));
  });

  it("clears what a crashed session left before building a new one", async () => {
    const server = fakeServer();
    await server.run(["load-module", "module-null-sink", `sink_name=${SHARE_SINK}`]);
    const stale = server.state.modules[0].index;
    const { shareAudio } = harness(server);

    await shareAudio.start();

    assert.ok(!server.state.modules.some((m) => m.index === stale));
    assert.equal(server.state.sinks.filter((s) => s.name === SHARE_SINK).length, 1);
  });

  it("pulls our own stream back out of the bus: the echo guard", async () => {
    const server = fakeServer();
    const { shareAudio } = harness(server);
    await shareAudio.start();
    server.addApp(7, "500", SHARE_SINK);

    await shareAudio.reconcile();

    assert.equal(server.where(7), "hw");
  });

  it("puts the default back when the bus is made the default", async () => {
    const server = fakeServer();
    const { shareAudio } = harness(server);
    await shareAudio.start();
    server.state.defaultSink = SHARE_SINK;

    await shareAudio.reconcile();

    assert.equal(server.state.defaultSink, "hw");
  });

  it("follows a device switch: loopback moves, new apps there are shared", async () => {
    const server = fakeServer();
    const { shareAudio } = harness(server);
    await shareAudio.start();
    server.state.sinks.push({ index: 3, name: "headset", module: null });
    server.state.defaultSink = "headset";
    server.addApp(8, "31", "headset");
    server.addApp(9, "500", "headset");

    await shareAudio.reconcile();

    const loop = server.state.inputs.find((i) => i.ownerModule !== null);
    assert.equal(loop.target, 3);
    assert.equal(server.where(8), SHARE_SINK);
    assert.equal(server.where(9), "headset");
  });

  it("ends when nobody ever reads the capture, and puts every app back", async () => {
    const server = fakeServer();
    server.addApp(1, "29");
    const { shareAudio, advance } = harness(server);
    await shareAudio.start();

    advance(IDLE_BEFORE_FIRST_READ_MS + 1);
    await shareAudio.reconcile();

    assert.equal(shareAudio.isActive(), false);
    assert.deepEqual(server.state.modules, []);
    assert.equal(server.where(1), "hw");
  });

  it("ends shortly after the capture is closed", async () => {
    const server = fakeServer();
    const { shareAudio, advance } = harness(server);
    await shareAudio.start();
    const capture = server.state.sources.find((s) => s.name === SHARE_SOURCE).index;
    server.state.outputs.push({ index: 1, target: capture });
    advance(1000);
    await shareAudio.reconcile();
    assert.equal(shareAudio.isActive(), true);

    server.state.outputs = [];
    advance(IDLE_AFTER_READ_MS + 1);
    await shareAudio.reconcile();

    assert.equal(shareAudio.isActive(), false);
  });

  it("says no, and loads nothing, without pactl", async () => {
    const server = fakeServer({ pactl: false });
    const { shareAudio } = harness(server);

    assert.deepEqual(await shareAudio.start(), { ok: false, reason: "no-pactl" });
    assert.equal(shareAudio.isActive(), false);
  });

  it("unloads what it loaded when a module refuses to load", async () => {
    const server = fakeServer();
    const realRun = server.run;
    const { shareAudio } = harness({
      ...server,
      run: (args) =>
        args[1] === "module-remap-source" ? Promise.reject(new Error("refused")) : realRun(args),
    });

    assert.deepEqual(await shareAudio.start(), { ok: false, reason: "load-failed" });
    assert.deepEqual(server.state.modules, []);
    assert.equal(shareAudio.isActive(), false);
  });

  it("tells the shell when a session is live and when it is gone, for the crash marker", async () => {
    const server = fakeServer();
    const seen = [];
    const { shareAudio } = harness(server, { onActive: (active) => seen.push(active) });

    await shareAudio.start();
    assert.deepEqual(seen, [true]);
    await shareAudio.stop();
    assert.deepEqual(seen, [true, false]);
  });

  it("never reports a session for a machine without pactl", async () => {
    const server = fakeServer({ pactl: false });
    const seen = [];
    const { shareAudio } = harness(server, { onActive: (active) => seen.push(active) });

    await shareAudio.start();
    assert.deepEqual(seen, []);
  });
});

describe("the arm that gates the bus", () => {
  it("is not armed until the page says so", () => {
    const { shareAudio } = harness(fakeServer());
    assert.equal(shareAudio.consumeArm(), false);
  });

  it("is good for one request only", () => {
    const { shareAudio } = harness(fakeServer());
    shareAudio.arm();
    assert.equal(shareAudio.consumeArm(), true);
    assert.equal(shareAudio.consumeArm(), false);
  });

  it("expires, so a stale arm cannot switch on a later request", () => {
    const { shareAudio, advance } = harness(fakeServer());
    shareAudio.arm();
    advance(ARM_TTL_MS + 1);
    assert.equal(shareAudio.consumeArm(), false);
  });

  it("arming alone loads nothing and never reads the sound server", async () => {
    const server = fakeServer();
    const calls = [];
    const { shareAudio } = harness({
      ...server,
      run: (args) => {
        calls.push(args);
        return server.run(args);
      },
    });
    shareAudio.arm();
    shareAudio.consumeArm();
    assert.deepEqual(calls, []);
    assert.equal(shareAudio.isActive(), false);
  });
});

describe("when the sound server is slow or refuses", () => {
  it("keeps the crash marker when an unload fails, drops it when nothing is left", async () => {
    const server = fakeServer();
    const seen = [];
    const realRun = server.run;
    let refuse = true;
    const { shareAudio } = harness(
      {
        ...server,
        run: (args) =>
          refuse && args[0] === "unload-module" ? Promise.reject(new Error("busy")) : realRun(args),
      },
      { onActive: (active) => seen.push(active) },
    );
    await shareAudio.start();
    await shareAudio.stop();
    assert.deepEqual(seen, [true], "modules were left, so the marker stays");

    refuse = false;
    assert.equal(await shareAudio.cleanup(), 0);
    assert.equal(server.state.modules.length, 0);
  });

  it("queues at most one pass behind a slow one, however many events arrive", async () => {
    const server = fakeServer();
    const timers = [];
    let snapshots = 0;
    let gate = null;
    const realRun = server.run;
    const child = { stdout: new EventEmitter(), kill() {}, on() {} };
    const shareAudio = createLinuxShareAudio({
      run: async (args) => {
        if (args[0] === "list" && args[1] === "sink-inputs") {
          snapshots += 1;
          if (gate) {
            await gate;
          }
        }
        return realRun(args);
      },
      subscribe: () => child,
      ownPids: () => new Set(["500"]),
      now: () => 0,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => {},
      setTick: () => 0,
      clearTick: () => {},
    });
    await shareAudio.start();
    const startSnapshots = snapshots;

    let release;
    gate = new Promise((resolve) => (release = resolve));
    const fire = () => timers.splice(0).forEach((fn) => fn());
    const burst = () => {
      for (let i = 0; i < 20; i += 1) {
        child.stdout.emit("data", "Event 'change' on sink-input #3");
      }
    };
    burst();
    fire(); // first pass starts and hangs on the gate
    for (let round = 0; round < 5; round += 1) {
      burst();
      fire();
    }
    release();
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      fire();
    }
    gate = null;
    await new Promise((resolve) => setImmediate(resolve));

    // One running, one follow-up, not six.
    assert.ok(snapshots - startSnapshots <= 2, `ran ${snapshots - startSnapshots} passes`);
    assert.ok(snapshots - startSnapshots >= 1);
  });
});

// ---------------------------------------------------------------------------
// After the first report from real hardware (October 2026, CachyOS, PipeWire
// with pipewire-pulse): browsers and one game reached viewers, Spotify (Flathub)
// and Helldivers 2 did not. Reproduced in the rig on PipeWire 1.4.2 /
// WirePlumber 0.5.8 and PulseAudio 17: a PA_STREAM_DONT_MOVE stream refuses
// `move-sink-input` ("Failure: Invalid argument"), and a native PipeWire stream
// (Spotify >= 1.2.86) carries no `application.process.id` on its sink input.

describe("the move path, after the first real-hardware report", () => {
  it("asks a DONT_MOVE stream once, reports the server's words, and never spawns pactl for it again", async () => {
    const server = fakeServer();
    server.addApp(1, "29"); // a browser
    server.addApp(3, "41"); // a Wine game on a named endpoint
    server.state.refuse.set(3, "Failure: Invalid argument\n");
    const { shareAudio } = harness(server);

    await shareAudio.start();
    await shareAudio.reconcile();
    await shareAudio.reconcile();

    assert.equal(server.where(1), SHARE_SINK);
    assert.equal(server.where(3), "hw", "the game is still heard");
    const attempts = server.state.log.filter((l) => l === `move-sink-input 3 ${SHARE_SINK}`);
    assert.equal(attempts.length, 1, "refused once means refused: no retry every tick");
    const game = shareAudio.diagnostics().streams.find((s) => s.node === 3);
    assert.equal(game.outcome, "refused");
    assert.equal(game.detail, "Failure: Invalid argument");
    assert.equal(game.own, false);
  });

  it("traces a native PipeWire stream to its client: another app is moved, pqp's is not", async () => {
    const server = fakeServer();
    // Spotify 1.2.86 as Flathub ships it: no pid, no application.name on the
    // stream; the client knows the sandbox pid AND the socket peer's pid.
    server.addApp(4, null, "hw", {
      props: { "media.name": "audio-src", "pipewire.access.portal.app_id": "com.spotify.Client" },
      client: 70,
      clientProps: {
        "application.process.id": "2",
        "pipewire.sec.pid": "7731",
        "application.process.binary": "spotify",
        "pipewire.access.portal.app_id": "com.spotify.Client",
      },
    });
    // pqp, had Chromium ever fallen back to a native stream: sandbox-looking
    // client pid, but the socket peer is ours.
    server.addApp(5, null, "hw", {
      props: { "media.name": "Playback" },
      client: 71,
      clientProps: { "application.process.id": "3", "pipewire.sec.pid": "500" },
    });
    const { shareAudio } = harness(server);

    await shareAudio.start();

    assert.equal(server.where(4), SHARE_SINK, "Spotify is shared");
    assert.equal(server.where(5), "hw", "the call stays out");
    const report = shareAudio.diagnostics().streams;
    const spotify = report.find((s) => s.node === 4);
    assert.equal(spotify.app, "audio-src");
    assert.equal(spotify.flatpak, "com.spotify.Client");
    assert.equal(spotify.own, false);
    assert.equal(spotify.outcome, "moved");
    assert.equal(report.find((s) => s.node === 5).outcome, "pqp-kept-out");
  });

  it("never moves a stream with no process id at all: it could be the call", async () => {
    const server = fakeServer();
    server.addApp(6, null, "hw", { props: { "media.name": "mystery" } });
    const { shareAudio } = harness(server);

    await shareAudio.start();

    assert.equal(server.where(6), "hw");
    assert.equal(shareAudio.diagnostics().streams.find((s) => s.node === 6).outcome, "skipped-no-process");
  });

  it("wins against stream-restore putting a stream back: moved again next pass, never marked refused", async () => {
    const server = fakeServer();
    server.addApp(1, "29");
    const { shareAudio } = harness(server);
    await shareAudio.start();
    assert.equal(server.where(1), SHARE_SINK);

    server.state.inputs.find((i) => i.index === 1).target = server.sinkByName("hw").index;
    await shareAudio.reconcile();

    assert.equal(server.where(1), SHARE_SINK);
    assert.equal(shareAudio.diagnostics().streams.find((s) => s.node === 1).outcome, "moved");
  });

  it("a stream named like pqp is not pqp's, and pqp's binary name is, whatever the pid", async () => {
    const server = fakeServer();
    server.addApp(1, "29", "hw", { props: { "application.name": "pqp", "application.process.binary": "chrome" } });
    server.addApp(2, "777", "hw", { props: { "application.name": "Chromium", "application.process.binary": "pqp" } });
    const shareAudio = createLinuxShareAudio({
      run: server.run,
      ownPids: () => new Set(["500"]),
      ownBinaries: () => new Set(["pqp"]),
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      setTick: () => 0,
      clearTick: () => {},
    });

    await shareAudio.start();

    assert.equal(server.where(1), SHARE_SINK, "an app called pqp is just an app");
    assert.equal(server.where(2), "hw", "our own executable never enters the bus");
  });
});

describe("process ids behind a stream", () => {
  it("never counts the pulse server's own pid as the app's", () => {
    const pids = streamPids(
      { "application.process.id": "47" },
      { "client.api": "pipewire-pulse", "application.process.id": "47", "pipewire.sec.pid": "22" },
    );
    assert.deepEqual([...pids], ["47"]);
  });

  it("takes a native client's pid and its socket peer's pid (a sandbox cannot hide behind pid 2)", () => {
    const pids = streamPids({}, { "application.process.id": 2, "pipewire.sec.pid": 55 });
    assert.deepEqual([...pids].sort(), ["2", "55"]);
    assert.equal(
      isOwnStream({ props: {}, clientProps: { "application.process.id": "2", "pipewire.sec.pid": "55" } }, new Set(["55"])),
      true,
    );
  });

  it("treats module streams and the sound server's own streams as modules", () => {
    assert.equal(
      isAppStream({ props: { "pulse.module.id": "536870919" }, clientProps: { "application.process.id": "22" } }),
      false,
    );
    assert.equal(
      isAppStream({ props: {}, clientProps: { "application.process.binary": "pipewire", "application.process.id": "22" } }),
      false,
    );
    assert.equal(
      isAppStream({ props: { "application.process.id": "29" }, ownerModule: 7 }),
      true,
      "PulseAudio owns every client stream by module 7",
    );
  });

  it("reads the client list and the Client field", () => {
    const clients = parseClients(
      'Client #70\n\tDriver: PipeWire\n\tProperties:\n\t\tapplication.process.id = "2"\n\t\tpipewire.sec.pid = "7731"\n',
    );
    assert.equal(clients.get(70)["pipewire.sec.pid"], "7731");
    assert.equal(parseStreams("Sink Input #4\n\tClient: 70\n\tSink: 1\n", "sink-inputs")[0].client, 70);
  });

  it("keeps the last line of a tool's error", () => {
    assert.equal(errorText({ stderr: "\nFailure: Invalid argument\n" }), "Failure: Invalid argument");
    assert.equal(errorText(new Error("Command failed: pactl x\nFailure: No such entity")), "Failure: No such entity");
  });
});

// ------------------------------------------------------------------ link path

const PW_FIXTURE = readFileSync(new URL("../test/fixtures/pw-dump-pipewire-1.4.2.json", import.meta.url), "utf8");

describe("reading pw-dump (trimmed from PipeWire 1.4.2 in the rig)", () => {
  const graph = parsePwDump(PW_FIXTURE);

  it("finds nodes, clients, ports, links and the default output", () => {
    assert.equal(graph.defaultSink, "hw");
    const spotify = graph.nodes.get(77);
    assert.equal(spotify.props["media.name"], "audio-src");
    assert.equal(spotify.props["application.process.id"], undefined, "a native stream has no pid of its own");
    assert.equal(spotify.clientProps["application.process.id"], "2", "numbers come back as strings");
    assert.equal(spotify.clientProps["pipewire.access.portal.app_id"], "com.spotify.Client");
  });

  it("knows the capture is being read and which links are ours", () => {
    assert.equal(graphCaptureInUse(graph), true);
    assert.equal(linksIntoBus(graph).length, 2);
  });

  it("plans the missing halves: plain-app's right, Spotify's AUX1, the pinned game's both", () => {
    const plan = planLinks({ graph, ownPids: new Set(["500"]), outputName: "hw" });
    const byNode = (id) => plan.links.filter((l) => l.node === id).length;
    assert.equal(byNode(71), 1);
    assert.equal(byNode(77), 1);
    assert.equal(byNode(72), 2);
    assert.deepEqual(plan.unlinks, []);
    assert.ok(plan.report.every((r) => r.outcome === "linked"));
    assert.equal(plan.report.find((r) => r.node === 72).pinned, true);
  });

  it("when a linked stream turns out to be ours, its link goes and nothing is added", () => {
    const plan = planLinks({ graph, ownPids: new Set(["47"]), outputName: "hw" });
    assert.equal(plan.links.filter((l) => l.node === 71).length, 0);
    assert.equal(plan.unlinks.length, 1, "plain-app's existing link into the bus goes");
  });

  it("maps every channel layout onto the stereo bus", () => {
    assert.deepEqual(busChannelsFor("FL", 0, 2), ["FL"]);
    assert.deepEqual(busChannelsFor("AUX0", 0, 2), ["FL"]);
    assert.deepEqual(busChannelsFor("AUX1", 1, 2), ["FR"]);
    assert.deepEqual(busChannelsFor("MONO", 0, 1), ["FL", "FR"]);
    assert.deepEqual(busChannelsFor("FC", 2, 6), ["FL", "FR"]);
    assert.deepEqual(busChannelsFor("LFE", 3, 6), []);
    assert.deepEqual(busChannelsFor("RR", 5, 6), ["FR"]);
    assert.deepEqual(busChannelsFor("", 3, 4), ["FR"]);
  });

  it("answers null for something that is not pw-dump", () => {
    assert.equal(parsePwDump("not json"), null);
    assert.equal(parsePwDump("{}"), null);
  });
});

/**
 * A PipeWire graph small enough to reason about: answers `pw-dump` with JSON
 * in the real shape, `pw-link` (create, `-d`), and the pactl commands the link
 * path sends. Node ids double as `object.serial`, which is the index pactl
 * uses for a stream.
 */
function fakePipeWire({ tools = true } = {}) {
  let nextId = 100;
  const state = {
    defaultSink: "hw",
    nodes: new Map(),
    clients: new Map(),
    ports: [],
    links: [],
    modules: [],
    nextModule: 536870920,
    linkFail: () => null,
    log: [],
  };
  const id = () => nextId++;
  const nodeByName = (name, mediaClass) =>
    [...state.nodes.values()].find(
      (n) => n.props["node.name"] === name && (!mediaClass || n.props["media.class"] === mediaClass),
    );
  const addPorts = (node, direction, channels, monitor = false) =>
    channels.map((channel) => {
      const port = { id: id(), node, direction, channel, monitor };
      state.ports.push(port);
      return port;
    });
  const addNode = (props, clientId = null) => {
    const nodeId = id();
    state.nodes.set(nodeId, {
      id: nodeId,
      props: { ...props, "object.serial": nodeId, ...(clientId !== null ? { "client.id": clientId } : {}) },
    });
    return nodeId;
  };
  const removeNode = (nodeId) => {
    state.nodes.delete(nodeId);
    state.ports = state.ports.filter((p) => p.node !== nodeId);
    state.links = state.links.filter((l) => l.outNode !== nodeId && l.inNode !== nodeId);
  };
  const addSink = (name) => {
    const nodeId = addNode({ "node.name": name, "media.class": "Audio/Sink" });
    addPorts(nodeId, "input", ["FL", "FR"]);
    addPorts(nodeId, "output", ["FL", "FR"], true);
    return nodeId;
  };
  const addLink = (outPort, inPort) => {
    const out = state.ports.find((p) => p.id === outPort);
    const inp = state.ports.find((p) => p.id === inPort);
    const link = { id: id(), outNode: out.node, outPort, inNode: inp.node, inPort };
    state.links.push(link);
    return link;
  };
  const linkTo = (nodeId, sinkName) => {
    state.links = state.links.filter((l) => l.outNode !== nodeId);
    const sink = nodeByName(sinkName, "Audio/Sink");
    const ins = state.ports.filter((p) => p.node === sink.id && p.direction === "input");
    state.ports
      .filter((p) => p.node === nodeId && p.direction === "output")
      .forEach((p, i) => addLink(p.id, ins[i % ins.length].id));
  };
  /** A second link from a node into the bus, the way a patchbay would add one. */
  const linkIntoBus = (nodeId, firstLinkId) => {
    const bus = nodeByName(SHARE_SINK, "Audio/Sink");
    const busIn = state.ports.filter((p) => p.node === bus.id && p.direction === "input");
    state.ports
      .filter((p) => p.node === nodeId && p.direction === "output")
      .forEach((p, i) =>
        state.links.push({ id: firstLinkId + i, outNode: nodeId, outPort: p.id, inNode: bus.id, inPort: busIn[i % busIn.length].id }),
      );
  };
  addSink("hw");

  const addStream = ({
    name,
    nodePid = null,
    clientPid = null,
    secPid = null,
    api = null,
    binary = "app",
    sink = "hw",
    channels = ["FL", "FR"],
    props = {},
    clientProps = {},
  }) => {
    const clientId = id();
    state.clients.set(clientId, {
      "application.name": name,
      ...(binary ? { "application.process.binary": binary } : {}),
      ...(clientPid !== null ? { "application.process.id": clientPid } : {}),
      ...(secPid !== null ? { "pipewire.sec.pid": secPid } : {}),
      ...(api ? { "client.api": api } : {}),
      ...clientProps,
    });
    const nodeId = addNode(
      {
        "node.name": name,
        "media.class": "Stream/Output/Audio",
        ...(nodePid !== null ? { "application.process.id": nodePid, "application.name": name } : {}),
        ...props,
      },
      clientId,
    );
    addPorts(nodeId, "output", channels);
    if (sink) {
      linkTo(nodeId, sink);
    }
    return nodeId;
  };
  /** A libpulse app as pipewire-pulse shows it: pid on the node, server pid as sec.pid. */
  const pulseApp = (name, pid, extra = {}) =>
    addStream({ name, nodePid: pid, clientPid: pid, secPid: 22, api: "pipewire-pulse", ...extra });

  const dump = () =>
    JSON.stringify([
      ...[...state.clients.entries()].map(([cid, props]) => ({
        id: cid,
        type: "PipeWire:Interface:Client",
        info: { props },
      })),
      ...[...state.nodes.values()].map((n) => ({ id: n.id, type: "PipeWire:Interface:Node", info: { props: n.props } })),
      ...state.ports.map((p) => ({
        id: p.id,
        type: "PipeWire:Interface:Port",
        info: {
          direction: p.direction,
          props: { "node.id": p.node, "audio.channel": p.channel, ...(p.monitor ? { "port.monitor": true } : {}) },
        },
      })),
      ...state.links.map((l) => ({
        id: l.id,
        type: "PipeWire:Interface:Link",
        info: {
          "output-node-id": l.outNode,
          "output-port-id": l.outPort,
          "input-node-id": l.inNode,
          "input-port-id": l.inPort,
        },
      })),
      {
        id: 39,
        type: "PipeWire:Interface:Metadata",
        props: { "metadata.name": "default" },
        metadata: [
          { subject: 0, key: "default.audio.sink", type: "Spa:String:JSON", value: { name: state.defaultSink } },
        ],
      },
    ]);

  const sinkTargetOf = (nodeId) => {
    const link = state.links.find((l) => l.outNode === nodeId);
    return link ? link.inNode : 4294967295;
  };
  const run = async (args) => {
    state.log.push(`pactl ${args.join(" ")}`);
    const [cmd, a1, a2] = args;
    if (cmd === "info") {
      return `Server Name: PulseAudio (on PipeWire 1.4.2)\nDefault Sink: ${state.defaultSink}\n`;
    }
    if (cmd === "list" && a1 === "short" && a2 === "modules") {
      return state.modules.map((m) => `${m.index}\t${m.name}\t${m.args}\t`).join("\n");
    }
    if (cmd === "list" && a1 === "short" && a2 === "sinks") {
      return [...state.nodes.values()]
        .filter((n) => n.props["media.class"] === "Audio/Sink")
        .map((n) => `${n.id}\t${n.props["node.name"]}\tPipeWire`)
        .join("\n");
    }
    if (cmd === "list" && a1 === "sink-inputs") {
      return [...state.nodes.values()]
        .filter((n) => n.props["media.class"] === "Stream/Output/Audio")
        .map((n) =>
          [
            `Sink Input #${n.id}`,
            "\tOwner Module: n/a",
            `\tSink: ${sinkTargetOf(n.id)}`,
            "\tProperties:",
            ...Object.entries(n.props).map(([k, v]) => `\t\t${k} = "${v}"`),
          ].join("\n"),
        )
        .join("\n\n");
    }
    if (cmd === "load-module") {
      const index = state.nextModule++;
      const rest = args.slice(2).join(" ");
      const module = { index, name: a1, args: rest, nodes: [] };
      if (a1 === "module-null-sink") {
        module.nodes.push(addSink(SHARE_SINK));
      } else if (a1 === "module-remap-source") {
        const src = addNode({
          "node.name": SHARE_SOURCE,
          "media.class": "Audio/Source",
          "node.link-group": "loopback-22-12",
        });
        addPorts(src, "output", ["FL", "FR"]);
        module.nodes.push(src);
      } else if (a1 === "module-loopback") {
        module.nodes.push(
          addNode({ "node.name": "output.loopback", "media.class": "Stream/Output/Audio", "pulse.module.id": index }),
        );
      }
      state.modules.push(module);
      return `${index}\n`;
    }
    if (cmd === "unload-module") {
      const module = state.modules.find((m) => m.index === Number(a1));
      state.modules = state.modules.filter((m) => m !== module);
      for (const nodeId of module?.nodes ?? []) {
        // Streams routed only to a vanished sink fall back to the default,
        // like the server does.
        const routed = state.links.filter((l) => l.inNode === nodeId).map((l) => l.outNode);
        removeNode(nodeId);
        for (const stream of new Set(routed)) {
          if (!state.links.some((l) => l.outNode === stream)) {
            linkTo(stream, state.defaultSink);
          }
        }
      }
      return "";
    }
    if (cmd === "set-default-sink") {
      state.defaultSink = a1;
      return "";
    }
    if (cmd === "move-sink-input") {
      linkTo(Number(a1), a2);
      return "";
    }
    throw new Error(`fake pactl does not know: ${args.join(" ")}`);
  };
  const runPw = async (tool, args) => {
    state.log.push(`${tool} ${args.join(" ")}`.trim());
    if (!tools) {
      throw Object.assign(new Error(`spawn ${tool} ENOENT`), { code: "ENOENT" });
    }
    if (args[0] === "--version") {
      return `${tool}\nCompiled with libpipewire 1.4.2\n`;
    }
    if (tool === "pw-dump") {
      return dump();
    }
    if (tool === "pw-link" && args[0] === "-d") {
      state.links = state.links.filter((l) => l.id !== Number(args[1]));
      return "";
    }
    if (tool === "pw-link") {
      const [out, inp] = args.map(Number);
      if (state.links.some((l) => l.outPort === out && l.inPort === inp)) {
        throw Object.assign(new Error("Command failed"), { stderr: "failed to link ports: File exists\n" });
      }
      const failure = state.linkFail(out, inp);
      if (failure) {
        throw Object.assign(new Error("Command failed"), { stderr: failure });
      }
      addLink(out, inp);
      return "";
    }
    throw new Error(`fake ${tool} does not know: ${args.join(" ")}`);
  };
  const bus = () => nodeByName(SHARE_SINK, "Audio/Sink");
  const busLinksFrom = (nodeId) => state.links.filter((l) => l.outNode === nodeId && l.inNode === bus()?.id).length;
  const hears = (nodeId, sinkName = "hw") =>
    state.links.some((l) => l.outNode === nodeId && l.inNode === nodeByName(sinkName, "Audio/Sink")?.id);
  /** Chromium opening the capture: a recording stream linked from our source. */
  const read = () => {
    const reader = addNode({ "node.name": "Chromium input", "media.class": "Stream/Input/Audio" });
    const ins = addPorts(reader, "input", ["FL", "FR"]);
    const src = nodeByName(SHARE_SOURCE, "Audio/Source");
    state.ports.filter((p) => p.node === src.id).forEach((p, i) => addLink(p.id, ins[i].id));
    return reader;
  };
  return { state, run, runPw, addStream, pulseApp, addSink, linkTo, linkIntoBus, busLinksFrom, hears, bus, read, removeNode };
}

function linkHarness(pw, { pids = ["500"], binaries = [], onReport } = {}) {
  let clock = 0;
  const shareAudio = createLinuxShareAudio({
    run: pw.run,
    runPw: pw.runPw,
    ownPids: () => new Set(pids),
    ownBinaries: () => new Set(binaries),
    ...(onReport ? { onReport } : {}),
    now: () => clock,
    setTimer: () => 0,
    clearTimer: () => {},
    setTick: () => 0,
    clearTick: () => {},
  });
  return { shareAudio, advance: (ms) => (clock += ms) };
}

describe("the link path (PipeWire with pw-dump and pw-link)", () => {
  it("links on PipeWire with its tools, and moves everywhere else", async () => {
    assert.equal((await linkHarness(fakePipeWire()).shareAudio.probe()).mode, "link");
    assert.equal((await linkHarness(fakePipeWire({ tools: false })).shareAudio.probe()).mode, "move");

    const pulse = fakeServer();
    const calls = [];
    const shareAudio = createLinuxShareAudio({
      run: async (args) => (args[0] === "info" ? "Server Name: pulseaudio\nDefault Sink: hw\n" : pulse.run(args)),
      runPw: async (tool) => {
        calls.push(tool);
        return "";
      },
      ownPids: () => new Set(),
    });
    assert.equal((await shareAudio.probe()).mode, "move");
    assert.deepEqual(calls, [], "PulseAudio never runs a PipeWire tool");
  });

  it("shares a browser, a DONT_MOVE game, a native player and Flatpak Spotify, never the call, and the speakers hear the same", async () => {
    const pw = fakePipeWire();
    const browser = pw.pulseApp("Firefox", "29");
    const game = pw.pulseApp("helldivers2.exe", "41", { props: { "node.dont-reconnect": "true" } });
    const player = pw.addStream({ name: "pw-play", clientPid: "31", secPid: "31", binary: "pw-cat" });
    const spotify = pw.addStream({
      name: "audio-src",
      clientPid: "2",
      secPid: "7731",
      binary: "spotify",
      channels: ["AUX0", "AUX1"],
      props: { "media.name": "audio-src" },
      clientProps: { "pipewire.access.portal.app_id": "com.spotify.Client", "pipewire.access": "flatpak" },
    });
    const call = pw.pulseApp("pqp", "500");
    const { shareAudio } = linkHarness(pw);

    assert.deepEqual(await shareAudio.start(), { ok: true, label: SHARE_SOURCE_LABEL });

    for (const node of [browser, game, player, spotify]) {
      assert.equal(pw.busLinksFrom(node), 2, `node ${node} is in the share`);
      assert.ok(pw.hears(node), `node ${node} still plays to the speakers`);
    }
    assert.equal(pw.busLinksFrom(call), 0, "the call never enters the bus");
    assert.ok(pw.hears(call));
    assert.equal(pw.state.defaultSink, "hw", "the default output is never changed");
    assert.deepEqual(
      pw.state.modules.map((m) => m.name),
      ["module-null-sink", "module-remap-source"],
      "no loopback: nobody was taken off the speakers",
    );
    assert.ok(
      !pw.state.log.some((l) => l.startsWith("pactl move-sink-input")),
      "nothing was moved, so WirePlumber remembers nothing",
    );
  });

  it("knows pqp's stream by any process id behind it, never by its name", async () => {
    const pw = fakePipeWire();
    const sandboxedCall = pw.addStream({ name: "Playback", clientPid: "3", secPid: "500" });
    const namedLikeUs = pw.pulseApp("pqp", "29", { binary: "chrome" });
    const ourBinary = pw.pulseApp("Chromium", "777", { props: { "application.process.binary": "pqp" } });
    const { shareAudio } = linkHarness(pw, { binaries: ["pqp"] });

    await shareAudio.start();

    assert.equal(pw.busLinksFrom(sandboxedCall), 0);
    assert.equal(pw.busLinksFrom(ourBinary), 0);
    assert.equal(pw.busLinksFrom(namedLikeUs), 2, "an app called pqp is just an app");
  });

  it("never links a stream with no process, a module's stream, or one that relays other audio", async () => {
    const pw = fakePipeWire();
    const mystery = pw.addStream({ name: "mystery", binary: "" });
    const moduleStream = pw.addStream({
      name: "output.loopback-1",
      clientPid: "22",
      secPid: "22",
      binary: "pipewire",
      props: { "pulse.module.id": "536870919" },
    });
    const filterHalf = pw.addStream({
      name: "output.filter",
      clientPid: "88",
      secPid: "88",
      props: { "node.link-group": "filter-chain-1" },
    });
    // An effects app: owns a sink, and its output stream carries everything
    // that plays into that sink (the call too, if the person routed it there).
    const effects = pw.addStream({ name: "easyeffects_out", clientPid: "90", secPid: "90", binary: "easyeffects" });
    const effectsSink = pw.addSink("easyeffects_sink");
    pw.state.nodes.get(effectsSink).props["client.id"] = pw.state.nodes.get(effects).props["client.id"];
    const { shareAudio } = linkHarness(pw);

    await shareAudio.start();

    for (const node of [mystery, moduleStream, filterHalf, effects]) {
      assert.equal(pw.busLinksFrom(node), 0, `node ${node} stays out`);
    }
    const outcome = (node) => shareAudio.diagnostics().streams.find((s) => s.node === node).outcome;
    assert.equal(outcome(mystery), "skipped-no-process");
    assert.equal(outcome(moduleStream), "skipped-module");
    assert.equal(outcome(filterHalf), "skipped-relay");
    assert.equal(outcome(effects), "skipped-relay");
  });

  it("links only what plays to the default output: a stream sent to a headset stays out", async () => {
    const pw = fakePipeWire();
    pw.addSink("headset");
    const elsewhere = pw.pulseApp("vlc", "29", { sink: "headset" });
    const { shareAudio } = linkHarness(pw);

    await shareAudio.start();

    assert.equal(pw.busLinksFrom(elsewhere), 0);
    assert.equal(shareAudio.diagnostics().streams.find((s) => s.node === elsewhere).outcome, "other-output");
  });

  it("links a stream that starts after the share, and again after it restarts", async () => {
    const pw = fakePipeWire();
    const { shareAudio } = linkHarness(pw);
    await shareAudio.start();

    const late = pw.addStream({ name: "spotify", clientPid: "2", secPid: "7731" });
    await shareAudio.reconcile();
    assert.equal(pw.busLinksFrom(late), 2);

    pw.removeNode(late);
    const again = pw.addStream({ name: "spotify", clientPid: "2", secPid: "7731" });
    await shareAudio.reconcile();
    assert.equal(pw.busLinksFrom(again), 2);
  });

  it("the echo guard: a link from pqp's stream into the bus goes before anything is added", async () => {
    const pw = fakePipeWire();
    const call = pw.pulseApp("pqp", "500");
    const { shareAudio } = linkHarness(pw);
    await shareAudio.start();
    // Somebody (a patchbay, a script) links the call into the bus.
    pw.linkIntoBus(call, 9000);
    const late = pw.pulseApp("game", "41");
    pw.state.log.length = 0;

    await shareAudio.reconcile();

    assert.equal(pw.busLinksFrom(call), 0);
    assert.ok(pw.hears(call));
    assert.equal(pw.busLinksFrom(late), 2);
    const firstUnlink = pw.state.log.findIndex((l) => l.startsWith("pw-link -d"));
    const firstLink = pw.state.log.findIndex((l) => /^pw-link \d/.test(l));
    assert.ok(firstUnlink !== -1 && firstUnlink < firstLink, "unlink first");
    assert.equal(shareAudio.diagnostics().streams.find((s) => s.node === call).outcome, "pqp-pulled-out");
  });

  it("pqp's stream ROUTED into the bus goes back to the speakers, and so does any app", async () => {
    const pw = fakePipeWire();
    const call = pw.pulseApp("pqp", "500");
    const app = pw.pulseApp("mpv", "29");
    const { shareAudio } = linkHarness(pw);
    await shareAudio.start();
    // WirePlumber restoring a target a move-path session left in
    // stream-properties, or a person picking the bus in a mixer.
    pw.linkTo(call, SHARE_SINK);
    pw.linkTo(app, SHARE_SINK);

    await shareAudio.reconcile();

    assert.ok(pw.hears(call));
    assert.equal(pw.busLinksFrom(call), 0);
    assert.ok(pw.hears(app), "the bus is silent in link mode, so a routed app goes back");
    await shareAudio.reconcile();
    assert.equal(pw.busLinksFrom(app), 2, "and is then linked like any other");
  });

  it("puts the default back when the bus is made the default output", async () => {
    const pw = fakePipeWire();
    const { shareAudio } = linkHarness(pw);
    await shareAudio.start();
    pw.state.defaultSink = SHARE_SINK;

    await shareAudio.reconcile();

    assert.equal(pw.state.defaultSink, "hw");
  });

  it("follows a device switch: links already made stay, new streams there are linked", async () => {
    const pw = fakePipeWire();
    const app = pw.pulseApp("mpv", "29");
    const { shareAudio } = linkHarness(pw);
    await shareAudio.start();
    pw.addSink("headset");
    pw.state.defaultSink = "headset";
    pw.linkTo(app, "headset");
    pw.linkIntoBus(app, 9100);
    const newcomer = pw.pulseApp("game", "41", { sink: "headset" });

    await shareAudio.reconcile();

    assert.equal(pw.busLinksFrom(app), 2);
    assert.equal(pw.busLinksFrom(newcomer), 2);
  });

  it("tries a refused link LINK_ATTEMPTS times, then reports it with the server's words", async () => {
    const pw = fakePipeWire();
    const app = pw.pulseApp("game", "41");
    pw.state.linkFail = () => "failed to link ports: Operation not permitted\n";
    const { shareAudio } = linkHarness(pw);
    await shareAudio.start();
    for (let i = 0; i < LINK_ATTEMPTS + 3; i += 1) {
      await shareAudio.reconcile();
    }
    const attempts = pw.state.log.filter((l) => /^pw-link \d/.test(l)).length;
    assert.equal(attempts, LINK_ATTEMPTS * 2, "two ports, each tried LINK_ATTEMPTS times");
    const entry = shareAudio.diagnostics().streams.find((s) => s.node === app);
    assert.equal(entry.outcome, "link-failed");
    assert.equal(entry.detail, "failed to link ports: Operation not permitted");
  });

  it("ends when the capture closes and leaves no link and no module, every app on the speakers", async () => {
    const pw = fakePipeWire();
    const app = pw.pulseApp("mpv", "29");
    const reports = [];
    const { shareAudio, advance } = linkHarness(pw, { onReport: (r) => reports.push(r) });
    await shareAudio.start();
    const reader = pw.read();
    advance(1000);
    await shareAudio.reconcile();
    assert.equal(shareAudio.isActive(), true);

    pw.removeNode(reader);
    advance(IDLE_AFTER_READ_MS + 1);
    await shareAudio.reconcile();

    assert.equal(shareAudio.isActive(), false);
    assert.deepEqual(pw.state.modules, []);
    assert.equal(pw.bus(), undefined);
    assert.equal(pw.state.links.filter((l) => l.outNode === app).length, 2);
    assert.ok(pw.hears(app));
    const last = shareAudio.diagnostics();
    assert.equal(last.active, false);
    assert.equal(last.endedReason, "capture-idle");
    assert.equal(last.mode, "link");
    assert.equal(last.streams.find((s) => s.node === app).outcome, "linked", "the report outlives the share");
    assert.equal(reports.at(-1).endedReason, "capture-idle");
  });

  it("a crash's leftovers: links into the bus are removed by id, then the modules", async () => {
    const pw = fakePipeWire();
    const app = pw.pulseApp("mpv", "29");
    await pw.run(["load-module", "module-null-sink", `sink_name=${SHARE_SINK}`]);
    pw.linkIntoBus(app, 9200);
    const { shareAudio } = linkHarness(pw);

    assert.equal(await shareAudio.cleanup(), 0);

    assert.ok(pw.state.log.includes("pw-link -d 9200") && pw.state.log.includes("pw-link -d 9201"));
    assert.equal(pw.bus(), undefined);
    assert.ok(pw.hears(app));
  });

  it("reads nothing and spawns nothing until a share starts", async () => {
    const pw = fakePipeWire();
    const { shareAudio } = linkHarness(pw);
    shareAudio.arm();
    shareAudio.consumeArm();
    assert.equal(shareAudio.diagnostics(), null);
    assert.deepEqual(pw.state.log, []);
  });

  it("keeps sharing a stream it already shared after the person moves it, and relinks it when the session manager drops the link", async () => {
    // A game pinned to the old device after the person switches the default,
    // and our link to it gone (a stream renegotiating its ports, a patchbay).
    const pw = fakePipeWire();
    pw.addSink("headset");
    const game = pw.pulseApp("helldivers2.exe", "41", { props: { "node.dont-reconnect": "true" } });
    const stranger = pw.pulseApp("vlc", "29", { sink: "headset" });
    const { shareAudio } = linkHarness(pw);
    await shareAudio.start();
    assert.equal(pw.busLinksFrom(game), 2);

    pw.state.defaultSink = "headset";
    pw.state.links = pw.state.links.filter((l) => !(l.outNode === game && l.inNode === pw.bus().id));
    await shareAudio.reconcile();

    assert.equal(pw.busLinksFrom(game), 2, "still on the old device, still shared");
    assert.ok(pw.hears(game, "hw"));
    assert.equal(pw.busLinksFrom(stranger), 2, "the headset is the default now, so it is shared too");
  });

  it("asks the session manager to move pqp's ROUTED stream instead of cutting its link", async () => {
    const pw = fakePipeWire();
    const call = pw.pulseApp("pqp", "500");
    const { shareAudio } = linkHarness(pw);
    await shareAudio.start();
    pw.linkTo(call, SHARE_SINK);
    pw.state.log.length = 0;

    await shareAudio.reconcile();

    assert.ok(pw.state.log.includes(`pactl move-sink-input ${call} hw`));
    assert.ok(!pw.state.log.some((l) => l.startsWith("pw-link -d")), "WirePlumber 0.4 relinks a link cut from under it");
    assert.ok(pw.hears(call));
    assert.equal(pw.busLinksFrom(call), 0);
  });
});
