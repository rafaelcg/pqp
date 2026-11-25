package gg.pqp.app.jam

import gg.pqp.app.core.ApiException
import java.io.IOException

/*
 * THE ADJUST EDITOR'S STATE, PURE. What is being edited, what a frame or an answer does to it, and what a refusal
 * means in words, with no engine and no view (`JamAdjustTest`).
 *
 * The rule that matters, and the web's (`jam-track-adjust.tsx`): NOTHING is sent until "Salvar", every drag is HEARD at
 * once (the engine plays the track with the edits laid on, [JamSongUi.liveTracks]), and the numbers the edits were laid
 * on are the baseline. When the STORED numbers move under an open editor (the same person adjusting on another device,
 * a frame that outran this one's answer) the edits start again from what is stored, because a nudge is "so many ms
 * on top of the stored offset" and a new stored offset makes the old nudge mean something else. While a save is out the
 * editor is left alone: its own answer is about to say the same.
 */

/** The numbers an adjustment is laid on. */
data class StoredTake(val offsetMs: Double, val trimStartMs: Double, val trimEndMs: Double, val gain: Double) {
    companion object {
        fun of(track: JamTrack) = StoredTake(track.offsetMs, track.trimStartMs, track.trimEndMs, track.gain)
    }
}

data class JamAdjust(
    val trackId: String,
    val edits: TakeEdits,
    val baseline: StoredTake,
    val saving: Boolean = false,
    val failure: JamWriteFailure? = null,
    /** Bumped when the edits were put back by something other than the person's hand, so the editor can say so. */
    val resets: Int = 0,
)

object JamAdjusting {
    fun open(track: JamTrack): JamAdjust =
        JamAdjust(track.id, JamTrackEdit.editsFromTrack(track), StoredTake.of(track))

    fun edit(adjust: JamAdjust, edits: TakeEdits): JamAdjust =
        if (adjust.saving) adjust else adjust.copy(edits = edits, failure = null)

    /** Back to what is stored (the editor's "Voltar ao automático"). */
    fun reset(adjust: JamAdjust, track: JamTrack): JamAdjust =
        if (adjust.saving) adjust else adjust.copy(edits = JamTrackEdit.editsFromTrack(track), baseline = StoredTake.of(track), failure = null)

    /**
     * The track as the screen now holds it (null once it is gone, which closes the editor). Edits are kept while the
     * stored numbers are the ones they were laid on, and started again from the stored ones when those moved.
     */
    fun reconcile(adjust: JamAdjust, track: JamTrack?): JamAdjust? {
        if (track == null) return null
        if (adjust.saving) return adjust
        val stored = StoredTake.of(track)
        if (stored == adjust.baseline) return adjust
        return JamAdjust(track.id, JamTrackEdit.editsFromTrack(track), stored, resets = adjust.resets + 1)
    }

    fun saving(adjust: JamAdjust): JamAdjust = adjust.copy(saving = true, failure = null)

    /** A refusal or a lost connection: the edits stay for another try. */
    fun failed(adjust: JamAdjust, failure: JamWriteFailure): JamAdjust = adjust.copy(saving = false, failure = failure)
}

/**
 * Why a jam WRITE did not land, in the terms a screen says (`jamErrorKind` of the web's `jam-api.ts`, plus the 403 that
 * is a permission and not the flag: "Tu não pode editar essa música").
 */
enum class JamWriteFailure { Off, Denied, TooLarge, StorageOff, RateLimited, Network, Gone, Invalid, Other }

fun jamWriteFailureOf(e: Throwable): JamWriteFailure {
    if (e is ApiException) {
        return when (e.serverMessage) {
            JamErrors.OFF -> JamWriteFailure.Off
            "jam_upload_too_large" -> JamWriteFailure.TooLarge
            "jam_storage_off" -> JamWriteFailure.StorageOff
            JamErrors.RATE_LIMITED -> JamWriteFailure.RateLimited
            else -> when (e.status) {
                // 403 with no jam token: the person may not do this (somebody else's take, a song that is not theirs).
                403 -> JamWriteFailure.Denied
                404 -> JamWriteFailure.Gone
                413 -> JamWriteFailure.TooLarge
                429 -> JamWriteFailure.RateLimited
                // The body did not parse (text that draws nothing) or the trims did not fit the file (`jam_trim_invalid`, 422).
                400, 422 -> JamWriteFailure.Invalid
                else -> JamWriteFailure.Other
            }
        }
    }
    return if (e is IOException) JamWriteFailure.Network else JamWriteFailure.Other
}

/** Who may do what to a take and a song, beyond what `JamPermissions` says about the mix and deletes. */
object JamEditPermissions {
    /**
     * "Ajustar" is the TRACK'S AUTHOR's alone, and only while the flag is on (`PATCH /api/jam-tracks/:id`: `gain`,
     * `offsetMs` and the trims are the track's author's; the song's author and moderators leave or delete somebody
     * else's take, they do not nudge it).
     */
    fun canAdjustTrack(track: JamTrack, viewerId: String?, flagOn: Boolean): Boolean =
        flagOn && viewerId != null && track.authorId == viewerId

    /** Title, artist and cover: the song's author or a moderator, flag on (`PATCH /api/jam-songs/:id`). */
    fun canEditSong(viewer: JamSongViewer, flagOn: Boolean): Boolean = flagOn && (viewer.isAuthor || viewer.canModerate)
}
