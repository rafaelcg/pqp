#!/usr/bin/env node
/**
 * Generate wire-parity vectors for the voice protocol.
 *
 * For every arm of `voiceClientMessageSchema` and `voiceSignalingMessageSchema`
 * this takes an example frame, runs it through the real zod schema, and records
 * zod's output in a canonicalized form: defaults applied, nullable-absent
 * fields written as `null`, non-nullable-absent fields dropped. That canonical
 * form is exactly the field-by-field mapping the Rust port promises (see the
 * table in `crates/pqp-core/src/proto.rs`), so comparing Rust's serialization
 * against it tests the port against zod and not against this file's opinions.
 *
 * Coverage comes from the schema, not from a list someone maintains. The
 * generator refuses to run unless there is an example for every arm of both
 * unions, which is how the #406 class of bug — a message type the router never
 * dispatches — fails loudly instead of silently.
 *
 * Run: node --experimental-strip-types --no-warnings \
 *        --import ./rust/scripts/ts-register.mjs rust/scripts/gen-proto-vectors.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../fixtures/proto-vectors.json");
const sig = await import(resolve(here, "../../packages/shared/src/signaling.ts"));

const U = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const CH = "33333333-3333-4333-8333-333333333333";
const PEER = "peer-a";
// Conversation ids are uuids on the wire in both directions, and zod refuses
// anything else. Worth pinning: a client that rings with a non-uuid id gets a
// frame that never parses, which reads as a call that silently does not ring.
const CONV = "44444444-4444-4444-8444-444444444444";
const NOW = 1_700_000_000_000;

const participant = (peerId = PEER, over = {}) => ({
  peerId,
  userId: U,
  displayName: "Rafa",
  avatarUrl: null,
  ...over,
});
const track = (id = "t1", over = {}) => ({
  id,
  provider: "youtube",
  videoId: "dQw4w9WgXcQ",
  title: "A song",
  sourceUrl: "https://youtube.com/watch?v=dQw4w9WgXcQ",
  thumbnailUrl: null,
  durationMs: 211000,
  addedByUserId: U,
  addedByName: "Rafa",
  ...over,
});

/** One example per arm. Missing arm => the generator refuses to write. */
const clientExamples = {
  "join-voice-room": { type: "join-voice-room", voiceChannelId: CH },
  "leave-voice-room": { type: "leave-voice-room" },
  "set-sharing-screen": { type: "set-sharing-screen", sharing: true, audioStreamId: "cap-1", uplinkBps: 2_500_000, sourceHeight: 1080, audioNeedsSfu: true },
  offer: { type: "offer", from: PEER, to: "peer-b", sdp: "v=0\r\n" },
  answer: { type: "answer", from: "peer-b", to: PEER, sdp: "v=0\r\n" },
  "ice-candidate": { type: "ice-candidate", from: PEER, to: "peer-b", candidate: { candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: null } },
  "call-ring": { type: "call-ring", conversationId: CONV },
  "call-decline": { type: "call-decline", conversationId: CONV },
  "set-camera": { type: "set-camera", streamId: null },
  "set-voice-state": { type: "set-voice-state", muted: true, deafened: false },
  "set-raised-hand": { type: "set-raised-hand", raised: true },
  "voice-still-here": { type: "voice-still-here" },
  "set-watch-party": { type: "set-watch-party", state: { videoId: "dQw4w9WgXcQ", status: "playing", positionMs: 4200, atMs: NOW, rev: 7, actorId: U } },
  "set-voice-track-mode": { type: "set-voice-track-mode", separated: true },
  "set-music": { type: "set-music", state: { current: track(), queue: [track("t2")], status: "playing", positionMs: 1000, atMs: NOW, rev: 3, actorId: U, repeat: "all", skipVotes: [U2], autoplay: true } },
  "set-music-listening": { type: "set-music-listening", listening: true },
  "live-reaction": { type: "live-reaction", channelId: CH, emoji: "🔥" },
  "soundboard-play": { type: "soundboard-play", channelId: CH, soundId: U },
  "watch-live": { type: "watch-live", channelId: CH, watching: true },
};

const serverExamples = {
  welcome: { type: "welcome", peerId: PEER, peers: [participant(), participant("peer-b", { userId: U2, muted: true })], voiceChannelId: CH, self: participant(PEER, { canSpeak: true, canStream: false }), transport: "livekit", resumed: true, resumeToken: "tok", canSpeak: true, speakReason: "permission", audience: { since: NOW, byUserId: U, speakerUserIds: [U2], unenforcedUserIds: [] } },
  "peer-joined": { type: "peer-joined", peer: participant() },
  "peer-updated": { type: "peer-updated", peer: participant(PEER, { muted: true, handRaisedAt: NOW }) },
  "peer-left": { type: "peer-left", peerId: PEER },
  "voice-roster": { type: "voice-roster", voiceChannelId: CH, participants: [participant()], transport: "mesh", seq: 12 },
  "voice-roster-delta": { type: "voice-roster-delta", voiceChannelId: CH, seq: 13, size: 2, transport: "mesh", joined: [participant("peer-b", { userId: U2 })], left: ["peer-c"] },
  "voice-room-full": { type: "voice-room-full", voiceChannelId: CH, limit: 500 },
  "voice-transport-unsupported": { type: "voice-transport-unsupported", voiceChannelId: CH, transport: "livekit", reason: "promoted" },
  "voice-transport-changed": { type: "voice-transport-changed", voiceChannelId: CH, transport: "livekit", reason: "room-size", participants: [participant()] },
  "voice-join-refused": { type: "voice-join-refused", voiceChannelId: CH, reason: "mesh-multi-instance" },
  "screen-share-denied": { type: "screen-share-denied", voiceChannelId: CH },
  "camera-denied": { type: "camera-denied", voiceChannelId: CH },
  offer: { type: "offer", from: PEER, to: "peer-b", sdp: "v=0\r\n" },
  answer: { type: "answer", from: "peer-b", to: PEER, sdp: "v=0\r\n" },
  "ice-candidate": { type: "ice-candidate", from: PEER, to: "peer-b", candidate: null },
  "call-incoming": { type: "call-incoming", conversationId: CONV, kind: "dm", caller: { userId: U, displayName: "Rafa", avatarUrl: null } },
  "call-ring-cancelled": { type: "call-ring-cancelled", conversationId: CONV, reason: "timeout" },
  "call-declined": { type: "call-declined", conversationId: CONV, userId: U },
  "voice-moderation": { type: "voice-moderation", action: "moved", voiceChannelId: CH, movedToChannelId: CH, message: "Você foi movido", reason: "idle", aloneMinutes: 15 },
  "voice-speak-changed": { type: "voice-speak-changed", voiceChannelId: CH, canSpeak: false, speakReason: "audience" },
  "voice-idle-warning": { type: "voice-idle-warning", voiceChannelId: CH, disconnectAt: NOW + 60_000 },
  "voice-idle-warning-cancelled": { type: "voice-idle-warning-cancelled", voiceChannelId: CH },
  // Ported in a later phase. The Rust port must refuse these frames outright
  // rather than accept and mis-read them; the test asserts that refusal.
  "voice-audience": { type: "voice-audience", voiceChannelId: CH, audience: null },
  "watch-party": { type: "watch-party", channelId: CH, state: null },
  music: { type: "music", channelId: CH, state: null },
  "channel-music": { type: "channel-music", channelId: CH, track: null },
  "live-reactions": { type: "live-reactions", channelId: CH, items: [{ emoji: "🔥", count: 3 }], seq: 4 },
  "soundboard-play": { type: "soundboard-play", channelId: CH, soundId: U, userId: U, displayName: "Rafa", emoji: "🔊", playedAt: NOW },
  "voice-stream": { type: "voice-stream", channelId: CH, stream: null },
  "channel-live": { type: "channel-live", channelId: CH, stream: null, watching: 2, viewers: 2 },
};

/** Fields the Rust port is allowed to be behind on. Keep this list short and
 *  never let it grow quietly: every entry is a message the port refuses. */
const serverPending = [
  "voice-audience", "watch-party", "music", "channel-music",
  "live-reactions", "soundboard-play", "voice-stream", "channel-live",
];

function unwrap(schema) {
  let optional = false, nullable = false, cur = schema;
  for (;;) {
    const t = cur._def?.typeName;
    if (t === "ZodOptional") { optional = true; cur = cur._def.innerType; continue; }
    if (t === "ZodDefault") { optional = true; cur = cur._def.innerType; continue; }
    if (t === "ZodNullable") { nullable = true; cur = cur._def.innerType; continue; }
    if (t === "ZodEffects" || t === "ZodPipeline") { cur = cur._def.schema; continue; }
    break;
  }
  return { inner: cur, optional, nullable };
}

/** Apply the port's field mapping to zod's own output. */
function canon(schema, value) {
  const { inner, nullable } = unwrap(schema);
  if (value === undefined) return nullable ? null : undefined;
  // A present null stays null. Without this the walker would descend into the
  // object's shape and turn `candidate: null` into an all-null candidate
  // object, which is a different message.
  if (value === null) {
    if (!nullable) throw new Error("null where the schema does not allow one");
    return null;
  }
  const t = inner._def?.typeName;
  if (t === "ZodObject") {
    const out = {};
    for (const [key, field] of Object.entries(inner.shape)) {
      const c = canon(field, value?.[key]);
      if (c !== undefined) out[key] = c;
    }
    return out;
  }
  if (t === "ZodArray") return value.map((v) => canon(inner._def.type, v));
  if (typeof value === "number") {
    // The port reads these as i64. If the schema ever carries a fraction, the
    // shortcut stops being true and the port must change before the fixture
    // does, so fail here rather than compare two different numbers.
    if (!Number.isInteger(value)) {
      throw new Error(`non-integer number in fixture: ${value}`);
    }
    return value;
  }
  return value;
}

function build(unionSchema, examples, label) {
  const arms = unionSchema.options.map((o) => o.shape.type.value);
  const missing = arms.filter((a) => !(a in examples));
  if (missing.length) {
    throw new Error(`${label}: no example for ${missing.join(", ")} — add one, do not skip it`);
  }
  const stale = Object.keys(examples).filter((a) => !arms.includes(a));
  if (stale.length) throw new Error(`${label}: example for removed type ${stale.join(", ")}`);
  const byType = new Map(unionSchema.options.map((o) => [o.shape.type.value, o]));
  const out = [];
  const failures = [];
  for (const type of arms) {
    const input = examples[type];
    let parsed;
    try {
      parsed = byType.get(type).parse(input);
    } catch (err) {
      const first = err?.errors?.[0];
      failures.push(`${type}: ${first?.path?.join(".") ?? "?"} ${first?.code ?? err?.name}`);
      continue;
    }
    out.push({ type, input, canonical: canon(byType.get(type), parsed) });
  }
  if (failures.length) {
    console.error("INVALID EXAMPLES:\n  " + failures.join("\n  "));
    throw new Error(`${failures.length} example(s) rejected by zod`);
  }
  return out;
}

const client = build(sig.voiceClientMessageSchema, clientExamples, "client");
const serverAll = build(sig.voiceSignalingMessageSchema, serverExamples, "server");
const serverTypes = serverAll.map((v) => v.type);
const unknownPending = serverPending.filter((t) => !serverTypes.includes(t));
if (unknownPending.length) throw new Error(`pending lists types the schema does not have: ${unknownPending}`);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({
  _generatedBy: "rust/scripts/gen-proto-vectors.mjs",
  note: "Canonical forms are zod's own parse output, mapped by the field rules in crates/pqp-core/src/proto.rs. Do not edit by hand.",
  client: { types: client.map((v) => v.type), vectors: client },
  server: { types: serverTypes, pending: serverPending, vectors: serverAll },
}, null, 2) + "\n");
console.log(`wrote ${client.length} client + ${serverAll.length} server vectors (${serverPending.length} pending) to ${out}`);
