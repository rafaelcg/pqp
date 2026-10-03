"use strict";

/**
 * THE COMPUTER'S SOUND IN A LINUX SCREEN SHARE, WITHOUT THE CALL IN IT.
 *
 * What was measured (Electron 44 in a container, PulseAudio 16.1 and PipeWire
 * 1.0.5, a tone for "the call" and another for "some other app"):
 *
 * - Chromium on Linux CAN capture system audio: Electron's `audio: "loopback"`
 *   reaches `PulseLoopbackManager`, which records the monitor of the DEFAULT
 *   sink, with no feature flag needed.
 * - That monitor contains this app's own playback, which is the call. Asking
 *   for `restrictOwnAudio` changes nothing: `media::IsRestrictOwnAudioSupported`
 *   is false on Linux, and the track reports `restrictOwnAudio: false` with
 *   capabilities `[false]`. So plain loopback is the 23 Aug 2026 echo.
 * - `getUserMedia` cannot open a monitor either: Chromium's Pulse backend
 *   leaves every monitor source out of the device list on purpose.
 *
 * So the shell builds its own "everything except pqp" bus, with `pactl`, and
 * no native module:
 *
 *   other apps --> [pqp_share_audio]  (null sink) --monitor--> loopback --> the user's output
 *                                          |
 *                                          +--> remap source "pqp-share-audio"  <-- getUserMedia
 *   pqp (the call) ------------------------------------------------------------> the user's output
 *
 * The user's default output is NEVER changed. That is the whole reason for
 * the remap source instead of Chromium's loopback: loopback follows the
 * default sink, so capturing our bus through it would mean making our bus the
 * default, and then every new stream pqp opens lands in the capture (echo)
 * until something moves it back, the volume keys stop controlling the call,
 * and a crash mid-share leaves the machine's default output on a null sink.
 * Here pqp's own streams are simply never moved, so they cannot reach the
 * bus, and a device switch (headset plugged in) is handled by the sound
 * server the way it always is.
 *
 * What still needs watching while a share runs, and `reconcile` does it on
 * every `pactl subscribe` event and on a slow tick:
 *   - new streams from other apps land on the default output and are moved
 *     into the bus (until then they are heard but not shared, never echoed);
 *   - a stream of OURS that somehow reached the bus goes back out (the one
 *     move that stops an echo, so it is checked on every pass);
 *   - the bus must never become the default output, and the loopback must
 *     follow the default output;
 *   - nobody reading the capture any more means the share is over: tear down.
 *
 * Everything that decides something is a pure function below, fed parsed
 * `pactl` text, so it runs in CI without a sound server. The orchestrator
 * takes its runner, its clock and its process list as arguments for the same
 * reason. `pactl` is run with `LC_ALL=C` because its long listings are
 * translated ("Entrada do destino #3" on a pt-BR desktop).
 */

/** The bus other apps are moved into. */
const SHARE_SINK = "pqp_share_audio";
/** The remap of its monitor: a normal source, so Chromium will list it. */
const SHARE_SOURCE = "pqp_share_audio_capture";
/**
 * What `enumerateDevices` shows as the label: Pulse's `device.description`.
 * No spaces, so it survives module-argument parsing with no quoting games.
 */
const SHARE_SOURCE_LABEL = "pqp-share-audio";
const SHARE_SINK_LABEL = "pqp-share-audio-mix";
/** Low enough to keep lips and sound together, high enough not to crackle. */
const LOOPBACK_LATENCY_MS = 30;

/** Before the renderer first opens the capture. Generous: a picker may be up. */
const IDLE_BEFORE_FIRST_READ_MS = 20_000;
/** After the capture was read and then closed: the share ended. */
const IDLE_AFTER_READ_MS = 4_000;
/**
 * How long the page's "arm" is good for. The page arms right before it calls
 * `getDisplayMedia`, and the picker may be up for a while, so this is generous;
 * it only has to be finite so that a stale arm can never switch a LATER
 * request from some other caller into building the bus.
 */
const ARM_TTL_MS = 120_000;
const TICK_MS = 2_000;
const EVENT_DEBOUNCE_MS = 120;

// ----------------------------------------------------------------- parsing

/** `pactl info`: server name, default sink. */
function parseInfo(text) {
  const out = { serverName: null, defaultSink: null, pipewire: false };
  for (const line of String(text ?? "").split("\n")) {
    const match = /^([^:]+):\s*(.*)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    if (match[1] === "Server Name") {
      out.serverName = match[2];
      out.pipewire = /pipewire/i.test(match[2]);
    } else if (match[1] === "Default Sink") {
      out.defaultSink = match[2] || null;
    }
  }
  return out;
}

/** `pactl list short <kind>`: tab-separated rows, first column the index. */
function parseShort(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const cols = line.split("\t");
    const index = Number.parseInt(cols[0], 10);
    if (!Number.isFinite(index)) {
      continue;
    }
    rows.push({ index, cols });
  }
  return rows;
}

/** Sinks or sources: `{ index, name }`. */
function parseNamed(text) {
  return parseShort(text).map(({ index, cols }) => ({ index, name: cols[1] ?? "" }));
}

/** Modules: `{ index, name, args }`. */
function parseModules(text) {
  return parseShort(text).map(({ index, cols }) => ({
    index,
    name: cols[1] ?? "",
    args: cols[2] ?? "",
  }));
}

/**
 * `pactl list sink-inputs` / `source-outputs` (LC_ALL=C), one entry per
 * "Sink Input #N" / "Source Output #N" block:
 * `{ index, target, ownerModule, props }` where `target` is the sink (or
 * source) index and `props` the `key = "value"` properties.
 */
function parseStreams(text, kind) {
  const heading = kind === "source-outputs" ? "Source Output #" : "Sink Input #";
  const targetKey = kind === "source-outputs" ? "Source" : "Sink";
  const streams = [];
  let current = null;
  let inProps = false;
  for (const raw of String(text ?? "").split("\n")) {
    if (raw.startsWith(heading)) {
      current = {
        index: Number.parseInt(raw.slice(heading.length), 10),
        target: null,
        ownerModule: null,
        props: {},
      };
      streams.push(current);
      inProps = false;
      continue;
    }
    if (!current) {
      continue;
    }
    const line = raw.trim();
    if (line === "Properties:") {
      inProps = true;
      continue;
    }
    const prop = /^([A-Za-z0-9_.-]+)\s*=\s*"(.*)"$/.exec(line);
    if (inProps && prop) {
      current.props[prop[1]] = prop[2];
      continue;
    }
    const field = /^([A-Za-z ]+):\s*(.*)$/.exec(line);
    if (field) {
      inProps = false;
      if (field[1] === targetKey) {
        const n = Number.parseInt(field[2], 10);
        current.target = Number.isFinite(n) ? n : null;
      } else if (field[1] === "Owner Module") {
        const n = Number.parseInt(field[2], 10);
        current.ownerModule = Number.isFinite(n) ? n : null;
      }
    }
  }
  return streams.filter((s) => Number.isFinite(s.index));
}

// ----------------------------------------------------------------- deciding

/** A stream opened by one of this app's processes (the call, sounds, films). */
function isOwnStream(stream, ownPids) {
  const pid = stream?.props?.["application.process.id"];
  return typeof pid === "string" && ownPids.has(pid);
}

/**
 * Only application streams are ever moved. A stream with no client process
 * belongs to a module (our own loopback, somebody's echo-cancel, an effects
 * chain) and moving it can build a feedback loop or break a setup we do not
 * understand.
 */
function isAppStream(stream) {
  const pid = stream?.props?.["application.process.id"];
  return typeof pid === "string" && pid.length > 0;
}

/**
 * Which playback streams go where, given the indexes of the user's output
 * and of our bus. Returns `[{ index, to }]` with `to` a sink NAME.
 *
 * - Ours on the bus: out, to the user's output. This is the echo, so it is
 *   answered first and unconditionally.
 * - Another app on the user's output: into the bus.
 * - Anything on any other sink stays put. Somebody who sent one app to their
 *   headphones on purpose did not ask us to reroute it, so it is simply not
 *   shared, which is the same answer a tab share gives.
 */
function planSinkInputMoves({ inputs, ownPids, outputIndex, shareIndex, outputName }) {
  const moves = [];
  for (const input of Array.isArray(inputs) ? inputs : []) {
    if (!isAppStream(input)) {
      continue;
    }
    if (isOwnStream(input, ownPids)) {
      if (input.target === shareIndex) {
        moves.push({ index: input.index, to: outputName });
      }
      continue;
    }
    if (input.target === outputIndex && outputIndex !== shareIndex) {
      moves.push({ index: input.index, to: SHARE_SINK });
    }
  }
  // Ours first: an echo is worse than a second of unshared sound.
  return moves.sort((a, b) => Number(b.to !== SHARE_SINK) - Number(a.to !== SHARE_SINK));
}

/** The loopback's own playback stream, found by the module that owns it. */
function loopbackInput(inputs, loopbackModule) {
  return (Array.isArray(inputs) ? inputs : []).find(
    (input) => loopbackModule !== null && input.ownerModule === loopbackModule,
  ) ?? null;
}

/** Is anybody recording from our capture source right now? */
function captureInUse(outputs, captureIndex) {
  if (captureIndex === null || captureIndex === undefined) {
    return false;
  }
  return (Array.isArray(outputs) ? outputs : []).some((o) => o.target === captureIndex);
}

/**
 * Should the session end? After a read, a short silence means the share
 * stopped. Before any read, a longer one means the renderer never came for it
 * (an old client, a share that failed after the picker).
 */
function idleExpired({ now, startedAt, lastReadAt }) {
  if (lastReadAt === null || lastReadAt === undefined) {
    return now - startedAt > IDLE_BEFORE_FIRST_READ_MS;
  }
  return now - lastReadAt > IDLE_AFTER_READ_MS;
}

/**
 * Our modules, from a previous session that did not end cleanly (a crash, a
 * kill, a power cut on a laptop that resumes with the sound server still up).
 * Unload order: the remap and the loopback before the sink they read.
 */
function leftoverModules(modules) {
  const ours = (Array.isArray(modules) ? modules : []).filter(
    (m) =>
      m.args.includes(`sink_name=${SHARE_SINK}`) ||
      m.args.includes(`source_name=${SHARE_SOURCE}`) ||
      m.args.includes(`${SHARE_SINK}.monitor`),
  );
  const rank = (m) => (m.name === "module-null-sink" ? 1 : 0);
  return ours.sort((a, b) => rank(a) - rank(b)).map((m) => m.index);
}

function nullSinkArgs() {
  return [
    "load-module",
    "module-null-sink",
    `sink_name=${SHARE_SINK}`,
    `sink_properties=device.description=${SHARE_SINK_LABEL}`,
  ];
}

function loopbackArgs(outputName) {
  // Deliberately NOT `sink_dont_move`: if the output disappears (a USB headset
  // unplugged) the server moves the loopback to the next output, where
  // `sink_dont_move` would unload it and leave every shared app mute for the
  // person sharing it.
  return [
    "load-module",
    "module-loopback",
    `source=${SHARE_SINK}.monitor`,
    `sink=${outputName}`,
    `latency_msec=${LOOPBACK_LATENCY_MS}`,
    "source_dont_move=true",
  ];
}

function remapArgs() {
  return [
    "load-module",
    "module-remap-source",
    `master=${SHARE_SINK}.monitor`,
    `source_name=${SHARE_SOURCE}`,
    `source_properties=device.description=${SHARE_SOURCE_LABEL}`,
  ];
}

// ------------------------------------------------------------ orchestrator

/**
 * `run(args)` resolves with pactl's stdout or rejects. `subscribe()` returns a
 * child-like object (`stdout` emitting data, `kill()`, `on("exit")`) or null.
 * `ownPids()` returns a Set of this app's process ids as strings.
 */
function createLinuxShareAudio({
  run,
  subscribe = () => null,
  ownPids,
  log = () => {},
  // Told when a session begins loading modules and when its last one is gone,
  // so the shell can leave a marker for the next launch (see `cleanup`).
  onActive = () => {},
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  setTick = setInterval,
  clearTick = clearInterval,
}) {
  let probed = null;
  let session = null;
  let armedAt = null;
  let chain = Promise.resolve();

  /** One pactl conversation at a time: a reconcile must not race a stop. */
  function serial(task) {
    const next = chain.then(task, task);
    chain = next.catch(() => {});
    return next;
  }

  async function probe() {
    if (probed) {
      return probed;
    }
    try {
      const info = parseInfo(await run(["info"]));
      probed = info.serverName
        ? { available: true, server: info.pipewire ? "pipewire" : "pulseaudio" }
        : { available: false, server: null, reason: "no-server" };
    } catch (err) {
      // No `pactl` on PATH (a minimal install, a Flatpak sandbox) or no sound
      // server answering. Not cached as final for long: a sound server that
      // was restarting will answer the next share.
      const result = { available: false, server: null, reason: "no-pactl" };
      log("probe failed", err?.message ?? err);
      return result;
    }
    return probed;
  }

  async function unloadLeftovers() {
    const modules = parseModules(await run(["list", "short", "modules"]));
    for (const index of leftoverModules(modules)) {
      await run(["unload-module", String(index)]).catch(() => {});
    }
  }

  async function snapshot() {
    const [info, sinks, sources, inputs, outputs] = await Promise.all([
      run(["info"]),
      run(["list", "short", "sinks"]),
      run(["list", "short", "sources"]),
      run(["list", "sink-inputs"]),
      run(["list", "short", "source-outputs"]),
    ]);
    const sinkList = parseNamed(sinks);
    const sourceList = parseNamed(sources);
    return {
      info: parseInfo(info),
      sinkIndex: (name) => sinkList.find((s) => s.name === name)?.index ?? null,
      captureIndex: sourceList.find((s) => s.name === SHARE_SOURCE)?.index ?? null,
      inputs: parseStreams(inputs, "sink-inputs"),
      outputs: parseShort(outputs).map(({ index, cols }) => ({
        index,
        target: Number.parseInt(cols[1], 10),
      })),
    };
  }

  async function reconcileNow() {
    if (!session) {
      return;
    }
    const state = await snapshot();
    const shareIndex = state.sinkIndex(SHARE_SINK);
    if (shareIndex === null) {
      // Somebody unloaded our sink (a sound server restart does it too).
      // Nothing is left to protect; end cleanly.
      log("share sink vanished; ending");
      await stopNow();
      return;
    }
    // The bus must never be the default output. A session manager can pick a
    // new sink as default on its own, and a person can pick it from the
    // desktop's sound menu; either way pqp's own streams would follow it into
    // the capture. Put the default back where it was.
    if (state.info.defaultSink === SHARE_SINK) {
      log("share sink became the default; restoring", session.output);
      await run(["set-default-sink", session.output]).catch(() => {});
    } else if (state.info.defaultSink && state.info.defaultSink !== session.output) {
      // A device switch. Follow it: the person now listens there.
      session.output = state.info.defaultSink;
    }
    const outputIndex = state.sinkIndex(session.output);
    const loop = loopbackInput(state.inputs, session.loopbackModule);
    if (loop && outputIndex !== null && loop.target !== outputIndex) {
      await run(["move-sink-input", String(loop.index), session.output]).catch(() => {});
    }
    const pids = ownPids();
    for (const move of planSinkInputMoves({
      inputs: state.inputs,
      ownPids: pids,
      outputIndex,
      shareIndex,
      outputName: session.output,
    })) {
      await run(["move-sink-input", String(move.index), move.to]).catch(() => {});
    }
    if (captureInUse(state.outputs, state.captureIndex)) {
      session.lastReadAt = now();
    } else if (idleExpired({ now: now(), startedAt: session.startedAt, lastReadAt: session.lastReadAt })) {
      log("capture idle; ending");
      await stopNow();
    }
  }

  function scheduleReconcile() {
    if (!session || session.debounce) {
      return;
    }
    session.debounce = setTimer(() => {
      if (session) {
        session.debounce = null;
      }
      void serial(reconcileNow).catch((err) => log("reconcile failed", err?.message ?? err));
    }, EVENT_DEBOUNCE_MS);
  }

  function watch() {
    const child = subscribe();
    if (!child) {
      return;
    }
    session.subscriber = child;
    child.stdout?.on?.("data", (chunk) => {
      if (/on (sink-input|sink|server|source-output)/.test(String(chunk))) {
        scheduleReconcile();
      }
    });
    child.on?.("exit", () => {
      if (session && session.subscriber === child) {
        session.subscriber = null;
      }
    });
  }

  async function startNow() {
    if (session) {
      // A second share while the first is winding down: keep the bus.
      session.startedAt = now();
      session.lastReadAt = null;
      return { ok: true, label: SHARE_SOURCE_LABEL };
    }
    const probeResult = await probe();
    if (!probeResult.available) {
      return { ok: false, reason: probeResult.reason ?? "unavailable" };
    }
    await unloadLeftovers().catch(() => {});
    const info = parseInfo(await run(["info"]));
    const output = info.defaultSink;
    if (!output || output === SHARE_SINK) {
      return { ok: false, reason: "no-output" };
    }
    onActive(true);
    session = {
      output,
      modules: [],
      loopbackModule: null,
      startedAt: now(),
      lastReadAt: null,
      subscriber: null,
      debounce: null,
      tick: null,
    };
    try {
      const sinkModule = Number.parseInt(await run(nullSinkArgs()), 10);
      session.modules.push(sinkModule);
      const loopModule = Number.parseInt(await run(loopbackArgs(output)), 10);
      session.modules.push(loopModule);
      session.loopbackModule = Number.isFinite(loopModule) ? loopModule : null;
      session.modules.push(Number.parseInt(await run(remapArgs()), 10));
      await reconcileNow();
    } catch (err) {
      log("start failed", err?.message ?? err);
      await stopNow();
      return { ok: false, reason: "load-failed" };
    }
    if (!session) {
      return { ok: false, reason: "ended" };
    }
    watch();
    session.tick = setTick(() => scheduleReconcile(), TICK_MS);
    log("started", { server: probeResult.server, output });
    return { ok: true, label: SHARE_SOURCE_LABEL };
  }

  async function stopNow() {
    const ending = session;
    if (!ending) {
      return;
    }
    session = null;
    if (ending.tick) {
      clearTick(ending.tick);
    }
    if (ending.debounce) {
      clearTimer(ending.debounce);
    }
    try {
      ending.subscriber?.kill?.();
    } catch {
      // Already gone.
    }
    // Put every app back on the output explicitly before the sink goes, so
    // nothing depends on the server's fallback choice.
    try {
      const inputs = parseStreams(await run(["list", "sink-inputs"]), "sink-inputs");
      const shareIndex = parseNamed(await run(["list", "short", "sinks"])).find(
        (s) => s.name === SHARE_SINK,
      )?.index;
      for (const input of inputs) {
        if (isAppStream(input) && input.target === shareIndex) {
          await run(["move-sink-input", String(input.index), ending.output]).catch(() => {});
        }
      }
    } catch {
      // The unload below still moves them, to the server's fallback.
    }
    for (const index of [...ending.modules].reverse()) {
      if (Number.isFinite(index)) {
        await run(["unload-module", String(index)]).catch(() => {});
      }
    }
    await unloadLeftovers().catch(() => {});
    onActive(false);
    log("stopped");
  }

  return {
    probe,
    /**
     * The page says: the next display-media request is a share it has asked
     * the person about, with the runtime flag on. Nothing else may start the
     * bus, whatever a request's `audioRequested` says (a console probe, a
     * stale page, a third-party frame that got through).
     */
    arm: () => {
      armedAt = now();
    },
    /** Read once per request, like the Windows arm: good for ONE share. */
    consumeArm: () => {
      const armed = armedAt !== null && now() - armedAt <= ARM_TTL_MS;
      armedAt = null;
      return armed;
    },
    start: () => serial(startNow),
    stop: () => serial(stopNow),
    /** One pass of the watcher, on demand (tests, and a renderer that knows). */
    reconcile: () => serial(reconcileNow),
    /**
     * For startup, and only when a marker says a session was live and never
     * ended cleanly: clear what a crashed session left behind. Never run
     * speculatively, because it reads the user's sound server.
     */
    cleanup: () => serial(unloadLeftovers),
    isActive: () => session !== null,
    /** Module ids to unload synchronously on quit. */
    activeModules: () => (session ? [...session.modules] : []),
  };
}

module.exports = {
  SHARE_SINK,
  SHARE_SOURCE,
  SHARE_SOURCE_LABEL,
  SHARE_SINK_LABEL,
  IDLE_BEFORE_FIRST_READ_MS,
  IDLE_AFTER_READ_MS,
  ARM_TTL_MS,
  parseInfo,
  parseShort,
  parseNamed,
  parseModules,
  parseStreams,
  isOwnStream,
  planSinkInputMoves,
  loopbackInput,
  captureInUse,
  idleExpired,
  leftoverModules,
  nullSinkArgs,
  loopbackArgs,
  remapArgs,
  createLinuxShareAudio,
};
