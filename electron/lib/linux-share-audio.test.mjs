import { strict as assert } from "node:assert";
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
  parseInfo,
  parseModules,
  parseStreams,
  planSinkInputMoves,
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
    if (cmd === "move-sink-input") {
      const input = state.inputs.find((i) => i.index === Number(a1));
      input.target = sinkByName(a2).index;
      return "";
    }
    if (cmd === "set-default-sink") {
      state.defaultSink = a1;
      return "";
    }
    throw new Error(`fake pactl does not know: ${args.join(" ")}`);
  };
  const addApp = (index, pid, sink = "hw") =>
    state.inputs.push({
      index,
      target: sinkByName(sink).index,
      ownerModule: null,
      props: { "application.process.id": pid },
    });
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
