package gg.pqp.app.voice

import androidx.annotation.StringRes
import gg.pqp.app.R

/**
 * Which sentence a voice refusal gets, and the one place that decides it.
 *
 * A watch party is a broadcast, not a call -- `docs/WATCH_PARTY.md` "A watch
 * party has no voice by default" -- and every generic [Refusal] string was
 * written for the ordinary case, an actual call: "the voice server", "this
 * call", "this voice call". Surfaced verbatim inside a watch party's own
 * room (a host's "Ir ao vivo" join failing, or a screen-share refusal while
 * live), that wording tells a host their broadcast is a dropped call, which
 * is a worse and wronger thing to hear than the truth. [inWatchParty] is
 * `true` exactly when the refusal happened in a channel this account is
 * currently hosting or watching a party in -- see the call site in
 * `PqpApp.kt`, which reads it off `WatchLiveStore.parties` keyed by
 * [VoiceState.channelId] rather than off the route, because the toast is
 * shown above the whole nav graph and may outlive the screen that started
 * the join.
 *
 * Deliberately narrow: only the refusals a watch party's own room can
 * plausibly produce, and only for the two words that misframe it, are
 * given a second sentence. [Refusal.RoomFull] ("This channel is full") says
 * neither "call" nor "voice server" and is left alone; a viewer never
 * reaches any of these in the first place, because watching opens no
 * [VoiceController] seat at all.
 */
@StringRes
fun voiceRefusalStringRes(refusal: Refusal, inWatchParty: Boolean): Int = when (refusal) {
    Refusal.RoomFull -> R.string.voice_room_full
    Refusal.TransportUnsupported ->
        if (inWatchParty) R.string.voice_transport_unsupported_watch_party else R.string.voice_transport_unsupported
    Refusal.ScreenShareDenied ->
        if (inWatchParty) R.string.voice_screen_share_denied_watch_party else R.string.voice_screen_share_denied
    Refusal.VoiceBackendUnreachable ->
        if (inWatchParty) R.string.voice_backend_unreachable_watch_party else R.string.voice_backend_unreachable
    Refusal.VoiceTokenRefused ->
        if (inWatchParty) R.string.voice_token_refused_watch_party else R.string.voice_token_refused
    Refusal.VoiceTransportMismatch ->
        if (inWatchParty) R.string.voice_transport_mismatch_watch_party else R.string.voice_transport_mismatch
    Refusal.VoiceBackendTimedOut ->
        if (inWatchParty) R.string.voice_backend_timeout_watch_party else R.string.voice_backend_timeout
    Refusal.JoinRefused ->
        if (inWatchParty) R.string.voice_join_refused_watch_party else R.string.voice_join_refused
    Refusal.JoinTimedOut ->
        if (inWatchParty) R.string.voice_join_timeout_watch_party else R.string.voice_join_timeout
}
