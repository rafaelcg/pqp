import { z } from "zod";
import {
  channelLiveMessageSchema,
  voiceStreamMessageSchema,
  watchLiveMessageSchema,
} from "./live-hls.js";
import {
  liveReactionMessageSchema,
  liveReactionsMessageSchema,
} from "./live-reactions.js";
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
   * Whether this participant holds `Permission.SPEAK` in the room. Absent on
   * a server that predates the field, and absent means "may speak", which is
   * also what every server resolved before SPEAK was enforced.
   *
   * Set by the server, never self-reported: it is what `muted` is not, a
   * *rule*. On the SFU it is the microphone half of the LiveKit publish grant.
   * Carried for every participant, not only self, so the UI can badge a stage
   * audience; the bit itself is already visible to anyone who can open the
   * roles editor.
   */
  canSpeak: z.boolean().optional(),
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
  /**
   * Whether this participant holds `Permission.STREAM` (camera / screen).
   * Absent on an older server: read as `canSpeak`, which is how those two
   * were bundled before the bits were split.
   */
  canStream: z.boolean().optional(),
  /**
   * WHEN THIS PERSON RAISED THEIR HAND, in epoch milliseconds, or null when
   * it is down. A queue, carried as a timestamp per person rather than as a
   * list.
   *
   * THE ORDER IS THE SERVER'S. The number is stamped by the server (from the
   * `voice_raised_hands` row's `NOW()` when the registry is on, so two
   * machines read one clock) and never by the raiser, which is the whole
   * point: "who was first" has to be one answer, not each client's opinion
   * of its own latency. Clients sort ascending and break ties on `userId`
   * (see `raisedHandQueue`), so every screen in the room prints the same
   * list in the same order.
   *
   * A TIMESTAMP AND NOT A SEPARATE FRAME. The roster already fans out to
   * everyone who can see the channel and already diffs per participant, so a
   * hand rides it for free and cannot disagree with the room it is drawn
   * over. A `voice-hands` frame beside it would need its own sequence, its
   * own convergence rule and its own answer for the socket that joined
   * mid-call, all to say something the roster is already saying.
   *
   * Keyed on the PERSON in the room, not on the seat: a socket blip that
   * reattaches the same peer, and a refresh inside the orphan window that
   * mints a new one, both come back holding the place in the queue. Leaving
   * the room drops it, because a queue full of hands belonging to people who
   * are gone is worse than no queue at all.
   *
   * Absent on a server that predates the field, and absent reads as "hand
   * down", which is also everybody's state on join.
   */
  handRaisedAt: z.number().int().nonnegative().nullable().optional(),
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
  /**
   * Same value as `self.canSpeak`, at the top level so a client does not
   * have to know the participant shape grew. False means: join muted, keep
   * the mic locked. Optional for wire compatibility; absent reads as true.
   */
  canSpeak: z.boolean().optional(),
  /**
   * Same value as `self.canStream`. False means: do not offer camera or
   * screen share. Absent reads as `canSpeak`.
   */
  canStream: z.boolean().optional(),
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
  /**
   * Where this snapshot sits in the room's roster sequence (see
   * `voiceRosterDeltaMessageSchema`). A full roster is always authoritative:
   * receiving one means "forget what you had, this is the room, and the next
   * delta you may apply is `seq + 1`".
   *
   * Absent on a server that predates deltas, and absent reads as 0, which is
   * also the sequence an empty room restarts from. A client that never
   * negotiated deltas can ignore this field entirely.
   */
  seq: z.number().int().nonnegative().optional(),
});

/**
 * WHAT CHANGED IN A ROOM, INSTEAD OF THE WHOLE ROOM.
 *
 * A `voice-roster` carries every participant to everyone who can *see* the
 * channel, because occupancy badges are drawn for people standing outside the
 * call. #260 bounded how often that goes out; it did nothing about its size,
 * and size times audience is the product that actually hurts: 130 people in a
 * community of 508 is ~45 KB per frame to every socket, which on 2026-09-05
 * was the whole reason arrivals could not be welcomed inside the client's own
 * give-up timer.
 *
 * So a room that has already been described is described incrementally. Three
 * lists, applied IN ORDER, each an absolute statement about one peer:
 *
 *   joined   this peer is in the room, with this state (replace by peerId)
 *   updated  this peer is in the room, with this state (replace by peerId)
 *   left     this peer is not in the room (remove by peerId)
 *
 * `joined` and `updated` are the same operation and are separated only so a
 * receiver can tell an arrival from a mute toggle (one plays a cue, the other
 * does not). Because every entry is absolute rather than relative, applying
 * one twice is the same as applying it once, which is what makes a delta that
 * overlaps a snapshot the client already holds harmless.
 *
 * HOW A RECEIVER KNOWS IT IS STILL RIGHT. Two independent checks:
 *
 *   `seq`   monotonic per room, +1 per delta, restarted at 1 whenever the room
 *           has been empty. Apply only when `seq === held + 1` (a client with
 *           no state holds 0, so the first delta after an empty room is
 *           self-sufficient). Anything else is a gap.
 *   `size`  how many participants the room has AFTER this delta. A receiver
 *           that applied everything and disagrees has diverged for some reason
 *           `seq` cannot see, and is equally out of sync.
 *
 * On either failure the receiver stops applying deltas for that room and waits
 * for the next full `voice-roster`, which the server sends periodically for
 * exactly this purpose. That is the whole convergence argument: a lost or
 * reordered frame costs a bounded interval of staleness and can never leave a
 * peer permanently invisible, because the next snapshot replaces the state
 * wholesale rather than patching it.
 *
 * Only ever sent to a socket that asked for it (`caps` on the `auth` frame).
 * Everything else keeps receiving full rosters at the old rate.
 */
export const voiceRosterDeltaMessageSchema = z.object({
  type: z.literal("voice-roster-delta"),
  voiceChannelId: z.string(),
  /** This delta's place in the room's sequence. Apply only when it is held + 1. */
  seq: z.number().int().positive(),
  /** Participants in the room once this delta has been applied. */
  size: z.number().int().nonnegative(),
  /** Same value the full roster carries. */
  transport: voiceRoomTransportSchema.optional(),
  joined: z.array(voiceParticipantSchema).optional(),
  updated: z.array(voiceParticipantSchema).optional(),
  left: z.array(z.string()).optional(),
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
  /**
   * Why the room runs a transport this client is not on.
   *
   * Absent is the original case: the join was refused up front because the
   * client declared it cannot run the room's transport. `promoted` is the
   * one case where the frame reaches a client that *was* seated: the room
   * moved to the SFU under it (see `voiceTransportChangedMessageSchema`) and
   * this socket never negotiated the frame that would have moved it in
   * place, so its seat was released. Both mean the same thing to a client
   * that ignores the field, which is why it is optional: leave the call and
   * say so. Only the sentence differs.
   */
  reason: z.literal("promoted").optional(),
});

/**
 * THE ROOM'S TRANSPORT CHANGED UNDER THE PEOPLE IN IT.
 *
 * The rule used to be absolute: a room keeps the transport it opened on until
 * it empties. It still is, with exactly one exception, and this frame is that
 * exception announced.
 *
 * WHY. A mesh camera is a full uplink copy per peer, so `CAMERA_LIMIT.mesh` is
 * three and the fourth camera in a small server's call used to be refused
 * outright ("essa call já chegou no máximo de câmeras"). The room was on mesh
 * only because the server has fewer than `LARGE_SERVER_MEMBER_THRESHOLD`
 * members, which is a guess about crowd size and says nothing about how many
 * cameras five friends want on. Where LiveKit is configured the SFU can carry
 * them, so the server moves the whole room there rather than refusing the
 * camera.
 *
 * WHAT MAKES IT SAFE. The half-move is what the one-transport rule exists to
 * prevent, so this frame moves the *room*: the server rewrites the pin first
 * (atomically, so two people clicking at once promote once), then tells every
 * seat, on this instance and across the bus. A seat that never negotiated
 * `SOCKET_CAPS.voiceTransportChanged` is not left building a mesh nobody else
 * is on: it is released and told, with `voice-transport-unsupported`'s
 * `promoted` reason, so it leaves the call and can rejoin onto the SFU.
 *
 * `participants` is the room as the server holds it at the moment of the
 * promotion, so the receiver can build its SFU session without waiting for a
 * roster to arrive. It is the same shape `welcome.peers` carries and includes
 * the receiver's own seat.
 */
export const voiceTransportChangedMessageSchema = z.object({
  type: z.literal("voice-transport-changed"),
  voiceChannelId: z.string(),
  /**
   * The transport the room runs on from now on. Only `livekit` is ever sent
   * today (a promotion is one-way: nothing demotes a live room). A receiver
   * that does not know what to do with the value must ignore the frame and
   * stay where it is rather than guess.
   */
  transport: voiceRoomTransportSchema,
  /**
   * What asked for the room: a camera or a screen share past the mesh cap
   * (`cameras` / `screens`), a ninth person at the door of a full mesh
   * (`room-full`), a room reaching `MESH_ROOM_PROMOTION_SIZE` so that nobody
   * meets a mesh cap in the first place (`room-size`), or a pin that no longer
   * matches the policy (`stale-pin`, a server that grew past ten members
   * during a call that never emptied). A
   * receiver that does not know the value still follows the move; only the
   * sentence on screen depends on it.
   */
  reason: z.enum(["cameras", "screens", "room-full", "room-size", "stale-pin"]),
  /** The room at the moment of the promotion, self included. */
  participants: z.array(voiceParticipantSchema),
});

/**
 * Join was refused after the client asked to resume (ACL, timeout, block), or
 * a cold mesh join was refused because the API is running on more than one
 * machine and this one cannot relay to the room's peers (`reason`, M5 of the
 * multi-instance plan). A holding client must hang up rather than sit on live
 * media outside the room. Older clients ignore an unknown type and an unknown
 * field.
 */
export const voiceJoinRefusedMessageSchema = z.object({
  type: z.literal("voice-join-refused"),
  voiceChannelId: z.string().uuid(),
  reason: z.enum(["mesh-multi-instance"]).optional(),
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
  /**
   * What this machine's uplink measured, in bit/s, for the mesh limit.
   *
   * Optional and clamped on arrival (`clampReportedUplinkBps`); every native
   * client omits it today and gets the old constant. It is read ONLY on mesh,
   * where the copies it pays for are the sender's own, and never on the voice
   * server, where the cost is the box's and the box is priced from the roster.
   */
  uplinkBps: z.number().optional(),
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

/**
 * Server → one participant's sockets: SPEAK and/or STREAM changed while
 * they were in the room. `canSpeak: false` locks the mic. `canStream: false`
 * stops camera and screen share. On the SFU the server has already rewritten
 * the publish grant. `true` unlocks the matching controls; the client stays
 * muted until the person chooses to unmute.
 */
export const voiceSpeakChangedMessageSchema = z.object({
  type: z.literal("voice-speak-changed"),
  voiceChannelId: z.string(),
  canSpeak: z.boolean(),
  canStream: z.boolean().optional(),
});

export type VoiceSpeakChangedMessage = z.infer<
  typeof voiceSpeakChangedMessageSchema
>;

// --- end voice moderation ---------------------------------------------------

export const voiceSignalingMessageSchema = z.discriminatedUnion("type", [
  welcomeMessageSchema,
  peerJoinedMessageSchema,
  peerUpdatedMessageSchema,
  peerLeftMessageSchema,
  voiceRosterMessageSchema,
  voiceRosterDeltaMessageSchema,
  voiceRoomFullMessageSchema,
  voiceTransportUnsupportedMessageSchema,
  voiceTransportChangedMessageSchema,
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
  voiceSpeakChangedMessageSchema,
  // --- watch party ---
  watchPartyMessageSchema,
  // --- live reactions --- see packages/shared/src/live-reactions.ts. Coalesced
  // counts for the room, never per person and never stored.
  liveReactionsMessageSchema,
  // --- live HLS (screen-share egress) ---
  voiceStreamMessageSchema,
  channelLiveMessageSchema,
]);

export type VoiceParticipant = z.infer<typeof voiceParticipantSchema>;
export type VoiceTransportUnsupportedMessage = z.infer<
  typeof voiceTransportUnsupportedMessageSchema
>;
export type VoiceTransportChangedMessage = z.infer<
  typeof voiceTransportChangedMessageSchema
>;
export type VoiceJoinRefusedMessage = z.infer<
  typeof voiceJoinRefusedMessageSchema
>;
export type WelcomeMessage = z.infer<typeof welcomeMessageSchema>;
export type PeerJoinedMessage = z.infer<typeof peerJoinedMessageSchema>;
export type PeerUpdatedMessage = z.infer<typeof peerUpdatedMessageSchema>;
export type PeerLeftMessage = z.infer<typeof peerLeftMessageSchema>;
export type VoiceRosterMessage = z.infer<typeof voiceRosterMessageSchema>;
export type VoiceRosterDeltaMessage = z.infer<
  typeof voiceRosterDeltaMessageSchema
>;
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
  /** See `setCameraMessageSchema.uplinkBps`: the mesh limit's measurement. */
  uplinkBps: z.number().optional(),
  /**
   * Published capture height, in lines. The HLS ladder refuses a rung
   * taller than this (a 720p window must not spend a core inventing 1080p).
   * Absent on older clients: the server then asks LiveKit, or starts the
   * configured ladder as before.
   */
  sourceHeight: z.number().int().positive().optional(),
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

/**
 * Client -> server: put my own hand up, or take it down.
 *
 * Only ever about the sender. Lowering somebody ELSE's hand is a moderation
 * action and goes through the HTTP route that every other voice-moderation
 * action goes through (`POST /api/servers/:id/members/:userId/voice-lower-hand`,
 * `Permission.MUTE_MEMBERS`), so there is no shape here that names a target.
 *
 * The server answers with the roster, not with an ack: `handRaisedAt` on the
 * next `voice-roster` (or delta) is what tells the raiser where in the queue
 * they landed, which is the same number everyone else is reading.
 */
export const setRaisedHandMessageSchema = z.object({
  type: z.literal("set-raised-hand"),
  raised: z.boolean(),
});

export type SetRaisedHandMessage = z.infer<typeof setRaisedHandMessageSchema>;

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
  // --- raised hands ---
  setRaisedHandMessageSchema,
  // --- watch party ---
  setWatchPartyMessageSchema,
  // --- live reactions ---
  liveReactionMessageSchema,
  // --- live HLS watch mode (no seat) ---
  watchLiveMessageSchema,
]);

export type VoiceClientMessage = z.infer<typeof voiceClientMessageSchema>;
