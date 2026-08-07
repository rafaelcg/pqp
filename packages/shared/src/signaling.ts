import { z } from "zod";

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
});

export const peerJoinedMessageSchema = z.object({
  type: z.literal("peer-joined"),
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

export const screenShareDeniedMessageSchema = z.object({
  type: z.literal("screen-share-denied"),
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

export const voiceSignalingMessageSchema = z.discriminatedUnion("type", [
  welcomeMessageSchema,
  peerJoinedMessageSchema,
  peerLeftMessageSchema,
  voiceRosterMessageSchema,
  voiceRoomFullMessageSchema,
  voiceTransportUnsupportedMessageSchema,
  screenShareDeniedMessageSchema,
  offerMessageSchema,
  answerMessageSchema,
  iceCandidateMessageSchema,
]);

export type VoiceParticipant = z.infer<typeof voiceParticipantSchema>;
export type VoiceTransportUnsupportedMessage = z.infer<
  typeof voiceTransportUnsupportedMessageSchema
>;
export type WelcomeMessage = z.infer<typeof welcomeMessageSchema>;
export type PeerJoinedMessage = z.infer<typeof peerJoinedMessageSchema>;
export type PeerLeftMessage = z.infer<typeof peerLeftMessageSchema>;
export type VoiceRosterMessage = z.infer<typeof voiceRosterMessageSchema>;
export type VoiceRoomFullMessage = z.infer<typeof voiceRoomFullMessageSchema>;
export type ScreenShareDeniedMessage = z.infer<
  typeof screenShareDeniedMessageSchema
>;
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
});

export const leaveVoiceRoomMessageSchema = z.object({
  type: z.literal("leave-voice-room"),
});

export const setSharingScreenMessageSchema = z.object({
  type: z.literal("set-sharing-screen"),
  sharing: z.boolean(),
});

export const voiceClientMessageSchema = z.discriminatedUnion("type", [
  joinVoiceRoomMessageSchema,
  leaveVoiceRoomMessageSchema,
  setSharingScreenMessageSchema,
  offerMessageSchema,
  answerMessageSchema,
  iceCandidateMessageSchema,
]);

export type VoiceClientMessage = z.infer<typeof voiceClientMessageSchema>;
