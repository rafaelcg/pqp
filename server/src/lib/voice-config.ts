import { z } from "zod";
import { isEnabled } from "./flags.js";

/**
 * What a voice call's controls need to know that the operator can change
 * without a deploy. Served by `GET /api/voice/config?serverId=`, read per
 * request, asked by the web client with the server the call is in.
 *
 * `audienceMode`: whether a host in this server is offered "Modo plateia"
 * (`docs/plans/AUDIENCE_MODE.md`). Runtime flag `audience_mode`, default off,
 * `AUDIENCE_MODE` as its environment default, per-server override so it goes
 * on for one server first. It gates turning audience mode ON; a session that
 * is already on is shown (and can be turned off) from the room's own state,
 * which the client gets on `welcome` and `voice-audience`, whatever this says.
 *
 * `serverId` absent (a DM call) or not a uuid is read as absent: the answer is
 * then the global value, and a DM call has no audience mode anyway.
 */
export interface VoiceConfig {
  audienceMode: boolean;
}

const serverIdSchema = z.string().uuid();

export function voiceConfigForServer(rawServerId: string | null): VoiceConfig {
  const parsed = serverIdSchema.safeParse(rawServerId);
  const serverId = parsed.success ? parsed.data : null;
  return {
    audienceMode: isEnabled("audience_mode", { serverId }),
  };
}
