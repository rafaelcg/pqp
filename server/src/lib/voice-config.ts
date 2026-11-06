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
 * `calmDetector`: the web call's speaking ring reads its analysers on a timer
 * (20 Hz, 4 Hz while the window is hidden) instead of on every animation
 * frame, which woke the renderer and the GPU process 120 times a second alone
 * in a silent call. Runtime flag `voice_calm_detector`, global, on by default,
 * `VOICE_CALM_DETECTOR` as its environment default. Client only: nothing on
 * the server changes with it, and off restores the per-frame loop on the
 * client's next config refresh, mid-call, with no reload. Global because the
 * detector belongs to the device, not to a server, and DM calls have none.
 *
 * `soundboard`: whether this server's calls offer the soundboard and its
 * settings tab. Runtime flag `soundboard`, per server, default off,
 * `SOUNDBOARD` as its environment default. The call's button and the settings
 * tab read it here, and the play gate reads it on every click, so a flip
 * either way needs no rejoin. The seat's `canUseSoundboard` is the bit alone.
 *
 * `cleanVoiceDefault`: a device with no stored noise-suppression choice
 * starts on "Voz limpa" (RNNoise, `docs/NOISE_SUPPRESSION.md` §"The default")
 * instead of the browser's suppressor, when the browser can run it and the
 * machine has the cores. Runtime flag `clean_voice_default`, global, on by
 * default, `CLEAN_VOICE_DEFAULT` as its environment default. Global because
 * the microphone belongs to the device, not to a server. Off is the kill
 * switch: a default is never persisted, so every device that never chose
 * goes back to the browser's suppressor on its next config refresh.
 *
 * `voiceGate`: Voz limpa's adaptive gate after RNNoise (`docs/NOISE_SUPPRESSION.md`
 * §"The voice gate"). Runtime flag `voice_gate`, global, on by default,
 * `VOICE_GATE` as its environment default. Off is the kill switch: every
 * running gate is bypassed on the client's next config refresh, mid-call, and
 * none is built, so Voz limpa is plain RNNoise again.
 *
 * `raisedHandSticky`: a raised hand stays up until the person, a moderator
 * or leaving the call takes it down (`docs/RAISED_HANDS.md` §"What lowers a
 * hand"). Runtime flag `raised_hand_sticky`, global, on by default,
 * `RAISED_HAND_STICKY` as its environment default. The server enforces the
 * lowering rules itself (allowing somebody to speak in audience mode no
 * longer lowers their hand); the client reads this only to show the new
 * controls (click your own hand to lower it, "Baixar todas" for a moderator),
 * so off hides them and restores the old audience-mode behaviour.
 *
 * `serverId` absent (a DM call) or not a uuid is read as absent: the answer is
 * then the global value, and a DM call has no audience mode anyway.
 */
export interface VoiceConfig {
  audienceMode: boolean;
  audioSelfHeal: boolean;
  calmDetector: boolean;
  soundboard: boolean;
  cleanVoiceDefault: boolean;
  voiceGate: boolean;
  raisedHandSticky: boolean;
}

const serverIdSchema = z.string().uuid();

export function voiceConfigForServer(rawServerId: string | null): VoiceConfig {
  const parsed = serverIdSchema.safeParse(rawServerId);
  const serverId = parsed.success ? parsed.data : null;
  return {
    audienceMode: isEnabled("audience_mode", { serverId }),
    audioSelfHeal: isEnabled("voice_audio_self_heal"),
    calmDetector: isEnabled("voice_calm_detector"),
    soundboard: isEnabled("soundboard", { serverId }),
    cleanVoiceDefault: isEnabled("clean_voice_default"),
    voiceGate: isEnabled("voice_gate"),
    raisedHandSticky: isEnabled("raised_hand_sticky"),
  };
}
