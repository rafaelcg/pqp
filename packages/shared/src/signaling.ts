import { z } from "zod";
import {
  setWatchPartyMessageSchema,
  watchPartyMessageSchema,
} from "./watch-party.js";

export const iceCandidateInitSchema = z.object({
  candidate: z.string().optional(),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().nullable().optional(),
  usernameFragment: z.string().nullable().optional(),
});

/**
 * The media path a voice room runs on.
 *
 * This is a property of the **room**, decided by the server, not a choice each
 * client makes for itself. Two clients on different transports in the same room
 * cannot hear each other at all — the mesh client's offers land on a client with
 * no peer-connection manager and are dropped, and the mesh client is not a
 * LiveKit participant so it never appears in the SFU client's peer list either.
 * Nothing in either UI distinguishes that from someone sitting there muted,
 * which is why the transport is stated on the wire instead of inferred.
 */
export const voiceRoomTransportSchema = z.enum(["mesh", "livekit"]);

export type VoiceRoomTransport = z.infer<typeof voiceRoomTransportSchema>;

export const voiceParticipantSchema = z.object({
  peerId: z.string(),
  userId: z.string().uuid(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  sharingScreen: z.boolean().default(false),
  /**
   * The sender-side MediaStream id of this participant's camera capture, or
   * null/absent when their camera is off.
   *
   * This exists for the *mesh* receive path: an incoming video track carries
   * only its stream id (`a=msid`), and a peer may legitimately be sending two
   * video tracks at once — screen and camera. The id is what lets a receiver
   * file each one under the right tile instead of guessing from arrival order.
   * On the SFU path LiveKit already labels tracks with a source, so this field
   * is informational there. Not sensitive: it names a capture, and only people
   * already allowed to see the roster receive it.
   */
  cameraStreamId: z.string().nullable().optional(),
  /**
   * The sender-side MediaStream id of this participant's screen capture *when
   * that capture carries audio*, or null/absent when it does not.
   *
   * Same job as `cameraStreamId`, for the other ambiguity a mesh receiver has:
   * an incoming audio track carries only its stream id, and a peer sharing a
   * tab with sound is sending two of them (microphone and system audio). Without
   * this the second one would be filed as the peer's voice and silence their
   * microphone. Absent is the common case, not an error: Safari and Firefox give
   * no display audio at all, and on macOS neither does a screen or window share.
   * On the SFU path LiveKit labels the publication `ScreenShareAudio`, so this
   * field is informational there.
   */
  screenAudioStreamId: z.string().nullable().optional(),
  // --- voice state ---
  //
  // Self-reported by the participant's client over `set-voice-state` and
  // carried on every roster, so someone *outside* the call can see who is
  // muted or deafened before joining. Defaulted for wire compatibility with a
  // server that predates the fields — absent reads as "not muted", which is
  // also a participant's initial state on join.
  //
  // `speaking` is deliberately NOT here. Mute and deafen change a handful of
  // times per call; speaking flips several times per *sentence*, and a roster
  // frame fans out to every member of the server who can see the channel —
  // the same cost argument that keeps user status pulled rather than pushed.
  // In-call clients already derive speaking locally from the audio they
  // receive, which is both free and more accurate than anything relayed.
  muted: z.boolean().default(false),
  deafened: z.boolean().default(false),
  /**
   * A moderator muted this participant for everyone in the call.
   *
   * Set by the server, never by the participant's own client, and enforced
   * the way an eviction is: the server changes the ROSTER and every other
   * client obeys it. On a mesh room the audio never touches the server, so a
   * mute there is each receiver forcing this peer's playback to zero, exactly
   * as each receiver already drops a peer the roster no longer lists. On a
   * LiveKit room the SFU also mutes the publication, but the flag travels
   * regardless so both transports look identical on every tile.
   *
   * While it is set the server keeps `muted` true and refuses the
   * participant's own `set-voice-state` unmute; only a moderator clearing it
   * or the room emptying resets it, so leaving and rejoining is not an unmute
   * button. Defaulted like `muted`, so a client or server that predates the
   * field reads absent as "not server-muted".
   */
  serverMuted: z.boolean().default(false),
});

export const welcomeMessageSchema = z.object({
  type: z.literal("welcome"),
  peerId: z.string(),
  peers: z.array(voiceParticipantSchema),
  voiceChannelId: z.string(),
  self: voiceParticipantSchema,
  /**
   * The transport this room runs on. Binding, not advisory: a client that
   * cannot use it must leave and say so rather than build the other one.
   *
   * Optional only for wire compatibility with a server that predates the
   * field — see `VoiceSessionProvider` on the client for what absence means
   * there.
   */
  transport: voiceRoomTransportSchema.optional(),
  /**
   * True when this welcome reattached or reconstructed an existing peer id
   * rather than minting a new one. Absent means a cold join (older servers,
   * or a resume the server declined). A client that held media across a
   * signaling drop uses this to skip tearing down WebRTC / LiveKit.
   */
  resumed: z.boolean().optional(),
  /**
   * Opaque HMAC the client sends back on `join-voice-room.resumeToken` so a
   * process restart cannot be turned into "whoever saw the roster claims this
   * id". Memory-only; a tab reload starts a cold join.
   */
  resumeToken: z.string().min(1).optional(),
});

export const peerJoinedMessageSchema = z.object({
  type: z.literal("peer-joined"),
  peer: voiceParticipantSchema,
});

/**
 * A peer already in the room now shows a different name or picture.
 *
 * Separate from `peer-joined` rather than a re-send of it: the client plays
 * the join cue on that one, and a rename is not somebody walking in.
 */
export const peerUpdatedMessageSchema = z.object({
  type: z.literal("peer-updated"),
  peer: voiceParticipantSchema,
});

export const peerLeftMessageSchema = z.object({
  type: z.literal("peer-left"),
  peerId: z.string(),
});

export const voiceRosterMessageSchema = z.object({
  type: z.literal("voice-roster"),
  voiceChannelId: z.string(),
  participants: z.array(voiceParticipantSchema),
  /** Same value `welcome` carries, so the room's transport is visible before joining. */
  transport: voiceRoomTransportSchema.optional(),
});

export const voiceRoomFullMessageSchema = z.object({
  type: z.literal("voice-room-full"),
  voiceChannelId: z.string(),
  limit: z.number(),
});

/**
 * The join was refused because the client said it cannot use the transport the
 * room runs on. No peer was created and nothing was broadcast, so the caller is
 * not in the room and nobody else ever saw them arrive.
 */
export const voiceTransportUnsupportedMessageSchema = z.object({
  type: z.literal("voice-transport-unsupported"),
  voiceChannelId: z.string(),
  transport: voiceRoomTransportSchema,
});

/**
 * Join was refused after the client asked to resume (ACL, timeout, block).
 * A holding client must hang up rather than sit on live media outside the room.
 * Older clients ignore an unknown type.
 */
export const voiceJoinRefusedMessageSchema = z.object({
  type: z.literal("voice-join-refused"),
  voiceChannelId: z.string().uuid(),
});

export const screenShareDeniedMessageSchema = z.object({
  type: z.literal("screen-share-denied"),
  voiceChannelId: z.string(),
});

export const cameraDeniedMessageSchema = z.object({
  type: z.literal("camera-denied"),
  voiceChannelId: z.string(),
});

export const offerMessageSchema = z.object({
  type: z.literal("offer"),
  from: z.string(),
  to: z.string(),
  sdp: z.string(),
});

export const answerMessageSchema = z.object({
  type: z.literal("answer"),
  from: z.string(),
  to: z.string(),
  sdp: z.string(),
});

export const iceCandidateMessageSchema = z.object({
  type: z.literal("ice-candidate"),
  from: z.string(),
  to: z.string(),
  candidate: iceCandidateInitSchema.nullable(),
});

// --- conversation calls ---------------------------------------------------
//
// A server voice channel is join-when-you-want; a conversation (DM / group DM)
// call RINGS. The frames below carry that ringing lifecycle. They are scoped
// to conversations only — the server refuses `call-ring` for any channel that
// belongs to a server — and every one of them is delivered to conversation
// participants alone, never to a server audience.

/** Who is calling, as shown on the incoming-call surface. */
export const callerSummarySchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
});

/**
 * Caller → server: ring the absent participants of a conversation.
 *
 * Sent *after* the caller has joined the conversation's voice room (the join
 * is where access, blocks and transport are enforced) — the server verifies
 * the sender is a live peer of exactly this room before ringing anyone.
 */
export const callRingMessageSchema = z.object({
  type: z.literal("call-ring"),
  conversationId: z.string().uuid(),
});

/** Callee → server: refuse the ring. Accepting is simply `join-voice-room`. */
export const callDeclineMessageSchema = z.object({
  type: z.literal("call-decline"),
  conversationId: z.string().uuid(),
});

/**
 * Camera state, declared to the room the way `set-sharing-screen` is.
 *
 * `streamId` is the local camera capture's MediaStream id (see
 * `voiceParticipantSchema.cameraStreamId`); null means the camera turned off.
 */
export const setCameraMessageSchema = z.object({
  type: z.literal("set-camera"),
  streamId: z.string().nullable(),
});

/** Server → callee sockets: someone is calling this conversation. */
export const callIncomingMessageSchema = z.object({
  type: z.literal("call-incoming"),
  conversationId: z.string().uuid(),
  kind: z.enum(["dm", "group"]),
  caller: callerSummarySchema,
});

/**
 * Server → callee sockets: stop ringing.
 *
 * - `answered` — this user joined the call (possibly from another device).
 * - `declined` — this user declined (from another device).
 * - `cancelled` — the call ended before anyone answered (caller hung up).
 * - `timeout` — nobody answered before the ring expired.
 */
export const callRingCancelledMessageSchema = z.object({
  type: z.literal("call-ring-cancelled"),
  conversationId: z.string().uuid(),
  reason: z.enum(["answered", "declined", "cancelled", "timeout"]),
});

/** Server → the room: a rung participant declined, so stop expecting them. */
export const callDeclinedMessageSchema = z.object({
  type: z.literal("call-declined"),
  conversationId: z.string().uuid(),
  userId: z.string().uuid(),
});

export type CallerSummary = z.infer<typeof callerSummarySchema>;
export type CallRingMessage = z.infer<typeof callRingMessageSchema>;
export type CallDeclineMessage = z.infer<typeof callDeclineMessageSchema>;
export type SetCameraMessage = z.infer<typeof setCameraMessageSchema>;
export type CallIncomingMessage = z.infer<typeof callIncomingMessageSchema>;
export type CallRingCancelledMessage = z.infer<
  typeof callRingCancelledMessageSchema
>;
export type CallDeclinedMessage = z.infer<typeof callDeclinedMessageSchema>;

// --- end conversation calls -----------------------------------------------

// --- voice moderation -------------------------------------------------------
//
// Server → the sanctioned participant's socket, before their peer is dropped.
// The sanction-notice principle applies: an eviction the target cannot see is
// indistinguishable from a network failure, so the frame carries the whole
// sentence, already written, and a client that renders nothing but `message`
// is a correct client.

export const voiceModerationMessageSchema = z.object({
  type: z.literal("voice-moderation"),
  action: z.enum(["disconnected", "moved", "muted", "unmuted"]),
  /** The room the action happened in — the one the target was connected to. */
  voiceChannelId: z.string(),
  /**
   * `moved` only: the voice channel the moderator sent the target to. The
   * client follows it by issuing an ordinary `join-voice-room`, which re-runs
   * every server-side check (channel access, timeout, transport, room-full) —
   * so a forged or replayed frame can never place a client somewhere the
   * server would not have admitted it anyway. The client additionally follows
   * only when it is currently in `voiceChannelId`; consent to be moved is
   * consent already given by being in that server's voice.
   */
  movedToChannelId: z.string().uuid().optional(),
  /** The whole sentence, already written — render it verbatim. */
  message: z.string(),
});

export type VoiceModerationMessage = z.infer<typeof voiceModerationMessageSchema>;

// --- end voice moderation ---------------------------------------------------

export const voiceSignalingMessageSchema = z.discriminatedUnion("type", [
  welcomeMessageSchema,
  peerJoinedMessageSchema,
  peerUpdatedMessageSchema,
  peerLeftMessageSchema,
  voiceRosterMessageSchema,
  voiceRoomFullMessageSchema,
  voiceTransportUnsupportedMessageSchema,
  voiceJoinRefusedMessageSchema,
  screenShareDeniedMessageSchema,
  cameraDeniedMessageSchema,
  offerMessageSchema,
  answerMessageSchema,
  iceCandidateMessageSchema,
  // --- conversation calls ---
  callIncomingMessageSchema,
  callRingCancelledMessageSchema,
  callDeclinedMessageSchema,
  // --- voice moderation ---
  voiceModerationMessageSchema,
  // --- watch party ---
  watchPartyMessageSchema,
]);

export type VoiceParticipant = z.infer<typeof voiceParticipantSchema>;
export type VoiceTransportUnsupportedMessage = z.infer<
  typeof voiceTransportUnsupportedMessageSchema
>;
export type VoiceJoinRefusedMessage = z.infer<
  typeof voiceJoinRefusedMessageSchema
>;
export type WelcomeMessage = z.infer<typeof welcomeMessageSchema>;
export type PeerJoinedMessage = z.infer<typeof peerJoinedMessageSchema>;
export type PeerUpdatedMessage = z.infer<typeof peerUpdatedMessageSchema>;
export type PeerLeftMessage = z.infer<typeof peerLeftMessageSchema>;
export type VoiceRosterMessage = z.infer<typeof voiceRosterMessageSchema>;
export type VoiceRoomFullMessage = z.infer<typeof voiceRoomFullMessageSchema>;
export type ScreenShareDeniedMessage = z.infer<
  typeof screenShareDeniedMessageSchema
>;
export type CameraDeniedMessage = z.infer<typeof cameraDeniedMessageSchema>;
export type OfferMessage = z.infer<typeof offerMessageSchema>;
export type AnswerMessage = z.infer<typeof answerMessageSchema>;
export type IceCandidateMessage = z.infer<typeof iceCandidateMessageSchema>;
export type VoiceSignalingMessage = z.infer<typeof voiceSignalingMessageSchema>;

export const clientRelayMessageSchema = z.discriminatedUnion("type", [
  offerMessageSchema,
  answerMessageSchema,
  iceCandidateMessageSchema,
]);

export type ClientRelayMessage = z.infer<typeof clientRelayMessageSchema>;

export function isClientRelayMessage(
  message: VoiceSignalingMessage,
): message is ClientRelayMessage {
  return (
    message.type === "offer" ||
    message.type === "answer" ||
    message.type === "ice-candidate"
  );
}

export const joinVoiceRoomMessageSchema = z.object({
  type: z.literal("join-voice-room"),
  voiceChannelId: z.string().uuid(),
  /**
   * Which transports this client is able to run. Declared up front so the
   * server can refuse the join *before* creating a peer — a client that cannot
   * use the room's transport must never appear in anyone's roster, not even for
   * the round trip it would take to discover the mismatch and leave.
   *
   * Absent means "assume both". That is the permissive reading, chosen because
   * the only clients that omit it are ones built before this field existed, and
   * refusing every one of them from an SFU room would be a worse deploy than
   * leaving them on the behaviour they already had.
   */
  transports: z.array(voiceRoomTransportSchema).nonempty().optional(),
  /**
   * Peer id from a previous `welcome` in this channel. Optional: older clients
   * omit it and get a new id. The server only honours it with a valid
   * `resumeToken` (same user, same channel, unexpired).
   */
  resumePeerId: z.string().uuid().optional(),
  /** HMAC issued on `welcome`. Missing or invalid → cold join, never 500. */
  resumeToken: z.string().min(1).optional(),
  /**
   * This client can hold media across a signaling drop and will try to
   * reattach. Web and Electron send `true`. Phones and older tabs omit it.
   * The server only keeps an orphan seat for peers that declared this.
   */
  resume: z.boolean().optional(),
});

export const leaveVoiceRoomMessageSchema = z.object({
  type: z.literal("leave-voice-room"),
  /**
   * Same pair as `join-voice-room`. Optional: a live socket already maps to
   * the peer. When the socket is new (hangup while `/ws` was down) the server
   * verifies these and removes that orphan instead of waiting out the TTL.
   */
  resumePeerId: z.string().uuid().optional(),
  resumeToken: z.string().min(1).optional(),
});

export const setSharingScreenMessageSchema = z.object({
  type: z.literal("set-sharing-screen"),
  sharing: z.boolean(),
  /**
   * The capture's MediaStream id when it carries audio (see
   * `voiceParticipantSchema.screenAudioStreamId`). Omitted or null means the
   * share is silent, which is what most of them are.
   */
  audioStreamId: z.string().nullable().optional(),
});

// --- voice state ---
//
// Client → server: declare mute/deafen so the roster can carry it (see the
// matching fields on `voiceParticipantSchema`). Both flags travel together —
// a partial update would make the server merge stale halves after a missed
// frame, and the client always knows both values anyway.
export const setVoiceStateMessageSchema = z.object({
  type: z.literal("set-voice-state"),
  muted: z.boolean(),
  deafened: z.boolean(),
});

export type SetVoiceStateMessage = z.infer<typeof setVoiceStateMessageSchema>;

export const voiceClientMessageSchema = z.discriminatedUnion("type", [
  joinVoiceRoomMessageSchema,
  leaveVoiceRoomMessageSchema,
  setSharingScreenMessageSchema,
  offerMessageSchema,
  answerMessageSchema,
  iceCandidateMessageSchema,
  // --- conversation calls ---
  callRingMessageSchema,
  callDeclineMessageSchema,
  setCameraMessageSchema,
  // --- voice state ---
  setVoiceStateMessageSchema,
  // --- watch party ---
  setWatchPartyMessageSchema,
]);

export type VoiceClientMessage = z.infer<typeof voiceClientMessageSchema>;
