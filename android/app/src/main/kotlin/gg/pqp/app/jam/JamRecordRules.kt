package gg.pqp.app.jam

/**
 * WHETHER A PERSON MAY RECORD, and if not, which sentence says why. The web's
 * `jam.song.cannot.*`, decided from what the client is told and nothing it
 * guesses: the runtime flag and storage (`GET /api/jam/config`), the song's join
 * mode, and the instruments the server says this person may add
 * (`viewer.addableInstruments`, which is already empty for a closed song, a full
 * one and a person at their own limit). The server still decides; this only
 * keeps a button honest.
 */
sealed interface RecordGate {
    data object Open : RecordGate

    data class Blocked(val reason: Reason) : RecordGate

    enum class Reason {
        /** The flag is off for this server: writes are paused, reads are not. */
        Off,

        /** The deployment has no object storage: a take could never be uploaded. */
        UploadsOff,

        /** The song is closed and the person did not start it. */
        Closed,

        /** Anything else the server's `addableInstruments` says no to (full, at the limit, cannot post here). */
        Other,
    }
}

object JamRecordRules {
    fun gate(config: JamConfig, song: JamSongSummary, viewer: JamSongViewer): RecordGate = when {
        !config.enabled -> RecordGate.Blocked(RecordGate.Reason.Off)
        !config.uploads -> RecordGate.Blocked(RecordGate.Reason.UploadsOff)
        viewer.addableInstruments.isNotEmpty() -> RecordGate.Open
        song.joinMode == JamJoinMode.Closed && !viewer.isAuthor -> RecordGate.Blocked(RecordGate.Reason.Closed)
        else -> RecordGate.Blocked(RecordGate.Reason.Other)
    }

    /** Starting a song: the flag and storage are the whole question (the server checks the permission to post). */
    fun gateNewSong(config: JamConfig): RecordGate = when {
        !config.enabled -> RecordGate.Blocked(RecordGate.Reason.Off)
        !config.uploads -> RecordGate.Blocked(RecordGate.Reason.UploadsOff)
        else -> RecordGate.Open
    }

    /** The instruments a `wanted` song is asking for; none for any other mode. */
    fun wanted(song: JamSongSummary): List<JamInstrument> =
        if (song.joinMode == JamJoinMode.Wanted) song.wantedInstruments else emptyList()

    /** Which instrument to offer first: the one the song is missing, then the one the person plays most (the first addable). */
    fun firstChoice(addable: List<JamInstrument>, song: JamSongSummary): JamInstrument =
        song.missingInstruments?.firstOrNull { it in addable }
            ?: wanted(song).firstOrNull { it in addable }
            ?: addable.firstOrNull()
            ?: JamInstrument.Guitar
}
