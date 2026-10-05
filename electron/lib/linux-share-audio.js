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
 *
 * TWO WAYS TO FEED THE BUS (October 2026, after the first report from real
 * hardware: a CachyOS desktop where browsers and one game reached viewers, and
 * Spotify from Flathub and Helldivers 2 did not).
 *
 * MOVING a stream (the design above, and still the PulseAudio path) needs
 * every stream to be movable, and two kinds are not:
 *   - a stream opened with `PA_STREAM_DONT_MOVE`: `pactl move-sink-input`
 *     answers "Failure: Invalid argument" on PulseAudio 17 and PipeWire 1.4
 *     alike (reproduced). Wine's winepulse sets that flag whenever a game opens
 *     a NAMED endpoint rather than the default one (`pulse_stream_connect` in
 *     dlls/winepulse.drv/pulse.c), so it is exactly the Proton game case;
 *   - a native PipeWire stream (Spotify since 1.2.86, `pw-play`, SDL3,
 *     GStreamer): `pactl` lists it as a sink input but with no
 *     `application.process.id`, because that lives on its client object, and
 *     the move path refuses to touch a stream it cannot prove is not pqp's.
 * Moving also writes `target: "pqp_share_audio"` into WirePlumber's
 * `stream-properties` for that app name, for good (reproduced on 0.5.8).
 *
 * So on PipeWire, when `pw-dump` and `pw-link` are there, the shell LINKS
 * instead of moving: every playback stream that is not pqp's, and that is
 * playing to the user's default output, gets a second link from its output
 * ports to the bus. Its original link to the speakers is untouched, so the
 * person hears exactly what they heard before, nothing is remembered, there
 * is no loopback (and none of its latency), and pinned and native streams are
 * shared like any other (reproduced: DONT_MOVE, `node.dont-reconnect`, a
 * native stream, a Flatpak-shaped native stream with an AUX0/AUX1 map).
 * WirePlumber leaves links it did not make alone, across a default-device
 * switch too, and unloading the bus takes every link into it with it.
 *
 * Which streams are pqp's: process ids, nothing else. A stream's ids are its
 * own `application.process.id` (libpulse clients), its client's
 * `application.process.id`, and its client's `pipewire.sec.pid` (the socket's
 * peer, so a native client cannot hide behind a sandbox pid). Any one of them
 * in pqp's process list makes it pqp's, and a stream with no id at all is
 * never shared, because it cannot be proven not to be the call. Names are not
 * used: every Chromium app calls itself something similar.
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
/** Most streams one diagnostic report keeps (the oldest goes first). */
const REPORT_LIMIT = 48;
/** How often one failing link is tried again before it is reported and left. */
const LINK_ATTEMPTS = 3;
/** Processes that are the sound server itself: their streams are modules. */
const SERVER_BINARIES = new Set(["pipewire", "pipewire-pulse", "wireplumber", "pulseaudio"]);

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
        client: null,
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
      } else if (field[1] === "Client") {
        const n = Number.parseInt(field[2], 10);
        current.client = Number.isFinite(n) ? n : null;
      }
    }
  }
  return streams.filter((s) => Number.isFinite(s.index));
}

/**
 * `pactl list clients` (LC_ALL=C): `Map<index, props>`. Only read when a
 * stream carries no process id of its own (a native PipeWire stream), to find
 * the process behind it.
 */
function parseClients(text) {
  const clients = new Map();
  let props = null;
  let inProps = false;
  for (const raw of String(text ?? "").split("\n")) {
    if (raw.startsWith("Client #")) {
      props = {};
      clients.set(Number.parseInt(raw.slice("Client #".length), 10), props);
      inProps = false;
      continue;
    }
    if (!props) {
      continue;
    }
    const line = raw.trim();
    if (line === "Properties:") {
      inProps = true;
      continue;
    }
    const prop = /^([A-Za-z0-9_.-]+)\s*=\s*"(.*)"$/.exec(line);
    if (inProps && prop) {
      props[prop[1]] = prop[2];
    } else if (/^[A-Za-z ]+:/.test(line)) {
      inProps = false;
    }
  }
  return clients;
}

// ----------------------------------------------------------------- deciding

/** A property as a non-empty string, whatever JSON type `pw-dump` used. */
function propText(props, key) {
  const value = props?.[key];
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

/**
 * Every process id that can be said to be behind a stream: its own
 * `application.process.id` (what libpulse stamps), its client's (what a native
 * PipeWire client stamps), and its client's `pipewire.sec.pid`, the socket
 * peer's pid as the kernel reports it. That last one is the only id a
 * sandboxed app cannot choose: a Flatpak reports `application.process.id = 2`
 * from inside its own pid namespace. For a client of the pulse compatibility
 * server the socket peer is the server itself, so it is left out there.
 */
function streamPids(props, clientProps) {
  const pids = new Set();
  const add = (value) => {
    if (/^\d+$/.test(value) && value !== "0") {
      pids.add(value);
    }
  };
  add(propText(props, "application.process.id"));
  if (clientProps) {
    add(propText(clientProps, "application.process.id"));
    const viaPulse = propText(clientProps, "client.api") === "pipewire-pulse";
    if (!viaPulse && !SERVER_BINARIES.has(propText(clientProps, "application.process.binary"))) {
      add(propText(clientProps, "pipewire.sec.pid"));
    }
  }
  return pids;
}

/** The binary behind a stream, for the own-process check and the report. */
function streamBinary(props, clientProps) {
  return (
    propText(props, "application.process.binary") ||
    propText(clientProps, "application.process.binary")
  );
}

/**
 * A stream opened by one of this app's processes (the call, sounds, films).
 * Any id behind it in our process list is enough, and so is our own
 * executable's name when the shell passes it: a false "ours" only costs a
 * stream its place in the share, while a false "not ours" is the echo.
 */
function isOwnStream(stream, ownPids, ownBinaries = null) {
  for (const pid of streamPids(stream?.props, stream?.clientProps)) {
    if (ownPids.has(pid)) {
      return true;
    }
  }
  const binary = streamBinary(stream?.props, stream?.clientProps);
  return Boolean(binary && ownBinaries && ownBinaries.has(binary));
}

/**
 * Only application streams are ever moved or linked. A stream with no client
 * process belongs to a module (our own loopback, somebody's echo-cancel, an
 * effects chain) and touching it can build a feedback loop or break a setup we
 * do not understand. A stream with no process id at all is not shared either:
 * nothing can prove it is not the call.
 */
function isAppStream(stream) {
  // Not `Owner Module`: on PulseAudio every client stream is owned by the
  // native-protocol module, so that field says nothing about who opened it.
  if (propText(stream?.props, "pulse.module.id")) {
    return false;
  }
  if (SERVER_BINARIES.has(streamBinary(stream?.props, stream?.clientProps))) {
    return false;
  }
  return streamPids(stream?.props, stream?.clientProps).size > 0;
}

/** What the diagnostic report calls a stream: names already on screen elsewhere. */
function describeStream(props, clientProps) {
  const pids = [...streamPids(props, clientProps)];
  return {
    app:
      propText(props, "application.name") ||
      propText(clientProps, "application.name") ||
      propText(props, "media.name") ||
      propText(props, "node.name") ||
      "?",
    media: propText(props, "media.name") || null,
    binary: streamBinary(props, clientProps) || null,
    pids,
    flatpak:
      propText(props, "pipewire.access.portal.app_id") ||
      propText(clientProps, "pipewire.access.portal.app_id") ||
      null,
    pinned:
      propText(props, "node.dont-reconnect") === "true" ||
      propText(props, "node.dont-move") === "true",
  };
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
function planSinkInputMoves({
  inputs,
  ownPids,
  ownBinaries = null,
  outputIndex,
  shareIndex,
  outputName,
  refused = null,
}) {
  const moves = [];
  for (const input of Array.isArray(inputs) ? inputs : []) {
    // The echo guard comes before every other test, the module test
    // included: a stream of ours on the bus goes back out whatever else is
    // true of it.
    if (isOwnStream(input, ownPids, ownBinaries)) {
      if (input.target === shareIndex) {
        moves.push({ index: input.index, to: outputName });
      }
      continue;
    }
    if (!isAppStream(input)) {
      continue;
    }
    // A stream the server refused to move once (PA_STREAM_DONT_MOVE) refuses
    // every time: asking again every two seconds only spawns `pactl`.
    if (refused?.has(input.index)) {
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

// ------------------------------------------------- the PipeWire graph (link)

/**
 * `pw-dump` JSON, reduced to what the link path decides with: nodes (with
 * their client's properties attached), ports, links, and the default sink's
 * name from the `default` metadata. Property values are kept as strings:
 * `pw-dump` writes `"application.process.id": 4242` as a NUMBER.
 */
function parsePwDump(text) {
  let objects;
  try {
    objects = JSON.parse(String(text ?? ""));
  } catch {
    return null;
  }
  if (!Array.isArray(objects)) {
    return null;
  }
  const clients = new Map();
  const nodes = new Map();
  const ports = [];
  const links = [];
  let defaultSink = null;
  const strings = (props) => {
    const out = {};
    for (const [key, value] of Object.entries(props ?? {})) {
      if (value !== null && typeof value !== "object") {
        out[key] = String(value);
      }
    }
    return out;
  };
  for (const object of objects) {
    const type = String(object?.type ?? "");
    const id = Number(object?.id);
    if (!Number.isFinite(id)) {
      continue;
    }
    if (type === "PipeWire:Interface:Client") {
      clients.set(id, strings(object.info?.props));
    } else if (type === "PipeWire:Interface:Node") {
      const props = strings(object.info?.props);
      nodes.set(id, { id, props, clientProps: null });
    } else if (type === "PipeWire:Interface:Port") {
      const props = strings(object.info?.props);
      ports.push({
        id,
        node: Number(props["node.id"]),
        direction: object.info?.direction === "input" ? "input" : "output",
        channel: props["audio.channel"] ?? "",
        monitor: props["port.monitor"] === "true",
      });
    } else if (type === "PipeWire:Interface:Link") {
      const info = object.info ?? {};
      links.push({
        id,
        outNode: Number(info["output-node-id"]),
        outPort: Number(info["output-port-id"]),
        inNode: Number(info["input-node-id"]),
        inPort: Number(info["input-port-id"]),
      });
    } else if (type === "PipeWire:Interface:Metadata" && object.props?.["metadata.name"] === "default") {
      for (const entry of Array.isArray(object.metadata) ? object.metadata : []) {
        if (entry?.key === "default.audio.sink") {
          const value = typeof entry.value === "string" ? safeJson(entry.value) : entry.value;
          defaultSink = typeof value?.name === "string" ? value.name : null;
        }
      }
    }
  }
  for (const node of nodes.values()) {
    const client = Number(node.props["client.id"]);
    node.clientProps = clients.get(client) ?? null;
  }
  return { nodes, ports, links, defaultSink };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function findNode(graph, name, mediaClass) {
  for (const node of graph.nodes.values()) {
    if (node.props["node.name"] === name && node.props["media.class"] === mediaClass) {
      return node;
    }
  }
  return null;
}

/**
 * Which of the bus's inputs one output channel of a stream feeds. Stereo goes
 * straight across; surround folds left and right; centre and mono feed both;
 * the subwoofer is dropped; numbered AUX channels (Spotify 1.2.86 opens
 * AUX0,AUX1) alternate left and right; anything else falls back to its place.
 */
function busChannelsFor(channel, position, count) {
  const ch = String(channel ?? "").toUpperCase();
  const LEFT = new Set(["FL", "RL", "SL", "FLC", "FLW", "RLC", "TFL", "TRL", "TSL"]);
  const RIGHT = new Set(["FR", "RR", "SR", "FRC", "FRW", "RRC", "TFR", "TRR", "TSR"]);
  const BOTH = new Set(["MONO", "FC", "RC", "TC", "TFC", "TRC"]);
  if (count === 1 || BOTH.has(ch)) {
    return ["FL", "FR"];
  }
  if (LEFT.has(ch)) {
    return ["FL"];
  }
  if (RIGHT.has(ch)) {
    return ["FR"];
  }
  if (ch === "LFE") {
    return [];
  }
  const aux = /^AUX(\d+)$/.exec(ch);
  const n = aux ? Number(aux[1]) : position;
  return [n % 2 === 0 ? "FL" : "FR"];
}

/**
 * A playback stream that relays other audio: one half of a loopback or a
 * filter chain (`node.link-group`), or an app that also owns a sink or records
 * a sink's monitor (an effects app, a desktop-audio recorder that plays back).
 * Its sound can contain the call, so it is never linked into the bus.
 */
function relaysOtherAudio(graph, node) {
  if (node.props["node.link-group"]) {
    return true;
  }
  const client = node.props["client.id"];
  if (!client) {
    return false;
  }
  const portsById = new Map(graph.ports.map((p) => [p.id, p]));
  for (const other of graph.nodes.values()) {
    if (other.props["client.id"] !== client || other.id === node.id) {
      continue;
    }
    const mediaClass = other.props["media.class"] ?? "";
    if (mediaClass.startsWith("Audio/Sink") || mediaClass.startsWith("Audio/Duplex")) {
      return true;
    }
    if (mediaClass === "Stream/Input/Audio") {
      for (const link of graph.links) {
        if (link.inNode !== other.id) {
          continue;
        }
        const from = graph.nodes.get(link.outNode);
        if (portsById.get(link.outPort)?.monitor || (from?.props["media.class"] ?? "").startsWith("Audio/Sink")) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * The link path's whole decision, from one `pw-dump`.
 *
 * Returns `{ unlinks, moves, links, report }`:
 *   - `unlinks`: link ids to destroy. Only ever a link from one of OUR
 *     streams into the bus: the echo, answered first.
 *   - `moves`: `{ index, to }` for `pactl move-sink-input`, for a stream that
 *     was ROUTED into the bus rather than linked (WirePlumber restoring a
 *     target a move-path session left behind, or a person picking the bus in
 *     a mixer). With no loopback the bus is silent to the person, so it goes
 *     back to their output.
 *   - `links`: `{ out, in, node }` port pairs to create with `pw-link`.
 *   - `report`: one entry per playback stream, for the diagnostic page.
 *
 * Only streams PLAYING TO THE DEFAULT OUTPUT are linked, the same rule the
 * move path keeps: with an effects app the default is its sink, its own
 * output stream (which carries everything, the call too) plays to the real
 * device, and so it is left out by the rule as well as by `relaysOtherAudio`.
 * `sticky` (`object.serial`s this session already linked) is the one exception: such a
 * stream is linked again wherever it now plays, since being on the default
 * output is how it qualified, not something it has to keep doing.
 */
function planLinks({ graph, ownPids, ownBinaries = null, outputName, failed = null, sticky = null }) {
  const out = { unlinks: [], moves: [], links: [], report: [] };
  const bus = findNode(graph, SHARE_SINK, "Audio/Sink");
  if (!bus) {
    return out;
  }
  const output = findNode(graph, outputName, "Audio/Sink");
  const busIn = new Map();
  for (const port of graph.ports) {
    if (port.node === bus.id && port.direction === "input") {
      busIn.set(port.channel.toUpperCase(), port.id);
    }
  }
  const busInByIndex = graph.ports
    .filter((p) => p.node === bus.id && p.direction === "input")
    .map((p) => p.id);
  const existing = new Set(graph.links.map((l) => `${l.outPort}>${l.inPort}`));

  for (const node of graph.nodes.values()) {
    if (node.props["media.class"] !== "Stream/Output/Audio") {
      continue;
    }
    const stream = { props: node.props, clientProps: node.clientProps };
    // `object.serial` is never reused; a node id is, once its node is gone.
    const serial = node.props["object.serial"] ?? `id:${node.id}`;
    const entry = {
      node: node.id,
      serial,
      ...describeStream(node.props, node.clientProps),
      own: false,
      outcome: "",
      detail: null,
    };
    const fromHere = graph.links.filter((l) => l.outNode === node.id);
    const intoBus = fromHere.filter((l) => l.inNode === bus.id);
    const elsewhere = fromHere.filter((l) => l.inNode !== bus.id);

    if (isOwnStream(stream, ownPids, ownBinaries)) {
      entry.own = true;
      if (intoBus.length > 0 && elsewhere.length === 0) {
        // ROUTED into the bus (it was made the default, or a mixer sent it
        // there): the session manager owns that link, so the session manager
        // is asked to move it. Destroying its link instead was measured on
        // WirePlumber 0.4 with real Electron: it put the link straight back
        // and the call stayed in the capture for seconds.
        out.moves.push({ index: Number(node.props["object.serial"] ?? node.id), to: outputName });
      } else {
        // An EXTRA link into the bus beside its real one: nobody manages it,
        // so it goes.
        for (const link of intoBus) {
          out.unlinks.push(link.id);
        }
      }
      entry.outcome = intoBus.length > 0 ? "pqp-pulled-out" : "pqp-kept-out";
      out.report.push(entry);
      continue;
    }
    if (!isAppStream(stream)) {
      entry.outcome = streamPids(node.props, node.clientProps).size > 0 ? "skipped-module" : "skipped-no-process";
      out.report.push(entry);
      continue;
    }
    if (relaysOtherAudio(graph, node)) {
      entry.outcome = "skipped-relay";
      out.report.push(entry);
      continue;
    }
    if (intoBus.length > 0 && elsewhere.length === 0) {
      // Routed INTO the bus, not linked: silent for the person sharing.
      if (output) {
        out.moves.push({ index: Number(node.props["object.serial"] ?? node.id), to: outputName });
      }
      entry.outcome = "moved-back";
      out.report.push(entry);
      continue;
    }
    // A stream this session already shared keeps being shared wherever it
    // plays now (a game pinned to the old device after a default switch, an
    // app the person moved to a headset mid-share). If our link to it is ever
    // gone (a stream renegotiating its ports, a patchbay), it is put back, not
    // just left alone; being on the default output is how it qualified, not
    // something it has to keep doing.
    const playsToOutput = Boolean(output) && elsewhere.some((l) => l.inNode === output.id);
    if (!playsToOutput && !(sticky?.has(serial) && elsewhere.length > 0)) {
      entry.outcome = intoBus.length > 0 ? "linked" : elsewhere.length > 0 ? "other-output" : "not-playing";
      out.report.push(entry);
      continue;
    }
    const outPorts = graph.ports
      .filter((p) => p.node === node.id && p.direction === "output" && !p.monitor)
      .sort((a, b) => a.id - b.id);
    let wanted = 0;
    let gaveUp = null;
    outPorts.forEach((port, position) => {
      for (const ch of busChannelsFor(port.channel, position, outPorts.length)) {
        const target = busIn.get(ch) ?? busInByIndex[ch === "FL" ? 0 : busInByIndex.length > 1 ? 1 : 0];
        if (target === undefined) {
          continue;
        }
        wanted += 1;
        const key = `${port.id}>${target}`;
        if (existing.has(key)) {
          continue;
        }
        const failure = failed?.get(key);
        if (failure && failure.count >= LINK_ATTEMPTS) {
          gaveUp = failure.error;
          continue;
        }
        out.links.push({ out: port.id, in: target, node: node.id });
      }
    });
    if (gaveUp) {
      entry.outcome = "link-failed";
      entry.detail = gaveUp;
    } else {
      entry.outcome = wanted > 0 ? "linked" : "no-ports";
    }
    out.report.push(entry);
  }
  return out;
}

/** Is anybody recording from our capture source, by the graph? */
function graphCaptureInUse(graph) {
  const capture = findNode(graph, SHARE_SOURCE, "Audio/Source/Virtual") ?? findNode(graph, SHARE_SOURCE, "Audio/Source");
  if (!capture) {
    return false;
  }
  return graph.links.some((l) => l.outNode === capture.id);
}

/** Link ids into the bus: on teardown every one of them goes. */
function linksIntoBus(graph) {
  const bus = findNode(graph, SHARE_SINK, "Audio/Sink");
  return bus ? graph.links.filter((l) => l.inNode === bus.id).map((l) => l.id) : [];
}

/** The last line a failed tool wrote, for the report ("Failure: Invalid argument"). */
function errorText(err) {
  const text = String(err?.stderr || err?.message || err || "").trim();
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? "error").slice(0, 200);
}

// ------------------------------------------------------------ orchestrator

/**
 * `run(args)` resolves with pactl's stdout or rejects (ideally with the
 * tool's `stderr` on the error). `runPw(tool, args)` does the same for
 * `pw-dump` and `pw-link`, and is null where the shell offers neither.
 * `subscribe()` returns a child-like object (`stdout` emitting data, `kill()`,
 * `on("exit")`) or null. `ownPids()` returns a Set of this app's process ids
 * as strings, `ownBinaries()` a Set of its executable names.
 * `onReport(diagnostics)` is told when what the watcher did to a stream
 * changed, so the shell can keep it in a file for the next bug report.
 */
function createLinuxShareAudio({
  run,
  runPw = null,
  subscribe = () => null,
  ownPids,
  ownBinaries = () => new Set(),
  log = () => {},
  // Told when a session begins loading modules and when its last one is gone,
  // so the shell can leave a marker for the next launch (see `cleanup`).
  onActive = () => {},
  onReport = () => {},
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
  /** The last session's report, kept after it ends for "copy diagnostics". */
  let lastReport = null;

  /** One sound-server conversation at a time: a reconcile must not race a stop. */
  function serial(task) {
    const next = chain.then(task, task);
    chain = next.catch(() => {});
    return next;
  }

  function pw(tool, args) {
    if (!runPw || (tool !== "pw-dump" && tool !== "pw-link")) {
      return Promise.reject(new Error(`${tool} unavailable`));
    }
    return runPw(tool, args);
  }

  async function probe() {
    if (probed) {
      return probed;
    }
    try {
      const info = parseInfo(await run(["info"]));
      if (!info.serverName) {
        probed = { available: false, server: null, mode: null, reason: "no-server" };
        return probed;
      }
      const server = info.pipewire ? "pipewire" : "pulseaudio";
      // Linking needs PipeWire AND both of its tools; anything less moves.
      let mode = "move";
      if (info.pipewire && runPw) {
        const tools = await Promise.all([
          pw("pw-dump", ["--version"]).then(() => true, () => false),
          pw("pw-link", ["--version"]).then(() => true, () => false),
        ]);
        if (tools.every(Boolean)) {
          mode = "link";
        }
      }
      probed = { available: true, server, mode };
    } catch (err) {
      // No `pactl` on PATH (a minimal install, a Flatpak sandbox) or no sound
      // server answering. Not cached as final for long: a sound server that
      // was restarting will answer the next share.
      const result = { available: false, server: null, mode: null, reason: "no-pactl" };
      log("probe failed", err?.message ?? err);
      return result;
    }
    return probed;
  }

  // --------------------------------------------------------------- report

  function snapshotReport() {
    if (!session) {
      return lastReport;
    }
    return {
      active: true,
      mode: session.mode,
      server: session.server,
      output: session.output,
      startedAt: session.startedAt,
      lastReadAt: session.lastReadAt,
      endedReason: null,
      streams: [...session.report.values()].map((entry) => ({ ...entry })),
    };
  }

  /**
   * Record what happened to each stream this pass. An entry keeps the first
   * time it was seen and is never forgotten during a session (up to a bound),
   * so a stream that came and went is still in the report afterwards.
   */
  function record(entries) {
    if (!session) {
      return;
    }
    let changed = false;
    for (const entry of entries) {
      const key = entry.key;
      const previous = session.report.get(key);
      if (!previous) {
        session.report.set(key, { ...entry, firstSeenAt: now(), lastSeenAt: now() });
        changed = true;
      } else {
        if (previous.outcome !== entry.outcome || previous.detail !== entry.detail) {
          changed = true;
        }
        session.report.set(key, { ...previous, ...entry, lastSeenAt: now() });
      }
    }
    while (session.report.size > REPORT_LIMIT) {
      session.report.delete(session.report.keys().next().value);
    }
    if (changed) {
      for (const entry of entries) {
        if (session.logged.get(entry.key) !== entry.outcome) {
          session.logged.set(entry.key, entry.outcome);
          log("stream", entry.app, entry.binary ?? "", entry.outcome, entry.detail ?? "");
        }
      }
      try {
        onReport(snapshotReport());
      } catch {
        // A report that cannot be written is not a reason to stop a share.
      }
    }
  }

  // --------------------------------------------------------------- modules

  /**
   * Unload what is ours, then look again: resolves with how many of our
   * modules are STILL loaded, so a caller never treats "tried" as "gone".
   * On PipeWire the links into the bus go first, explicitly; unloading the
   * bus would take them anyway, but a link nobody named is a link nobody
   * checked.
   */
  async function unloadLeftovers() {
    if (runPw) {
      try {
        const graph = parsePwDump(await pw("pw-dump", []));
        for (const id of graph ? linksIntoBus(graph) : []) {
          await pw("pw-link", ["-d", String(id)]).catch(() => {});
        }
      } catch {
        // No PipeWire tools, or no PipeWire: the unload below is enough.
      }
    }
    const modules = parseModules(await run(["list", "short", "modules"]));
    for (const index of leftoverModules(modules)) {
      await run(["unload-module", String(index)]).catch(() => {});
    }
    return leftoverModules(parseModules(await run(["list", "short", "modules"]))).length;
  }

  // ---------------------------------------------------------- move path

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
    const streams = parseStreams(inputs, "sink-inputs");
    // A stream with no process id of its own (a native PipeWire client) is
    // traced to its client, the only place its process is written down.
    if (streams.some((s) => !propText(s.props, "application.process.id") && s.client !== null)) {
      const clients = parseClients(await run(["list", "clients"]).catch(() => ""));
      for (const stream of streams) {
        stream.clientProps = stream.client !== null ? clients.get(stream.client) ?? null : null;
      }
    }
    return {
      info: parseInfo(info),
      sinkIndex: (name) => sinkList.find((s) => s.name === name)?.index ?? null,
      captureIndex: sourceList.find((s) => s.name === SHARE_SOURCE)?.index ?? null,
      inputs: streams,
      outputs: parseShort(outputs).map(({ index, cols }) => ({
        index,
        target: Number.parseInt(cols[1], 10),
      })),
    };
  }

  /** What the move path did to each stream this pass, for the report. */
  function moveReport(state, { shareIndex, outputIndex, pids, binaries, moved, refusedNow }) {
    const entries = [];
    for (const input of state.inputs) {
      if (input.ownerModule !== null && input.ownerModule === session.loopbackModule) {
        continue;
      }
      const entry = {
        key: `input:${input.index}`,
        node: input.index,
        ...describeStream(input.props, input.clientProps),
        own: isOwnStream(input, pids, binaries),
        outcome: "",
        detail: null,
      };
      const refused = session.refused.get(input.index);
      if (entry.own) {
        entry.outcome = moved.has(input.index) || input.target === shareIndex ? "pqp-pulled-out" : "pqp-kept-out";
      } else if (!isAppStream(input)) {
        entry.outcome = streamPids(input.props, input.clientProps).size > 0 ? "skipped-module" : "skipped-no-process";
      } else if (refused) {
        entry.outcome = "refused";
        entry.detail = refused;
      } else if (moved.has(input.index) || input.target === shareIndex) {
        entry.outcome = "moved";
      } else if (refusedNow.has(input.index)) {
        entry.outcome = "move-failed";
        entry.detail = refusedNow.get(input.index);
      } else {
        entry.outcome = input.target === outputIndex ? "pending" : "other-output";
      }
      entries.push(entry);
    }
    return entries;
  }

  async function reconcileMove() {
    const state = await snapshot();
    const shareIndex = state.sinkIndex(SHARE_SINK);
    if (shareIndex === null) {
      // Somebody unloaded our sink (a sound server restart does it too).
      // Nothing is left to protect; end cleanly.
      log("share sink vanished; ending");
      await stopNow("sink-vanished");
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
    const binaries = ownBinaries();
    const moved = new Set();
    const refusedNow = new Map();
    for (const move of planSinkInputMoves({
      inputs: state.inputs,
      ownPids: pids,
      ownBinaries: binaries,
      outputIndex,
      shareIndex,
      outputName: session.output,
      refused: session.refused,
    })) {
      try {
        await run(["move-sink-input", String(move.index), move.to]);
        moved.add(move.index);
      } catch (err) {
        const text = errorText(err);
        if (move.to === SHARE_SINK) {
          // "Invalid argument" is the server saying the stream was opened
          // with PA_STREAM_DONT_MOVE (a Wine game on a named device does it).
          // It will say so every time: stop asking, and say why in the report.
          const attempts = (session.moveFailures.get(move.index) ?? 0) + 1;
          session.moveFailures.set(move.index, attempts);
          if (/invalid argument/i.test(text) || attempts >= LINK_ATTEMPTS) {
            session.refused.set(move.index, text);
          } else {
            refusedNow.set(move.index, text);
          }
        } else {
          log("could not pull a pqp stream out of the bus", text);
        }
      }
    }
    record(moveReport(state, { shareIndex, outputIndex, pids, binaries, moved, refusedNow }));
    if (captureInUse(state.outputs, state.captureIndex)) {
      session.lastReadAt = now();
    } else if (idleExpired({ now: now(), startedAt: session.startedAt, lastReadAt: session.lastReadAt })) {
      log("capture idle; ending");
      await stopNow("capture-idle");
    }
  }

  // ---------------------------------------------------------- link path

  async function reconcileLink() {
    const graph = parsePwDump(await pw("pw-dump", []));
    if (!graph) {
      throw new Error("pw-dump answered something that is not JSON");
    }
    if (!findNode(graph, SHARE_SINK, "Audio/Sink")) {
      log("share sink vanished; ending");
      await stopNow("sink-vanished");
      return;
    }
    if (graph.defaultSink === SHARE_SINK) {
      log("share sink became the default; restoring", session.output);
      await run(["set-default-sink", session.output]).catch(() => {});
    } else if (graph.defaultSink && graph.defaultSink !== session.output) {
      session.output = graph.defaultSink;
    }
    const pids = ownPids();
    const plan = planLinks({
      graph,
      ownPids: pids,
      ownBinaries: ownBinaries(),
      outputName: session.output,
      failed: session.linkFailures,
      sticky: session.shared,
    });
    // Ours out of the bus before anything else is added to it.
    for (const id of plan.unlinks) {
      await pw("pw-link", ["-d", String(id)]).catch((err) =>
        log("could not unlink a pqp stream from the bus", errorText(err)),
      );
    }
    for (const move of plan.moves) {
      await run(["move-sink-input", String(move.index), move.to]).catch(() => {});
    }
    const failedNodes = new Map();
    for (const link of plan.links) {
      const key = `${link.out}>${link.in}`;
      try {
        await pw("pw-link", [String(link.out), String(link.in)]);
        session.linkFailures.delete(key);
      } catch (err) {
        const text = errorText(err);
        // "File exists": a link we made a moment ago, already there.
        if (/file exists/i.test(text)) {
          continue;
        }
        const failure = session.linkFailures.get(key) ?? { count: 0, error: text };
        session.linkFailures.set(key, { count: failure.count + 1, error: text });
        failedNodes.set(link.node, text);
      }
    }
    for (const entry of plan.report) {
      if (entry.outcome === "linked" && !failedNodes.has(entry.node)) {
        session.shared.add(entry.serial);
      } else if (entry.own || entry.outcome.startsWith("skipped")) {
        session.shared.delete(entry.serial);
      }
    }
    record(
      plan.report.map((entry) => {
        const failure = failedNodes.get(entry.node);
        return {
          ...entry,
          key: `node:${entry.node}`,
          ...(failure && entry.outcome === "linked" ? { outcome: "link-failed", detail: failure } : {}),
        };
      }),
    );
    if (graphCaptureInUse(graph)) {
      session.lastReadAt = now();
    } else if (idleExpired({ now: now(), startedAt: session.startedAt, lastReadAt: session.lastReadAt })) {
      log("capture idle; ending");
      await stopNow("capture-idle");
    }
  }

  async function reconcileNow() {
    if (!session) {
      return;
    }
    if (session.mode === "link") {
      await reconcileLink();
    } else {
      await reconcileMove();
    }
  }

  function scheduleReconcile() {
    if (!session || session.debounce) {
      return;
    }
    session.debounce = setTimer(() => {
      const current = session;
      if (!current) {
        return;
      }
      current.debounce = null;
      // At most one pass running and one more wanted. A sound server that is
      // slow to answer must not make every tick and event queue a pass of its
      // own (each one is several processes once it finally runs).
      if (current.reconciling) {
        current.rerun = true;
        return;
      }
      current.reconciling = true;
      void serial(reconcileNow)
        .catch((err) => log("reconcile failed", err?.message ?? err))
        .finally(() => {
          current.reconciling = false;
          if (current.rerun && session === current) {
            current.rerun = false;
            scheduleReconcile();
          }
        });
    }, EVENT_DEBOUNCE_MS);
  }

  function watch() {
    const child = subscribe();
    if (!child) {
      return;
    }
    session.subscriber = child;
    child.stdout?.on?.("data", (chunk) => {
      // PipeWire's pulse server reports native streams as sink inputs too, so
      // one subscription covers both paths.
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
    const mode = probeResult.mode === "link" ? "link" : "move";
    session = {
      mode,
      server: probeResult.server,
      output,
      modules: [],
      loopbackModule: null,
      startedAt: now(),
      lastReadAt: null,
      subscriber: null,
      debounce: null,
      reconciling: false,
      rerun: false,
      tick: null,
      report: new Map(),
      logged: new Map(),
      refused: new Map(),
      moveFailures: new Map(),
      linkFailures: new Map(),
      shared: new Set(),
    };
    try {
      const sinkModule = Number.parseInt(await run(nullSinkArgs()), 10);
      session.modules.push(sinkModule);
      if (mode === "move") {
        // Only the move path takes apps OFF the person's output, so only it
        // needs a way back to their ears.
        const loopModule = Number.parseInt(await run(loopbackArgs(output)), 10);
        session.modules.push(loopModule);
        session.loopbackModule = Number.isFinite(loopModule) ? loopModule : null;
      }
      session.modules.push(Number.parseInt(await run(remapArgs()), 10));
      await reconcileNow();
    } catch (err) {
      log("start failed", err?.message ?? err);
      await stopNow("load-failed");
      return { ok: false, reason: "load-failed" };
    }
    if (!session) {
      return { ok: false, reason: "ended" };
    }
    watch();
    session.tick = setTick(() => scheduleReconcile(), TICK_MS);
    log("started", { server: probeResult.server, mode, output });
    return { ok: true, label: SHARE_SOURCE_LABEL };
  }

  async function stopNow(reason = "stopped") {
    const ending = session;
    if (!ending) {
      return;
    }
    lastReport = { ...snapshotReport(), active: false, endedReason: reason };
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
    if (ending.mode === "link") {
      // Our links first, by name, so nothing depends on the unload's side
      // effect; then anything routed into the bus goes back to the output.
      try {
        const graph = parsePwDump(await pw("pw-dump", []));
        for (const id of graph ? linksIntoBus(graph) : []) {
          await pw("pw-link", ["-d", String(id)]).catch(() => {});
        }
      } catch {
        // The unload below takes them with the bus.
      }
    }
    // Put every app back on the output explicitly before the sink goes, so
    // nothing depends on the server's fallback choice.
    try {
      const inputs = parseStreams(await run(["list", "sink-inputs"]), "sink-inputs");
      const shareIndex = parseNamed(await run(["list", "short", "sinks"])).find(
        (s) => s.name === SHARE_SINK,
      )?.index;
      for (const input of inputs) {
        if (input.target === shareIndex && input.ownerModule !== ending.loopbackModule && !propText(input.props, "pulse.module.id")) {
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
    // The marker goes only when nothing of ours is left; a failed unload (or
    // a sound server that stopped answering) keeps it, so the next launch
    // looks again.
    const remaining = await unloadLeftovers().catch(() => -1);
    if (remaining === 0) {
      onActive(false);
    }
    try {
      onReport(lastReport);
    } catch {
      // As above.
    }
    log("stopped", remaining === 0 ? reason : { reason, remaining });
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
    stop: () => serial(() => stopNow("stopped")),
    /** One pass of the watcher, on demand (tests, and a renderer that knows). */
    reconcile: () => serial(reconcileNow),
    /**
     * For startup, and only when a marker says a session was live and never
     * ended cleanly: clear what a crashed session left behind. Never run
     * speculatively, because it reads the user's sound server. Resolves with
     * how many of our modules are still loaded afterwards.
     */
    cleanup: () => serial(unloadLeftovers),
    isActive: () => session !== null,
    /** Module ids to unload synchronously on quit. */
    activeModules: () => (session ? [...session.modules] : []),
    /**
     * What the live session (or the last one) did with every playback stream
     * it saw: app name, binary, process ids, Flatpak id, whether it is pqp's,
     * and the outcome with the sound server's own words when it refused.
     * Reads nothing from the sound server; null before any share.
     */
    diagnostics: () => {
      const report = snapshotReport();
      return report ? { ...report, probe: probed } : probed ? { probe: probed } : null;
    },
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
  LINK_ATTEMPTS,
  parseInfo,
  parseShort,
  parseNamed,
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
  relaysOtherAudio,
  graphCaptureInUse,
  linksIntoBus,
  errorText,
  loopbackInput,
  captureInUse,
  idleExpired,
  leftoverModules,
  nullSinkArgs,
  loopbackArgs,
  remapArgs,
  createLinuxShareAudio,
};
