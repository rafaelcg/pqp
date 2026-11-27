package gg.pqp.app.jam

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/*
 * THE STARTER'S ANSWER to a part somebody outside sent: accept it (it goes in the mix, with an undo for a few seconds),
 * or decline it (it is deleted, no undo). The web's `JamPublicRequests` and `JamAnswerNotice` in `jam-song-panel.tsx`.
 *
 * Both are writes that existed (`PATCH /api/jam-tracks/:id { inMix }` and `DELETE /api/jam-tracks/:id`); what is new is
 * what the screen says about them. Three rules carried over from slice 1's QA:
 *  - a failure is said NEXT TO the part it is about (`failure.trackId`), on screen, and the part stays where it was;
 *  - nothing is dropped silently: the part stays in the list until the server said yes;
 *  - the answer is said where it was given, and leaves by itself ([JamAnswer.lifetimeMs]).
 */

enum class JamRequestAction { Accept, Decline, Undo }

data class JamRequestFailure(val trackId: String, val action: JamRequestAction, val failure: JamWriteFailure)

data class JamRequestsUi(
    /** The take a write is out for. One at a time: a second tap on any of them waits for the answer. */
    val busy: String? = null,
    val failure: JamRequestFailure? = null,
    val answer: JamAnswer? = null,
    /** The take whose "Recusar" is waiting for its confirmation. */
    val confirmDecline: JamTrack? = null,
)

/** What the answer changes outside the song: the starter's inbox and the notice items that follow it. */
interface JamRequestsHook {
    /** The take left the inbox (accepted, or removed). */
    fun dropped(trackId: String)

    /** Read the waiting lists again: best effort, never in the way of what was done. */
    fun changed()

    object None : JamRequestsHook {
        override fun dropped(trackId: String) = Unit
        override fun changed() = Unit
    }
}

class JamRequests(
    private val backend: JamBackend,
    private val scope: CoroutineScope,
    private val channelId: String,
    /** The song as the screen holds it now: the answer of a delete carries no summary, so the count comes from here. */
    private val song: () -> JamSongSummary?,
    /** Apply a frame to the song, as the one the room is getting (the answer says the same, and applying it is idempotent). */
    private val apply: (JamFrame) -> Unit,
    /** Whether the answer to this write is at least as new as what the song holds (a frame can outrun it). */
    private val accepts: (JamSongSummary) -> Boolean,
    /** A take that is being auditioned and is accepted or removed: the audition is over. */
    private val endAudition: (JamTrack) -> Unit,
    /** A refused write says what this person may do changed: read it again. */
    private val permissionsChanged: () -> Unit,
    private val hook: JamRequestsHook = JamRequestsHook.None,
) {
    private val _ui = MutableStateFlow(JamRequestsUi())
    val ui: StateFlow<JamRequestsUi> = _ui.asStateFlow()

    /** "Aceitar": the take goes in the mix, and the starter is told what the public sees now, with "Desfazer". */
    fun accept(track: JamTrack) {
        if (_ui.value.busy != null) return
        _ui.update { it.copy(busy = track.id, failure = null) }
        scope.launch {
            try {
                val answer = backend.setInMix(track.id, true)
                if (song()?.let(accepts) != false) apply(JamFrame.TrackUpdated(channelId, answer.song, answer.track))
                endAudition(track)
                hook.dropped(track.id)
                hook.changed()
                _ui.update { it.copy(answer = JamAnswer(JamAnswerKind.Accepted, track.id, track.instrument, track.authorName)) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failed(track, JamRequestAction.Accept, e)
            } finally {
                _ui.update { it.copy(busy = null) }
            }
        }
    }

    /** "Recusar" asks first (the recording is deleted); [confirmDecline] is what the dialog answers. */
    fun askDecline(track: JamTrack) = _ui.update { it.copy(confirmDecline = track, failure = null) }

    fun cancelDecline() = _ui.update { it.copy(confirmDecline = null) }

    fun confirmDecline() {
        val track = _ui.value.confirmDecline ?: return
        _ui.update { it.copy(confirmDecline = null) }
        if (_ui.value.busy != null) return
        _ui.update { it.copy(busy = track.id, failure = null) }
        scope.launch {
            try {
                backend.deleteTrack(track.id)
                // 204 carries no summary: the same frame the room gets says it, so reuse the song's with a count down.
                song()?.let { held ->
                    apply(JamFrame.TrackDeleted(channelId, held.copy(trackCount = (held.trackCount - 1).coerceAtLeast(0)), track.id))
                }
                endAudition(track)
                hook.dropped(track.id)
                hook.changed()
                _ui.update { it.copy(answer = JamAnswer(JamAnswerKind.Refused, track.id, track.instrument, track.authorName)) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failed(track, JamRequestAction.Decline, e)
            } finally {
                _ui.update { it.copy(busy = null) }
            }
        }
    }

    /** "Desfazer" after Aceitar: the same take is taken out of the mix again and goes back to the queue. */
    fun undo() {
        val answer = _ui.value.answer ?: return
        if (answer.kind != JamAnswerKind.Accepted || _ui.value.busy != null) return
        _ui.update { it.copy(busy = answer.trackId, failure = null) }
        scope.launch {
            try {
                val reply = backend.setInMix(answer.trackId, false)
                if (song()?.let(accepts) != false) apply(JamFrame.TrackUpdated(channelId, reply.song, reply.track))
                // The undo happened: say so first. The read only brings the lists up to date (the inbox is what lists a
                // waiting part, and the sender's "entrou" item goes with the part) and is best effort.
                _ui.update { it.copy(answer = answer.copy(kind = JamAnswerKind.Undone)) }
                hook.changed()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failed(null, JamRequestAction.Undo, e, trackId = answer.trackId)
            } finally {
                _ui.update { it.copy(busy = null) }
            }
        }
    }

    fun dismissAnswer(trackId: String, kind: JamAnswerKind) =
        _ui.update { if (it.answer?.trackId == trackId && it.answer.kind == kind) it.copy(answer = null) else it }

    fun dismissFailure() = _ui.update { it.copy(failure = null) }

    private fun failed(track: JamTrack?, action: JamRequestAction, e: Exception, trackId: String? = track?.id) {
        val failure = jamWriteFailureOf(e)
        _ui.update { it.copy(failure = JamRequestFailure(trackId.orEmpty(), action, failure)) }
        if (failure == JamWriteFailure.Denied) permissionsChanged()
        // A part that is already gone (the sender deleted it while the starter listened) is not waiting any more.
        if (failure == JamWriteFailure.Gone) hook.changed()
    }
}
