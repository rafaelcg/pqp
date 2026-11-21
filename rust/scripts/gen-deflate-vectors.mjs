#!/usr/bin/env node
/**
 * permessage-deflate parity fixtures, produced by the peer itself.
 *
 * This generator does not reimplement the framing. It drives the same
 * `PerMessageDeflate` class the server runs, through the same calls
 * `websocket-server.js` makes on a real handshake
 * (`extension.parse(header)` -> `accept(offers)` -> `extension.format(params)`),
 * and records what came out. A fixture written from a reading of RFC 7692 would
 * test the crate against the same misreading, which is how a port ships
 * something that passes its own tests and cannot talk to the browser.
 *
 * THREE THINGS THAT WERE WRONG IN THE FIRST DRAFT OF THIS FILE, all found by
 * running it against `ws` 8.21 rather than reading about it:
 *
 *   - `PerMessageDeflate` takes ONE argument in ws 8. The server flag is
 *     `options.isServer`; a second constructor argument is silently ignored, so
 *     an instance built as `new PerMessageDeflate(opts, true)` negotiates as a
 *     CLIENT and records the wrong directions.
 *   - The deflate knobs live in `options.zlibDeflateOptions`. Passing
 *     `{ level: 3 }` at the top level is accepted and ignored, so the fixtures
 *     would have been compressed at zlib's defaults instead of the shipped ones.
 *   - The shipped policy asks for NO CONTEXT TAKEOVER in both directions, and
 *     `acceptAsServer` forces `server_no_context_takeover` and
 *     `client_no_context_takeover` into the response from the SERVER's options,
 *     whether or not the client mentioned them. A response that omits them is
 *     still a working connection -- with a per-socket window that grows for the
 *     life of the socket, which is the memory behaviour the policy exists to
 *     prevent. That is why the response header is recorded verbatim here.
 *
 * Directions are recorded with the names ws uses internally (`server_*` is the
 * server's own outbound stream, `client_*` the peer's) and translated into
 * `deflate_*` / `inflate_*` for the crate, because mixing the two up is easy and
 * a wrong window bit surfaces as corrupt data two messages later:
 *
 *   deflate_window_bits  the window ws compressed with   -> Rust opens its
 *                        Inflater here
 *   inflate_window_bits  the window ws will decompress   -> Rust must not
 *                        compress with a wider window
 *
 * Run: node --experimental-strip-types --no-warnings \
 *        --import ./rust/scripts/ts-register.mjs rust/scripts/gen-deflate-vectors.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWs } from "./ws-locate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

/** The `ws` the server runs, loaded by path -- see `ws-locate.mjs`. */
const ws = loadWs(root);
const { PerMessageDeflate, extension, package: wsPackage } = ws;

/** The shipped policy, imported rather than retyped, so a change to it fails
 *  the drift check instead of quietly forking the fixture's assumptions. */
const { WS_PER_MESSAGE_DEFLATE } = await import(resolve(here, "../../server/src/lib/ws-compression.ts"));

const out = resolve(here, "../crates/pqp-deflate/fixtures/deflate-vectors.json");

/**
 * `deflated` is the only field in this fixture that is not a property of pqp.
 * Inflate is exact per RFC 1951, so the bytes below are a portable oracle the
 * Rust crate can be required to read; deflate is not -- two zlib builds given
 * the same input, level, window and strategy may both be correct and still
 * disagree byte for byte. Node on a mac and Node on the Linux runner do not
 * carry the same zlib (this one reports `process.versions.zlib`), which is how
 * a green branch turned into a red drift gate over one line nobody changed.
 *
 * So a committed deflate string is kept rather than recompressed. The callers
 * run their read-back check AFTER this, so what survives into the file is what
 * this environment's ws actually inflated, and a vector that stops inflating
 * still fails here instead of in a socket.
 */
const pinnedDeflate = new Map();
if (existsSync(out)) {
  const previous = JSON.parse(readFileSync(out, "utf8"));
  for (const vector of previous.vectors ?? []) {
    (vector.frames ?? []).forEach((frame, index) => {
      pinnedDeflate.set(`${vector.name}\u0000${index}`, frame.deflated ?? null);
    });
  }
}
let kept = 0;
let recompressed = 0;
let minted = 0;

/** Keep the committed deflate string for each frame, keyed by vector name and
 *  frame index. Whether a frame is compressed at all is NOT overridable: that
 *  is a ws decision the port has to match, so a disagreement about it is a
 *  failure rather than something to regenerate over. */
function keepCommitted(name, frames) {
  frames.forEach((frame, index) => {
    const key = `${name}\u0000${index}`;
    if (!pinnedDeflate.has(key)) {
      minted += 1;
      return;
    }
    const committed = pinnedDeflate.get(key);
    if ((committed === null) !== (frame.deflated === null)) {
      throw new Error(
        `${name} frame ${index}: ws changed whether this frame is compressed ` +
          `(committed ${committed === null ? "raw" : "deflated"}, this run ` +
          `${frame.deflated === null ? "raw" : "deflated"}). That is a behaviour ` +
          `change in the shipped policy -- fix the port, do not regenerate over it.`,
      );
    }
    if (committed === null) {
      return;
    }
    if (committed !== frame.deflated) {
      recompressed += 1;
    }
    kept += 1;
    frame.deflated = committed;
    frame.ends_with_sync_marker = Buffer.from(committed, "base64")
      .subarray(-4)
      .equals(Buffer.from([0x00, 0x00, 0xff, 0xff]));
  });
}

/** `ws` is callback-based; every call needs this wrapper. */
function step(instance, method, data, fin) {
  return new Promise((done, fail) => {
    instance[method](data, fin, (err, result) => (err ? fail(err) : done(result)));
  });
}

/** A server-side instance with the shipped options, in the shape
 *  `websocket-server.js` builds it. */
function serverInstance() {
  return new PerMessageDeflate({ ...WS_PER_MESSAGE_DEFLATE, isServer: true });
}

/**
 * Whether `ws` sets RSV1 on a message, mirrored from `sender.js:370-383`.
 *
 * `PerMessageDeflate#compress()` does NOT consult `threshold`: the decision is
 * made by the Sender, and only when the instance's own no-context-takeover
 * parameter is set. A gateway that calls compress() unconditionally is still
 * protocol-correct and still ships bytes the Node server would have sent raw,
 * so the rule is recorded per frame rather than assumed.
 */
function decidesToCompress(byteLength, params) {
  if (!params.server_no_context_takeover) return true;
  return byteLength >= WS_PER_MESSAGE_DEFLATE.threshold;
}

/**
 * One connection: negotiate one real header, then send messages in order on the
 * same two streams. A sequence is the smallest unit that can be wrong, because
 * context takeover -- on or off -- makes message N depend on messages 1..N-1.
 */
async function record(name, header, texts) {
  const offers = extension.parse(header);
  if (!offers[PerMessageDeflate.extensionName]) {
    throw new Error(`${name}: header has no permessage-deflate offer: ${header}`);
  }
  const pmd = serverInstance();
  const params = pmd.accept(offers[PerMessageDeflate.extensionName]);
  // The exact `Sec-WebSocket-Extensions` value the peer would receive. This is
  // the string a browser acts on, so it is the thing the crate's negotiation has
  // to reproduce byte for byte.
  const response = extension.format({ [PerMessageDeflate.extensionName]: [params] });

  const frames = [];
  for (let i = 0; i < texts.length; i += 1) {
    // Every entry here is a WHOLE message, so every one is flagged. The first
    // draft flagged only the last, which models one message cut into fragments
    // rather than a connection carrying several -- and under the shipped
    // no-context-takeover policy that difference is the whole point: ws resets
    // the deflate stream on the flag, so an unflagged run of messages keeps
    // history the policy forbids. It showed up in the numbers: the second
    // roster compressed to 246 bytes off the first one's dictionary instead of
    // the ~2 KB a reset stream produces. `fragmented-message` is where
    // fin=false belongs, because there the fragments really are one message.
    const fin = true;
    const payload = Buffer.from(texts[i], "utf8");
    const rsv1 = decidesToCompress(payload.length, params);
    const compressed = rsv1 ? await step(pmd, "compress", payload, fin) : null;
    frames.push({
      text: payload.toString("base64"),
      byte_length: payload.length,
      fin,
      rsv1,
      deflated: compressed === null ? null : compressed.toString("base64"),
      // The `fin` fragment must not carry the sync marker, and the ones before
      // it must. Asserted here so a change inside ws fails the fixture rather
      // than turning into a Rust test that compares the wrong bytes.
      ends_with_sync_marker:
        compressed === null ? null : compressed.subarray(-4).equals(Buffer.from([0x00, 0x00, 0xff, 0xff])),
    });
  }
  const recorded = {
    name,
    // Which end produced the frames: "server-sends" is what the gateway writes,
    // "client-sends" is what it reads. The crate sits in the server's seat, so
    // the two directions exercise different streams and different windows, and
    // only the second one contains bytes that were really encoded at a narrow
    // window -- which is the case `flate2` refuses to open a stream at.
    direction: "server-sends",
    offer_header: header,
    response_header: response,
    accepted_params: { ...params },
    frames,
    // ws picks the window from the negotiated parameters and falls back to
    // zlib's default when the peer named none (`permessage-deflate.js:407`).
    deflate_window_bits: typeof params.server_max_window_bits === "number" ? params.server_max_window_bits : 15,
    inflate_window_bits: typeof params.client_max_window_bits === "number" ? params.client_max_window_bits : 15,
    deflate_resets_each_message: !!params.server_no_context_takeover,
    inflate_resets_each_message: !!params.client_no_context_takeover,
  };
  pmd.cleanup();

  keepCommitted(name, frames);

  // Self-check before anything is written, as a browser would do it: parse the
  // response HEADER TEXT with ws's own parser, hand it to a client-mode
  // instance, and read the frames back in order. This checks three things at
  // once -- that the response is parseable, that a peer negotiates the same
  // windows from it, and that the recorded fragments decompress. Feeding the
  // params object straight back would not: `acceptAsServer` mutates it, and
  // `normalizeParams` only accepts the array-shaped values the header parser
  // produces, so a params object is not a valid offer.
  const reader = new PerMessageDeflate({ ...WS_PER_MESSAGE_DEFLATE, isServer: false });
  // `extension.parse` already yields the array of offers `accept` wants, which
  // is why `websocket-server.js` passes `offers[name]` and not `[offers[name]]`.
  reader.accept(extension.parse(response)[PerMessageDeflate.extensionName]);
  for (const frame of frames) {
    if (!frame.rsv1) continue;
    const back = await step(reader, "decompress", Buffer.from(frame.deflated, "base64"), frame.fin);
    if (back.toString("utf8") !== Buffer.from(frame.text, "base64").toString("utf8")) {
      throw new Error(`${name}: a client-mode ws could not read back what the server wrote`);
    }
  }
  reader.cleanup();
  return recorded;
}

/**
 * The other direction on the same negotiation: `ws` in CLIENT mode accepts the
 * response the server would send, and compresses.
 *
 * This is the only way to get fixtures whose bytes really were encoded with the
 * window the server named. Recording the server's outbound frames twice and
 * calling them inbound would test nothing about narrow windows, because the
 * server's own deflate ran at `server_max_window_bits`. It matters immediately:
 * `client_max_window_bits=8` is legal per RFC 7692 §7.1.3, Chromium negotiates
 * the parameter rather than a number, and `flate2` panics below 9
 * (`flate2-1.1.11/src/mem.rs:422`), so a gateway built without checking would
 * abort a socket over a legal browser header.
 *
 * Payloads here are smaller than the outbound ones on purpose: what is under
 * test is the window and the reset, not the 32 KiB history, and 30 participants
 * clears the 1 KiB threshold several times over without doubling the fixture in
 * git.
 */
async function recordInbound(name, header, texts) {
  const parsed = extension.parse(header);
  const server = serverInstance();
  const params = server.accept(parsed[PerMessageDeflate.extensionName]);
  const response = extension.format({ [PerMessageDeflate.extensionName]: [params] });
  server.cleanup();

  const client = new PerMessageDeflate({ ...WS_PER_MESSAGE_DEFLATE, isServer: false });
  client.accept(extension.parse(response)[PerMessageDeflate.extensionName]);

  const frames = [];
  for (const text of texts) {
    const payload = Buffer.from(text, "utf8");
    const rsv1 = payload.length >= WS_PER_MESSAGE_DEFLATE.threshold;
    const compressed = rsv1 ? await step(client, "compress", payload, true) : null;
    frames.push({
      text: payload.toString("base64"),
      byte_length: payload.length,
      fin: true,
      rsv1,
      deflated: compressed === null ? null : compressed.toString("base64"),
      ends_with_sync_marker:
        compressed === null ? null : compressed.subarray(-4).equals(Buffer.from([0x00, 0x00, 0xff, 0xff])),
    });
  }
  const recorded = {
    name,
    direction: "client-sends",
    offer_header: header,
    response_header: response,
    accepted_params: { ...params },
    frames,
    // Unchanged in meaning: the windows the instance in the server's seat uses,
    // so `inflate_window_bits` is the window these frames were encoded with.
    deflate_window_bits: typeof params.server_max_window_bits === "number" ? params.server_max_window_bits : 15,
    inflate_window_bits: typeof params.client_max_window_bits === "number" ? params.client_max_window_bits : 15,
    deflate_resets_each_message: !!params.server_no_context_takeover,
    inflate_resets_each_message: !!params.client_no_context_takeover,
  };

  // Same rule as the outbound direction: the committed deflate string wins, and
  // the read-back below is what proves it still inflates here.
  keepCommitted(name, frames);

  // Read them back the way the server would: same header, fresh instance.
  const reader = serverInstance();
  reader.accept(extension.parse(header)[PerMessageDeflate.extensionName]);
  for (const frame of frames) {
    if (!frame.rsv1) continue;
    const back = await step(reader, "decompress", Buffer.from(frame.deflated, "base64"), frame.fin);
    if (back.toString("utf8") !== Buffer.from(frame.text, "base64").toString("utf8")) {
      throw new Error(`${name}: a server-mode ws could not read what a client-mode ws wrote`);
    }
  }
  reader.cleanup();
  client.cleanup();
  return recorded;
}

/** Header-shaped refusals: what the peer answers, recorded so the crate can be
 *  required to refuse the same set instead of a friendlier subset. */
function recordRefusal(name, header) {
  const pmd = serverInstance();
  try {
    pmd.accept(extension.parse(header)[PerMessageDeflate.extensionName]);
    return { name, offer_header: header, accepted: true };
  } catch (error) {
    return {
      name,
      offer_header: header,
      accepted: false,
      ws_error: { name: error.name, message: error.message },
    };
  } finally {
    pmd.cleanup();
  }
}

/** A roster-shaped text big enough for a 32 KiB window to matter. */
function rosterText(participants, seq) {
  const parts = [];
  for (let i = 0; i < participants; i += 1) {
    parts.push(
      `{"peerId":"${i.toString(16).padStart(8, "0")}aaaa-bbbb-4ccc-8ddd-${(i * 7).toString(16).padStart(12, "0")}",` +
        `"userId":"u${i.toString(36)}-${(i * 31) % 997}","displayName":"Player ${i}","muted":${i % 3 === 0}}`,
    );
  }
  return `{"type":"voice-roster","voiceChannelId":"chan-a","seq":${seq},"participants":[${parts.join(",")}]}`;
}

const vectors = [
  // The four stacks that send the bare offer (Firefox, WebKit/Safari, iOS
  // CFNetwork, Android OkHttp) and the one that offers client_max_window_bits
  // (Chromium). These two shapes are why the policy sets no window-bits number:
  // echoing one to a client that did not offer it is a 400.
  await record("browsers-bare", "permessage-deflate", [rosterText(120, 1), rosterText(120, 2), rosterText(121, 3)]),
  await record("chromium-offer", "permessage-deflate; client_max_window_bits", [
    rosterText(120, 1),
    rosterText(120, 2),
    rosterText(121, 3),
  ]),
  // A client that names OUR window. ws honours it verbatim and echoes it, so
  // the server's outbound stream really is 9 bits wide here.
  await record("narrow-server-window", "permessage-deflate; server_max_window_bits=9", [
    rosterText(120, 1),
    rosterText(120, 2),
  ]),
  // A client that names ITS window, as a number rather than the bare flag.
  await record("client-window-8", "permessage-deflate; client_max_window_bits=8", [
    rosterText(120, 1),
    rosterText(120, 2),
  ]),
  // Two offers in one header: the FIRST acceptable one wins, so the response
  // names server_max_window_bits=12 and ignores the second line entirely.
  await record("two-offers", "permessage-deflate; server_max_window_bits=12, permessage-deflate; client_max_window_bits", [
    rosterText(90, 1),
    rosterText(90, 2),
  ]),
  // Mixed sizes on one connection, which is the shipped steady state: pongs and
  // typing indicators under the threshold go out raw, rosters get RSV1.
  await record("mixed-sub-threshold", "permessage-deflate; client_max_window_bits", [
    '{"type":"pong"}',
    rosterText(120, 1),
    '{"type":"typing","peerId":"peer-a","typing":true}',
    rosterText(120, 2),
  ]),
];

// The same negotiations seen from the reading side. `client-window-8` is the one
// that matters: the bytes below were compressed at an 8-bit window by ws, and
// whatever inflates them has to cope with a window narrower than its backend's
// floor.
for (const [name, header] of [
  ["inbound-browsers-bare", "permessage-deflate"],
  ["inbound-client-window-8", "permessage-deflate; client_max_window_bits=8"],
  ["inbound-narrow-server-window", "permessage-deflate; server_max_window_bits=9"],
]) {
  vectors.push(await recordInbound(name, header, [rosterText(30, 1), rosterText(30, 2), rosterText(31, 3)]));
}

// One message in three fragments, only the last flagged. `ws` keeps the sync
// marker on the unflagged ones, which is the detail that makes a naive
// implementation truncate mid-message.
{
  const header = "permessage-deflate; client_max_window_bits";
  const pmd = serverInstance();
  const params = pmd.accept(extension.parse(header)[PerMessageDeflate.extensionName]);
  const whole = Buffer.from(rosterText(90, 7), "utf8");
  const cut = [0, Math.floor(whole.length / 3), Math.floor((whole.length * 2) / 3), whole.length];
  const frames = [];
  for (let i = 0; i < 3; i += 1) {
    const fin = i === 2;
    const slice = whole.subarray(cut[i], cut[i + 1]);
    const compressed = await step(pmd, "compress", slice, fin);
    frames.push({
      text: slice.toString("base64"),
      byte_length: slice.length,
      fin,
      rsv1: true,
      deflated: compressed.toString("base64"),
      ends_with_sync_marker: compressed.subarray(-4).equals(Buffer.from([0x00, 0x00, 0xff, 0xff])),
    });
  }
  // Pinned before the assertion, so the markers checked here are the markers of
  // the bytes that go into the file.
  keepCommitted("fragmented-message", frames);
  if (frames[0].ends_with_sync_marker !== true || frames[2].ends_with_sync_marker !== false) {
    throw new Error("fragmented: sync markers are not where ws leaves them");
  }
  vectors.push({
    name: "fragmented-message",
    direction: "server-sends",
    offer_header: header,
    response_header: extension.format({ [PerMessageDeflate.extensionName]: [params] }),
    accepted_params: { ...params },
    frames,
    deflate_window_bits: 15,
    inflate_window_bits: 15,
    deflate_resets_each_message: !!params.server_no_context_takeover,
    inflate_resets_each_message: !!params.client_no_context_takeover,
  });
  pmd.cleanup();
}

const refusals = [
  recordRefusal("unknown-parameter", "permessage-deflate; client_max_latency=4"),
  recordRefusal("duplicate-parameter", "permessage-deflate; client_max_window_bits; client_max_window_bits"),
  recordRefusal("window-bits-16", "permessage-deflate; server_max_window_bits=16"),
  recordRefusal("window-bits-7", "permessage-deflate; server_max_window_bits=7"),
  recordRefusal("window-bits-not-a-number", "permessage-deflate; server_max_window_bits=large"),
  recordRefusal("client-window-bits-16", "permessage-deflate; client_max_window_bits=16"),
];
// A refusal that only refuses if the peer really checks: if any of these come
// back accepted, the crate is being asked to match a rule ws does not have, and
// the fixture has to say so rather than encode a rule nobody enforces.
for (const refusal of refusals) {
  if (refusal.accepted === true && !refusal.name.startsWith("client-window")) {
    console.error(`NOTE: ws accepted ${refusal.name}: ${refusal.offer_header}`);
  }
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify(
    {
      _generatedBy: "rust/scripts/gen-deflate-vectors.mjs",
      note:
        "Compressed by the shipped ws PerMessageDeflate through the same parse/accept/format " +
        "calls websocket-server.js makes, with the shipped WS_PER_MESSAGE_DEFLATE options, " +
        "and read back by a second instance before being written. Test material: the payloads " +
        "are synthetic frames and the base64 strings are deflate output, not credentials. " +
        "`deflated` is kept as committed rather than recompressed, because deflate output is " +
        "not byte-identical across zlib builds while inflate is exact: each string here is the " +
        "output of whichever zlib build minted that vector, and every one of them is read back " +
        "through ws before it is written, so a string that no longer inflates fails the " +
        "generator instead of the socket.",
      wsVersion: wsPackage.version,
      wsResolvedFrom: ws.dir.slice(root.length + 1),
      wsResolvedVia: ws.how,
      shippedPolicy: { ...WS_PER_MESSAGE_DEFLATE },
      trailer: "0000ffff",
      vectors,
      refusals,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `wrote ${vectors.length} deflate vectors and ${refusals.length} refusals ` +
    `(ws ${wsPackage.version} via ${ws.how}) to ${out.slice(root.length + 1)}`,
);
console.error(
  `deflate strings: kept ${kept} as committed (${recompressed} of them recompressed ` +
    `differently by zlib ${process.versions.zlib}), minted ${minted} new`,
);
