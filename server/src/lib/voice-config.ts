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
 * `audioSelfHeal`: the client watches its own audio (a microphone that stopped
 * reaching the room, a call that stopped playing), repairs it quietly, and
 * offers "Arrumar" when that did not work. Runtime flag
 * `voice_audio_self_heal`, global, on by default, `VOICE_AUDIO_SELF_HEAL` as
 * its environment default. Global because half of what it is for is DM calls,
 * which have no server. It doubles as the client's proof that this API accepts
 * `mediaQuality.audioHealth` on a call rating: a client that never heard
 * `true` from here never sends the field.
 *
 * `soundboard`: whether this server's calls offer the soundboard and its
 * settings tab. Runtime flag `soundboard`, per server, default off,
 * `SOUNDBOARD` as its environment default. The call's button and the settings
 * tab read it here, and the play gate reads it on every click, so a flip
 * either way needs no rejoin. The seat's `canUseSoundboard` is the bit alone.
 *
 * `serverId` absent (a DM call) or not a uuid is read as absent: the answer is
 * then the global value, and a DM call has no audience mode anyway.
 */
export interface VoiceConfig {
  audienceMode: boolean;
  audioSelfHeal: boolean;
  soundboard: boolean;
}

const serverIdSchema = z.string().uuid();

export function voiceConfigForServer(rawServerId: string | null): VoiceConfig {
  const parsed = serverIdSchema.safeParse(rawServerId);
  const serverId = parsed.success ? parsed.data : null;
  return {
    audienceMode: isEnabled("audience_mode", { serverId }),
    audioSelfHeal: isEnabled("voice_audio_self_heal"),
    soundboard: isEnabled("soundboard", { serverId }),
  };
}
