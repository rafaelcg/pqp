package gg.pqp.app.voicenotes

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.PqpJson
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.core.VoiceTranscriptionPrefs
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

@Serializable
private data class VoiceTranscriptionPatch(val voiceTranscription: VoiceTranscriptionPrefs)

/**
 * `PATCH /api/me/preferences` with `voiceTranscription`. Replaced as a whole, so both halves go every
 * time: a patch naming only one would read the other as "never chosen" and turn it back on.
 */
suspend fun ApiClient.setVoiceTranscription(mine: Boolean, show: Boolean) {
    val body = PqpJson.encodeToString(
        VoiceTranscriptionPatch.serializer(),
        VoiceTranscriptionPatch(VoiceTranscriptionPrefs(mine = mine, show = show)),
    )
    execute(
        Request.Builder()
            .url(url("/api/me/preferences"))
            .patch(body.toRequestBody(ApiClient.JSON_MEDIA_TYPE)),
    ).close()
}

/**
 * The two halves of voice note transcription, both on until turned off (the web's
 * `voice-transcription-prefs.ts`):
 *  - `mine`: my notes may be transcribed. The server copies it onto each note when the note is sent, so
 *    turning it off never reaches back into notes already sent.
 *  - `show`: I read transcripts. Off hides every transcript from this account, and the server stops
 *    transcribing a conversation's notes for me alone.
 *
 * The session holds the value every screen reads, and a tap moves it first, so a remount never shows
 * the one from launch. Writes run one at a time in a scope that outlives the screen; each sends the
 * choice as it stands when its turn comes, so several quick taps collapse into the last one. A refused
 * write puts the session back to what the server last confirmed and says so ([failed]), because this
 * is a privacy choice: "I turned it off, the request failed, nobody told me" is the one outcome to avoid.
 */
object VoiceTranscriptionPreference {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val writes = Mutex()
    private var owner: String? = null
    private var confirmed: VoiceTranscriptionPrefs? = null

    private val _failed = MutableStateFlow(false)

    /** The last write was refused and the switch went back. Cleared by the next tap. */
    val failed: StateFlow<Boolean> = _failed.asStateFlow()

    fun current(session: SessionStore): VoiceTranscriptionPrefs = read(session.phase.value)

    fun read(phase: SessionPhase): VoiceTranscriptionPrefs =
        (phase as? SessionPhase.Ready)?.me?.preferences?.voiceTranscription ?: VoiceTranscriptionPrefs()

    fun change(session: SessionStore, mine: Boolean? = null, show: Boolean? = null) {
        val userId = (session.phase.value as? SessionPhase.Ready)?.me?.id ?: return
        val before = current(session)
        synchronized(this) {
            if (owner != userId) {
                // First tap for this account: what the session holds came from `/api/me`.
                owner = userId
                confirmed = before
            }
        }
        _failed.value = false
        val next = VoiceTranscriptionPrefs(mine = mine ?: before.mineOn, show = show ?: before.showOn)
        session.applyVoiceTranscription(next)
        scope.launch {
            writes.withLock {
                // The choice as it stands NOW: an earlier queued tap that this one superseded sends once.
                val wanted = current(session)
                val settled = synchronized(this@VoiceTranscriptionPreference) { confirmed }
                if (settled != null && wanted.mineOn == settled.mineOn && wanted.showOn == settled.showOn) return@withLock
                try {
                    session.api.setVoiceTranscription(mine = wanted.mineOn, show = wanted.showOn)
                    synchronized(this@VoiceTranscriptionPreference) { confirmed = wanted }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    val back = synchronized(this@VoiceTranscriptionPreference) { confirmed }
                    // Another account may be signed in by now: only this one's session is put back.
                    if ((session.phase.value as? SessionPhase.Ready)?.me?.id == userId && back != null) {
                        session.applyVoiceTranscription(back)
                    }
                    _failed.value = true
                }
            }
        }
    }
}
