import { z } from "zod";

export const iceCandidateInitSchema = z.object({
  candidate: z.string().optional(),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().nullable().optional(),
  usernameFragment: z.string().nullable().optional(),
});

export const welcomeMessageSchema = z.object({
  type: z.literal("welcome"),
  peerId: z.string(),
  peers: z.array(z.string()),
  voiceChannelId: z.string(),
});

export const peerJoinedMessageSchema = z.object({
  type: z.literal("peer-joined"),
  peerId: z.string(),
});

export const peerLeftMessageSchema = z.object({
  type: z.literal("peer-left"),
  peerId: z.string(),
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
  offerMessageSchema,
  answerMessageSchema,
  iceCandidateMessageSchema,
]);

export type WelcomeMessage = z.infer<typeof welcomeMessageSchema>;
export type PeerJoinedMessage = z.infer<typeof peerJoinedMessageSchema>;
export type PeerLeftMessage = z.infer<typeof peerLeftMessageSchema>;
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
});

export const leaveVoiceRoomMessageSchema = z.object({
  type: z.literal("leave-voice-room"),
});

export const voiceClientMessageSchema = z.discriminatedUnion("type", [
  joinVoiceRoomMessageSchema,
  leaveVoiceRoomMessageSchema,
  offerMessageSchema,
  answerMessageSchema,
  iceCandidateMessageSchema,
]);

export type VoiceClientMessage = z.infer<typeof voiceClientMessageSchema>;
