package gg.pqp.app.jam

import gg.pqp.app.jam.audio.JamAlignment
import gg.pqp.app.jam.audio.JamFocusPolicy
import gg.pqp.app.jam.audio.JamVideoPlan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** What plays, what is heard, how a live frame changes an open song, who may do what, and the playback rules. */
class JamSongRulesTest {

    private val channel = "00000000-0000-4000-8000-0000000000c1"

    private fun song(id: String = "s", tracks: Int = 0) = JamSongSummary(
        id = id, channelId = channel, title = "Song", trackCount = tracks, updatedAt = "2026-11-01T10:00:00.000Z",
    )

    private fun track(
        id: String,
        instrument: JamInstrument = JamInstrument.Guitar,
        inMix: Boolean = true,
        offset: Double = 0.0,
        trimStart: Double = 0.0,
        gain: Double = 1.0,
        created: String = "2026-11-01T10:00:00.000Z",
        author: String = "u",
        songId: String = "s",
        video: Boolean = false,
    ) = JamTrack(
        id = id, songId = songId, authorId = author, instrument = instrument, inMix = inMix, offsetMs = offset, trimStartMs = trimStart, gain = gain,
        durationMs = 1000.0, createdAt = created, videoUrl = if (video) "https://x/v.mp4" else null,
    )

    // --- the mix ---

    @Test
    fun `only in-mix tracks play, until a competing take is auditioned`() {
        val a = track("a")
        val b = track("b", inMix = false)
        val drums = track("d", JamInstrument.Drums)
        val tracks = listOf(a, b, drums)
        assertEquals(listOf("a", "d"), JamMixRules.activeTracks(tracks, emptyMap()).map { it.id })
        // Auditioning b takes a's place, per instrument; drums are untouched.
        val auditioning = mapOf(JamInstrument.Guitar to "b")
        assertEquals(listOf("b", "d"), JamMixRules.activeTracks(tracks, auditioning).map { it.id })
        assertEquals(listOf("a"), JamMixRules.otherTakes(tracks, auditioning).map { it.id })
        // An audition of a track that is gone is no audition.
        assertEquals(listOf("a", "d"), JamMixRules.activeTracks(tracks, mapOf(JamInstrument.Guitar to "gone")).map { it.id })
    }

    @Test
    fun `solo wins over mute, as on a console`() {
        assertTrue(JamMixRules.isAudible("a", emptySet(), emptySet()))
        assertFalse(JamMixRules.isAudible("a", emptySet(), setOf("a")))
        assertTrue(JamMixRules.isAudible("a", setOf("a"), setOf("a")))
        assertFalse(JamMixRules.isAudible("b", setOf("a"), emptySet()))
    }

    @Test
    fun `the stack is in picker order, oldest first within an instrument`() {
        val tracks = listOf(
            track("v", JamInstrument.Vocals),
            track("g2", JamInstrument.Guitar, created = "2026-11-01T12:00:00.000Z"),
            track("g1", JamInstrument.Guitar, created = "2026-11-01T11:00:00.000Z"),
            track("b", JamInstrument.Bass),
        )
        assertEquals(listOf("g1", "g2", "b", "v"), JamMixRules.stack(tracks, emptyMap()).map { it.id })
    }

    @Test
    fun `the timeline starts at the earliest stem and ends at the latest`() {
        val early = track("e", offset = -250.0)
        val late = track("l", offset = 700.0)
        val timeline = JamMixRules.timeline(listOf(early, late))
        assertEquals(-250.0, timeline.originMs, 0.0)
        assertEquals(1950.0, timeline.durationMs, 0.0)
        assertEquals(0.0, JamMixRules.timeline(emptyList()).durationMs, 0.0)
        val fraction = JamMixRules.fractions(late, timeline.originMs, timeline.durationMs)
        assertEquals(950.0 / 1950.0, fraction.start, 1e-9)
        assertEquals(1.0, fraction.endInclusive, 1e-9)
    }

    @Test
    fun `the playhead maps a touch to a position and back`() {
        assertEquals(5000.0, JamPlayhead.position(50f, 100f, 10_000.0), 1e-9)
        assertEquals(0.0, JamPlayhead.position(-10f, 100f, 10_000.0), 0.0)
        assertEquals(10_000.0, JamPlayhead.position(500f, 100f, 10_000.0), 0.0)
        assertEquals(0.0, JamPlayhead.position(5f, 0f, 10_000.0), 0.0)
        assertEquals(25f, JamPlayhead.x(2500.0, 100f, 10_000.0), 1e-4f)
        assertEquals(100f, JamPlayhead.x(20_000.0, 100f, 10_000.0), 0f)
    }

    // --- an open song and the seven frames ---

    private fun open(vararg tracks: JamTrack) = JamSongState(song(tracks = tracks.size), tracks.toList())

    @Test
    fun `a track added live is fresh and reloads the stems only when it is in the mix`() {
        val base = open(track("a"))
        val inMix = base.apply(JamFrame.TrackAdded(channel, song(tracks = 2), track("b", JamInstrument.Bass)))
        assertEquals(JamEffect.ReloadStems, inMix.effect)
        assertEquals(setOf("b"), inMix.state.fresh)
        assertEquals(2, inMix.state.tracks.size)
        val competing = base.apply(JamFrame.TrackAdded(channel, song(tracks = 2), track("c", inMix = false)))
        assertEquals(JamEffect.None, competing.effect)
        // The writer's own socket says it twice: by id, so nothing doubles and nothing reloads.
        val again = inMix.state.apply(JamFrame.TrackAdded(channel, song(tracks = 2), track("b", JamInstrument.Bass)))
        assertEquals(2, again.state.tracks.size)
        assertEquals(JamEffect.None, again.effect)
    }

    @Test
    fun `an update that moves a stem reloads, a gain tweak only changes levels, a vote or label changes nothing`() {
        val base = open(track("a"))
        assertEquals(JamEffect.ReloadStems, base.apply(JamFrame.TrackUpdated(channel, song(), track("a", offset = 12.0))).effect)
        assertEquals(JamEffect.ReloadStems, base.apply(JamFrame.TrackUpdated(channel, song(), track("a", inMix = false))).effect)
        assertEquals(JamEffect.Levels, base.apply(JamFrame.TrackUpdated(channel, song(), track("a", gain = 0.5))).effect)
        val label = base.apply(JamFrame.TrackUpdated(channel, song(), track("a").copy(label = "take 2")))
        assertEquals(JamEffect.None, label.effect)
        assertEquals("take 2", label.state.tracks.single().label)
    }

    @Test
    fun `a deleted track drops its vote, and reloads only if it was playing or auditioned`() {
        val base = open(track("a"), track("b", inMix = false)).copy(viewer = JamSongViewer(votedTrackIds = listOf("b")))
        val gone = base.apply(JamFrame.TrackDeleted(channel, song(tracks = 1), "b"))
        assertEquals(JamEffect.None, gone.effect)
        assertTrue("b" !in gone.state.viewer.votedTrackIds)
        assertEquals(JamEffect.ReloadStems, base.apply(JamFrame.TrackDeleted(channel, song(), "a")).effect)
        assertEquals(JamEffect.ReloadStems, base.apply(JamFrame.TrackDeleted(channel, song(), "b"), auditioned = setOf("b")).effect)
    }

    @Test
    fun `votes, from a frame and from the answer to your own vote`() {
        val base = open(track("a"))
        val framed = base.apply(JamFrame.TrackVotes(channel, "s", "a", 4)).state
        assertEquals(4, framed.tracks.single().voteCount)
        val mine = framed.apply(JamVoteResponse("a", "s", 5, voted = true))
        assertEquals(5, mine.tracks.single().voteCount)
        assertEquals(listOf("a"), mine.viewer.votedTrackIds)
        val taken = mine.apply(JamVoteResponse("a", "s", 4, voted = false))
        assertEquals(emptyList<String>(), taken.viewer.votedTrackIds)
        // Another song's vote is not ours.
        assertEquals(base, base.apply(JamVoteResponse("a", "other", 9, true)))
    }

    @Test
    fun `a frame for another song does nothing, and a deleted song says so`() {
        val base = open(track("a"))
        assertEquals(base, base.apply(JamFrame.TrackAdded(channel, song("other"), track("x", songId = "other"))).state)
        assertTrue(base.apply(JamFrame.SongDeleted(channel, "s")).state.wasDeleted)
        assertFalse(base.apply(JamFrame.SongDeleted(channel, "other")).state.wasDeleted)
        val renamed = base.apply(JamFrame.SongUpdated(channel, song().copy(title = "New name"))).state
        assertEquals("New name", renamed.song.title)
    }

    @Test
    fun `the first read of a song has the frames that arrived during it put on top, the newer ones only`() {
        // The read was produced at 10:00:00 with one track. While it was out: a track was added AFTER it (10:00:05),
        // and a frame for a change the read already includes (09:59:59) arrived late.
        val at = { time: String -> song(tracks = 2).copy(updatedAt = "2026-11-01T$time.000Z") }
        val detail = JamSongDetailResponse(song(tracks = 1), listOf(track("a")), JamSongViewer())
        val pending = listOf(
            JamFrame.TrackAdded(channel, at("10:00:05"), track("b", JamInstrument.Bass)),
            // Older than the read: its change is already in it, and applying it would put the old value back.
            JamFrame.TrackUpdated(channel, at("09:59:59"), track("a", gain = 0.1)),
            JamFrame.TrackAdded(channel, at("09:59:58"), track("c", JamInstrument.Keys)),
            // A vote count has no date: not applied, the next frame or read carries the number.
            JamFrame.TrackVotes(channel, "s", "a", 3),
        )
        val state = JamSongState.loaded(detail, pending)
        assertEquals(listOf("a", "b"), state.tracks.map { it.id })
        assertEquals(1.0, state.tracks.first { it.id == "a" }.gain, 0.0)
        assertEquals(0, state.tracks.first { it.id == "a" }.voteCount)
        assertEquals(setOf("b"), state.fresh)
        // The song deleted while the read was out is a deleted song, whenever it was.
        assertTrue(JamSongState.loaded(detail, listOf(JamFrame.SongDeleted(channel, "s"))).wasDeleted)
        assertEquals(1, JamSongState.loaded(detail, emptyList()).tracks.size)
        // A frame at the very instant of the read is already in it.
        assertEquals(1, JamSongState.loaded(detail, listOf(JamFrame.TrackAdded(channel, song(tracks = 2), track("d")))).tracks.size)
    }

    @Test
    fun `the answer to your own write is not applied over something newer`() {
        val held = open(track("a")).copy(song = song().copy(updatedAt = "2026-11-01T12:00:00.000Z"))
        // A newer frame already landed (another moderator): the older answer is dropped.
        assertFalse(held.accepts(song().copy(updatedAt = "2026-11-01T11:59:59.000Z")))
        // The same instant or later is applied.
        assertTrue(held.accepts(song().copy(updatedAt = "2026-11-01T12:00:00.000Z")))
        assertTrue(held.accepts(song().copy(updatedAt = "2026-11-01T12:00:01.000Z")))
    }

    @Test
    fun `a video that is only buffering is left alone, one that died is prepared again`() {
        val buffering = 2
        val ready = 3
        assertEquals(JamVideoPlan.Start.Wait, JamVideoPlan.start(playWhenReady = true, state = buffering))
        assertEquals(JamVideoPlan.Start.Wait, JamVideoPlan.start(playWhenReady = true, state = ready))
        assertEquals(JamVideoPlan.Start.SeekAndPlay, JamVideoPlan.start(playWhenReady = false, state = ready))
        assertEquals(JamVideoPlan.Start.SeekAndPlay, JamVideoPlan.start(playWhenReady = true, state = JamVideoPlan.STATE_ENDED))
        // A load or decoder error leaves it idle with the play intent still set: left alone it froze for the rest of the song.
        assertEquals(JamVideoPlan.Start.Reprepare, JamVideoPlan.start(playWhenReady = true, state = JamVideoPlan.STATE_IDLE))
        assertEquals(JamVideoPlan.Start.Reprepare, JamVideoPlan.start(playWhenReady = false, state = JamVideoPlan.STATE_IDLE))
    }

    // --- who may do what ---

    @Test
    fun `permissions follow the contract`() {
        val mine = track("a", author = "me")
        val theirs = track("b", author = "them")
        val author = JamSongViewer(isAuthor = true)
        val moderator = JamSongViewer(canModerate = true)
        val member = JamSongViewer()
        assertTrue(JamPermissions.canSetMix(author))
        assertTrue(JamPermissions.canSetMix(moderator))
        assertFalse(JamPermissions.canSetMix(member))
        assertTrue(JamPermissions.canDeleteTrack(theirs, author, "me"))
        assertTrue(JamPermissions.canDeleteTrack(theirs, moderator, "me"))
        assertTrue(JamPermissions.canDeleteTrack(mine, member, "me"))
        assertFalse(JamPermissions.canDeleteTrack(theirs, member, "me"))
        assertFalse(JamPermissions.canDeleteTrack(mine, member, null))
        assertTrue(JamPermissions.canDeleteSong(author))
        assertFalse(JamPermissions.canDeleteSong(member))
    }

    // --- audio focus ---

    @Test
    fun `a song never starts under a call`() {
        assertTrue(JamFocusPolicy.mayStart(callActive = false))
        assertFalse(JamFocusPolicy.mayStart(callActive = true))
        assertEquals(JamFocusPolicy.Action.Pause, JamFocusPolicy.onCallActive(playing = true))
        assertEquals(JamFocusPolicy.Action.None, JamFocusPolicy.onCallActive(playing = false))
    }

    @Test
    fun `focus changes pause, duck, and resume the way the voice notes do`() {
        val loss = JamFocusPolicy.onChange(JamFocusPolicy.Change.Loss, playing = true, resumeOnGain = false, callActive = false)
        assertEquals(JamFocusPolicy.Decision(JamFocusPolicy.Action.Pause, false), loss)

        val transient = JamFocusPolicy.onChange(JamFocusPolicy.Change.LossTransient, playing = true, resumeOnGain = false, callActive = false)
        assertEquals(JamFocusPolicy.Decision(JamFocusPolicy.Action.PauseUntilGain, true), transient)
        // Already paused by the person: a transient loss must not arm a resume they did not ask for.
        val idle = JamFocusPolicy.onChange(JamFocusPolicy.Change.LossTransient, playing = false, resumeOnGain = false, callActive = false)
        assertEquals(JamFocusPolicy.Decision(JamFocusPolicy.Action.None, false), idle)

        val duck = JamFocusPolicy.onChange(JamFocusPolicy.Change.LossTransientCanDuck, playing = true, resumeOnGain = false, callActive = false)
        assertEquals(JamFocusPolicy.Action.Duck, duck.action)

        val back = JamFocusPolicy.onChange(JamFocusPolicy.Change.Gain, playing = false, resumeOnGain = true, callActive = false)
        assertEquals(JamFocusPolicy.Decision(JamFocusPolicy.Action.Resume, false), back)
        // A call connected while focus was away: the song does not come back over it.
        val underCall = JamFocusPolicy.onChange(JamFocusPolicy.Change.Gain, playing = false, resumeOnGain = true, callActive = true)
        assertEquals(JamFocusPolicy.Action.Unduck, underCall.action)
        assertFalse(underCall.resumeOnGain)

        assertEquals(JamFocusPolicy.Action.Pause, JamFocusPolicy.onBecomingNoisy(true))
        assertEquals(JamFocusPolicy.Action.None, JamFocusPolicy.onBecomingNoisy(false))
    }

    // --- the video's lock to the clock ---

    @Test
    fun `video drift is left alone, nudged, or sought`() {
        assertEquals(JamVideoPlan.Correction.None, JamVideoPlan.correction(1000.0, 1030.0))
        assertEquals(JamVideoPlan.Correction.Speed(1.04f), JamVideoPlan.correction(1000.0, 1200.0))
        assertEquals(JamVideoPlan.Correction.Speed(0.96f), JamVideoPlan.correction(1300.0, 1000.0))
        assertEquals(JamVideoPlan.Correction.Seek(5000), JamVideoPlan.correction(1000.0, 5000.0))
        assertEquals(JamVideoPlan.Correction.Seek(0), JamVideoPlan.correction(9000.0, -50.0))
    }

    @Test
    fun `a video waits before its slice and holds after it`() {
        val t = track("v", offset = 500.0, video = true)
        assertTrue(JamVideoPlan.waiting(100.0, t))
        assertFalse(JamVideoPlan.waiting(500.0, t))
        assertFalse(JamVideoPlan.finished(1499.0, t))
        assertTrue(JamVideoPlan.finished(1500.0, t))
        // A head trim hides the first part of the file and moves nothing: the video waits for the first HEARD frame.
        val trimmed = track("w", offset = 500.0, trimStart = 200.0, video = true)
        assertTrue(JamVideoPlan.waiting(699.0, trimmed))
        assertFalse(JamVideoPlan.waiting(700.0, trimmed))
        assertTrue(JamVideoPlan.finished(1500.0, trimmed))
    }

    @Test
    fun `the video file time is the audio file time`() {
        // offset 500 (the file's first sample), trim start 200: at song time 900 the file is 400 ms in, and song
        // time 700 is its first heard frame.
        assertEquals(400.0, JamAlignment.videoFileMs(900.0, 500.0, 200.0, 0.0, 2000.0), 0.0)
        assertEquals(200.0, JamAlignment.videoFileMs(700.0, 500.0, 200.0, 0.0, 2000.0), 0.0)
        // Before the slice it holds on the first heard frame; after, on the last.
        assertEquals(200.0, JamAlignment.videoFileMs(0.0, 500.0, 200.0, 0.0, 2000.0), 0.0)
        assertEquals(2000.0, JamAlignment.videoFileMs(9000.0, 500.0, 200.0, 0.0, 2000.0), 0.0)
        // A negative offset: song time 0 is already 250 ms into the file.
        assertEquals(250.0, JamAlignment.videoFileMs(0.0, -250.0, 0.0, 0.0, 2000.0), 0.0)
    }
}
