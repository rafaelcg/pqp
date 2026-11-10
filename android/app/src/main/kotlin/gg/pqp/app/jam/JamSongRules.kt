package gg.pqp.app.jam

import kotlin.math.max
import kotlin.math.min

/*
 * THE SONG SCREEN'S RULES, PURE: which tracks play, which are heard, how the
 * stack is ordered, how a live frame changes it, and where the playhead is on
 * the stacked waveforms. A test for each (`JamSongRulesTest`), no engine and no
 * view. The choices that are arbitrary are the iOS client's.
 */

object JamMixRules {
    /**
     * The tracks that play right now: everything `inMix`, except that a take
     * the listener is AUDITIONING replaces the in-mix take(s) of its own
     * instrument. Local to this phone (it is how a person hears a competing
     * take before voting for it) and it never reaches the server.
     */
    fun activeTracks(tracks: List<JamTrack>, auditioning: Map<JamInstrument, String>): List<JamTrack> =
        tracks.filter { track ->
            val chosen = auditioning[track.instrument]
            if (chosen != null && tracks.any { it.id == chosen }) track.id == chosen else track.inMix
        }

    /**
     * Whether a stem is heard: with any solo on, only the soloed ones; with
     * none, everything that is not muted. Solo wins over mute, as on a console:
     * soloing a muted track is asking to hear it.
     */
    fun isAudible(trackId: String, soloed: Set<String>, muted: Set<String>): Boolean =
        if (soloed.isNotEmpty()) trackId in soloed else trackId !in muted

    /** The stack's rows: in-mix tracks (or the auditioned ones) in picker order of instrument, oldest first within one. */
    fun stack(tracks: List<JamTrack>, auditioning: Map<JamInstrument, String>): List<JamTrack> =
        ordered(activeTracks(tracks, auditioning))

    /** Takes that are not playing: competing versions waiting for a vote. */
    fun otherTakes(tracks: List<JamTrack>, auditioning: Map<JamInstrument, String>): List<JamTrack> {
        val active = activeTracks(tracks, auditioning).mapTo(HashSet()) { it.id }
        return ordered(tracks.filter { it.id !in active })
    }

    fun ordered(tracks: List<JamTrack>): List<JamTrack> =
        tracks.sortedWith(
            compareBy<JamTrack> { JamInstrument.entries.indexOf(it.instrument) }
                .thenBy { it.createdAtMs }
                .thenBy { it.id },
        )

    /**
     * The timeline of what plays: where it starts and how long it is, from the
     * tracks' own numbers (the engine's come from the files, within a
     * millisecond, once they are loaded).
     */
    fun timeline(tracks: List<JamTrack>): Timeline {
        val playable = tracks.filter { it.playedMs > 0 }
        if (playable.isEmpty()) return Timeline(0.0, 0.0)
        val start = playable.minOf { it.startMs }
        val end = playable.maxOf { it.endMs }
        return Timeline(start, max(0.0, end - start))
    }

    data class Timeline(val originMs: Double, val durationMs: Double)

    /** A track's slice as fractions of the timeline, for drawing its row. */
    fun fractions(track: JamTrack, originMs: Double, durationMs: Double): ClosedFloatingPointRange<Double> {
        if (durationMs <= 0) return 0.0..0.0
        val start = ((track.startMs - originMs) / durationMs).coerceIn(0.0, 1.0)
        val end = ((track.endMs - originMs) / durationMs).coerceIn(0.0, 1.0)
        return start..end
    }
}

// --- The playhead ---

object JamPlayhead {
    /** Position (ms from the origin) for a touch at [x] across a row of [width]. */
    fun position(x: Float, width: Float, durationMs: Double): Double {
        if (width <= 0f || durationMs <= 0) return 0.0
        return min(durationMs, max(0.0, x / width * durationMs))
    }

    /** The reverse: where to draw the line. */
    fun x(positionMs: Double, width: Float, durationMs: Double): Float {
        if (durationMs <= 0) return 0f
        return (positionMs / durationMs * width).toFloat().coerceIn(0f, width)
    }
}

// --- A live frame on an open song ---

/** What a frame changed that the ENGINE has to follow. A vote, a label or a gain tweak is not a reload. */
enum class JamEffect {
    None,

    /** The set of stems or where they sit changed: reload the engine. */
    ReloadStems,

    /** Only a level changed. */
    Levels,
}

/**
 * The song as the screen holds it, and what the seven frames do to it. Applied
 * by id and idempotent, because a change reaches the writer's own socket too.
 */
data class JamSongState(
    val song: JamSongSummary,
    val tracks: List<JamTrack> = emptyList(),
    val viewer: JamSongViewer = JamSongViewer(),
    /** Track ids that arrived live, for the entrance and the "new" mark. */
    val fresh: Set<String> = emptySet(),
    val wasDeleted: Boolean = false,
) {
    data class Applied(val state: JamSongState, val effect: JamEffect)

    /**
     * [auditioned] is the set of out-of-mix takes this phone is playing in
     * place of the mix, so a delete of one of those is a change of stems too.
     */
    fun apply(frame: JamFrame, auditioned: Set<String> = emptySet()): Applied = when (frame) {
        is JamFrame.SongCreated -> Applied(this, JamEffect.None)
        is JamFrame.SongUpdated ->
            if (frame.song.id == song.id) Applied(copy(song = frame.song), JamEffect.None) else Applied(this, JamEffect.None)
        is JamFrame.SongDeleted ->
            if (frame.songId == song.id) Applied(copy(wasDeleted = true), JamEffect.None) else Applied(this, JamEffect.None)
        is JamFrame.TrackAdded -> {
            if (frame.song.id != song.id || frame.track.songId != song.id) {
                Applied(this, JamEffect.None)
            } else {
                val index = tracks.indexOfFirst { it.id == frame.track.id }
                if (index >= 0) {
                    Applied(copy(song = frame.song, tracks = tracks.toMutableList().also { it[index] = frame.track }), JamEffect.None)
                } else {
                    Applied(
                        copy(song = frame.song, tracks = tracks + frame.track, fresh = fresh + frame.track.id),
                        if (frame.track.inMix) JamEffect.ReloadStems else JamEffect.None,
                    )
                }
            }
        }
        is JamFrame.TrackUpdated -> {
            if (frame.song.id != song.id || frame.track.songId != song.id) {
                Applied(this, JamEffect.None)
            } else {
                val index = tracks.indexOfFirst { it.id == frame.track.id }
                if (index < 0) {
                    Applied(
                        copy(song = frame.song, tracks = tracks + frame.track, fresh = fresh + frame.track.id),
                        if (frame.track.inMix) JamEffect.ReloadStems else JamEffect.None,
                    )
                } else {
                    val before = tracks[index]
                    val after = frame.track
                    val moved = before.inMix != after.inMix || before.offsetMs != after.offsetMs ||
                        before.trimStartMs != after.trimStartMs || before.trimEndMs != after.trimEndMs
                    val effect = when {
                        moved -> JamEffect.ReloadStems
                        before.gain != after.gain -> JamEffect.Levels
                        else -> JamEffect.None
                    }
                    Applied(copy(song = frame.song, tracks = tracks.toMutableList().also { it[index] = after }), effect)
                }
            }
        }
        is JamFrame.TrackDeleted -> {
            if (frame.song.id != song.id) {
                Applied(this, JamEffect.None)
            } else {
                val index = tracks.indexOfFirst { it.id == frame.trackId }
                if (index < 0) {
                    Applied(copy(song = frame.song), JamEffect.None)
                } else {
                    val wasPlaying = tracks[index].inMix || frame.trackId in auditioned
                    Applied(
                        copy(
                            song = frame.song,
                            tracks = tracks.filterIndexed { i, _ -> i != index },
                            fresh = fresh - frame.trackId,
                            viewer = viewer.copy(votedTrackIds = viewer.votedTrackIds - frame.trackId),
                        ),
                        if (wasPlaying) JamEffect.ReloadStems else JamEffect.None,
                    )
                }
            }
        }
        is JamFrame.TrackVotes -> {
            val index = tracks.indexOfFirst { it.id == frame.trackId }
            if (frame.songId != song.id || index < 0) {
                Applied(this, JamEffect.None)
            } else {
                Applied(
                    copy(tracks = tracks.toMutableList().also { it[index] = it[index].copy(voteCount = frame.voteCount) }),
                    JamEffect.None,
                )
            }
        }
    }

    /** The answer to the viewer's own vote: the count and where they stand. */
    fun apply(vote: JamVoteResponse): JamSongState {
        val index = tracks.indexOfFirst { it.id == vote.trackId }
        if (vote.songId != song.id || index < 0) return this
        val voted = if (vote.voted) viewer.votedTrackIds + vote.trackId else viewer.votedTrackIds - vote.trackId
        return copy(
            tracks = tracks.toMutableList().also { it[index] = it[index].copy(voteCount = vote.voteCount) },
            viewer = viewer.copy(votedTrackIds = voted.distinct()),
        )
    }
}

// --- Who may do what ---

object JamPermissions {
    /** `inMix` is the song's author's or a moderator's alone. */
    fun canSetMix(viewer: JamSongViewer): Boolean = viewer.isAuthor || viewer.canModerate

    /** A track goes away by its author, the song's author or a moderator. */
    fun canDeleteTrack(track: JamTrack, viewer: JamSongViewer, viewerId: String?): Boolean =
        viewer.isAuthor || viewer.canModerate || (viewerId != null && track.authorId == viewerId)

    /** A song goes away by its author or a moderator. */
    fun canDeleteSong(viewer: JamSongViewer): Boolean = viewer.isAuthor || viewer.canModerate

    /**
     * Whether this build offers a record button or says "recording is on the
     * computer". Today there is none, so it never records; the seam is here so
     * the real button replaces the sheet and not a screen.
     */
    const val CAN_RECORD_HERE = false
}
