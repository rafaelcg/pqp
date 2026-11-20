#!/usr/bin/env node
/**
 * Generate the **structure** half of the wire-contract fixtures: one or more
 * example frames for every arm of the voice socket's two unions, each run
 * through the real zod schema and recorded with zod's own output in a canonical
 * form.
 *
 *   pnpm --filter @pqp/shared fixtures:wire          write both fixtures
 *   pnpm --filter @pqp/shared fixtures:wire:check    compare, write nothing
 *
 * The value rules (`.guid()`, `.max(64)`, enum membership, ...) are the other
 * half, `gen-constraints.mjs`. Together they are what every client (web today;
 * Android, iOS and any Rust core next, see docs/plans/RUST.md phase A) replays
 * to prove it reads a frame the way the shipped schema does. The schema stays
 * the only source of truth; nothing here is a second opinion about it.
 *
 * THE CANONICAL FORM. Defaults applied, an absent nullable field written as
 * `null`, an absent field that is not nullable dropped. That is the
 * field-by-field mapping a typed client promises, so comparing a client's
 * decode of `input` against `canonical` tests the client against zod and not
 * against this file's opinions.
 *
 * LESSONS THAT EARNED A RULE HERE (all from #1561, the Rust core spike):
 *
 * - **Optional is not nullable.** `canSpeak` is `.boolean().optional()`: absent
 *   stays absent, and a decoder that wrote `false` for it told every old
 *   client "you may not speak". `cameraStreamId` is `.nullable().optional()`:
 *   absent and `null` both mean "no camera", and the canonical form says
 *   `null`. A port that treats the two alike is wrong for one of them, so an
 *   example of each sits in the same frame.
 * - **Read state is not write state.** `MusicState` (what the server sends) has
 *   `repeat`, `skipVotes`, `history`, ... defaulted; `MusicStateWrite` (what a
 *   client sends) has them `.optional()`, because ABSENT means "leave the
 *   room's value alone". Filling them from a default on the way in would wipe
 *   the room's skip votes on the next position sample. `set-music` therefore
 *   carries a write frame that omits them, and `music` a read frame that omits
 *   them, and the two canonical forms differ.
 * - **An arm that holds a nullable object is seen both ways.** With only one of
 *   a filled and a `null` example, either mapping looks right: a port that
 *   expanded `null` into an all-null object, or one that dropped a present
 *   object, passes. `build()` derives the list of such fields from the schema,
 *   so a newly nullable field demands its second example by itself.
 * - **Every arm has a vector.** The generator refuses to write unless there is
 *   an example for every arm of both unions, which is how the #406 class of bug
 *   (a message type the router never dispatches) fails loudly.
 *
 * Reading the schema is `zod4-walk.mjs`'s job, and it throws on any node type it
 * has no rule for: a zod 3 walk here once matched nothing and wrote an empty
 * fixture without failing.
 */
import {
  UnrecognisedZodNode,
  arrayElement,
  discriminatedArms,
  nodeType,
  objectEntries,
  unwrap,
} from "./zod4-walk.mjs";
import { PROTO_VECTORS_URL, isMain, runCli } from "./wire-fixture-io.mjs";

const U = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const CH = "33333333-3333-4333-8333-333333333333";
const PEER = "peer-a";
// Conversation ids are guids on the wire in both directions, and zod refuses
// anything else. Worth pinning: a client that rings with a non-guid id gets a
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
  // Filled by default so every rule on `thumbnailUrl` is reachable and can be
  // proved; the queue's second track below carries the null.
  thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
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
  queue: [track("t2", { thumbnailUrl: null }), track("t4")],
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

/** At least one example per arm. A missing arm makes the generator refuse to
 *  write. An arm may carry several: an arm whose frame holds a nullable object
 *  has to be seen both ways, which `buildVectors()` enforces rather than
 *  leaving to whoever remembered. */
export const clientExamples = {
  // A resume carries the peer id and token from before the drop, and a client
  // that knows two transports names both. Neither field appears on a plain
  // join, so the resuming frame is a second vector: without it nothing in the
  // repo proves a client even reads them.
  "join-voice-room": [
    { type: "join-voice-room", voiceChannelId: CH },
    { type: "join-voice-room", voiceChannelId: CH, transports: ["mesh", "livekit"], resumePeerId: U, resumeToken: "tok", resume: true },
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
  // The write form and the read form differ on purpose (see the lessons above):
  // the third frame omits `openControls`, `repeat`, `skipVotes` and `history`,
  // and zod must leave them OUT. Only a client that reads that difference gets
  // this canonical form right.
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

export const serverExamples = {
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
  // The first state omits every defaulted field, which is what proves a client
  // fills them; the second sends all of them, which is what proves it keeps
  // them. A client that only saw one of the two would pass either way.
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

/** Apply the canonical field mapping to zod's own output. */
export function canon(schema, value, where = "") {
  const { inner, nullable } = unwrap(schema, where);
  if (value === undefined) return nullable ? null : undefined;
  // A present null stays null. Without this the walker would descend into the
  // object's shape and turn `candidate: null` into an all-null candidate
  // object, which is a different message.
  if (value === null) {
    if (!nullable) throw new Error(`null at ${where || "(root)"} where the schema does not allow one`);
    return null;
  }
  const type = nodeType(inner, where);
  if (type === "object") {
    const out = {};
    for (const [key, field] of objectEntries(inner, where)) {
      const c = canon(field, value?.[key], where ? `${where}.${key}` : key);
      if (c !== undefined) out[key] = c;
    }
    return out;
  }
  if (type === "array") return value.map((v, i) => canon(arrayElement(inner, where), v, `${where}[${i}]`));
  if (type === "union") {
    // Which arm a nested value matched is not recoverable from zod's output.
    // None exists on the wire today; when one does, model it deliberately.
    throw new UnrecognisedZodNode(`a union nested at ${where || "(root)"} has no canonical mapping yet`);
  }
  if (typeof value === "number" && !Number.isInteger(value)) {
    // Clients read these as 64-bit integers. If the schema ever carries a
    // fraction, that shortcut stops being true and the clients must change
    // before the fixture does, so fail here rather than compare two numbers.
    throw new Error(`non-integer number in fixture at ${where || "(root)"}: ${value}`);
  }
  return value;
}

/** Top-level fields of an arm that are a nullable object, i.e. a nested frame
 *  the sender may leave out by sending null. */
export function nullableObjectFields(armSchema, discriminator = "type") {
  const out = [];
  for (const [key, field] of objectEntries(armSchema, "")) {
    if (key === discriminator) continue;
    const { inner, nullable } = unwrap(field, key);
    if (nullable && nodeType(inner, key) === "object") out.push(key);
  }
  return out;
}

/**
 * The vectors of one union. Throws, never skips: a missing arm, an example for
 * an arm that no longer exists, an example zod refuses, an empty list, or an arm
 * with a nullable object seen only one way.
 */
export function buildVectors(unionSchema, examples, label) {
  const arms = discriminatedArms(unionSchema, label);
  const names = arms.map((arm) => arm.type);
  const missing = names.filter((name) => !(name in examples));
  if (missing.length) {
    throw new Error(`${label}: no example for ${missing.join(", ")}. Add one, do not skip it`);
  }
  const stale = Object.keys(examples).filter((name) => !names.includes(name));
  if (stale.length) throw new Error(`${label}: example for removed type ${stale.join(", ")}`);
  const out = [];
  const failures = [];
  for (const { type, schema } of arms) {
    const frames = Array.isArray(examples[type]) ? examples[type] : [examples[type]];
    if (!frames.length) throw new Error(`${label}: ${type} has an empty example list`);
    frames.forEach((input, i) => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        failures.push(`${type}#${i + 1}: ${first?.path?.join(".") || "(root)"} ${first?.code} ${first?.message}`);
        return;
      }
      out.push({
        type,
        label: frames.length > 1 ? `${type}#${i + 1}` : type,
        input,
        canonical: canon(schema, parsed.data),
      });
    });
  }
  if (failures.length) {
    throw new Error(`${label}: ${failures.length} example(s) rejected by zod:\n  ${failures.join("\n  ")}`);
  }
  const thin = [];
  for (const { type, schema } of arms) {
    for (const key of nullableObjectFields(schema)) {
      const mine = out.filter((vector) => vector.type === type);
      const sawNull = mine.some((vector) => vector.canonical?.[key] === null);
      const sawValue = mine.some((vector) => vector.canonical?.[key] != null);
      if (!sawNull || !sawValue) {
        thin.push(`${type}.${key} (saw ${sawNull ? "null" : "no null"}, ${sawValue ? "a value" : "no value"})`);
      }
    }
  }
  if (thin.length) {
    throw new Error(`${label}: an example is thin, needs both null and filled for ${thin.join(", ")}`);
  }
  return out;
}

/** The whole fixture, built in memory. `sig` is `packages/shared/src/signaling`. */
export function generateProtoVectors(sig, examples = { client: clientExamples, server: serverExamples }) {
  const client = buildVectors(sig.voiceClientMessageSchema, examples.client, "client");
  const server = buildVectors(sig.voiceSignalingMessageSchema, examples.server, "server");
  // `types` is the list of arms the schema actually has, not the list of vectors
  // written: an arm may carry several vectors, and a client's test uses this to
  // assert that it speaks every arm and nothing else.
  const types = (union, label) => discriminatedArms(union, label).map((arm) => arm.type);
  return {
    _generatedBy: "packages/shared/scripts/gen-proto-vectors.mjs",
    note: "Canonical forms are zod's own parse output (defaults applied, absent nullable fields as null, absent non-nullable fields dropped). Do not edit by hand: pnpm --filter @pqp/shared fixtures:wire regenerates it.",
    client: { types: types(sig.voiceClientMessageSchema, "client"), vectors: client },
    server: { types: types(sig.voiceSignalingMessageSchema, "server"), vectors: server },
  };
}

if (isMain(import.meta.url)) {
  const sig = await import(new URL("../src/signaling.ts", import.meta.url).href);
  const fixture = generateProtoVectors(sig);
  const frames = fixture.client.vectors.length + fixture.server.vectors.length;
  const arms = fixture.client.types.length + fixture.server.types.length;
  runCli({
    script: "gen-proto-vectors",
    url: PROTO_VECTORS_URL,
    fixture,
    summary: `${fixture.client.vectors.length} client + ${fixture.server.vectors.length} server vectors (${frames} frames over ${arms} arms)`,
  });
}
