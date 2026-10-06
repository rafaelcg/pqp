import { z } from "zod";

/**
 * AUDIENCE MODE ("Modo plateia"): a host turns a running voice call into a
 * stage. Only the people running the room speak; everybody else is told why
 * on the mic button and asks with a raised hand. `docs/plans/AUDIENCE_MODE.md`
 * has the decisions.
 *
 * The state belongs to the CALL, not the channel: it lives with the room row
 * and dies with it, so a forgotten audience mode cannot outlive the call it
 * was turned on in.
 */

/**
 * Why this person's microphone is locked, when it is.
 *
 * - `permission`: the channel (or the server) does not give them SPEAK. Only
 *   a role or an overwrite edit changes that.
 * - `audience`: audience mode is on in this call and they are not on the
 *   stage. A host can let them speak, and raising a hand is how to ask.
 *
 * Absent means the mic is not locked, or a server that predates the field;
 * a client then shows its generic "listen only" copy.
 */
export const speakReasonSchema = z.enum(["permission", "audience"]);
export type SpeakReason = z.infer<typeof speakReasonSchema>;

/**
 * The room's audience mode, as everybody in the call reads it. Null on the
 * wire means "off".
 */
export const voiceAudienceStateSchema = z.object({
  /** When it was turned on, epoch ms (the row's clock with the registry on). */
  since: z.number().int().nonnegative(),
  /** Who turned it on. */
  byUserId: z.string(),
  /**
   * People a host has let speak in this session ("Liberar o microfone").
   * Sorted, so two machines send the same array for the same rows.
   */
  speakerUserIds: z.array(z.string()),
  /**
   * People the media server has not yet confirmed as silenced (the SFU call
   * failed or timed out for them). The server retries; a host's control
   * shows these instead of claiming it worked. Always empty on a mesh room,
   * which has no media server to ask. Absent reads as empty.
   */
  unenforcedUserIds: z.array(z.string()).optional(),
});
export type VoiceAudienceState = z.infer<typeof voiceAudienceStateSchema>;

/** Why audience mode switched off by itself. */
export const voiceAudienceEndReasonSchema = z.enum([
  /** A host turned it off. */
  "host",
  /** The last person who could run the stage left the call. */
  "no-host",
  /** The operator turned the feature off for this server. */
  "flag-off",
]);
export type VoiceAudienceEndReason = z.infer<typeof voiceAudienceEndReasonSchema>;

/** What just happened, for the transient notice in the call. */
export const voiceAudienceChangeSchema = z.object({
  kind: z.enum(["on", "off", "speaker-added", "speaker-removed"]),
  /** Who did it; null when the server did it on its own (`reason`). */
  byUserId: z.string().nullable().optional(),
  /** `speaker-*`: whom it was about. */
  userId: z.string().optional(),
  /** `off`: why. */
  reason: voiceAudienceEndReasonSchema.optional(),
});
export type VoiceAudienceChange = z.infer<typeof voiceAudienceChangeSchema>;

/**
 * Server -> every socket seated in the room: audience mode changed (or the
 * media server's confirmation did). The person's own grant travels
 * separately on `voice-speak-changed`, which is what locks the mic; this
 * frame is the state everybody draws (the badge, the host's controls, the
 * notice).
 */
export const voiceAudienceMessageSchema = z.object({
  type: z.literal("voice-audience"),
  voiceChannelId: z.string(),
  audience: voiceAudienceStateSchema.nullable(),
  change: voiceAudienceChangeSchema.optional(),
});
export type VoiceAudienceMessage = z.infer<typeof voiceAudienceMessageSchema>;

// --- HTTP ---------------------------------------------------------------------

/** `PUT /api/channels/:channelId/voice-audience` */
export const setVoiceAudienceSchema = z.object({ enabled: z.boolean() });

/** `PUT /api/channels/:channelId/voice-audience/speakers/:userId` */
export const setVoiceAudienceSpeakerSchema = z.object({ allowed: z.boolean() });

/**
 * What the media layer did with the change, for the host who asked. A
 * LiveKit room answers with who is still pending after the first pass; a
 * mesh room has no media server, so `pendingUserIds` is empty and the
 * receivers enforce it (see the plan doc, "Mesh").
 */
export const voiceAudienceEnforcementSchema = z.object({
  transport: z.enum(["mesh", "livekit"]),
  pendingUserIds: z.array(z.string()),
  /** The media server did not answer at all; the server keeps retrying. */
  unreachable: z.boolean(),
});
export type VoiceAudienceEnforcement = z.infer<
  typeof voiceAudienceEnforcementSchema
>;

export const voiceAudienceResponseSchema = z.object({
  audience: voiceAudienceStateSchema.nullable(),
  enforcement: voiceAudienceEnforcementSchema,
});
export type VoiceAudienceResponse = z.infer<typeof voiceAudienceResponseSchema>;
