#!/usr/bin/env node
/**
 * Generate wire-parity vectors for the voice protocol.
 *
 * For every arm of `voiceClientMessageSchema` and `voiceSignalingMessageSchema`
 * this takes one or more example frames, runs them through the real zod
 * schema, and records
 * zod's output in a canonicalized form: defaults applied, nullable-absent
 * fields written as `null`, non-nullable-absent fields dropped. That canonical
 * form is exactly the field-by-field mapping the Rust port promises (see the
 * table in `crates/pqp-core/src/proto.rs`), so comparing Rust's serialization
 * against it tests the port against zod and not against this file's opinions.
 *
 * An arm whose frame can hold a nullable object is required to have both a
 * filled and a null example. `build()` derives that list from the schema, so
 * the rule applies to a field nobody has looked at yet.
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
const audience = (over = {}) => ({
  since: NOW,
  byUserId: U,
  speakerUserIds: [U2],
  ...over,
});
const watchState = (over = {}) => ({
  videoId: "dQw4w9WgXcQ",
  status: "playing",
  positionMs: 4200,
  atMs: NOW,
  rev: 7,
  actorId: U,
  ...over,
});
const musicState = (over = {}) => ({
  current: track(),
  queue: [track("t2")],
  status: "playing",
  positionMs: 1000,
  atMs: NOW,
  rev: 3,
  actorId: U,
  ...over,
});
const hlsStream = (over = {}) => ({
  hlsUrl: "/api/voice/hls-playlist/a.m3u8",
  startedAt: NOW,
  presenterPeerId: PEER,
  ...over,
});
const candidate = {
  candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host",
  sdpMid: "0",
  sdpMLineIndex: 0,
  usernameFragment: null,
};

/** At least one example per arm. Missing arm => the generator refuses to
 *  write. An arm may carry several: an arm whose frame holds a nullable
 *  object has to be seen both ways, which `build()` enforces rather than
 *  leaving to whoever remembered. */
const clientExamples = {
  // A resume carries the peer id and token from before the drop, and a client
  // that knows two transports names both. Neither field appears on a plain
  // join, so the resuming frame is a second vector: without it nothing in the
  // repo proves the port even reads them.
  "join-voice-room": [
    { type: "join-voice-room", voiceChannelId: CH },
    { type: "join-voice-room", voiceChannelId: CH, transports: ["mesh", "livekit"], resumePeerId: U, resumeToken: "tok" },
  ],
  "leave-voice-room": [
    { type: "leave-voice-room" },
    { type: "leave-voice-room", resumePeerId: U, resumeToken: "tok" },
  ],
  "set-sharing-screen": { type: "set-sharing-screen", sharing: true, audioStreamId: "cap-1", uplinkBps: 2_500_000, sourceHeight: 1080, audioNeedsSfu: true },
  offer: { type: "offer", from: PEER, to: "peer-b", sdp: "v=0\r\n" },
  answer: { type: "answer", from: "peer-b", to: PEER, sdp: "v=0\r\n" },
  "ice-candidate": [
    { type: "ice-candidate", from: PEER, to: "peer-b", candidate },
    { type: "ice-candidate", from: PEER, to: "peer-b", candidate: null },
  ],
  "call-ring": { type: "call-ring", conversationId: CONV },
  "call-decline": { type: "call-decline", conversationId: CONV },
  "set-camera": { type: "set-camera", streamId: null },
  "set-voice-state": { type: "set-voice-state", muted: true, deafened: false },
  "set-raised-hand": { type: "set-raised-hand", raised: true },
  "voice-still-here": { type: "voice-still-here" },
  // Null here is a person ending the party, not a missing field, so the write
  // arm needs both forms too.
  "set-watch-party": [
    { type: "set-watch-party", state: watchState() },
    { type: "set-watch-party", state: null },
  ],
  "set-voice-track-mode": { type: "set-voice-track-mode", separated: true },
  // The write form and the read form differ on purpose: the third frame omits
  // `openControls`, `repeat`, `skipVotes` and `history`, and zod must leave
  // them OUT (absent means "unchanged"; filling them would wipe the room's
  // votes on the next position sample). Only a port that reads that difference
  // gets this canonical form right.
  "set-music": [
    { type: "set-music", state: { ...musicState(), repeat: "all", skipVotes: [U2], autoplay: true, history: [track("t3")] } },
    { type: "set-music", state: { current: null, queue: [], status: "paused", positionMs: 0, atMs: NOW, rev: 9, actorId: U } },
    { type: "set-music", state: null },
  ],
  "set-music-listening": { type: "set-music-listening", listening: true },
  "live-reaction": { type: "live-reaction", channelId: CH, emoji: "🔥" },
  "soundboard-play": { type: "soundboard-play", channelId: CH, soundId: U },
  "watch-live": { type: "watch-live", channelId: CH, watching: true },
};

/// The join frame as a room with audience mode on sends it. `audience: null`
/// is the same arm, so it is a second vector rather than a second arm.
const welcomeFull = { type: "welcome", peerId: PEER, peers: [participant(), participant("peer-b", { userId: U2, muted: true, handRaisedAt: NOW })], voiceChannelId: CH, self: participant(PEER, { canSpeak: true, canStream: false, handRaisedAt: NOW }), transport: "livekit", resumed: true, resumeToken: "tok", canSpeak: true, speakReason: "permission", audience: audience({ unenforcedUserIds: [] }) };

const serverExamples = {
  welcome: [welcomeFull, { ...welcomeFull, audience: null }],
  "peer-joined": [
    { type: "peer-joined", peer: participant() },
    { type: "peer-joined", peer: participant("peer-b", { userId: U2, handRaisedAt: NOW }) },
  ],
  "peer-updated": { type: "peer-updated", peer: participant(PEER, { muted: true, handRaisedAt: NOW }) },
  "peer-left": { type: "peer-left", peerId: PEER },
  "voice-roster": { type: "voice-roster", voiceChannelId: CH, participants: [participant(), participant("peer-b", { userId: U2, handRaisedAt: NOW })], transport: "mesh", seq: 12 },
  "voice-roster-delta": { type: "voice-roster-delta", voiceChannelId: CH, seq: 13, size: 2, transport: "mesh", joined: [participant("peer-b", { userId: U2, handRaisedAt: NOW })], updated: [participant(PEER, { handRaisedAt: NOW })], left: ["peer-c"] },
  "voice-room-full": { type: "voice-room-full", voiceChannelId: CH, limit: 500 },
  "voice-transport-unsupported": { type: "voice-transport-unsupported", voiceChannelId: CH, transport: "livekit", reason: "promoted" },
  "voice-transport-changed": { type: "voice-transport-changed", voiceChannelId: CH, transport: "livekit", reason: "room-size", participants: [participant(), participant("peer-b", { userId: U2, handRaisedAt: NOW })] },
  "voice-join-refused": { type: "voice-join-refused", voiceChannelId: CH, reason: "mesh-multi-instance" },
  "screen-share-denied": { type: "screen-share-denied", voiceChannelId: CH },
  "camera-denied": { type: "camera-denied", voiceChannelId: CH },
  offer: { type: "offer", from: PEER, to: "peer-b", sdp: "v=0\r\n" },
  answer: { type: "answer", from: "peer-b", to: PEER, sdp: "v=0\r\n" },
  "ice-candidate": [
    { type: "ice-candidate", from: PEER, to: "peer-b", candidate: null },
    { type: "ice-candidate", from: PEER, to: "peer-b", candidate },
  ],
  "call-incoming": { type: "call-incoming", conversationId: CONV, kind: "dm", caller: { userId: U, displayName: "Rafa", avatarUrl: null } },
  "call-ring-cancelled": { type: "call-ring-cancelled", conversationId: CONV, reason: "timeout" },
  "call-declined": { type: "call-declined", conversationId: CONV, userId: U },
  "voice-moderation": { type: "voice-moderation", action: "moved", voiceChannelId: CH, movedToChannelId: CH, message: "Você foi movido", reason: "idle", aloneMinutes: 15 },
  "voice-speak-changed": { type: "voice-speak-changed", voiceChannelId: CH, canSpeak: false, speakReason: "audience" },
  "voice-idle-warning": { type: "voice-idle-warning", voiceChannelId: CH, disconnectAt: NOW + 60_000 },
  "voice-idle-warning-cancelled": { type: "voice-idle-warning-cancelled", voiceChannelId: CH },
  // Audience mode: off, on, and the two notices that explain a change. The
  // `off` notice carries `byUserId: null` (the server acted alone), which is
  // the nullable-and-optional case, beside `speaker-added`'s present fields.
  "voice-audience": [
    { type: "voice-audience", voiceChannelId: CH, audience: null },
    { type: "voice-audience", voiceChannelId: CH, audience: audience({ unenforcedUserIds: [U] }) },
    { type: "voice-audience", voiceChannelId: CH, audience: audience(), change: { kind: "speaker-added", byUserId: U, userId: U2 } },
    { type: "voice-audience", voiceChannelId: CH, audience: null, change: { kind: "off", byUserId: null, reason: "no-host" } },
  ],
  "watch-party": [
    { type: "watch-party", channelId: CH, state: null },
    { type: "watch-party", channelId: CH, state: watchState({ status: "paused" }) },
    { type: "watch-party", channelId: CH, state: { ...watchState(), videoId: null, status: "ended" } },
  ],
  // The first state omits every defaulted field, which is what proves the port
  // fills them; the second sends all of them, which is what proves it keeps
  // them. A port that only saw one of the two would pass either way.
  music: [
    { type: "music", channelId: CH, state: null },
    { type: "music", channelId: CH, state: musicState() },
    { type: "music", channelId: CH, state: musicState({ current: null, queue: [], status: "paused", positionMs: 0, openControls: true, repeat: "all", skipVotes: [U2], history: [track()], autoplay: true }), forced: true },
  ],
  "channel-music": [
    { type: "channel-music", channelId: CH, track: null },
    { type: "channel-music", channelId: CH, track: { videoId: "dQw4w9WgXcQ", title: "A song", thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", listeners: 3 } },
    { type: "channel-music", channelId: CH, track: { videoId: "dQw4w9WgXcQ", title: "A song", thumbnailUrl: null } },
  ],
  "live-reactions": [
    { type: "live-reactions", channelId: CH, items: [{ emoji: "🔥", count: 3 }], seq: 4 },
    { type: "live-reactions", channelId: CH, items: [{ emoji: "👍", count: 1 }, { emoji: "❤️", count: 12 }, { emoji: "😂", count: 7 }, { emoji: "😮", count: 2 }, { emoji: "🎉", count: 9 }], seq: 5 },
  ],
  "soundboard-play": [
    { type: "soundboard-play", channelId: CH, soundId: U, userId: U, displayName: "Rafa", emoji: "🔊", playedAt: NOW },
  ],
  "voice-stream": [
    { type: "voice-stream", channelId: CH, stream: null },
    { type: "voice-stream", channelId: CH, stream: hlsStream() },
    { type: "voice-stream", channelId: CH, stream: hlsStream({ presenterUserId: U, delaySeconds: 3, topHeight: 1080, topFramerate: 60, hasAudio: true, cameraHlsUrl: "/api/voice/hls-playlist/cam.m3u8", cameraHasVideo: true, cameraHasVoiceAudio: false, mode: "ll", partTargetMs: 200 }) },
  ],
  "channel-live": [
    { type: "channel-live", channelId: CH, stream: null, watching: 0, ended: true },
    { type: "channel-live", channelId: CH, stream: null, watching: 2, viewers: 2 },
    { type: "channel-live", channelId: CH, stream: hlsStream({ presenterUserId: U, delaySeconds: 3, topHeight: 1080, topFramerate: 60, hasAudio: true, cameraHlsUrl: "/api/voice/hls-playlist/cam.m3u8", cameraHasVideo: true, cameraHasVoiceAudio: false, mode: "ll", partTargetMs: 200 }), watching: 4, viewers: 11 },
  ],
};

/** Fields the Rust port is allowed to be behind on. Keep this list short and
 *  never let it grow quietly: every entry is a message the port refuses. The
 *  server union is ported in full as of phase 1; an arm added to the schema
 *  afterwards has to appear here (refused) or get a Rust variant, and the
 *  generator's coverage check is what forces that decision. */
const serverPending = [];

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

/** Top-level fields of an arm that are a nullable object, i.e. a nested frame
 *  that the sender may leave out by sending null. */
function nullableObjectFields(armSchema) {
  const out = [];
  for (const [key, field] of Object.entries(armSchema.shape)) {
    if (key === "type") continue;
    const { inner, nullable } = unwrap(field);
    if (nullable && inner._def?.typeName === "ZodObject") out.push(key);
  }
  return out;
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
    const schema = byType.get(type);
    const frames = Array.isArray(examples[type]) ? examples[type] : [examples[type]];
    if (!frames.length) throw new Error(`${label}: ${type} has an empty example list`);
    frames.forEach((input, i) => {
      let parsed;
      try {
        parsed = schema.parse(input);
      } catch (err) {
        const first = err?.errors?.[0];
        failures.push(`${type}#${i + 1}: ${first?.path?.join(".") ?? "?"} ${first?.code ?? err?.name}`);
        return;
      }
      out.push({
        type,
        label: frames.length > 1 ? `${type}#${i + 1}` : type,
        input,
        canonical: canon(schema, parsed),
      });
    });
  }
  if (failures.length) {
    console.error("INVALID EXAMPLES:\n  " + failures.join("\n  "));
    throw new Error(`${failures.length} example(s) rejected by zod`);
  }
  // An arm that can hold a nested object has to be seen both with it and
  // without it. With only one of the two, either mapping looks correct: a port
  // that expanded `null` into an all-null object, or one that dropped a
  // present object, passes a single-example fixture. The list of fields that
  // need both comes from the schema, so a newly nullable field demands its
  // second example on its own instead of waiting for someone to notice.
  const thin = [];
  for (const arm of unionSchema.options) {
    const type = arm.shape.type.value;
    for (const key of nullableObjectFields(arm)) {
      const mine = out.filter((v) => v.type === type);
      const sawNull = mine.some((v) => v.canonical?.[key] === null);
      const sawValue = mine.some((v) => v.canonical?.[key] != null);
      if (!sawNull || !sawValue) {
        thin.push(`${type}.${key} (saw ${sawNull ? "null" : "no null"}, ${sawValue ? "a value" : "no value"})`);
      }
    }
  }
  if (thin.length) {
    throw new Error(
      `${label}: an example is thin, needs both null and filled for ${thin.join(", ")}`,
    );
  }
  return out;
}

const client = build(sig.voiceClientMessageSchema, clientExamples, "client");
const serverAll = build(sig.voiceSignalingMessageSchema, serverExamples, "server");
// `types` is the list of arms the schema actually has, not the list of vectors
// written: an arm may carry several vectors, and the Rust test uses this to
// assert that the port speaks every arm and nothing else.
const armTypes = (union) => union.options.map((o) => o.shape.type.value);
const serverTypes = armTypes(sig.voiceSignalingMessageSchema);
const unknownPending = serverPending.filter((t) => !serverTypes.includes(t));
if (unknownPending.length) throw new Error(`pending lists types the schema does not have: ${unknownPending}`);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({
  _generatedBy: "rust/scripts/gen-proto-vectors.mjs",
  note: "Canonical forms are zod's own parse output, mapped by the field rules in crates/pqp-core/src/proto.rs. Do not edit by hand.",
  client: { types: armTypes(sig.voiceClientMessageSchema), vectors: client },
  server: { types: serverTypes, pending: serverPending, vectors: serverAll },
}, null, 2) + "\n");
console.log(
  `wrote ${client.length} client + ${serverAll.length} server vectors ` +
  `(${client.length + serverAll.length} frames over ` +
  `${armTypes(sig.voiceClientMessageSchema).length + serverTypes.length} arms, ` +
  `${serverPending.length} pending) to ${out}`,
);
